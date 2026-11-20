"""Background job queue (DB-backed, in-process worker threads with a concurrency limit).

Jobs survive restarts as records; a job that was running when the server stopped is marked failed
("interrupted") rather than silently retried, so no provider call is repeated without consent.
"""
from __future__ import annotations

import io
import threading
import time
import traceback

import numpy as np
from PIL import Image

from . import imaging, storage, validation
from .audit import audit, qa
from .config import settings
from .db import SessionLocal, session_scope
from .models import EditRequest, Generation, Job, Mask, Project, SourceImage, now
from .oscillator import engine
from .oscillator.providers.base import ProviderError, UnsupportedOperation

_sem = None
_stop = threading.Event()
_threads: list[threading.Thread] = []


def _set(job_id: str, **kw):
    with session_scope() as db:
        j = db.get(Job, job_id)
        for k, v in kw.items():
            setattr(j, k, v)


def load_region(db, er: EditRequest, src: SourceImage) -> tuple[np.ndarray, np.ndarray | None]:
    size = (src.width, src.height)
    edit = prot = None
    if er.edit_mask_id:
        m = db.get(Mask, er.edit_mask_id)
        if m.project_id != er.project_id or m.source_image_id != src.id:
            raise PermissionError("edit mask does not belong to this project/image")
        edit = imaging.load_mask(storage.read(er.project_id, m.storage_path), size)
    if er.protected_mask_id:
        m = db.get(Mask, er.protected_mask_id)
        if m.project_id != er.project_id or m.source_image_id != src.id:
            raise PermissionError("protected mask does not belong to this project/image")
        prot = imaging.load_mask(storage.read(er.project_id, m.storage_path), size)
    region = imaging.effective_edit_region(size, edit, prot, er.scope)
    return region, prot


def run_image_edit(job_id: str, adapter_override=None):
    with SessionLocal() as db:
        job = db.get(Job, job_id)
        er = db.get(EditRequest, job.edit_request_id)
        src = db.get(SourceImage, er.source_image_id)
        project = db.get(Project, job.project_id)
        entry = next((e for e in engine.load_registry()["models"]
                      if e["provider"] == job.provider and e["model"] == job.model), None)
        if entry is None:
            raise ProviderError(f"{job.provider}/{job.model} is no longer in the capability registry")
        src_bytes = storage.read(project.id, src.storage_path)
        if storage.sha256_bytes(src_bytes) != src.sha256:
            raise ProviderError("Source image hash mismatch — refusing to run on a modified source")
        src_img = imaging.load_rgb(src_bytes)
        region, prot = load_region(db, er, src)
        if not region.any():
            raise ProviderError("The effective edit region is empty (mask minus protected areas)")
        prompt = job.prompt
        params = dict(job.params or {})
    _set(job_id, progress=15, message="Preparing image and mask for provider")
    prep = imaging.prepare_for_provider(src_img, region, entry.get("output_sizes") or ["1024x1024"])
    recorder = engine.make_recorder(session_scope, project_id=job.project_id, job_id=job_id, user_id=job.created_by,
                                    provider=job.provider)
    ad = adapter_override or engine.adapter(job.provider, recorder=recorder)
    if adapter_override is not None and getattr(ad, "recorder", None) is None:
        ad.recorder = recorder
    _set(job_id, progress=30, message=f"Calling {job.provider}/{job.model}")
    fidelity = "high" if entry.get("supports_input_fidelity") and params.get("input_fidelity", True) else None
    result = ad.image_edit(model=job.model, image_png=prep.image_png, mask_png=prep.mask_png, prompt=prompt,
                           size=prep.size_label, quality=params.get("quality"), input_fidelity=fidelity)
    _set(job_id, progress=75, message="Restoring geometry and compositing")
    try:
        with Image.open(io.BytesIO(result.image_bytes)) as im:
            gen_img = im.convert("RGB").copy()
    except Exception as e:
        raise ProviderError(f"Provider returned data that is not a valid image: {e}") from e
    raw_rel, _ = storage.write_new(job.project_id, "raw", result.image_bytes, "png")
    restored = imaging.restore_from_provider(gen_img, prep, src_img.size)
    use_comp = bool(er.composite)
    final = imaging.composite(src_img, restored, region, params.get("feather_px", 1.5)) if use_comp else restored
    final_rel, _ = storage.write_new(job.project_id, "outputs", imaging.to_png(final), "png")
    with session_scope() as db:
        src = db.get(SourceImage, src.id)
        ok_hash = storage.sha256_file(storage.resolve(job.project_id, src.storage_path)) == src.sha256
        report = validation.run_checks(src_img, final, region, prot, use_comp, ok_hash)
        report["prepared"] = {"provider_size": prep.size_label, "scale": prep.scale, "pad": prep.pad}
        report["usage"] = result.usage
        er = db.get(EditRequest, er.id)
        version = db.query(Generation).filter_by(edit_request_id=er.id).count() + 1
        g = Generation(project_id=job.project_id, job_id=job_id, edit_request_id=er.id, source_image_id=src.id,
                       version=version, raw_path=raw_rel, final_path=final_rel, composited=use_comp,
                       width=final.width, height=final.height, validation=report,
                       checklist=validation.build_checklist(er.analysis or {}))
        db.add(g)
        p = db.get(Project, job.project_id)
        j = db.get(Job, job_id)
        j.actual_cost = j.estimated_cost  # provider does not return a price; usage is stored for reconciliation
        p.spent_usd = round((p.spent_usd or 0) + j.actual_cost, 4)
        db.flush()
        gid = g.id
    if not report["automated_passed"]:
        with session_scope() as db:
            failed = [c["label"] for c in report["checks"] if c["blocking"] and not c["passed"]]
            cat = "unauthorized_edit" if any("outside" in c["id"] or c["id"] == "protected" for c in report["checks"]
                                             if c["blocking"] and not c["passed"]) else "failed_generation"
            qa(db, job.project_id, cat, f"Automated checks failed for output v{version}", "; ".join(failed),
               {"generation_id": gid, "job_id": job_id, "model": job.model})
    _set(job_id, status="succeeded", progress=100, message="Output ready for review", finished_at=now())


def execute(job_id: str, adapter_override=None):
    _set(job_id, status="running", started_at=now(), progress=5, message="Started")
    try:
        with SessionLocal() as db:
            kind = db.get(Job, job_id).kind
        if kind == "image_edit":
            run_image_edit(job_id, adapter_override)
        else:
            raise UnsupportedOperation(f"Unknown job kind {kind}")
    except Exception as e:
        msg = str(e) if isinstance(e, (ProviderError, PermissionError, ValueError)) else f"{type(e).__name__}: {e}"
        _set(job_id, status="failed", error=msg, message="Failed — no output was produced", finished_at=now())
        with session_scope() as db:
            j = db.get(Job, job_id)
            qa(db, j.project_id, "failed_generation", f"Job failed ({j.provider}/{j.model})", msg,
               {"job_id": job_id, "model": j.model})
            audit(db, j.project_id, j.created_by, "job.failed", job_id, {"error": msg})
        if not isinstance(e, (ProviderError, PermissionError, ValueError)):
            traceback.print_exc()


def _worker():
    while not _stop.is_set():
        job_id = None
        with session_scope() as db:
            j = db.query(Job).filter_by(status="queued").order_by(Job.created_at).first()
            if j:
                # Atomic claim so two workers never run the same job.
                claimed = db.query(Job).filter_by(id=j.id, status="queued").update({"status": "running", "started_at": now()})
                job_id = j.id if claimed == 1 else None
        if not job_id:
            _stop.wait(0.5)
            continue
        execute(job_id)


def recover_interrupted():
    with session_scope() as db:
        for j in db.query(Job).filter(Job.status == "running").all():
            j.status = "failed"
            j.error = "Interrupted by server restart. Not retried automatically; start a new run to try again."
            j.finished_at = now()


def start_workers():
    recover_interrupted()
    _stop.clear()
    for i in range(max(1, settings.max_concurrent_jobs)):
        t = threading.Thread(target=_worker, name=f"job-worker-{i}", daemon=True)
        t.start()
        _threads.append(t)


def stop_workers():
    _stop.set()
    for t in _threads:
        t.join(timeout=2)
    _threads.clear()


def wait_for(job_id: str, timeout: float = 30) -> str:
    end = time.time() + timeout
    while time.time() < end:
        with SessionLocal() as db:
            s = db.get(Job, job_id).status
        if s in ("succeeded", "failed", "cancelled"):
            return s
        time.sleep(0.1)
    return "timeout"
