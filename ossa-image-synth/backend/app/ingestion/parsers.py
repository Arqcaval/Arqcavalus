"""Module-specific extraction. Every produced record carries a source reference and the evidence text
it was derived from. Nothing here is inferred from images; finishes come only from documents."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .extract import Extracted, Table

CODE_RE = re.compile(r"^(?:[A-Z]{1,4})-?\d{1,3}[A-Z]?$")

MANUFACTURERS = [
    "Sherwin-Williams", "Benjamin Moore", "PPG", "Formica", "Wilsonart", "Pionite", "Corian", "Armstrong",
    "Daltile", "Crossville", "Mohawk", "Interface", "Shaw", "Caesarstone", "Cambria", "Silestone", "Rockfon",
    "USG", "Johnsonite", "Tarkett", "Roppe", "Hussey", "Hoshizaki", "Manitowoc", "True", "Traulsen", "Vulcan",
    "Frymaster", "Pitco", "Hobart", "Rational", "Turbochef", "Merrychef", "Scotsman", "Beverage-Air", "Perlick",
    "Krowne", "Eagle", "Advance Tabco", "Bunn", "Vollrath", "Hatco", "Delfield", "Victory", "Continental",
]
SHEEN = ["flat", "matte", "eggshell", "satin", "semi-gloss", "gloss", "low sheen", "honed", "polished", "textured",
         "suede", "natural grain", "matte 58", "plain slice"]

CATEGORY_BY_PREFIX = [
    ("WCP", "wood_paneling"), ("WP", "wood_paneling"), ("WD", "wood_paneling"), ("PLAM", "laminate"), ("PL", "laminate"),
    ("SS", "solid_surface"), ("ACT", "acoustic_ceiling"), ("CPT", "carpet"), ("LVT", "resilient_flooring"),
    ("RB", "resilient_base"), ("CT", "tile"), ("PT", "paint"), ("T", "tile"), ("ST", "stone"), ("QZ", "quartz"),
    ("MTL", "metal"), ("GL", "glass"), ("P", "paint"),
]
CATEGORY_KEYWORDS = [
    ("paint", [r"\bpaint\b", r"sherwin", r"benjamin moore", r"\bppg\b", r"\bSW ?\d{4}\b", r"eggshell", r"semi-gloss"]),
    ("laminate", [r"laminate", r"\bplam\b", r"formica \d{4,5}", r"wilsonart", r"pionite"]),
    ("solid_surface", [r"solid surface", r"everform", r"corian"]),
    ("tile", [r"\btile\b", r"porcelain", r"ceramic", r"mosaic"]),
    ("wood_paneling", [r"veneer", r"woodworks", r"wood panel", r"paneling", r"\bwood ceiling\b"]),
    ("acoustic_ceiling", [r"acoustic", r"ceiling tile"]),
    ("stone", [r"granite", r"marble", r"quartzite"]),
    ("quartz", [r"\bquartz\b", r"caesarstone", r"cambria", r"silestone"]),
    ("metal", [r"stainless", r"aluminum", r"\bmetal\b"]),
]


@dataclass
class ProposedRecord:
    module_key: str
    record_type: str
    key: str
    data: dict
    source_ref: str
    evidence: str
    confidence: float
    notes: list[str] = field(default_factory=list)


def material_category(code: str, text: str) -> tuple[str, float, str]:
    prefix = re.match(r"[A-Z]+", code.upper())
    pcat = None
    if prefix:
        for p, cat in CATEGORY_BY_PREFIX:
            if prefix.group(0) == p:
                pcat = cat
                break
    kcat = None
    for cat, pats in CATEGORY_KEYWORDS:
        if any(re.search(p, text, re.I) for p in pats):
            kcat = cat
            break
    if pcat and kcat and pcat == kcat:
        return pcat, 0.95, f"code prefix and description agree ({pcat})"
    if kcat and pcat and pcat != kcat:
        return kcat, 0.6, f"description indicates {kcat} but code prefix suggests {pcat} — please review"
    if kcat:
        return kcat, 0.75, f"description indicates {kcat}"
    if pcat:
        return pcat, 0.6, f"inferred from code prefix only ({pcat})"
    return "other", 0.3, "material category not determinable"


def _manufacturer(text: str) -> str:
    for m in MANUFACTURERS:
        if re.search(r"\b" + re.escape(m) + r"\b", text, re.I):
            return m
    return ""


def _split_product(text: str, manufacturer: str) -> dict:
    d: dict = {}
    rest = re.sub(re.escape(manufacturer), "", text, flags=re.I).strip(" -–,:;") if manufacturer else text
    m = re.search(r"\b(SW|BM|PPG)\s?-?(\d{4})\b", rest)
    if m:
        d["color_code"] = f"{m.group(1)} {m.group(2)}"
        after = rest[m.end():].strip(" -–,:;")
        d["color_name"] = re.split(r"[,;(]| - ", after)[0].strip()
    else:
        m = re.search(r"\b(Everform\s+)?(\d{3,5}(?:-\d{2})?)\b\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})", rest)
        if m:
            d["product_number"] = (m.group(1) or "") + m.group(2)
            d["color_name"] = m.group(3).strip()
    for s in SHEEN:
        if re.search(r"\b" + re.escape(s) + r"\b", text, re.I):
            d["texture"] = s
            break
    dim = re.findall(r"\d+(?:\.\d+)?\s?(?:\"|'|in\b|mm\b|cm\b|ft\b)(?:\s?[x×]\s?\d+(?:\.\d+)?\s?(?:\"|'|in\b|mm\b|cm\b|ft\b))*", text)
    if dim:
        d["dimensions"] = dim[0].strip()
    d["product"] = rest.strip()
    return d


HEADER_ALIASES = {
    "code": ["code", "mark", "tag", "finish code", "designation", "symbol", "key", "finish", "id", "item", "item no", "item #", "no", "no."],
    "manufacturer": ["manufacturer", "mfr", "mfg", "vendor", "brand"],
    "product": ["product", "description", "product name", "material", "item description", "name", "color/finish", "color", "style"],
    "color": ["color", "colour", "color name", "pattern"],
    "texture": ["texture", "sheen", "finish type", "surface"],
    "dimensions": ["size", "dimensions", "dimension", "thickness", "nominal size"],
    "application": ["location", "application", "use", "where used", "remarks/location", "area", "room"],
    "drawing_ref": ["drawing", "sheet", "reference", "ref", "detail"],
    "model": ["model", "model no", "model #", "model number", "catalog no"],
    "qty": ["qty", "quantity", "count"],
    "remarks": ["remarks", "notes", "comments"],
    "electrical": ["electrical", "elec", "volts", "voltage", "kw", "amps"],
}


def _map_header(row: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for idx, cell in enumerate(row):
        c = cell.lower().strip().rstrip(":")
        for field_, aliases in HEADER_ALIASES.items():
            if c in aliases and field_ not in mapping:
                mapping[field_] = idx
                break
    return mapping


def _find_header(table: Table, required: set[str]) -> tuple[int, dict[str, int]] | None:
    for i, row in enumerate(table.rows[:15]):
        mp = _map_header(row)
        if required <= set(mp):
            return i, mp
    return None


def parse_finishes(ex: Extracted) -> list[ProposedRecord]:
    out: dict[str, ProposedRecord] = {}
    for t in ex.tables:
        found = _find_header(t, {"code"})
        if not found:
            continue
        h, mp = found
        if not ({"manufacturer", "product", "color"} & set(mp)):
            continue
        for r_i in range(h + 1, len(t.rows)):
            row = t.rows[r_i]
            get = lambda f: row[mp[f]].strip() if f in mp and mp[f] < len(row) else ""  # noqa: E731
            code = get("code").upper().replace(" ", "")
            if not CODE_RE.match(code):
                continue
            manufacturer = get("manufacturer")
            product_txt = " ".join(x for x in [get("product"), get("color")] if x)
            joined = " | ".join(c for c in row if c)
            manufacturer = manufacturer or _manufacturer(joined)
            data = _split_product(product_txt or joined, manufacturer)
            data.update({k: v for k, v in {
                "code": code, "manufacturer": manufacturer, "texture": get("texture") or data.get("texture", ""),
                "dimensions": get("dimensions") or data.get("dimensions", ""), "application": get("application"),
                "drawing_refs": get("drawing_ref"), "remarks": get("remarks"),
            }.items() if v})
            cat, conf, why = material_category(code, joined)
            data["category"] = cat
            ref = t.row_refs[r_i] if r_i < len(t.row_refs) else t.ref
            out[code] = ProposedRecord("N02", "finish", code, data, ref, joined, round(min(conf, 0.95), 2), [why])
    # Free text: "P1  Sherwin-Williams SW 7005 Pure White (Eggshell) - walls"
    line_re = re.compile(r"^\s*([A-Z]{1,4}-?\d{1,3}[A-Z]?)\s*(?:[:=\-–|\t]|\s{2,}|\s)\s*(.{6,240})$")
    for ref, text in ex.pages:
        for ln, line in enumerate(text.splitlines(), start=1):
            m = line_re.match(line)
            if not m:
                continue
            code, desc = m.group(1).replace(" ", ""), m.group(2).strip()
            manufacturer = _manufacturer(desc)
            if not manufacturer and not re.search(r"\b(SW|BM) ?\d{4}\b|laminate|solid surface|tile|veneer|paint", desc, re.I):
                continue
            if code in out:
                continue
            data = _split_product(desc, manufacturer)
            data.update({"code": code, "manufacturer": manufacturer})
            loc = re.search(r"(?:location|application|at|@)\s*[:\-]\s*(.+)$", desc, re.I)
            if loc:
                data["application"] = loc.group(1).strip()
            refs = re.findall(r"\b[A-Z]{1,2}-?\d{1,3}\.\d{1,2}\b|\b[A-Z]-\d{3}\b", desc)
            if refs:
                data["drawing_refs"] = ", ".join(refs)
            cat, conf, why = material_category(code, desc)
            data["category"] = cat
            out[code] = ProposedRecord("N02", "finish", code, data, f"{ref} line {ln}", line.strip(),
                                       round(conf * 0.9, 2), [why, "parsed from free text"])
    return list(out.values())


TAG_RE = re.compile(r"^(?:[A-Z]{1,4}-?)?\d{1,4}[A-Z]?$")


def parse_equipment(ex: Extracted) -> list[ProposedRecord]:
    out: dict[str, ProposedRecord] = {}
    for t in ex.tables:
        found = _find_header(t, {"code"})
        if not found:
            continue
        h, mp = found
        if not ({"model", "manufacturer"} & set(mp)):
            continue
        for r_i in range(h + 1, len(t.rows)):
            row = t.rows[r_i]
            get = lambda f: row[mp[f]].strip() if f in mp and mp[f] < len(row) else ""  # noqa: E731
            tag = get("code").upper().replace(" ", "")
            if not TAG_RE.match(tag):
                continue
            joined = " | ".join(c for c in row if c)
            data = {k: v for k, v in {
                "tag": tag, "description": get("product"), "manufacturer": get("manufacturer") or _manufacturer(joined),
                "model": get("model"), "qty": get("qty"), "dimensions": get("dimensions"),
                "schedule_location": get("application"), "electrical": get("electrical"), "remarks": get("remarks"),
            }.items() if v}
            # Locations are NEVER validated from a schedule alone.
            data["location_verified"] = False
            data["visible_in_source_image"] = None
            missing = [f for f in ("manufacturer", "model", "dimensions") if not data.get(f)]
            conf = 0.9 - 0.15 * len(missing)
            notes = [f"missing: {', '.join(missing)}"] if missing else []
            ref = t.row_refs[r_i] if r_i < len(t.row_refs) else t.ref
            out[tag] = ProposedRecord("N03", "equipment", tag, data, ref, joined, round(max(conf, 0.3), 2), notes)
    return list(out.values())


def find_equipment_on_plan(ex: Extracted, tags: list[str]) -> list[ProposedRecord]:
    """Evidence that a scheduled tag appears on a plan. This is a *proposal*; a person must verify it."""
    res = []
    for tag in tags:
        pat = re.compile(r"(?<![A-Z0-9-])" + re.escape(tag) + r"(?![A-Z0-9])")
        for ref, text in ex.pages:
            for ln, line in enumerate(text.splitlines(), start=1):
                if pat.search(line):
                    res.append(ProposedRecord("N03", "equipment_location", tag,
                                              {"tag": tag, "plan_ref": f"{ref} line {ln}", "found_on_plan": True},
                                              f"{ref} line {ln}", line.strip()[:300], 0.6,
                                              ["tag text found on plan — confirm position visually"]))
                    break
            else:
                continue
            break
    return res


ROOM_WORDS = ["KITCHEN", "BAR", "SERVERY", "RESTROOM", "TOILET", "MEN", "WOMEN", "STORAGE", "PANTRY", "LOBBY", "OFFICE",
              "CORRIDOR", "VESTIBULE", "DINING", "PATIO", "TERRACE", "MECHANICAL", "JANITOR", "JAN", "PREP", "WALK-IN",
              "COOLER", "FREEZER", "DISH", "SEATING", "LOUNGE", "ENTRY", "HALL", "ELEC", "IT", "LOCKER", "PORCH",
              "GRILL", "SNACK", "COUNTER", "QUEUE", "PRO SHOP", "HALFWAY HOUSE", "BREAK", "RECEIVING"]


def parse_project(ex: Extracted, filename: str) -> list[ProposedRecord]:
    out: list[ProposedRecord] = []
    seen: set[tuple[str, str]] = set()

    def add(rt, key, data, ref, ev, conf, notes=None):
        k = (rt, key.upper())
        if k in seen:
            return
        seen.add(k)
        out.append(ProposedRecord("N01", rt, key, data, ref, ev[:400], conf, notes or []))

    fields = {
        "project_name": r"^\s*project(?:\s+name)?\s*[:\-–]\s*(.+)$",
        "project_number": r"^\s*(?:project|job)\s*(?:no\.?|number|#)\s*[:\-–]\s*(.+)$",
        "client": r"^\s*(?:client|owner)\s*[:\-–]\s*(.+)$",
        "address": r"^\s*(?:address|location|site)\s*[:\-–]\s*(.+)$",
        "architect": r"^\s*architect\s*[:\-–]\s*(.+)$",
        "scope": r"^\s*scope(?:\s+of\s+work)?\s*[:\-–]\s*(.+)$",
        "phase": r"^\s*(?:phase|issue)\s*[:\-–]\s*(.+)$",
    }
    room_re = re.compile(r"\b(\d{3}[A-Z]?)\s+([A-Z][A-Z /&\-]{1,40})\b|\b([A-Z][A-Z /&\-]{1,40})\s+(\d{3}[A-Z]?)\b")
    sheet_re = re.compile(r"\b([A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?)\s+[-–]?\s*([A-Z][A-Z0-9 ,&/\-]{3,60}?(?:PLAN|ELEVATIONS?|SECTIONS?|DETAILS?|SCHEDULES?|RCP))\b")
    constraint_re = re.compile(r"\b(shall not|do not|must not|must|shall|NIC|not in contract|by owner|existing to remain|protect)\b", re.I)

    for ref, text in ex.pages:
        for ln, line in enumerate(text.splitlines(), start=1):
            s = line.strip()
            if not s:
                continue
            src = f"{ref} line {ln}"
            for f, pat in fields.items():
                m = re.match(pat, s, re.I)
                if m:
                    val = m.group(1).strip()
                    add("project_info", f, {"field": f, "value": val}, src, s, 0.85)
            for m in sheet_re.finditer(s):
                add("drawing_ref", m.group(1), {"sheet": m.group(1), "title": m.group(2).strip()}, src, s, 0.75)
            for m in room_re.finditer(s.upper() if s.isupper() else s):
                num, name = (m.group(1), m.group(2)) if m.group(1) else (m.group(4), m.group(3))
                name = name.strip(" -/&")
                if any(re.search(r"\b" + re.escape(w) + r"\b", name) for w in ROOM_WORDS) and len(name) <= 40:
                    add("room", f"{num} {name}", {"number": num, "name": name}, src, s, 0.7)
            m = re.match(r"^\s*rooms?\s*[:\-–]\s*(.+)$", s, re.I)
            if m:
                for part in re.split(r"[;,]", m.group(1)):
                    part = part.strip()
                    if part:
                        add("room", part, {"name": part}, src, s, 0.8)
            if constraint_re.search(s) and 12 < len(s) < 300:
                add("constraint", s[:120], {"text": s}, src, s, 0.55, ["constraint language detected — confirm applicability"])
    if not any(r.record_type == "project_info" and r.key == "project_name" for r in out):
        stem = re.sub(r"[_\-]+", " ", filename.rsplit(".", 1)[0])
        out.append(ProposedRecord("N01", "project_info", "project_name_candidate",
                                  {"field": "project_name", "value": stem}, "filename", filename, 0.2,
                                  ["low confidence: derived from filename only"]))
    return out
