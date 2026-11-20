"""Administrator CLI.

  python -m app.cli create-user jack@ossa.studio "Jack Ossa" --admin
  python -m app.cli add-member jack@ossa.studio <project-id> owner
  python -m app.cli reset-password jack@ossa.studio
  python -m app.cli list-projects
"""
from __future__ import annotations

import argparse
import getpass
import secrets

from . import db as dbmod
from .models import Project, ProjectMember, User
from .security import hash_password


def main():
    ap = argparse.ArgumentParser(prog="image-synth")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-user")
    c.add_argument("email")
    c.add_argument("name", nargs="?", default="")
    c.add_argument("--admin", action="store_true")
    c.add_argument("--password")
    r = sub.add_parser("reset-password")
    r.add_argument("email")
    m = sub.add_parser("add-member")
    m.add_argument("email")
    m.add_argument("project_id")
    m.add_argument("role", choices=["owner", "editor", "reviewer", "viewer"])
    sub.add_parser("list-projects")
    a = ap.parse_args()
    dbmod.init_engine()
    with dbmod.SessionLocal() as db:
        if a.cmd == "create-user":
            pw = a.password or secrets.token_urlsafe(12)
            if db.query(User).filter_by(email=a.email.lower()).first():
                raise SystemExit("user exists")
            db.add(User(email=a.email.lower(), name=a.name, password_hash=hash_password(pw), is_admin=a.admin))
            db.commit()
            print(f"Created {a.email}. Temporary password: {pw}" if not a.password else f"Created {a.email}.")
        elif a.cmd == "reset-password":
            u = db.query(User).filter_by(email=a.email.lower()).first()
            if not u:
                raise SystemExit("no such user")
            typed = getpass.getpass("New password (blank = generate): ")
            pw = typed or secrets.token_urlsafe(12)
            u.password_hash = hash_password(pw)
            db.commit()
            print("Password updated." + ("" if typed else f" Temporary password: {pw}"))
        elif a.cmd == "add-member":
            u = db.query(User).filter_by(email=a.email.lower()).first()
            if not u or not db.get(Project, a.project_id):
                raise SystemExit("unknown user or project")
            mem = db.query(ProjectMember).filter_by(project_id=a.project_id, user_id=u.id).first()
            if mem:
                mem.role = a.role
            else:
                db.add(ProjectMember(project_id=a.project_id, user_id=u.id, role=a.role))
            db.commit()
            print("ok")
        elif a.cmd == "list-projects":
            for p in db.query(Project):
                print(p.id, p.code, p.name)


if __name__ == "__main__":
    main()
