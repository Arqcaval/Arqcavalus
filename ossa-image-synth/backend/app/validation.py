"""NODE 08 – automated output checks + reviewer checklist. All numbers are measured, never assumed."""
from __future__ import annotations

import numpy as np
from PIL import Image

from . import imaging


def run_checks(src: Image.Image, final: Image.Image, region: np.ndarray, protected: np.ndarray | None,
               composited: bool, source_hash_ok: bool) -> dict:
    checks = []
    dims_ok = src.size == final.size
    checks.append({"id": "dimensions", "label": "Output dimensions equal source dimensions", "passed": dims_ok,
                   "detail": f"source {src.size[0]}×{src.size[1]}, output {final.size[0]}×{final.size[1]}", "blocking": True})
    checks.append({"id": "source_integrity", "label": "Source image file unchanged (SHA-256 verified)", "passed": source_hash_ok,
                   "detail": "hash matches original upload" if source_hash_ok else "HASH MISMATCH", "blocking": True})
    stats = {}
    if dims_ok:
        tol = 0 if composited else 6
        stats = imaging.change_stats(src, final, region, tol)
        if composited:
            ok = stats["changed_outside"] == 0
            detail = (f"VERIFIED pixel-identical outside the edit region: 0 of {stats['pixels_outside']:,} pixels changed"
                      if ok else f"{stats['changed_outside']:,} of {stats['pixels_outside']:,} pixels changed outside the region "
                                 f"(max Δ {stats['max_diff_outside']})")
        else:
            ok = stats["changed_outside_pct"] < 0.5
            detail = (f"Not composited: {stats['changed_outside_pct']:.3f}% of pixels outside the region differ by more than "
                      f"{tol} levels (max Δ {stats['max_diff_outside']}). Outside pixels are NOT guaranteed identical.")
        checks.append({"id": "outside_region", "label": "No changes outside the authorised edit region", "passed": ok,
                       "detail": detail, "blocking": True})
        if protected is not None and protected.any():
            ps = imaging.change_stats(src, final, ~protected, tol)  # 'outside' of ~protected == protected
            pok = ps["changed_outside"] == 0 if composited else ps["changed_outside_pct"] < 0.05
            checks.append({"id": "protected", "label": "Protected regions unchanged", "passed": pok,
                           "detail": f"{ps['changed_outside']:,} of {ps['pixels_outside']:,} protected pixels changed", "blocking": True})
        visible = stats["mean_diff_inside"] >= 1.0
        checks.append({"id": "edit_visible", "label": "A change is present inside the edit region", "passed": visible,
                       "detail": f"mean Δ inside region {stats['mean_diff_inside']:.2f}; {stats['changed_inside_pct']:.1f}% of region pixels changed",
                       "blocking": False})
    return {"checks": checks, "stats": stats, "composited": composited,
            "automated_passed": all(c["passed"] for c in checks if c["blocking"])}


STANDARD_ITEMS = [
    ("geometry", "Geometry, camera and perspective unchanged"),
    ("equipment", "Equipment unchanged (no added, moved or removed items)"),
    ("adjacent", "Adjacent finishes outside the edit unchanged"),
    ("no_additions", "No unrequested objects added"),
    ("shadows", "Shadows were not interpreted as material changes"),
]


def build_checklist(analysis: dict) -> dict:
    items = []
    for ref in analysis.get("referenced_finishes", []):
        if ref.get("status") == "approved":
            d = ref.get("data") or {}
            items.append({"id": f"finish_{ref['code']}", "label": f"Edited surface matches {ref['code']} — "
                          f"{(d.get('manufacturer', '') + ' ' + d.get('product', '')).strip()}", "checked": False, "required": True})
    items += [{"id": i, "label": l, "checked": False, "required": True} for i, l in STANDARD_ITEMS]
    return {"items": items}


def checklist_complete(cl: dict) -> bool:
    return all(i.get("checked") for i in (cl or {}).get("items", []) if i.get("required"))
