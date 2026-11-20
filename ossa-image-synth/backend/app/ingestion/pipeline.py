"""Document intake: identify -> extract -> classify -> map to modules -> propose records."""
from __future__ import annotations

import io

from PIL import Image
from sqlalchemy.orm import Session

from .. import storage
from ..audit import audit
from ..models import Document, ModuleMapping, Record, SourceImage
from .classify import TYPE_MODULES, classify
from .extract import CAD_EXT, IMAGE_EXT, SUPPORTED_EXT, extract
from .parsers import find_equipment_on_plan, parse_equipment, parse_finishes, parse_project

ALLOWED_EXT = SUPPORTED_EXT | CAD_EXT


def _clear_unreviewed(db: Session, doc: Document) -> None:
    """Remove proposals derived from this document that a person has not reviewed yet.
    Approved / rejected records are kept: they represent human decisions."""
    db.query(Record).filter(Record.document_id == doc.id, Record.status == "proposed").delete()
    db.query(ModuleMapping).filter(ModuleMapping.document_id == doc.id, ModuleMapping.status == "proposed").delete()


def _add_records(db: Session, doc: Document, proposals) -> int:
    n = 0
    for p in proposals:
        # Skip if an identical reviewed record from this doc already exists.
        exists = db.query(Record).filter_by(project_id=doc.project_id, document_id=doc.id,
                                            record_type=p.record_type, key=p.key).first()
        if exists:
            continue
        db.add(Record(project_id=doc.project_id, module_key=p.module_key, record_type=p.record_type, key=p.key,
                      data=p.data, status="proposed", origin="parser", document_id=doc.id, source_ref=p.source_ref,
                      evidence=p.evidence, confidence=p.confidence, notes="; ".join(p.notes)))
        n += 1
    return n


def process_document(db: Session, doc: Document, user_id: str | None = None) -> Document:
    doc.status = "processing"
    db.commit()
    try:
        data = storage.read(doc.project_id, doc.storage_path)
        ex = extract(doc.ext, data)
        doc.page_count = ex.page_count
        doc.text_excerpt = ex.full_text[:20000]
        doc.meta = {**(doc.meta or {}), "warnings": ex.warnings, "tables": len(ex.tables), "image": ex.image}
        if doc.classification_source != "manual":
            t, conf, ev = classify(doc.original_name, doc.ext, ex)
            doc.doc_type, doc.classification_confidence, doc.classification_evidence = t, conf, ev
        _clear_unreviewed(db, doc)
        if ex.unsupported:
            doc.status = "unsupported"
            doc.error = ex.unsupported
            db.commit()
            audit(db, doc.project_id, user_id, "document.unsupported", doc.id, {"reason": ex.unsupported})
            return doc

        modules = TYPE_MODULES.get(doc.doc_type, [])
        for mk in modules:
            if not db.query(ModuleMapping).filter_by(document_id=doc.id, module_key=mk).first():
                db.add(ModuleMapping(project_id=doc.project_id, document_id=doc.id, module_key=mk, status="proposed",
                                     confidence=doc.classification_confidence,
                                     evidence=[f"document classified as {doc.doc_type}"] + list(doc.classification_evidence or [])[:4]))
        proposals = []
        if "N02" in modules and ex.kind != "image":
            proposals += parse_finishes(ex)
        if "N03" in modules and ex.kind != "image":
            if doc.doc_type in ("equipment_schedule", "cut_sheet"):
                proposals += parse_equipment(ex)
            if doc.doc_type == "equipment_plan":
                tags = [r.key for r in db.query(Record).filter_by(project_id=doc.project_id, record_type="equipment")
                        if r.status != "rejected"]
                proposals += find_equipment_on_plan(ex, tags)
        if "N01" in modules and ex.kind != "image":
            proposals += parse_project(ex, doc.original_name)
        n = _add_records(db, doc, proposals)

        if doc.ext in IMAGE_EXT and doc.doc_type == "source_image":
            if not db.query(SourceImage).filter_by(document_id=doc.id).first():
                db.add(SourceImage(project_id=doc.project_id, document_id=doc.id, label=doc.original_name,
                                   width=ex.image["width"], height=ex.image["height"], sha256=doc.sha256,
                                   storage_path=doc.storage_path, status="candidate"))
        doc.status = "processed"
        doc.error = ""
        if not modules:
            doc.meta = {**doc.meta, "note": "No module can use this document as classified. Override the classification if wrong."}
        db.commit()
        audit(db, doc.project_id, user_id, "document.processed", doc.id,
              {"doc_type": doc.doc_type, "modules": modules, "records_proposed": n})
    except Exception as e:
        db.rollback()
        doc = db.get(Document, doc.id)
        doc.status = "error"
        doc.error = f"{type(e).__name__}: {e}"
        db.commit()
        audit(db, doc.project_id, user_id, "document.error", doc.id, {"error": doc.error})
    return doc


def thumbnail(data: bytes, size: int = 480) -> bytes:
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size))
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=82)
        return buf.getvalue()
