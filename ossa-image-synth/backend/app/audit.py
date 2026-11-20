from __future__ import annotations

from sqlalchemy.orm import Session

from .models import AuditEvent, QALogEntry


def audit(db: Session, project_id: str | None, user_id: str | None, action: str, target: str = "", detail: dict | None = None):
    db.add(AuditEvent(project_id=project_id, user_id=user_id, action=action, target=target, detail=detail or {}))
    db.commit()


def qa(db: Session, project_id: str | None, category: str, title: str, detail: str = "", related: dict | None = None,
       user_id: str | None = None, is_lesson: bool = False, scope: str = "project"):
    e = QALogEntry(project_id=project_id, scope=scope, category=category, title=title, detail=detail,
                   related=related or {}, is_lesson=is_lesson, created_by=user_id)
    db.add(e)
    db.commit()
    return e
