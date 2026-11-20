"""Module definitions and readiness evaluation (NODE 01–09).

States: EMPTY | PROCESSING | NEEDS_REVIEW | VALIDATED | ERROR
A module is VALIDATED only when every *required* requirement is satisfied by approved facts.
Uploading a file never by itself validates a module.
"""
from __future__ import annotations

from sqlalchemy.orm import Session

from . import storage
from .models import Document, EditRequest, Generation, Job, Mask, ModuleMapping, Project, QALogEntry, Record, SourceImage

MODULES = {
    "N01": {"name": "Project Understanding", "critical": True,
            "inputs": "Architectural drawings, project metadata, descriptions, plans, elevations, sections"},
    "N02": {"name": "Finish Schedule Intelligence", "critical": "conditional",
            "inputs": "Finish schedules, material specifications, manufacturer references"},
    "N03": {"name": "Equipment & Food Service Intelligence", "critical": "conditional",
            "inputs": "Equipment schedules, equipment plans, cut sheets, installation documents"},
    "N04": {"name": "Visual Intent Engine", "critical": True,
            "inputs": "User instructions, project requirements, approved design direction"},
    "N05": {"name": "Source Image Integrity", "critical": True, "inputs": "Original Enscape renders / authorised source images"},
    "N06": {"name": "Learning & QA Log", "critical": False, "inputs": "Corrections, failures, approvals, lessons"},
    "N07": {"name": "Oscillator / AI Engine", "critical": True, "inputs": "Provider credentials, capability registry"},
    "N08": {"name": "Output & Validation", "critical": False, "inputs": "Generated outputs"},
    "N09": {"name": "Document Intake & Module Mapping", "critical": False, "inputs": "All uploaded files"},
}


def _req(rid, label, ok, required=True, detail="", evidence=None):
    return {"id": rid, "label": label, "satisfied": bool(ok), "required": required, "detail": detail, "evidence": evidence or []}


def _doc_state(db: Session, project_id: str, mk: str) -> tuple[bool, bool, list[dict]]:
    maps = db.query(ModuleMapping).filter_by(project_id=project_id, module_key=mk).filter(ModuleMapping.status != "rejected").all()
    docs = [db.get(Document, m.document_id) for m in maps]
    processing = any(d and d.status in ("uploaded", "processing") for d in docs)
    error = any(d and d.status == "error" for d in docs)
    srcs = [{"document_id": d.id, "name": d.original_name, "mapping": m.status, "status": d.status}
            for m, d in zip(maps, docs) if d]
    return processing, error, srcs


def _state(reqs, has_content, processing, error, pending_review):
    if error:
        return "ERROR"
    if processing:
        return "PROCESSING"
    if not has_content:
        return "EMPTY"
    if all(r["satisfied"] for r in reqs if r["required"]) and not pending_review:
        return "VALIDATED"
    return "NEEDS_REVIEW"


def _records(db, pid, mk):
    return db.query(Record).filter_by(project_id=pid, module_key=mk).all()


def eval_n01(db, p):
    recs = _records(db, p.id, "N01")
    appr = [r for r in recs if r.status == "approved"]
    name = [r for r in appr if r.record_type == "project_info" and (r.data or {}).get("field") == "project_name"]
    rooms = [r for r in appr if r.record_type == "room"]
    sheets = [r for r in appr if r.record_type == "drawing_ref"]
    reqs = [
        _req("identity", "Project identity (name) approved", name, detail=", ".join(r.data.get("value", "") for r in name)),
        _req("rooms", "At least one room / space identified and approved", rooms, detail=f"{len(rooms)} approved"),
        _req("drawings", "Drawing references (plans/elevations/sections)", sheets, required=False, detail=f"{len(sheets)} approved"),
        _req("constraints", "Design constraints / scope reviewed", not any(r.record_type == "constraint" and r.status == "proposed" for r in recs),
             required=False),
    ]
    return reqs, recs


def eval_n02(db, p):
    recs = [r for r in _records(db, p.id, "N02") if r.record_type == "finish"]
    appr = [r for r in recs if r.status == "approved"]
    incomplete = [r.key for r in appr if not (r.data.get("product") or r.data.get("color_name")) or r.data.get("category") in (None, "", "other")]
    by_code: dict[str, set] = {}
    for r in recs:
        if r.status != "rejected":
            by_code.setdefault(r.key, set()).add((r.data.get("product") or "").strip().lower())
    conflicts = [c for c, v in by_code.items() if len(v) > 1]
    no_loc = [r.key for r in appr if not r.data.get("application") and not r.data.get("drawing_refs")]
    reqs = [
        _req("finishes", "At least one finish record approved", appr, detail=f"{len(appr)} approved of {len(recs)}"),
        _req("complete", "Each approved finish has product and material category", not incomplete and appr,
             detail=("incomplete: " + ", ".join(incomplete)) if incomplete else ""),
        _req("conflicts", "No conflicting records for the same finish code", not conflicts,
             detail=("conflicts: " + ", ".join(conflicts)) if conflicts else "",),
        _req("reviewed", "All proposed finish records reviewed", not any(r.status == "proposed" for r in recs),
             detail=f"{sum(r.status == 'proposed' for r in recs)} awaiting review"),
        _req("locations", "Application / drawing location for each finish", not no_loc, required=False,
             detail=("missing for: " + ", ".join(no_loc)) if no_loc else ""),
    ]
    return reqs, recs


def eval_n03(db, p):
    recs = _records(db, p.id, "N03")
    eq = [r for r in recs if r.record_type == "equipment"]
    appr = [r for r in eq if r.status == "approved"]
    plan_maps = (db.query(ModuleMapping).join(Document, Document.id == ModuleMapping.document_id)
                 .filter(ModuleMapping.project_id == p.id, ModuleMapping.module_key == "N03",
                         ModuleMapping.status == "accepted", Document.doc_type == "equipment_plan").count())
    unverified = [r.key for r in appr if not r.data.get("location_verified")]
    incomplete = [r.key for r in appr if not (r.data.get("manufacturer") and r.data.get("model"))]
    reqs = [
        _req("schedule", "Equipment schedule records approved", appr, detail=f"{len(appr)} approved of {len(eq)}"),
        _req("ids", "Each approved item has manufacturer and model", appr and not incomplete,
             detail=("incomplete: " + ", ".join(incomplete)) if incomplete else ""),
        _req("plan", "Equipment plan accepted for cross-checking", plan_maps > 0,
             detail="A schedule alone cannot establish locations. Upload and accept an equipment plan."),
        _req("locations", "Every approved item's location verified against the plan", appr and not unverified,
             detail=("unverified: " + ", ".join(unverified)) if unverified else ""),
        _req("reviewed", "All proposals reviewed", not any(r.status == "proposed" for r in recs),
             detail=f"{sum(r.status == 'proposed' for r in recs)} awaiting review"),
    ]
    return reqs, recs


def eval_n04(db, p, er: EditRequest | None = None):
    er = er or db.query(EditRequest).filter_by(project_id=p.id).order_by(EditRequest.created_at.desc()).first()
    if not er:
        return [_req("request", "An edit request has been described", False)], [], None
    a = er.analysis or {}
    blocks = [i for i in a.get("issues", []) if i["severity"] == "block"]
    reqs = [
        _req("request", "Edit request described and analysed", bool(a), detail=er.instruction[:120]),
        _req("no_blockers", "No blocking intent issues", not blocks, detail="; ".join(i["message"] for i in blocks)),
        _req("region", "Edit region authorised (approved mask, or authorised global edit)",
             (er.scope == "local" and er.edit_mask_id and (m := db.get(Mask, er.edit_mask_id)) and m.status == "approved")
             or (er.scope == "global" and er.global_authorized)),
        _req("approved", "Edit request approved by a user", er.status == "approved"),
    ]
    return reqs, [], er


def eval_n05(db, p):
    imgs = db.query(SourceImage).filter_by(project_id=p.id).all()
    auth = [i for i in imgs if i.status == "authorized"]
    tampered = []
    for i in auth:
        try:
            if storage.sha256_file(storage.resolve(p.id, i.storage_path)) != i.sha256:
                tampered.append(i.label)
        except Exception:
            tampered.append(i.label)
    protected = db.query(Mask).filter_by(project_id=p.id, kind="protected", status="approved").count()
    reqs = [
        _req("authorized", "At least one source image authorised", auth, detail=f"{len(auth)} authorised of {len(imgs)}"),
        _req("integrity", "Stored source files match their original SHA-256", not tampered,
             detail=("MISMATCH: " + ", ".join(tampered)) if tampered else "verified"),
        _req("protected", "Protected regions defined", protected > 0, required=False, detail=f"{protected} approved protected mask(s)"),
    ]
    return reqs, imgs, bool(tampered)


def eval_n07(db, p, discover_fn=None):
    from .oscillator import engine
    discover_fn = discover_fn or engine.discover
    reqs = []
    any_conf = False
    any_models = False
    for prov in engine.providers():
        d = discover_fn(prov)
        any_conf |= d["configured"]
        any_models |= bool(d["models"])
        reqs.append(_req(f"cred_{prov}", f"{d['label']}: credentials configured", d["configured"],
                         required=prov == "openai", detail=d["error"] or d.get("hint", "")))
    reg = engine.load_registry()
    edit_models = {(e["provider"], e["model"]) for e in reg["models"] if "image_edit" in e.get("operations", [])}
    avail = [f"{pv}/{m}" for pv in engine.providers() for m in discover_fn(pv)["models"] if (pv, m) in edit_models]
    reqs.append(_req("models", "A registered image-editing model is available", avail, detail=", ".join(avail) or "none"))
    remaining = p.budget_usd - p.spent_usd
    reqs.append(_req("budget", "Project budget remaining", remaining > 0, detail=f"${remaining:.2f} of ${p.budget_usd:.2f}"))
    any_err = any(discover_fn(pv)["configured"] and discover_fn(pv)["error"] for pv in engine.providers())
    return reqs, any_conf, any_err


def evaluate(db: Session, project: Project, discover_fn=None) -> dict:
    out = {}
    # N01–N03: document-derived
    for mk, fn in (("N01", eval_n01), ("N02", eval_n02), ("N03", eval_n03)):
        reqs, recs = fn(db, project)
        processing, error, srcs = _doc_state(db, project.id, mk)
        pending = any(r.status == "proposed" for r in recs)
        state = _state(reqs, bool(recs) or bool(srcs), processing, error, pending)
        out[mk] = {"requirements": reqs, "sources": srcs, "counts": {
            "proposed": sum(r.status == "proposed" for r in recs), "approved": sum(r.status == "approved" for r in recs),
            "rejected": sum(r.status == "rejected" for r in recs)}, "state": state}
    reqs, _, er = eval_n04(db, project)
    out["N04"] = {"requirements": reqs, "sources": [], "state": "EMPTY" if er is None else _state(reqs, True, False, False, False),
                  "edit_request_id": er.id if er else None}
    reqs, imgs, tampered = eval_n05(db, project)
    processing, error, srcs = _doc_state(db, project.id, "N05")
    out["N05"] = {"requirements": reqs, "sources": srcs, "counts": {"images": len(imgs)},
                  "state": "ERROR" if tampered or error else _state(reqs, bool(imgs), processing, False,
                                                                    any(i.status == "candidate" for i in imgs) and not any(i.status == "authorized" for i in imgs))}
    n_qa = db.query(QALogEntry).filter((QALogEntry.project_id == project.id)).count()
    n_lessons = db.query(QALogEntry).filter(QALogEntry.project_id == project.id, QALogEntry.is_lesson.is_(True)).count()
    out["N06"] = {"requirements": [_req("log", "QA history recorded", n_qa > 0, required=False, detail=f"{n_qa} entries, {n_lessons} lessons")],
                  "sources": [], "state": "VALIDATED" if n_qa else "EMPTY"}
    reqs, conf, err = eval_n07(db, project, discover_fn)
    out["N07"] = {"requirements": reqs, "sources": [], "mode": (project.oscillator or {}).get("mode", "auto"),
                  "state": "ERROR" if err else (_state(reqs, True, False, False, False) if conf else "EMPTY")}
    last_job = db.query(Job).filter_by(project_id=project.id).order_by(Job.created_at.desc()).first()
    gens = db.query(Generation).filter_by(project_id=project.id).order_by(Generation.created_at.desc()).all()
    if last_job and last_job.status in ("queued", "running"):
        s8 = "PROCESSING"
    elif last_job and last_job.status == "failed" and (not gens or gens[0].created_at < last_job.created_at):
        s8 = "ERROR"
    elif not gens:
        s8 = "EMPTY"
    elif gens[0].status == "approved":
        s8 = "VALIDATED"
    else:
        s8 = "NEEDS_REVIEW"
    out["N08"] = {"requirements": [
        _req("output", "Generated output available", bool(gens), detail=f"{len(gens)} version(s)"),
        _req("decision", "Latest output reviewed", bool(gens) and gens[0].status != "pending_review",
             detail=gens[0].status if gens else ""),
    ], "sources": [], "state": s8, "last_job_error": last_job.error if last_job and last_job.status == "failed" else ""}
    docs = db.query(Document).filter_by(project_id=project.id).all()
    maps = db.query(ModuleMapping).filter_by(project_id=project.id).all()
    unsupported = [d.original_name for d in docs if d.status == "unsupported"]
    s9 = ("EMPTY" if not docs else "PROCESSING" if any(d.status in ("uploaded", "processing") for d in docs)
          else "ERROR" if any(d.status == "error" for d in docs)
          else "NEEDS_REVIEW" if any(m.status == "proposed" for m in maps) or any(d.doc_type == "unknown" for d in docs)
          else "VALIDATED")
    out["N09"] = {"requirements": [
        _req("docs", "Documents uploaded", docs, detail=f"{len(docs)} file(s)"),
        _req("classified", "All documents classified", docs and not any(d.doc_type == "unknown" for d in docs)),
        _req("mappings", "All proposed module mappings reviewed", not any(m.status == "proposed" for m in maps),
             detail=f"{sum(m.status == 'proposed' for m in maps)} awaiting review"),
        _req("unsupported", "No unsupported files awaiting conversion", not unsupported, required=False,
             detail=", ".join(unsupported)),
    ], "sources": [], "state": s9}

    for mk, v in out.items():
        v.update({"key": mk, **MODULES[mk]})
        v["missing"] = [r["label"] + (f" — {r['detail']}" if r["detail"] else "") for r in v["requirements"]
                        if r["required"] and not r["satisfied"]]
        v["readiness"] = ("satisfied" if v["state"] == "VALIDATED" else
                          "blocked" if v["state"] in ("EMPTY", "ERROR") else "partial")
    return out


def execution_gate(db: Session, project: Project, er: EditRequest, discover_fn=None) -> dict:
    states = evaluate(db, project, discover_fn)
    reqs4, _, _ = eval_n04(db, project, er)
    n04_state = _state(reqs4, True, False, False, False)
    states["N04"] = {**states["N04"], "requirements": reqs4, "state": n04_state,
                     "missing": [r["label"] + (f" — {r['detail']}" if r["detail"] else "") for r in reqs4 if r["required"] and not r["satisfied"]]}
    required = (er.analysis or {}).get("requires_modules") or ["N01", "N04", "N05", "N07"]
    blockers = []
    for mk in required:
        if states[mk]["state"] != "VALIDATED":
            blockers.append({"module": mk, "name": MODULES[mk]["name"], "state": states[mk]["state"], "missing": states[mk]["missing"]})
    src = db.get(SourceImage, er.source_image_id)
    if not src or src.status != "authorized":
        blockers.append({"module": "N05", "name": "Source Image Integrity", "state": "BLOCKED",
                         "missing": ["The selected source image is not authorised"]})
    return {"ok": not blockers, "blockers": blockers, "required_modules": required}
