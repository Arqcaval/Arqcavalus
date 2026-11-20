from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import db as dbmod
from . import jobs
from .config import settings
from .routers import auth, images, oscillator, outputs, projects
from .seed import ensure_admin, ensure_global_rules, seed_reference_project

log = logging.getLogger("image_synth")


def bootstrap():
    dbmod.init_engine()
    with dbmod.SessionLocal() as db:
        admin, generated = ensure_admin(db)
        if generated:
            pw_file = settings.data_dir / "INITIAL_ADMIN_PASSWORD.txt"
            pw_file.write_text(f"{admin.email}\n{generated}\n")
            pw_file.chmod(0o600)
            log.warning("Created administrator %s. Initial password written to %s", admin.email, pw_file)
        ensure_global_rules(db)
        if settings.seed_reference_project:
            seed_reference_project(db, admin)


@asynccontextmanager
async def lifespan(app: FastAPI):
    bootstrap()
    if settings.run_worker:
        jobs.start_workers()
    yield
    jobs.stop_workers()


def create_app() -> FastAPI:
    app = FastAPI(title="OSSA Studio — Image Synth", version="1.0.0", lifespan=lifespan)
    for r in (auth.router, projects.router, images.router, oscillator.router, outputs.router):
        app.include_router(r)

    @app.get("/api/health")
    def health():
        return {"ok": True, "app": "OSSA Studio Image Synth", "version": app.version}

    @app.exception_handler(PermissionError)
    async def perm(_, exc):
        return JSONResponse({"detail": str(exc)}, status_code=403)

    static = Path(settings.static_dir) if settings.static_dir else None
    if static and (static / "index.html").exists():
        app.mount("/assets", StaticFiles(directory=static / "assets"), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            f = static / path
            if path and f.is_file() and static in f.resolve().parents:
                return FileResponse(f)
            return FileResponse(static / "index.html")
    return app


app = create_app()
