from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..audit import audit
from ..db import get_db
from ..models import User
from ..security import create_session, current_user, hash_password, require_admin, revoke_session, verify_password
from ..serialize import ser

router = APIRouter(prefix="/api", tags=["auth"])


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/auth/login")
def login(body: LoginIn, db: Session = Depends(get_db)):
    u = db.query(User).filter_by(email=body.email.strip().lower()).first()
    if not u or not u.active or not verify_password(body.password, u.password_hash):
        raise HTTPException(401, "Invalid email or password")
    token = create_session(db, u)
    audit(db, None, u.id, "auth.login", u.id)
    return {"token": token, "user": ser(u)}


@router.post("/auth/logout")
def logout(authorization: str | None = Header(default=None), db: Session = Depends(get_db), user: User = Depends(current_user)):
    if authorization:
        revoke_session(db, authorization[7:].strip())
    return {"ok": True}


@router.get("/auth/me")
def me(user: User = Depends(current_user)):
    return ser(user)


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


@router.post("/auth/password")
def change_password(body: PasswordIn, db: Session = Depends(get_db), user: User = Depends(current_user)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is incorrect")
    if len(body.new_password) < 10:
        raise HTTPException(400, "Password must be at least 10 characters")
    user.password_hash = hash_password(body.new_password)
    db.commit()
    return {"ok": True}


class UserIn(BaseModel):
    email: str
    name: str = ""
    password: str
    is_admin: bool = False


@router.get("/admin/users")
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)):
    return [ser(u) for u in db.query(User).order_by(User.created_at)]


@router.post("/admin/users")
def create_user(body: UserIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "Invalid email")
    if len(body.password) < 10:
        raise HTTPException(400, "Password must be at least 10 characters")
    if db.query(User).filter_by(email=email).first():
        raise HTTPException(409, "User already exists")
    u = User(email=email, name=body.name, password_hash=hash_password(body.password), is_admin=body.is_admin)
    db.add(u)
    db.commit()
    audit(db, None, admin.id, "user.create", u.id, {"email": email, "is_admin": body.is_admin})
    return ser(u)


class UserPatch(BaseModel):
    name: str | None = None
    password: str | None = None
    is_admin: bool | None = None
    active: bool | None = None


@router.patch("/admin/users/{uid}")
def patch_user(uid: str, body: UserPatch, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    u = db.get(User, uid)
    if not u:
        raise HTTPException(404)
    if body.name is not None:
        u.name = body.name
    if body.password:
        if len(body.password) < 10:
            raise HTTPException(400, "Password must be at least 10 characters")
        u.password_hash = hash_password(body.password)
    if body.is_admin is not None:
        u.is_admin = body.is_admin
    if body.active is not None:
        if u.id == admin.id and not body.active:
            raise HTTPException(400, "You cannot disable yourself")
        u.active = body.active
    db.commit()
    audit(db, None, admin.id, "user.update", u.id, body.model_dump(exclude={"password"}, exclude_none=True))
    return ser(u)
