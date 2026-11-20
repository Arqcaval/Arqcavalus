"""Runtime configuration. All values come from environment variables (see .env.example).

Secrets (provider API keys) are read only on the server and are never serialised to clients
or included in project exports.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("IMAGE_SYNTH_DATA_DIR", "./data")).resolve())
    database_url: str = field(default_factory=lambda: os.environ.get("DATABASE_URL", ""))
    secret_key: str = field(default_factory=lambda: os.environ.get("SECRET_KEY", "dev-insecure-change-me"))
    admin_email: str = field(default_factory=lambda: os.environ.get("ADMIN_EMAIL", "admin@ossa.studio"))
    admin_password: str = field(default_factory=lambda: os.environ.get("ADMIN_PASSWORD", ""))
    seed_reference_project: bool = field(default_factory=lambda: os.environ.get("SEED_REFERENCE_PROJECT", "1") == "1")

    # Limits
    max_upload_mb: int = field(default_factory=lambda: _int("MAX_UPLOAD_MB", 60))
    max_image_pixels: int = field(default_factory=lambda: _int("MAX_IMAGE_PIXELS", 40_000_000))
    max_concurrent_jobs: int = field(default_factory=lambda: _int("MAX_CONCURRENT_JOBS", 2))
    max_cost_per_job_usd: float = field(default_factory=lambda: _float("MAX_COST_PER_JOB_USD", 1.00))
    default_project_budget_usd: float = field(default_factory=lambda: _float("DEFAULT_PROJECT_BUDGET_USD", 25.0))
    provider_timeout_s: float = field(default_factory=lambda: _float("PROVIDER_TIMEOUT_S", 300.0))
    session_hours: int = field(default_factory=lambda: _int("SESSION_HOURS", 72))

    # Providers (server-side only)
    openai_api_key: str = field(default_factory=lambda: os.environ.get("OPENAI_API_KEY", ""))
    openai_base_url: str = field(default_factory=lambda: os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    openai_org: str = field(default_factory=lambda: os.environ.get("OPENAI_ORG_ID", ""))

    static_dir: str = field(default_factory=lambda: os.environ.get("STATIC_DIR", ""))
    run_worker: bool = field(default_factory=lambda: os.environ.get("RUN_WORKER", "1") == "1")

    @property
    def db_url(self) -> str:
        return self.database_url or f"sqlite:///{self.data_dir / 'image_synth.db'}"

    @property
    def storage_dir(self) -> Path:
        return self.data_dir / "projects"


settings = Settings()


def reload_settings() -> Settings:
    global settings
    new = Settings()
    settings.__dict__.update(new.__dict__)
    return settings
