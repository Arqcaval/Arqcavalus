from __future__ import annotations

import os

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import modules, storage
from ..audit import audit, qa
from ..config import settings
from ..db import get_db
from ..ingestion.classify import DOC_TYPES, TYPE_MODULES
from ..ingestion.extract import IMAGE_EXT
from ..ingestion.pipeline import ALLOWED_EXT, process_document, thumbnail
from ..models import Document, ModuleMapping, Project, ProjectMember, Record, SourceImage, User, now
from ..security import ROLE_RANK, current_user, get_project_for, project_role
from ..serialize import ser

router = APIRouter(prefix="/api/projects", tags=["projects"])


class ProjectIn(BaseModel):
    name: str
    code: str = ""
    description: str = ""
    budget_usd: float | None = None


@router.get("")
def list_projects(db: Session = Depends(get_db), user: User = Depends(current_user)):
    q = db.query(Project).filter(Project.archived.is_(False))
    if not user.is_admin:
        q = q.join(ProjectMember, ProjectMember.project_id == Project.id).filter(ProjectMember.user_id == user.id)
    return [{**ser(p), "role": project_role(db, user, p.id)} for p in q.order_by(Project.created_at)]


@router.post("")
def create_project(body: ProjectIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if not body.name.strip():
        raise HTTPException(400, "Project name is required")
    p = Project(name=body.name.strip(), code=body.code.strip(), description=body.description,
                budget_usd=body.budget_usd if body.budget_usd is not None else settings.default_project_budget_usd,
                created_by=user.id, oscillator={"mode": "auto", "quality": "high", "input_fidelity": True})
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=user.id, role="owner"))
    db.commit()
    audit(db, p.id, user.id, "project.create", p.id, {"name": p.name})
    return {**ser(p), "role": "owner"}


@router.get("/{pid}")
def get_project(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid)
    return {**ser(p), "role": project_role(db, user, pid)}


class ProjectPatch(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    budget_usd: float | None = None
    archived: bool | None = None


@router.patch("/{pid}")
def patch_project(pid: str, body: ProjectPatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid, "owner")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(p, k, v)
    db.commit()
    audit(db, pid, user.id, "project.update", pid, body.model_dump(exclude_none=True))
    return ser(p)


class CanvasIn(BaseModel):
    canvas: dict


@router.put("/{pid}/canvas")
def save_canvas(pid: str, body: CanvasIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid, "editor")
    p.canvas = body.canvas
    db.commit()
    return {"ok": True}


# ---- members -----------------------------------------------------------------------------------
@router.get("/{pid}/members")
def members(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return [{"user_id": m.user_id, "email": m.user.email, "name": m.user.name, "role": m.role}
            for m in db.query(ProjectMember).filter_by(project_id=pid)]


class MemberIn(BaseModel):
    email: str
    role: str = "editor"


@router.post("/{pid}/members")
def add_member(pid: str, body: MemberIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "owner")
    if body.role not in ROLE_RANK:
        raise HTTPException(400, f"role must be one of {list(ROLE_RANK)}")
    u = db.query(User).filter_by(email=body.email.strip().lower()).first()
    if not u:
        raise HTTPException(404, "No user with that email. An administrator must create the account first.")
    m = db.query(ProjectMember).filter_by(project_id=pid, user_id=u.id).first()
    if m:
        m.role = body.role
    else:
        db.add(ProjectMember(project_id=pid, user_id=u.id, role=body.role))
    db.commit()
    audit(db, pid, user.id, "member.set", u.id, {"role": body.role})
    return {"ok": True}


@router.delete("/{pid}/members/{uid}")
def remove_member(pid: str, uid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "owner")
    db.query(ProjectMember).filter_by(project_id=pid, user_id=uid).delete()
    db.commit()
    return {"ok": True}


# ---- documents ---------------------------------------------------------------------------------
def _doc_out(db, d: Document) -> dict:
    maps = db.query(ModuleMapping).filter_by(document_id=d.id).all()
    n = db.query(Record).filter_by(document_id=d.id).count()
    img = db.query(SourceImage).filter_by(document_id=d.id).first()
    return {**ser(d, exclude={"text_excerpt", "storage_path"}), "mappings": [ser(m) for m in maps], "record_count": n,
            "source_image_id": img.id if img else None, "doc_type_label": DOC_TYPES.get(d.doc_type, d.doc_type)}


@router.get("/{pid}/documents")
def list_documents(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return [_doc_out(db, d) for d in db.query(Document).filter_by(project_id=pid).order_by(Document.created_at.desc())]


@router.get("/meta/doc-types")
def doc_types(_: User = Depends(current_user)):
    return [{"value": k, "label": v, "modules": TYPE_MODULES[k]} for k, v in DOC_TYPES.items()]


@router.post("/{pid}/documents")
async def upload(pid: str, files: list[UploadFile] = File(...), db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    results = []
    limit = settings.max_upload_mb * 1024 * 1024
    for f in files:
        name = os.path.basename(f.filename or "upload")
        ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        if ext == "jpeg":
            ext = "jpg"
        if ext not in ALLOWED_EXT:
            results.append({"name": name, "error": f"Unsupported file type .{ext}. Supported: PDF, PNG, JPEG, WEBP, CSV, XLSX, TXT/MD (DWG/RVT are stored but not parsed)."})
            continue
        data = await f.read(limit + 1)
        if len(data) > limit:
            results.append({"name": name, "error": f"File exceeds the {settings.max_upload_mb} MB limit"})
            continue
        if not data:
            results.append({"name": name, "error": "Empty file"})
            continue
        rel, digest = storage.write_new(pid, "documents", data, ext)
        dup = db.query(Document).filter_by(project_id=pid, sha256=digest).first()
        d = Document(project_id=pid, original_name=name, ext=ext, mime=f.content_type or "", size=len(data), sha256=digest,
                     storage_path=rel, uploaded_by=user.id, meta={"duplicate_of": dup.id} if dup else {})
        db.add(d)
        db.commit()
        audit(db, pid, user.id, "document.upload", d.id, {"name": name, "sha256": digest, "size": len(data)})
        d = process_document(db, d, user.id)
        results.append(_doc_out(db, d))
    return results


@router.get("/{pid}/documents/{did}")
def get_document(pid: str, did: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    d = db.query(Document).filter_by(id=did, project_id=pid).first()
    if not d:
        raise HTTPException(404, "Document not found")
    return {**_doc_out(db, d), "text_excerpt": d.text_excerpt[:20000],
            "records": [ser(r) for r in db.query(Record).filter_by(document_id=d.id)]}


@router.get("/{pid}/documents/{did}/file")
def document_file(pid: str, did: str, thumb: bool = False, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    d = db.query(Document).filter_by(id=did, project_id=pid).first()
    if not d:
        raise HTTPException(404, "Document not found")
    path = storage.resolve(pid, d.storage_path)
    if thumb and d.ext in IMAGE_EXT:
        return Response(thumbnail(path.read_bytes()), media_type="image/jpeg")
    media = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "webp": "image/webp",
             "csv": "text/csv", "txt": "text/plain", "md": "text/plain"}.get(d.ext, "application/octet-stream")
    return FileResponse(path, media_type=media, filename=d.original_name,
                        content_disposition_type="inline" if media != "application/octet-stream" else "attachment")


class ClassIn(BaseModel):
    doc_type: str
    reason: str = ""


@router.patch("/{pid}/documents/{did}")
def override_classification(pid: str, did: str, body: ClassIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    d = db.query(Document).filter_by(id=did, project_id=pid).first()
    if not d:
        raise HTTPException(404, "Document not found")
    if body.doc_type not in DOC_TYPES:
        raise HTTPException(400, "Unknown document type")
    old = d.doc_type
    d.doc_type = body.doc_type
    d.classification_source = "manual"
    d.classification_confidence = 1.0
    d.classification_evidence = [f"manually classified by {user.email}" + (f": {body.reason}" if body.reason else ""),
                                 f"previous automatic classification: {old}"]
    # Mappings for the old type that were accepted are retracted; reviewed records are kept.
    for m in db.query(ModuleMapping).filter_by(document_id=d.id):
        if m.module_key not in TYPE_MODULES[body.doc_type]:
            db.delete(m)
    if body.doc_type != "source_image":
        for img in db.query(SourceImage).filter_by(document_id=d.id, status="candidate"):
            db.delete(img)
    db.commit()
    qa(db, pid, "user_correction", f"Document reclassified: {d.original_name}", f"{old} → {body.doc_type}. {body.reason}",
       {"document_id": d.id}, user.id)
    audit(db, pid, user.id, "document.reclassify", d.id, {"from": old, "to": body.doc_type})
    d = process_document(db, d, user.id)
    return _doc_out(db, d)


@router.post("/{pid}/documents/{did}/reprocess")
def reprocess(pid: str, did: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    d = db.query(Document).filter_by(id=did, project_id=pid).first()
    if not d:
        raise HTTPException(404, "Document not found")
    return _doc_out(db, process_document(db, d, user.id))


class MappingIn(BaseModel):
    status: str


@router.patch("/{pid}/mappings/{mid}")
def review_mapping(pid: str, mid: str, body: MappingIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    m = db.query(ModuleMapping).filter_by(id=mid, project_id=pid).first()
    if not m:
        raise HTTPException(404)
    if body.status not in ("accepted", "rejected", "proposed"):
        raise HTTPException(400)
    m.status = body.status
    if body.status == "rejected":
        n = db.query(Record).filter_by(document_id=m.document_id, module_key=m.module_key, status="proposed").delete()
        audit(db, pid, user.id, "mapping.reject", mid, {"removed_proposals": n})
    db.commit()
    audit(db, pid, user.id, "mapping.review", mid, {"status": body.status})
    return ser(m)


# ---- records -----------------------------------------------------------------------------------
@router.get("/{pid}/records")
def list_records(pid: str, module: str | None = None, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    q = db.query(Record).filter_by(project_id=pid)
    if module:
        q = q.filter_by(module_key=module)
    docs = {d.id: d.original_name for d in db.query(Document).filter_by(project_id=pid)}
    return [{**ser(r), "document_name": docs.get(r.document_id)} for r in q.order_by(Record.module_key, Record.record_type, Record.key)]


class RecordIn(BaseModel):
    module_key: str
    record_type: str
    key: str
    data: dict
    notes: str = ""


@router.post("/{pid}/records")
def create_record(pid: str, body: RecordIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    if body.module_key not in modules.MODULES:
        raise HTTPException(400, "unknown module")
    r = Record(project_id=pid, module_key=body.module_key, record_type=body.record_type, key=body.key.strip(), data=body.data,
               status="approved", origin="user", source_ref=f"entered manually by {user.email}", evidence="manual entry",
               confidence=1.0, notes=body.notes, reviewed_by=user.id, reviewed_at=now())
    db.add(r)
    db.commit()
    audit(db, pid, user.id, "record.create", r.id, {"key": r.key, "type": r.record_type})
    return ser(r)


class RecordPatch(BaseModel):
    status: str | None = None
    data: dict | None = None
    notes: str | None = None
    key: str | None = None


@router.patch("/{pid}/records/{rid}")
def review_record(pid: str, rid: str, body: RecordPatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    r = db.query(Record).filter_by(id=rid, project_id=pid).first()
    if not r:
        raise HTTPException(404, "Record not found")
    before = {"status": r.status, "data": dict(r.data or {}), "key": r.key}
    if body.data is not None:
        r.data = {**(r.data or {}), **body.data}
        if before["data"] != r.data:
            qa(db, pid, "material_error" if r.record_type == "finish" else "user_correction",
               f"Corrected {r.record_type} {r.key}", f"before: {before['data']}\nafter: {r.data}", {"record_id": r.id}, user.id)
    if body.key is not None:
        r.key = body.key.strip()
    if body.notes is not None:
        r.notes = body.notes
    if body.status is not None:
        if body.status not in ("proposed", "approved", "rejected"):
            raise HTTPException(400)
        r.status = body.status
        r.reviewed_by, r.reviewed_at = user.id, now()
    # Approving an equipment_location proposal marks the equipment item's location as verified.
    if r.record_type == "equipment_location" and body.status == "approved":
        eq = db.query(Record).filter_by(project_id=pid, record_type="equipment", key=r.key).filter(Record.status != "rejected").all()
        for e in eq:
            e.data = {**e.data, "location_verified": True, "location_evidence": r.source_ref, "verified_by": user.email}
    db.commit()
    audit(db, pid, user.id, "record.review", rid, {"before": before, "status": r.status})
    return ser(r)


# ---- modules -----------------------------------------------------------------------------------
@router.get("/{pid}/modules")
def module_states(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid)
    states = modules.evaluate(db, p)
    summary = {"satisfied": [k for k, v in states.items() if v["readiness"] == "satisfied"],
               "partial": [k for k, v in states.items() if v["readiness"] == "partial"],
               "blocked": [k for k, v in states.items() if v["readiness"] == "blocked"]}
    critical_ok = all(states[k]["state"] == "VALIDATED" for k in ("N01", "N04", "N05", "N07"))
    return {"modules": states, "summary": summary, "execution_ready": critical_ok}
