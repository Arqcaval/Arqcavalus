"""Oscillator: capability registry, provider discovery, compatibility checks and model selection."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import settings
from ..models import Generation, Job, ProviderCall
from .providers.base import ProviderAdapter, ProviderError
from .providers.openai_adapter import OpenAIAdapter

DEFAULT_REGISTRY = Path(__file__).with_name("registry.json")
DISCOVERY_TTL_S = 600

_discovery: dict[str, dict] = {}
_lock = threading.Lock()
_adapter_factories: dict[str, callable] = {"openai": lambda recorder=None: OpenAIAdapter(recorder=recorder)}


def register_adapter(name: str, factory) -> None:
    """Extension point for additional providers (e.g. a future Google/Stability adapter)."""
    _adapter_factories[name] = factory


def adapter(name: str, recorder=None) -> ProviderAdapter:
    if name not in _adapter_factories:
        raise ProviderError(f"Unknown provider '{name}'")
    return _adapter_factories[name](recorder=recorder)


def providers() -> list[str]:
    return list(_adapter_factories)


def registry_path() -> Path:
    return settings.data_dir / "capability_registry.json"


def load_registry() -> dict:
    p = registry_path()
    if p.exists():
        return json.loads(p.read_text())
    return json.loads(DEFAULT_REGISTRY.read_text())


def save_registry(reg: dict) -> None:
    if not isinstance(reg.get("models"), list):
        raise ValueError("registry must contain a 'models' list")
    for m in reg["models"]:
        for k in ("provider", "model", "operations", "score"):
            if k not in m:
                raise ValueError(f"registry entry missing '{k}': {m}")
    registry_path().parent.mkdir(parents=True, exist_ok=True)
    registry_path().write_text(json.dumps(reg, indent=2))


def reset_discovery():
    with _lock:
        _discovery.clear()


def make_recorder(db_factory, project_id=None, job_id=None, user_id=None, provider="openai"):
    def rec(operation, endpoint, model, req, status, resp, ms):
        with db_factory() as db:
            db.add(ProviderCall(project_id=project_id, job_id=job_id, user_id=user_id, provider=provider, model=model,
                                operation=operation, endpoint=endpoint, request_summary=req, response_status=status,
                                response_summary=resp, duration_ms=ms))
    return rec


def discover(provider: str, force: bool = False, recorder=None) -> dict:
    with _lock:
        cached = _discovery.get(provider)
        if cached and not force and time.time() - cached["at"] < DISCOVERY_TTL_S:
            return cached
    a = adapter(provider, recorder=recorder)
    res = {"provider": provider, "label": a.label, "configured": a.configured(), "models": [], "error": "",
           "hint": a.credential_hint(), "at": time.time()}
    if not a.configured():
        res["error"] = "Credentials not configured"
    else:
        try:
            res["models"] = a.list_models()
        except ProviderError as e:
            res["error"] = str(e)
    with _lock:
        _discovery[provider] = res
    return res


def estimate_cost(entry: dict, quality: str | None) -> float:
    table = entry.get("cost_per_image_usd") or {}
    if not table:
        return 0.0
    if quality and quality in table:
        return float(table[quality])
    return float(max(table.values()))


def compatibility(entry: dict, operation: str, src_meta: dict, needs_mask: bool) -> list[str]:
    """Return a list of reasons the model cannot perform the operation (empty = compatible)."""
    reasons = []
    if operation not in entry.get("operations", []):
        reasons.append(f"does not support '{operation}' (supports: {', '.join(entry.get('operations', [])) or 'nothing'})")
    if operation == "image_edit":
        if needs_mask and not entry.get("supports_mask"):
            reasons.append("cannot accept an edit mask, which local edits require")
        if entry.get("requires_square") and src_meta and src_meta.get("width") != src_meta.get("height"):
            reasons.append(f"requires a square source image (source is {src_meta.get('width')}×{src_meta.get('height')}); "
                           "padding to square would be needed and is not enabled")
        fmt = (src_meta or {}).get("format")
        if fmt and entry.get("input_formats") and fmt not in entry["input_formats"] and "png" not in entry["input_formats"]:
            reasons.append(f"input format {fmt} not accepted")
    return reasons


def project_adjustment(db: Session, project_id: str, provider: str, model: str) -> tuple[float, str]:
    """Project-specific learning signal from recorded decisions (transparent, bounded)."""
    rows = (db.query(Generation.status).join(Job, Job.id == Generation.job_id)
            .filter(Generation.project_id == project_id, Job.provider == provider, Job.model == model).all())
    approved = sum(1 for (s,) in rows if s == "approved")
    rejected = sum(1 for (s,) in rows if s == "rejected")
    failed = db.query(Job).filter_by(project_id=project_id, provider=provider, model=model, status="failed").count()
    adj = max(-20.0, min(10.0, 2.0 * approved - 4.0 * rejected - 1.0 * failed))
    return adj, f"project history: {approved} approved, {rejected} rejected, {failed} failed → {adj:+.0f}"


def candidates(db: Session, project_id: str, operation: str, src_meta: dict, needs_mask: bool, quality: str | None,
               discover_fn=discover) -> list[dict]:
    reg = load_registry()
    disc = {p: discover_fn(p) for p in providers()}
    out = []
    for e in reg["models"]:
        p = e["provider"]
        d = disc.get(p)
        row = {"provider": p, "model": e["model"], "label": e.get("label", e["model"]), "registry_score": e["score"],
               "operations": e.get("operations", []), "notes": e.get("notes", ""), "available": False, "compatible": False,
               "reasons": []}
        if d is None:
            row["reasons"].append(f"no adapter for provider '{p}'")
        elif not d["configured"]:
            row["reasons"].append(f"{p}: credentials not configured")
        elif d["error"]:
            row["reasons"].append(f"{p}: discovery failed — {d['error']}")
        elif e["model"] not in d["models"]:
            row["reasons"].append("not available to the configured API key (not returned by model discovery)")
        else:
            row["available"] = True
        incompat = compatibility(e, operation, src_meta, needs_mask)
        row["reasons"] += incompat
        row["compatible"] = row["available"] and not incompat
        q = quality if quality in (e.get("quality_levels") or []) else ((e.get("quality_levels") or [None])[-1])
        row["quality"] = q
        row["estimated_cost_usd"] = estimate_cost(e, q)
        if row["estimated_cost_usd"] > settings.max_cost_per_job_usd:
            row["reasons"].append(f"estimated cost ${row['estimated_cost_usd']:.2f} exceeds per-job cap ${settings.max_cost_per_job_usd:.2f}")
            row["compatible"] = False
        adj, why = project_adjustment(db, project_id, p, e["model"])
        row["adjustment"] = adj
        row["adjustment_reason"] = why
        row["final_score"] = e["score"] + adj
        row["entry"] = e
        out.append(row)
    # Discovered but unregistered models: identified, never selected automatically.
    registered = {(e["provider"], e["model"]) for e in reg["models"]}
    for p, d in disc.items():
        for m in d.get("models", []):
            if (p, m) not in registered and any(k in m for k in ("image", "dall-e")):
                out.append({"provider": p, "model": m, "label": m, "registry_score": None, "available": True,
                            "compatible": False, "operations": [], "notes": "",
                            "reasons": ["discovered but not in the capability registry — capabilities unknown; an administrator must register it before use"],
                            "final_score": None, "estimated_cost_usd": None, "entry": None})
    return out


def select(db: Session, project_id: str, mode: str, operation: str, src_meta: dict, needs_mask: bool,
           quality: str | None, manual: dict | None = None, discover_fn=discover) -> dict:
    cands = candidates(db, project_id, operation, src_meta, needs_mask, quality, discover_fn)
    public = [{k: v for k, v in c.items() if k != "entry"} for c in cands]
    if mode == "manual":
        manual = manual or {}
        match = next((c for c in cands if c["provider"] == manual.get("provider") and c["model"] == manual.get("model")), None)
        if not match:
            return {"ok": False, "mode": mode, "candidates": public,
                    "error": f"Manually selected model {manual.get('provider')}/{manual.get('model')} is not in the capability registry."}
        if not match["compatible"]:
            alts = sorted([c for c in cands if c["compatible"]], key=lambda c: -c["final_score"])
            return {"ok": False, "mode": mode, "candidates": public,
                    "error": f"{match['model']} cannot run this job: " + "; ".join(match["reasons"]),
                    "suggested_alternative": ({"provider": alts[0]["provider"], "model": alts[0]["model"]} if alts else None),
                    "note": "Image Synth will not switch models automatically. Select the alternative explicitly to approve the switch."}
        return {"ok": True, "mode": mode, "provider": match["provider"], "model": match["model"], "entry": match["entry"],
                "quality": match["quality"], "estimated_cost_usd": match["estimated_cost_usd"], "candidates": public,
                "rationale": f"Manually selected {match['label']}."}
    compat = sorted([c for c in cands if c["compatible"]], key=lambda c: -c["final_score"])
    if not compat:
        return {"ok": False, "mode": "auto", "candidates": public,
                "error": "No available model can perform this operation with the current credentials and constraints."}
    best = compat[0]
    return {"ok": True, "mode": "auto", "provider": best["provider"], "model": best["model"], "entry": best["entry"],
            "quality": best["quality"], "estimated_cost_usd": best["estimated_cost_usd"], "candidates": public,
            "rationale": (f"AUTO BEST selected {best['label']}: highest final score {best['final_score']:.0f} "
                          f"(registry {best['registry_score']}, {best['adjustment_reason']}) among {len(compat)} compatible model(s). "
                          "Ranking uses the evaluation registry, not release date.")}
