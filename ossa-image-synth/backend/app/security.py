from __future__ import annotations

import datetime as dt
import hashlib
import hmac
import secrets

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, Project, ProjectMember, User, now

ROLE_RANK = {"viewer": 0, "reviewer": 1, "editor": 2, "owner": 3}


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 240_000)
    return f"pbkdf2_sha256$240000${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iters, salt, digest = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iters))
        return hmac.compare_digest(dk.hex(), digest)
    except Exception:
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256((settings.secret_key + token).encode()).hexdigest()


def create_session(db: Session, user: User) -> str:
    token = secrets.token_urlsafe(32)
    db.add(AuthSession(token_hash=_token_hash(token), user_id=user.id,
                       expires_at=now() + dt.timedelta(hours=settings.session_hours)))
    db.commit()
    return token


def revoke_session(db: Session, token: str) -> None:
    s = db.get(AuthSession, _token_hash(token))
    if s:
        db.delete(s)
        db.commit()


def current_user(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None, description="Token for <img> URLs"),
    db: Session = Depends(get_db),
) -> User:
    raw = None
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    elif token:
        raw = token
    if not raw:
        raise HTTPException(401, "Not authenticated")
    s = db.get(AuthSession, _token_hash(raw))
    if not s or s.expires_at < now():
        raise HTTPException(401, "Session expired")
    user = db.get(User, s.user_id)
    if not user or not user.active:
        raise HTTPException(401, "User disabled")
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(403, "Administrator role required")
    return user


def project_role(db: Session, user: User, project_id: str) -> str | None:
    if user.is_admin:
        return "owner"
    m = db.query(ProjectMember).filter_by(project_id=project_id, user_id=user.id).first()
    return m.role if m else None


def get_project_for(db: Session, user: User, project_id: str, min_role: str = "viewer") -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    role = project_role(db, user, project_id)
    if role is None:
        # Do not reveal existence of projects the user cannot access.
        raise HTTPException(404, "Project not found")
    if ROLE_RANK[role] < ROLE_RANK[min_role]:
        raise HTTPException(403, f"Requires project role '{min_role}' (you are '{role}')")
    return project
