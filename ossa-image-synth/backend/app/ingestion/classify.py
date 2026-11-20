"""Rule-based document classifier with explicit evidence.

Classification is a *proposal*: it is shown to the user with the evidence that produced it and can be
overridden manually (classification_source = "manual").
"""
from __future__ import annotations

import re

from .extract import Extracted

DOC_TYPES = {
    "finish_schedule": "Finish schedule / material specification",
    "equipment_schedule": "Equipment schedule",
    "equipment_plan": "Equipment / food service plan",
    "cut_sheet": "Manufacturer cut sheet / installation document",
    "architectural_drawing": "Architectural drawing (plan / elevation / section)",
    "project_description": "Project description / metadata",
    "specification": "Written specification",
    "design_direction": "Design direction / visual intent",
    "source_image": "Source render (e.g. Enscape)",
    "reference_image": "Reference image (not a source render)",
    "cad_unsupported": "CAD model (not parsed)",
    "unknown": "Unclassified",
}

# Which modules each document type feeds.
TYPE_MODULES = {
    "finish_schedule": ["N02"],
    "equipment_schedule": ["N03"],
    "equipment_plan": ["N03", "N01"],
    "cut_sheet": ["N03"],
    "architectural_drawing": ["N01"],
    "project_description": ["N01"],
    "specification": ["N02", "N01"],
    "design_direction": ["N04"],
    "source_image": ["N05"],
    "reference_image": ["N04"],
    "cad_unsupported": [],
    "unknown": [],
}

KEYWORDS = {
    "finish_schedule": [r"finish schedule", r"finish legend", r"material schedule", r"\bsherwin[- ]williams\b", r"\bformica\b",
                        r"\bwilsonart\b", r"\bbenjamin moore\b", r"\beverform\b", r"\blaminate\b", r"\bsolid surface\b",
                        r"\bSW ?\d{4}\b", r"\beggshell\b", r"\bfinish code\b", r"\bpaint\b"],
    "equipment_schedule": [r"equipment schedule", r"food ?service equipment", r"\bitem (no|#)", r"\bqty\b", r"\bmodel\b",
                           r"\bmfr\b", r"\bmanufacturer\b", r"\bfryer\b", r"\brefrigerat", r"\bice machine\b", r"\bfreezer\b",
                           r"\bkw\b|\bvolts?\b|\bamps?\b"],
    "equipment_plan": [r"equipment plan", r"food ?service plan", r"kitchen equipment plan", r"\bFS-?\d"],
    "cut_sheet": [r"cut sheet", r"specification sheet", r"installation (instructions|manual)", r"\bdimensions?\b.*\b(in|mm)\b",
                  r"\bwarranty\b"],
    "architectural_drawing": [r"floor plan", r"\belevation\b", r"\bsection\b", r"reflected ceiling plan", r"\bscale\s*:",
                              r"\bsheet\b", r"\b[A-Z]-?\d{3}\b", r"\bdetail\b"],
    "project_description": [r"\bproject (name|description|number)\b", r"\bclient\b", r"\bowner\b", r"\bscope\b",
                            r"\baddress\b", r"\barchitect\b"],
    "specification": [r"\bsection \d{2} ?\d{2} ?\d{2}\b", r"\bpart [123]\b", r"\bsubmittals?\b", r"\bexecution\b"],
    "design_direction": [r"design direction", r"visual intent", r"\bmood\b", r"render(ing)? notes", r"\bvisualization\b"],
}

NAME_HINTS = {
    "finish_schedule": ["finish", "material", "fin_sch", "finishes"],
    "equipment_schedule": ["equipment schedule", "equip_sch", "eq schedule", "equipment_schedule", "fses"],
    "equipment_plan": ["equipment plan", "equip_plan", "fs plan", "equipment_plan", "kitchen plan"],
    "cut_sheet": ["cut sheet", "cutsheet", "spec sheet", "install"],
    "architectural_drawing": ["plan", "elevation", "section", "rcp", "drawing", "sheet"],
    "project_description": ["description", "project info", "brief", "narrative", "metadata"],
    "design_direction": ["direction", "intent", "notes"],
    "source_image": ["enscape", "render", "view", "camera", "vis", "persp"],
}


def _count(patterns: list[str], text: str) -> tuple[int, list[str]]:
    hits, ev = 0, []
    for p in patterns:
        m = re.findall(p, text, flags=re.I)
        if m:
            hits += min(len(m), 5)
            ev.append(f"matched '{p}' ×{len(m)}")
    return hits, ev


def classify(filename: str, ext: str, ex: Extracted) -> tuple[str, float, list[str]]:
    name = filename.lower()
    if ex.kind == "cad":
        return "cad_unsupported", 1.0, [ex.unsupported]
    if ex.kind == "image":
        for t in ("architectural_drawing", "equipment_plan"):
            for h in NAME_HINTS[t]:
                if h in name and not any(s in name for s in NAME_HINTS["source_image"]):
                    return t if t != "equipment_plan" else "equipment_plan", 0.55, [f"image filename contains '{h}'"]
        hint = next((h for h in NAME_HINTS["source_image"] if h in name), None)
        ev = [f"raster image {ex.image['width']}×{ex.image['height']}"]
        if hint:
            ev.append(f"filename contains '{hint}'")
            return "source_image", 0.85, ev
        ev.append("raster image without render keywords in name; please confirm it is an authorised source render")
        return "source_image", 0.5, ev

    text = ex.full_text[:200_000]
    scores: dict[str, float] = {}
    evidence: dict[str, list[str]] = {}
    for t, pats in KEYWORDS.items():
        n, ev = _count(pats, text)
        score = float(n)
        for h in NAME_HINTS.get(t, []):
            if h in name:
                score += 4
                ev.append(f"filename contains '{h}'")
        if t == "finish_schedule":
            codes = re.findall(r"(?m)^\s*\"?(P|PT|PL|SS|WCP|ACT|CPT|CT|PT|RB|ST|QZ|LVT|WD|MTL|GL)-?\d{1,3}\b", text)
            if codes:
                score += min(len(codes), 10) * 1.5
                ev.append(f"{len(codes)} finish-code rows (e.g. {codes[0]}…)")
        scores[t] = score
        evidence[t] = ev
    # Tabular equipment vs plan disambiguation: schedules are tabular.
    if ex.kind == "table":
        scores["equipment_plan"] *= 0.3
        scores["architectural_drawing"] *= 0.3
    best = max(scores, key=scores.get)
    total = sum(scores.values()) or 1.0
    if scores[best] < 2:
        return "unknown", 0.0, ["no strong indicators found; classify manually"]
    conf = round(min(0.95, scores[best] / total + 0.15), 2)
    return best, conf, evidence[best][:8]
