from __future__ import annotations

import io

import numpy as np
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import imaging, intent, storage
from ..audit import audit
from ..db import get_db
from ..ingestion.pipeline import thumbnail
from ..models import EditRequest, Mask, SourceImage, User, now
from ..security import current_user, get_project_for
from ..serialize import ser

router = APIRouter(prefix="/api/projects/{pid}", tags=["images"])


def _img(db, pid, iid) -> SourceImage:
    i = db.query(SourceImage).filter_by(id=iid, project_id=pid).first()
    if not i:
        raise HTTPException(404, "Image not found in this project")
    return i


@router.get("/images")
def list_images(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    out = []
    for i in db.query(SourceImage).filter_by(project_id=pid).order_by(SourceImage.created_at):
        masks = db.query(Mask).filter_by(source_image_id=i.id).order_by(Mask.created_at).all()
        out.append({**ser(i, exclude={"storage_path"}), "masks": [ser(m, exclude={"storage_path"}) for m in masks]})
    return out


class ImagePatch(BaseModel):
    status: str | None = None
    label: str | None = None


@router.patch("/images/{iid}")
def patch_image(pid: str, iid: str, body: ImagePatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    i = _img(db, pid, iid)
    if body.label is not None:
        i.label = body.label
    if body.status is not None:
        if body.status not in ("candidate", "authorized", "rejected"):
            raise HTTPException(400)
        if body.status == "authorized":
            if storage.sha256_file(storage.resolve(pid, i.storage_path)) != i.sha256:
                raise HTTPException(409, "Stored file does not match the uploaded hash; cannot authorise")
            i.authorized_by, i.authorized_at = user.id, now()
        i.status = body.status
    db.commit()
    audit(db, pid, user.id, "image.update", iid, body.model_dump(exclude_none=True))
    return ser(i, exclude={"storage_path"})


@router.get("/images/{iid}/file")
def image_file(pid: str, iid: str, thumb: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    i = _img(db, pid, iid)
    path = storage.resolve(pid, i.storage_path)
    if thumb:
        return Response(thumbnail(path.read_bytes()), media_type="image/jpeg")
    ext = i.storage_path.rsplit(".", 1)[-1]
    return FileResponse(path, media_type={"jpg": "image/jpeg", "webp": "image/webp"}.get(ext, "image/png"))


@router.get("/images/{iid}/verify")
def verify_image(pid: str, iid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    i = _img(db, pid, iid)
    actual = storage.sha256_file(storage.resolve(pid, i.storage_path))
    return {"expected": i.sha256, "actual": actual, "unchanged": actual == i.sha256}


@router.post("/images/{iid}/masks")
async def upload_mask(pid: str, iid: str, kind: str = Form(...), label: str = Form(""), file: UploadFile = File(...),
                      db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    i = _img(db, pid, iid)
    if kind not in ("edit", "protected"):
        raise HTTPException(400, "kind must be 'edit' or 'protected'")
    data = await file.read(30 * 1024 * 1024)
    try:
        m = imaging.load_mask(data, (i.width, i.height))
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception:
        raise HTTPException(400, "Mask must be a PNG image")
    if not m.any():
        raise HTTPException(400, "Mask is empty")
    png = imaging.mask_to_png(m)
    rel, digest = storage.write_new(pid, "masks", png, "png")
    mk = Mask(project_id=pid, source_image_id=i.id, kind=kind, label=label or f"{kind} mask", storage_path=rel, sha256=digest,
              coverage=round(float(m.mean()) * 100, 3), status="draft", created_by=user.id)
    db.add(mk)
    db.commit()
    audit(db, pid, user.id, "mask.create", mk.id, {"kind": kind, "coverage_pct": mk.coverage})
    return ser(mk, exclude={"storage_path"})


def _mask(db, pid, mid) -> Mask:
    m = db.query(Mask).filter_by(id=mid, project_id=pid).first()
    if not m:
        raise HTTPException(404, "Mask not found in this project")
    return m


class MaskPatch(BaseModel):
    status: str | None = None
    label: str | None = None


@router.patch("/masks/{mid}")
def patch_mask(pid: str, mid: str, body: MaskPatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    m = _mask(db, pid, mid)
    if body.label is not None:
        m.label = body.label
    if body.status is not None:
        if body.status not in ("draft", "approved"):
            raise HTTPException(400)
        m.status = body.status
        m.approved_by = user.id if body.status == "approved" else None
    db.commit()
    audit(db, pid, user.id, "mask.update", mid, body.model_dump(exclude_none=True))
    return ser(m, exclude={"storage_path"})


@router.get("/masks/{mid}/file")
def mask_file(pid: str, mid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    m = _mask(db, pid, mid)
    return FileResponse(storage.resolve(pid, m.storage_path), media_type="image/png")


# ---- edit requests (NODE 04) -------------------------------------------------------------------
class EditIn(BaseModel):
    source_image_id: str
    instruction: str
    scope: str = "local"
    edit_mask_id: str | None = None
    protected_mask_id: str | None = None
    composite: bool = True
    global_authorized: bool = False
    allow_object_additions: bool = False


def _check_refs(db, pid, body: EditIn):
    src = _img(db, pid, body.source_image_id)
    for mid, kind in ((body.edit_mask_id, "edit"), (body.protected_mask_id, "protected")):
        if mid:
            m = _mask(db, pid, mid)
            if m.source_image_id != src.id:
                raise HTTPException(400, f"The {kind} mask was drawn on a different image")
            if m.kind != kind:
                raise HTTPException(400, f"Mask {mid} is a {m.kind} mask, not {kind}")
    if body.scope not in ("local", "global"):
        raise HTTPException(400, "scope must be local or global")


@router.post("/edit-requests")
def create_edit(pid: str, body: EditIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    _check_refs(db, pid, body)
    er = EditRequest(project_id=pid, created_by=user.id, **body.model_dump())
    db.add(er)
    db.flush()
    er.analysis = intent.analyze(db, er)
    db.commit()
    audit(db, pid, user.id, "edit_request.create", er.id, {"instruction": er.instruction, "scope": er.scope})
    return ser(er)


@router.get("/edit-requests")
def list_edits(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return [ser(e) for e in db.query(EditRequest).filter_by(project_id=pid).order_by(EditRequest.created_at.desc())]


class EditPatch(BaseModel):
    instruction: str | None = None
    scope: str | None = None
    edit_mask_id: str | None = None
    protected_mask_id: str | None = None
    composite: bool | None = None
    global_authorized: bool | None = None
    allow_object_additions: bool | None = None
    status: str | None = None


@router.patch("/edit-requests/{eid}")
def patch_edit(pid: str, eid: str, body: EditPatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    er = db.query(EditRequest).filter_by(id=eid, project_id=pid).first()
    if not er:
        raise HTTPException(404)
    changes = body.model_dump(exclude_unset=True)
    status = changes.pop("status", None)
    for k, v in changes.items():
        setattr(er, k, v)
    _check_refs(db, pid, EditIn(source_image_id=er.source_image_id, instruction=er.instruction, scope=er.scope,
                                edit_mask_id=er.edit_mask_id, protected_mask_id=er.protected_mask_id))
    if changes:
        er.status = "draft"  # any change requires re-approval
    er.analysis = intent.analyze(db, er)
    if status == "approved":
        if er.analysis["blocking"]:
            raise HTTPException(409, "Cannot approve: " + "; ".join(i["message"] for i in er.analysis["issues"] if i["severity"] == "block"))
        if er.scope == "local":
            m = db.get(Mask, er.edit_mask_id)
            if m.status != "approved":
                raise HTTPException(409, "Approve the edit mask first")
        er.status, er.approved_by = "approved", user.id
    elif status == "draft":
        er.status = "draft"
    db.commit()
    audit(db, pid, user.id, "edit_request.update", eid, {**changes, "status": er.status})
    return ser(er)


@router.get("/images/{iid}/mask-preview")
def mask_preview(pid: str, iid: str, edit_mask_id: str | None = None, protected_mask_id: str | None = None,
                 db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    i = _img(db, pid, iid)
    src = imaging.load_rgb(storage.read(pid, i.storage_path))
    size = (i.width, i.height)
    edit = imaging.load_mask(storage.read(pid, _mask(db, pid, edit_mask_id).storage_path), size) if edit_mask_id else np.zeros((i.height, i.width), bool)
    prot = imaging.load_mask(storage.read(pid, _mask(db, pid, protected_mask_id).storage_path), size) if protected_mask_id else None
    region = edit & ~prot if prot is not None else edit
    buf = io.BytesIO()
    imaging.mask_overlay(src, region, prot).save(buf, "JPEG", quality=85)
    return Response(buf.getvalue(), media_type="image/jpeg")
