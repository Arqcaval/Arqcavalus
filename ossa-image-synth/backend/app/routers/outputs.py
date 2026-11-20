from __future__ import annotations

import io
import json
import zipfile

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import imaging, storage, validation
from ..audit import audit, qa
from ..db import get_db
from ..jobs import load_region
from ..models import (AuditEvent, Document, EditRequest, Generation, Job, Mask, Project, ProviderCall, QALogEntry, Record,
                      SourceImage, User, now)
from ..security import current_user, get_project_for, project_role, require_admin
from ..serialize import ser

router = APIRouter(prefix="/api", tags=["outputs"])

QA_CATEGORIES = ["user_correction", "failed_generation", "approved_result", "material_error", "geometry_change",
                 "equipment_hallucination", "unauthorized_edit", "override", "lesson"]


def _gen(db, pid, gid) -> Generation:
    g = db.query(Generation).filter_by(id=gid, project_id=pid).first()
    if not g:
        raise HTTPException(404, "Output not found in this project")
    return g


def _gen_out(db, g: Generation) -> dict:
    j = db.get(Job, g.job_id)
    er = db.get(EditRequest, g.edit_request_id)
    return {**ser(g, exclude={"raw_path", "final_path"}), "provider": j.provider, "model": j.model,
            "selection_mode": j.selection_mode, "instruction": er.instruction, "scope": er.scope,
            "checklist_complete": validation.checklist_complete(g.checklist),
            "approval_blocked": not (g.validation or {}).get("automated_passed") or not validation.checklist_complete(g.checklist)}


@router.get("/projects/{pid}/generations")
def list_generations(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return [_gen_out(db, g) for g in db.query(Generation).filter_by(project_id=pid).order_by(Generation.created_at.desc())]


@router.get("/projects/{pid}/generations/{gid}")
def get_generation(pid: str, gid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return _gen_out(db, _gen(db, pid, gid))


@router.get("/projects/{pid}/generations/{gid}/file")
def generation_file(pid: str, gid: str, variant: str = "final", db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    g = _gen(db, pid, gid)
    if variant == "final":
        return FileResponse(storage.resolve(pid, g.final_path), media_type="image/png")
    if variant == "raw":
        return FileResponse(storage.resolve(pid, g.raw_path), media_type="image/png")
    src_row = db.get(SourceImage, g.source_image_id)
    src = imaging.load_rgb(storage.read(pid, src_row.storage_path))
    if variant == "source":
        return FileResponse(storage.resolve(pid, src_row.storage_path))
    final = imaging.load_rgb(storage.read(pid, g.final_path))
    buf = io.BytesIO()
    if variant == "diff":
        imaging.diff_image(src, final).save(buf, "PNG")
    elif variant == "mask":
        er = db.get(EditRequest, g.edit_request_id)
        region, prot = load_region(db, er, src_row)
        imaging.mask_overlay(src, region, prot).save(buf, "PNG")
    else:
        raise HTTPException(400, "variant must be final|raw|source|diff|mask")
    return Response(buf.getvalue(), media_type="image/png")


class ChecklistIn(BaseModel):
    items: dict[str, bool]


@router.patch("/projects/{pid}/generations/{gid}/checklist")
def update_checklist(pid: str, gid: str, body: ChecklistIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "reviewer")
    g = _gen(db, pid, gid)
    if g.status != "pending_review":
        raise HTTPException(409, "This output has already been decided")
    items = [dict(i) for i in g.checklist.get("items", [])]
    for i in items:
        if i["id"] in body.items:
            i["checked"] = bool(body.items[i["id"]])
            i["checked_by"] = user.email
    g.checklist = {"items": items}
    db.commit()
    return _gen_out(db, g)


class DecisionIn(BaseModel):
    decision: str  # approve|reject|revise
    reason: str = ""
    override_reason: str = ""
    qa_category: str | None = None
    revised_instruction: str | None = None
    make_lesson: bool = False


@router.post("/projects/{pid}/generations/{gid}/decision")
def decide(pid: str, gid: str, body: DecisionIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "reviewer")
    role = project_role(db, user, pid)
    g = _gen(db, pid, gid)
    if g.status != "pending_review":
        raise HTTPException(409, f"Output already {g.status}")
    j = db.get(Job, g.job_id)
    out: dict = {}
    if body.decision == "approve":
        auto_ok = (g.validation or {}).get("automated_passed", False)
        cl_ok = validation.checklist_complete(g.checklist)
        if not (auto_ok and cl_ok):
            failed = [c["label"] for c in g.validation.get("checks", []) if c["blocking"] and not c["passed"]]
            if not cl_ok:
                failed.append("reviewer checklist incomplete")
            if not body.override_reason.strip():
                raise HTTPException(409, {"message": "Approval blocked: required checks failed", "failed": failed})
            if role not in ("owner", "reviewer"):
                raise HTTPException(403, "Only a project owner or reviewer may override failed checks")
            g.override_reason = body.override_reason.strip()
            qa(db, pid, "override", f"Approval override on output v{g.version}", f"Failed: {'; '.join(failed)}\nReason: {g.override_reason}",
               {"generation_id": g.id}, user.id)
        g.status = "approved"
        qa(db, pid, "approved_result", f"Approved output v{g.version} ({j.provider}/{j.model})", body.reason,
           {"generation_id": g.id, "model": j.model}, user.id)
    elif body.decision in ("reject", "revise"):
        if not body.reason.strip():
            raise HTTPException(400, "A reason is required")
        cat = body.qa_category if body.qa_category in QA_CATEGORIES else "user_correction"
        g.status = "rejected" if body.decision == "reject" else "revision_requested"
        qa(db, pid, cat, f"{'Rejected' if body.decision == 'reject' else 'Revision requested'}: output v{g.version}", body.reason,
           {"generation_id": g.id, "model": j.model}, user.id, is_lesson=body.make_lesson)
        if body.decision == "revise":
            from .. import intent
            er = db.get(EditRequest, g.edit_request_id)
            new = EditRequest(project_id=pid, source_image_id=er.source_image_id, instruction=body.revised_instruction or er.instruction,
                              scope=er.scope, edit_mask_id=er.edit_mask_id, protected_mask_id=er.protected_mask_id,
                              composite=er.composite, global_authorized=er.global_authorized,
                              allow_object_additions=er.allow_object_additions, created_by=user.id)
            db.add(new)
            db.flush()
            new.analysis = intent.analyze(db, new)
            new.analysis["revision_of_generation"] = g.id
            out["new_edit_request_id"] = new.id
    else:
        raise HTTPException(400, "decision must be approve, reject or revise")
    g.decided_by, g.decided_at, g.decision_reason = user.id, now(), body.reason
    db.commit()
    audit(db, pid, user.id, f"generation.{body.decision}", gid, {"reason": body.reason, "override": g.override_reason})
    return {**_gen_out(db, g), **out}


# ---- QA log ------------------------------------------------------------------------------------
class QAIn(BaseModel):
    category: str
    title: str
    detail: str = ""
    is_lesson: bool = False


@router.get("/projects/{pid}/qa")
def list_qa(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    proj = db.query(QALogEntry).filter_by(project_id=pid).order_by(QALogEntry.created_at.desc()).all()
    glob = db.query(QALogEntry).filter_by(scope="global").order_by(QALogEntry.created_at).all()
    return {"project": [ser(e) for e in proj], "global": [ser(e) for e in glob], "categories": QA_CATEGORIES}


@router.post("/projects/{pid}/qa")
def add_qa(pid: str, body: QAIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "reviewer")
    if body.category not in QA_CATEGORIES:
        raise HTTPException(400, "unknown category")
    return ser(qa(db, pid, body.category, body.title, body.detail, {}, user.id, body.is_lesson))


class QAPatch(BaseModel):
    is_lesson: bool | None = None
    active: bool | None = None


@router.patch("/projects/{pid}/qa/{qid}")
def patch_qa(pid: str, qid: str, body: QAPatch, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "reviewer")
    e = db.query(QALogEntry).filter_by(id=qid, project_id=pid).first()
    if not e:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(e, k, v)
    db.commit()
    return ser(e)


@router.post("/qa/global")
def add_global_rule(body: QAIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return ser(qa(db, None, "lesson", body.title, body.detail, {}, admin.id, True, scope="global"))


@router.patch("/qa/global/{qid}")
def patch_global_rule(qid: str, body: QAPatch, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    e = db.query(QALogEntry).filter_by(id=qid, scope="global").first()
    if not e:
        raise HTTPException(404)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(e, k, v)
    db.commit()
    return ser(e)


# ---- audit & export ----------------------------------------------------------------------------
@router.get("/projects/{pid}/audit")
def project_audit(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    ev = db.query(AuditEvent).filter_by(project_id=pid).order_by(AuditEvent.created_at.desc()).limit(500).all()
    calls = db.query(ProviderCall).filter_by(project_id=pid).order_by(ProviderCall.created_at.desc()).limit(200).all()
    users = {u.id: u.email for u in db.query(User)}
    return {"events": [{**ser(e), "user": users.get(e.user_id)} for e in ev],
            "provider_calls": [{**ser(c), "user": users.get(c.user_id)} for c in calls]}


@router.get("/projects/{pid}/export")
def export_project(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid)
    q = lambda M: [ser(x) for x in db.query(M).filter_by(project_id=pid)]  # noqa: E731
    gens = db.query(Generation).filter_by(project_id=pid).all()
    bundle = {
        "format": "ossa-image-synth-export/1", "exported_at": now().isoformat() + "Z", "exported_by": user.email,
        "note": "Contains no credentials. Provider API keys are server-side only.",
        "project": ser(p), "documents": [ser(d, exclude={"text_excerpt"}) for d in db.query(Document).filter_by(project_id=pid)],
        "records": q(Record), "source_images": q(SourceImage), "masks": q(Mask), "edit_requests": q(EditRequest),
        "jobs": q(Job), "generations": [ser(g) for g in gens], "qa_log": q(QALogEntry),
        "audit": q(AuditEvent), "provider_calls": q(ProviderCall),
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(bundle, indent=2, default=str))
        for g in gens:
            if g.status == "approved":
                z.write(storage.resolve(pid, g.final_path), f"approved/{g.id}_v{g.version}.png")
    audit(db, pid, user.id, "project.export", pid)
    safe = "".join(c if c.isalnum() else "_" for c in (p.code or p.name))[:40]
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{safe}_image_synth_export.zip"'})
