"""Bootstrap: administrator account and the Myers Park Country Club — Halfway House reference project.

Reference finish records are loaded with origin="reference" and status="proposed": they are initial
reference records, NOT validated facts. They must be confirmed against the project's uploaded documents.
"""
from __future__ import annotations

import secrets

from sqlalchemy.orm import Session

from .config import settings
from .models import Project, ProjectMember, QALogEntry, Record, User
from .security import hash_password

REFERENCE_FINISHES = [
    ("P1", "Sherwin-Williams", "SW 7005 Pure White", "paint", {"color_code": "SW 7005", "color_name": "Pure White"}),
    ("P2", "Sherwin-Williams", "SW 6254 Lazy Gray", "paint", {"color_code": "SW 6254", "color_name": "Lazy Gray"}),
    ("P3", "Sherwin-Williams", "SW 6256 Serious Gray", "paint", {"color_code": "SW 6256", "color_name": "Serious Gray"}),
    ("P4", "Sherwin-Williams", "SW 9177 Salty Dog", "paint", {"color_code": "SW 9177", "color_name": "Salty Dog"}),
    ("PL2", "Formica", "09312 Planked Urban Oak", "laminate", {"product_number": "09312", "color_name": "Planked Urban Oak"}),
    ("SS1", "Formica", "Everform 620 Tumbled Harvest", "solid_surface", {"product_number": "Everform 620", "color_name": "Tumbled Harvest"}),
    ("SS2", "Formica", "Everform 623 Fossilized Lava", "solid_surface", {"product_number": "Everform 623", "color_name": "Fossilized Lava"}),
    ("WCP1", "Armstrong", "WoodWorks Linear Veneered, Plain Slice Cherry", "wood_paneling",
     {"color_name": "Plain Slice Cherry", "texture": "plain slice veneer"}),
]

PROJECT_LESSONS = [
    ("material_error", "A PL2 wood laminate must not be replaced with gray paint."),
    ("material_error", "A backsplash identified as SS2 must not change because an adjacent vertical panel receives PL2."),
    ("unauthorized_edit", "Local cabinet modifications must not alter adjacent bar finishes."),
    ("user_correction", "Keep existing slim black separators unless instructed otherwise."),
    ("unauthorized_edit", "Painting a shelf must not change its contents."),
    ("geometry_change", "Do not confuse material color changes with geometric remodeling."),
    ("material_error", "Do not interpret a shadow as a different material."),
    ("user_correction", "Never mix documentation between separate projects."),
]

GLOBAL_RULES = [
    "The source architectural image is the primary visual authority.",
    "Architectural accuracy takes priority over visual creativity.",
    "Default to localized editing inside an approved mask.",
]


def ensure_admin(db: Session) -> tuple[User, str | None]:
    u = db.query(User).filter_by(email=settings.admin_email.lower()).first()
    if u:
        return u, None
    pw = settings.admin_password or secrets.token_urlsafe(12)
    u = User(email=settings.admin_email.lower(), name="Administrator", password_hash=hash_password(pw), is_admin=True)
    db.add(u)
    db.commit()
    return u, (None if settings.admin_password else pw)


def ensure_global_rules(db: Session):
    if db.query(QALogEntry).filter_by(scope="global").count():
        return
    for r in GLOBAL_RULES:
        db.add(QALogEntry(project_id=None, scope="global", category="lesson", title=r, is_lesson=True))
    db.commit()


def seed_reference_project(db: Session, owner: User) -> Project | None:
    if db.query(Project).filter_by(is_reference=True).first():
        return None
    p = Project(name="Myers Park Country Club — Halfway House", code="MPCC-HH",
                description="Reference configuration. Finish records below are initial references and must be confirmed "
                            "against the project's uploaded finish schedule.",
                budget_usd=settings.default_project_budget_usd, is_reference=True, created_by=owner.id,
                oscillator={"mode": "auto", "quality": "high", "input_fidelity": True})
    db.add(p)
    db.flush()
    db.add(ProjectMember(project_id=p.id, user_id=owner.id, role="owner"))
    for code, mfr, product, cat, extra in REFERENCE_FINISHES:
        db.add(Record(project_id=p.id, module_key="N02", record_type="finish", key=code, status="proposed", origin="reference",
                      data={"code": code, "manufacturer": mfr, "product": product, "category": cat, **extra},
                      source_ref="OSSA reference configuration (not a project document)",
                      evidence=f"{code} — {mfr} {product}", confidence=0.5,
                      notes="Initial reference record. Confirm against the uploaded finish schedule before approval."))
    db.add(Record(project_id=p.id, module_key="N01", record_type="project_info", key="project_name", status="proposed",
                  origin="reference", data={"field": "project_name", "value": "Myers Park Country Club — Halfway House"},
                  source_ref="OSSA reference configuration", evidence="Reference project name", confidence=0.5))
    for cat, title in PROJECT_LESSONS:
        db.add(QALogEntry(project_id=p.id, scope="project", category=cat, title=title, is_lesson=True,
                          detail="Seeded project lesson (reference configuration)."))
    db.commit()
    return p
