from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from .. import imaging, modules, storage
from ..audit import audit
from ..config import settings
from ..db import get_db, session_scope
from ..models import EditRequest, Job, Project, Record, SourceImage, User
from ..oscillator import engine
from ..oscillator.providers.base import ProviderError
from ..security import current_user, get_project_for, require_admin
from ..serialize import ser

router = APIRouter(prefix="/api", tags=["oscillator"])


@router.get("/oscillator/providers")
def provider_status(refresh: bool = False, user: User = Depends(current_user)):
    out = []
    for p in engine.providers():
        d = engine.discover(p, force=refresh, recorder=engine.make_recorder(session_scope, user_id=user.id, provider=p))
        out.append({k: v for k, v in d.items() if k != "at"})
    return {"providers": out, "limits": {"max_cost_per_job_usd": settings.max_cost_per_job_usd,
                                         "max_concurrent_jobs": settings.max_concurrent_jobs}}


@router.get("/oscillator/registry")
def get_registry(_: User = Depends(current_user)):
    return engine.load_registry()


@router.put("/oscillator/registry")
def put_registry(reg: dict, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    try:
        engine.save_registry(reg)
    except ValueError as e:
        raise HTTPException(400, str(e))
    audit(db, None, admin.id, "registry.update", "", {"models": [f"{m['provider']}/{m['model']}" for m in reg["models"]]})
    return engine.load_registry()


class OscIn(BaseModel):
    mode: str = "auto"
    manual_provider: str | None = None
    manual_model: str | None = None
    quality: str | None = "high"
    input_fidelity: bool = True


@router.get("/projects/{pid}/oscillator")
def get_osc(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid)
    return p.oscillator or {"mode": "auto"}


@router.put("/projects/{pid}/oscillator")
def put_osc(pid: str, body: OscIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid, "editor")
    if body.mode not in ("auto", "manual"):
        raise HTTPException(400, "mode must be auto or manual")
    old = dict(p.oscillator or {})
    p.oscillator = body.model_dump()
    db.commit()
    audit(db, pid, user.id, "oscillator.settings", pid, {"from": old, "to": p.oscillator})
    return p.oscillator


def _src_meta(src: SourceImage) -> dict:
    return {"width": src.width, "height": src.height, "format": "png"}


def plan(db: Session, p: Project, er: EditRequest) -> dict:
    gate = modules.execution_gate(db, p, er)
    src = db.get(SourceImage, er.source_image_id)
    osc = p.oscillator or {}
    sel = engine.select(db, p.id, osc.get("mode", "auto"), "image_edit", _src_meta(src), needs_mask=er.scope == "local",
                        quality=osc.get("quality"),
                        manual={"provider": osc.get("manual_provider"), "model": osc.get("manual_model")})
    budget_left = round(p.budget_usd - p.spent_usd, 4)
    cost = sel.get("estimated_cost_usd") or 0
    budget_ok = cost <= budget_left
    issues = []
    if not budget_ok:
        issues.append(f"Estimated cost ${cost:.2f} exceeds remaining project budget ${budget_left:.2f}")
    if er.status != "approved":
        issues.append("The edit request has not been approved")
    sel_public = {k: v for k, v in sel.items() if k != "entry"}
    return {"gate": gate, "selection": sel_public, "budget_remaining_usd": budget_left, "issues": issues,
            "prompt": (er.analysis or {}).get("prompt", ""), "composite": er.composite, "scope": er.scope,
            "ready": gate["ok"] and sel["ok"] and budget_ok and er.status == "approved"}


class PlanIn(BaseModel):
    edit_request_id: str


@router.post("/projects/{pid}/oscillator/plan")
def plan_route(pid: str, body: PlanIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid)
    er = db.query(EditRequest).filter_by(id=body.edit_request_id, project_id=pid).first()
    if not er:
        raise HTTPException(404, "Edit request not found")
    return plan(db, p, er)


class JobIn(BaseModel):
    edit_request_id: str
    confirm_estimated_cost_usd: float
    parent_generation_id: str | None = None


@router.post("/projects/{pid}/jobs")
def create_job(pid: str, body: JobIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid, "editor")
    er = db.query(EditRequest).filter_by(id=body.edit_request_id, project_id=pid).first()
    if not er:
        raise HTTPException(404, "Edit request not found")
    pl = plan(db, p, er)
    if not pl["ready"]:
        audit(db, pid, user.id, "job.blocked", er.id, {"gate": pl["gate"]["blockers"], "selection_error": pl["selection"].get("error"),
                                                       "issues": pl["issues"]})
        raise HTTPException(409, {"message": "Execution blocked", "plan": pl})
    sel = pl["selection"]
    if abs(body.confirm_estimated_cost_usd - (sel["estimated_cost_usd"] or 0)) > 1e-6:
        raise HTTPException(409, {"message": "Cost estimate changed; review and confirm again", "plan": pl})
    if db.query(Job).filter(Job.project_id == pid, Job.status.in_(["queued", "running"])).count() >= settings.max_concurrent_jobs:
        raise HTTPException(429, "Too many concurrent jobs for this project; wait for running jobs to finish")
    osc = p.oscillator or {}
    j = Job(project_id=pid, edit_request_id=er.id, parent_generation_id=body.parent_generation_id, provider=sel["provider"],
            model=sel["model"], selection_mode=sel["mode"],
            selection={"rationale": sel["rationale"], "candidates": sel["candidates"]},
            params={"quality": sel["quality"], "input_fidelity": osc.get("input_fidelity", True), "feather_px": 1.5},
            prompt=pl["prompt"], estimated_cost=sel["estimated_cost_usd"] or 0, created_by=user.id, message="Queued")
    db.add(j)
    db.commit()
    audit(db, pid, user.id, "job.create", j.id, {"provider": j.provider, "model": j.model, "mode": j.selection_mode,
                                                 "estimated_cost": j.estimated_cost})
    return ser(j)


@router.get("/projects/{pid}/jobs")
def list_jobs(pid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    return [ser(j) for j in db.query(Job).filter_by(project_id=pid).order_by(Job.created_at.desc()).limit(100)]


@router.get("/projects/{pid}/jobs/{jid}")
def get_job(pid: str, jid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid)
    j = db.query(Job).filter_by(id=jid, project_id=pid).first()
    if not j:
        raise HTTPException(404)
    return ser(j)


@router.post("/projects/{pid}/jobs/{jid}/cancel")
def cancel_job(pid: str, jid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    get_project_for(db, user, pid, "editor")
    n = db.query(Job).filter_by(id=jid, project_id=pid, status="queued").update({"status": "cancelled", "message": "Cancelled"})
    db.commit()
    if not n:
        raise HTTPException(409, "Only queued jobs can be cancelled (running provider calls cannot be recalled)")
    return {"ok": True}


ANALYSIS_PROMPT = ("You are assisting an architectural visualization QA review. List the visible surfaces and objects in this "
                   "render as short bullet points (surface, apparent material, apparent colour). Mark every item as an "
                   "observation, not a specification. Do not guess product names. Note any areas where shadows make the "
                   "material ambiguous.")


@router.post("/projects/{pid}/images/{iid}/analyze")
def analyze_image(pid: str, iid: str, db: Session = Depends(get_db), user: User = Depends(current_user)):
    p = get_project_for(db, user, pid, "editor")
    src = db.query(SourceImage).filter_by(id=iid, project_id=pid).first()
    if not src:
        raise HTTPException(404)
    osc = p.oscillator or {}
    sel = engine.select(db, pid, "auto", "image_analysis", _src_meta(src), False, None)
    if not sel["ok"]:
        raise HTTPException(409, {"message": sel["error"], "candidates": sel["candidates"]})
    img = imaging.load_rgb(storage.read(pid, src.storage_path))
    img.thumbnail((1536, 1536))
    ad = engine.adapter(sel["provider"], recorder=engine.make_recorder(session_scope, pid, None, user.id, sel["provider"]))
    try:
        text = ad.image_analysis(model=sel["model"], image_png=imaging.to_png(img), prompt=ANALYSIS_PROMPT)
    except ProviderError as e:
        raise HTTPException(502, f"Image analysis failed: {e}")
    r = Record(project_id=pid, module_key="N05", record_type="ai_observation", key=f"analysis {src.label}"[:120],
               data={"text": text, "model": f"{sel['provider']}/{sel['model']}", "image_id": iid}, status="proposed",
               origin="ai", source_ref=f"AI analysis of {src.label}", evidence="AI assumption — not a document fact",
               confidence=0.3, notes="AI observations never satisfy finish or equipment requirements.")
    db.add(r)
    db.commit()
    _ = osc
    return ser(r)
