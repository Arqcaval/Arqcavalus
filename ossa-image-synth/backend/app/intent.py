"""NODE 04 – Visual Intent Engine. Deterministic interpretation of the instruction against approved
project facts. Produces categories, referenced finishes, blocking issues and the provider prompt."""
from __future__ import annotations

import re

from sqlalchemy.orm import Session

from .models import EditRequest, QALogEntry, Record

CATEGORIES = {
    "material_correction": [r"\bfinish", r"\bmaterial", r"\blaminate", r"\bpaint", r"\bcolou?r\b", r"\breplace .* with\b",
                            r"\bchange .* to\b", r"\bwood\b", r"\btile\b", r"\bveneer", r"\bsolid surface", r"\bcounter ?top",
                            r"\bbacksplash", r"\bcabinet", r"\bpanel"],
    "lighting_adjustment": [r"\blight(ing)?\b", r"\bbright", r"\bexposure", r"\bwarm(er|th)?\b", r"\bcool(er)?\b light",
                            r"\bdaylight", r"\bglow", r"\bdim\b", r"\bluminaire"],
    "equipment_presentation": [r"\bequipment", r"\bfryer", r"\bcooler\b", r"\brefrigerat", r"\boven", r"\bhood\b",
                               r"\bice machine", r"\bfreezer", r"\bgriddle", r"\bmerchandiser", r"\bstainless"],
    "object_addition": [r"\badd(ing)?\b", r"\binsert", r"\bplace (a|an|some)\b", r"\binclude (a|an|some)\b", r"\bplants?\b",
                        r"\bpeople\b", r"\bdecor", r"\bflowers?\b", r"\bartwork"],
    "global_improvement": [r"\boverall\b", r"\bentire (image|scene|render)", r"\bwhole (image|scene)", r"\bphotoreal",
                           r"\brealism\b", r"\benhance\b", r"\bimage quality"],
}
GEOMETRY = [r"\bmove\b", r"\brelocate", r"\bresize", r"\benlarge", r"\bshrink", r"\bwiden", r"\bnarrow", r"\bextend",
            r"\breshape", r"\bremove (the )?(wall|column|window|door|opening|ceiling)", r"\braise the ceiling",
            r"\blower the ceiling", r"\bchange (the )?(camera|perspective|angle|view)", r"\brotate"]

GLOBAL_RULES = [
    "Preserve camera position, focal length, perspective and framing exactly.",
    "Preserve all architecture and geometry: walls, openings, glazing, millwork profiles, ceiling and floor patterns, material joint layouts.",
    "Do not move, add, remove or restyle equipment.",
    "Do not change shadows or reflections outside the edit region.",
    "A change of material colour is not a change of geometry.",
    "Do not interpret a shadow as a different material.",
]


def _active_lessons(db: Session, project_id: str) -> list[QALogEntry]:
    return (db.query(QALogEntry)
            .filter(QALogEntry.is_lesson.is_(True), QALogEntry.active.is_(True))
            .filter((QALogEntry.project_id == project_id) | (QALogEntry.scope == "global"))
            .order_by(QALogEntry.created_at).all())


def analyze(db: Session, er: EditRequest) -> dict:
    text = er.instruction or ""
    low = text.lower()
    cats = [c for c, pats in CATEGORIES.items() if any(re.search(p, low) for p in pats)]
    issues: list[dict] = []
    geom = [p for p in GEOMETRY if re.search(p, low)]
    if geom:
        issues.append({"severity": "block", "code": "geometry_change",
                       "message": "The instruction asks for a geometric change (move/resize/remodel/camera). Image Synth only edits "
                                  "appearance inside an authorised mask. Change the model and re-render in Enscape instead."})
    if "object_addition" in cats and not er.allow_object_additions:
        issues.append({"severity": "block", "code": "object_addition",
                       "message": "The instruction appears to add objects. Object additions require explicit approval "
                                  "(enable 'Allow object additions')."})
    if er.scope == "global" and not er.global_authorized:
        issues.append({"severity": "block", "code": "global_unauthorized",
                       "message": "Global edits change the whole image and must be explicitly authorised."})
    if er.scope == "local" and not er.edit_mask_id:
        issues.append({"severity": "block", "code": "mask_missing", "message": "Local edits require an explicit edit mask."})
    if not text.strip():
        issues.append({"severity": "block", "code": "empty", "message": "Describe the required modification."})
    if "lighting_adjustment" in cats and er.scope == "local":
        issues.append({"severity": "warn", "code": "lighting_local",
                       "message": "Lighting changes inside a mask can create discontinuities at the mask edge. Review the boundary."})

    finishes = {r.key.upper(): r for r in db.query(Record).filter_by(project_id=er.project_id, record_type="finish")
                if r.status != "rejected"}
    mentioned = sorted({m.upper().replace(" ", "") for m in re.findall(r"\b([A-Z]{1,4}-?\d{1,3}[A-Z]?)\b", text)})
    refs = []
    for code in mentioned:
        rec = finishes.get(code) or finishes.get(code.replace("-", ""))
        if rec is None:
            issues.append({"severity": "block", "code": "finish_unknown",
                           "message": f"Finish code {code} is not in this project's finish records."})
            refs.append({"code": code, "status": "unknown"})
        elif rec.status != "approved":
            issues.append({"severity": "block", "code": "finish_unapproved",
                           "message": f"Finish {code} exists but has not been approved. Review it in Finish Schedule Intelligence."})
            refs.append({"code": code, "status": rec.status, "record_id": rec.id})
        else:
            refs.append({"code": code, "status": "approved", "record_id": rec.id, "data": rec.data,
                         "source": rec.source_ref, "origin": rec.origin})
    if "material_correction" in cats and not mentioned:
        issues.append({"severity": "warn", "code": "finish_not_referenced",
                       "message": "A material change is requested without a finish code. Reference the scheduled code (e.g. PL2) "
                                  "so the edit is grounded in the finish schedule."})
    if not cats:
        cats = ["unclassified"]
    lessons = _active_lessons(db, er.project_id)
    prompt = build_prompt(er, refs, lessons)
    return {"categories": cats, "referenced_finishes": refs, "issues": issues,
            "blocking": any(i["severity"] == "block" for i in issues), "prompt": prompt,
            "lessons_applied": [{"id": l.id, "title": l.title, "scope": l.scope} for l in lessons],
            "requires_modules": sorted({"N01", "N04", "N05", "N07"} | ({"N02"} if refs or "material_correction" in cats else set())
                                       | ({"N03"} if "equipment_presentation" in cats else set()))}


def _finish_text(ref: dict) -> str:
    d = ref.get("data") or {}
    parts = [d.get("manufacturer", ""), d.get("product", "")]
    extra = ", ".join(x for x in [d.get("category", "").replace("_", " "), d.get("color_name", ""), d.get("texture", "")] if x)
    return f"{ref['code']}: {' '.join(p for p in parts if p).strip()}" + (f" ({extra})" if extra else "")


def build_prompt(er: EditRequest, refs: list[dict], lessons) -> str:
    lines = ["Architectural visualization edit of an existing rendered interior. The image is the authoritative source."]
    if er.scope == "local":
        lines.append("Edit ONLY the transparent (masked) region. Everything outside the mask must remain identical.")
    else:
        lines.append("Global adjustment authorised. Keep all geometry, materials and objects identical; adjust only what is requested.")
    lines.append(f"Requested change: {er.instruction.strip()}")
    approved = [r for r in refs if r.get("status") == "approved"]
    if approved:
        lines.append("Specified finishes (from the project finish schedule):")
        lines += [f"- {_finish_text(r)}" for r in approved]
        lines.append("Match the specified product's real colour and texture; keep the existing panel joints, edges and grain direction.")
    lines.append("Constraints:")
    lines += [f"- {r}" for r in GLOBAL_RULES]
    if not er.allow_object_additions:
        lines.append("- Do not add any objects, decor, people or plants.")
    if lessons:
        lines.append("Project lessons:")
        lines += [f"- {l.title}" for l in lessons[:20]]
    return "\n".join(lines)[:31000]
