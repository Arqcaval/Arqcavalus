"""Project-scoped, write-once file storage.

Layout: <data>/projects/<project_id>/<area>/<sha256-prefix>_<uuid>.<ext>
Files are never overwritten: every write gets a unique path and is chmod'ed read-only.
Path resolution always verifies the file is inside the owning project's directory, which is the
mechanism that prevents one project's files from being served through another project.
"""
from __future__ import annotations

import hashlib
import os
import uuid
from pathlib import Path

from .config import settings

AREAS = {"documents", "masks", "outputs", "raw", "thumbs", "exports"}


def project_dir(project_id: str) -> Path:
    if not project_id.isalnum():
        raise ValueError("invalid project id")
    return settings.storage_dir / project_id


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_new(project_id: str, area: str, data: bytes, ext: str) -> tuple[str, str]:
    """Write bytes to a brand-new file. Returns (relative_path, sha256)."""
    if area not in AREAS:
        raise ValueError(area)
    ext = "".join(c for c in ext.lower().lstrip(".") if c.isalnum())[:8] or "bin"
    digest = sha256_bytes(data)
    folder = project_dir(project_id) / area
    folder.mkdir(parents=True, exist_ok=True)
    name = f"{digest[:12]}_{uuid.uuid4().hex}.{ext}"
    path = folder / name
    # O_EXCL guarantees we never overwrite an existing file.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(path, 0o444)
    return f"{project_id}/{area}/{name}", digest


def resolve(project_id: str, rel_path: str) -> Path:
    base = project_dir(project_id).resolve()
    p = (settings.storage_dir / rel_path).resolve()
    if base not in p.parents:
        raise PermissionError("file does not belong to this project")
    return p


def read(project_id: str, rel_path: str) -> bytes:
    return resolve(project_id, rel_path).read_bytes()
