"""Relational schema.

Separation of concerns (requirement 6):
  * Document        – an uploaded file, stored immutably (write-once, content hashed).
  * Record          – a piece of information extracted from a document (origin=parser), proposed by
                      AI (origin=ai, i.e. an assumption), entered by a user (origin=user) or loaded from a
                      reference configuration (origin=reference). Only status=approved records are
                      "approved facts" and only they can satisfy module requirements.
  * SourceImage     – an authorised visual source; never modified.
  * Generation      – AI output versions; raw provider output and composites are stored separately.
"""
from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def _id() -> str:
    return uuid.uuid4().hex


def now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class AuthSession(Base):
    __tablename__ = "auth_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class Project(Base):
    __tablename__ = "projects"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    name: Mapped[str] = mapped_column(String(255))
    code: Mapped[str] = mapped_column(String(64), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    budget_usd: Mapped[float] = mapped_column(Float, default=25.0)
    spent_usd: Mapped[float] = mapped_column(Float, default=0.0)
    canvas: Mapped[dict] = mapped_column(JSON, default=dict)
    oscillator: Mapped[dict] = mapped_column(JSON, default=dict)
    is_reference: Mapped[bool] = mapped_column(Boolean, default=False)
    archived: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now, onupdate=now)


class ProjectMember(Base):
    __tablename__ = "project_members"
    __table_args__ = (UniqueConstraint("project_id", "user_id"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(16), default="editor")  # owner|editor|reviewer|viewer
    user: Mapped[User] = relationship()


class Document(Base):
    __tablename__ = "documents"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    original_name: Mapped[str] = mapped_column(String(512))
    ext: Mapped[str] = mapped_column(String(16))
    mime: Mapped[str] = mapped_column(String(128), default="")
    size: Mapped[int] = mapped_column(Integer, default=0)
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    storage_path: Mapped[str] = mapped_column(String(1024))
    doc_type: Mapped[str] = mapped_column(String(48), default="unknown")
    classification_confidence: Mapped[float] = mapped_column(Float, default=0.0)
    classification_evidence: Mapped[list] = mapped_column(JSON, default=list)
    classification_source: Mapped[str] = mapped_column(String(16), default="auto")  # auto|manual
    status: Mapped[str] = mapped_column(String(16), default="uploaded")  # uploaded|processing|processed|unsupported|error
    error: Mapped[str] = mapped_column(Text, default="")
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    text_excerpt: Mapped[str] = mapped_column(Text, default="")
    meta: Mapped[dict] = mapped_column(JSON, default=dict)
    uploaded_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class ModuleMapping(Base):
    __tablename__ = "module_mappings"
    __table_args__ = (UniqueConstraint("document_id", "module_key"),)
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"), index=True)
    module_key: Mapped[str] = mapped_column(String(8))
    status: Mapped[str] = mapped_column(String(16), default="proposed")  # proposed|accepted|rejected
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class Record(Base):
    __tablename__ = "records"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    module_key: Mapped[str] = mapped_column(String(8), index=True)
    record_type: Mapped[str] = mapped_column(String(32), index=True)
    key: Mapped[str] = mapped_column(String(128), default="")
    data: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="proposed")  # proposed|approved|rejected
    origin: Mapped[str] = mapped_column(String(16), default="parser")  # parser|ai|user|reference
    document_id: Mapped[str | None] = mapped_column(ForeignKey("documents.id", ondelete="SET NULL"), nullable=True)
    source_ref: Mapped[str] = mapped_column(String(255), default="")
    evidence: Mapped[str] = mapped_column(Text, default="")
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    notes: Mapped[str] = mapped_column(Text, default="")
    reviewed_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    reviewed_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class SourceImage(Base):
    __tablename__ = "source_images"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    document_id: Mapped[str] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(255), default="")
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)
    sha256: Mapped[str] = mapped_column(String(64))
    storage_path: Mapped[str] = mapped_column(String(1024))
    status: Mapped[str] = mapped_column(String(16), default="candidate")  # candidate|authorized|rejected
    authorized_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    authorized_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class Mask(Base):
    __tablename__ = "masks"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    source_image_id: Mapped[str] = mapped_column(ForeignKey("source_images.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # edit|protected
    label: Mapped[str] = mapped_column(String(255), default="")
    storage_path: Mapped[str] = mapped_column(String(1024))
    sha256: Mapped[str] = mapped_column(String(64))
    coverage: Mapped[float] = mapped_column(Float, default=0.0)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|approved
    approved_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class EditRequest(Base):
    __tablename__ = "edit_requests"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    source_image_id: Mapped[str] = mapped_column(ForeignKey("source_images.id", ondelete="CASCADE"))
    instruction: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(16), default="local")  # local|global
    global_authorized: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_object_additions: Mapped[bool] = mapped_column(Boolean, default=False)
    composite: Mapped[bool] = mapped_column(Boolean, default=True)
    edit_mask_id: Mapped[str | None] = mapped_column(ForeignKey("masks.id", ondelete="SET NULL"), nullable=True)
    protected_mask_id: Mapped[str | None] = mapped_column(ForeignKey("masks.id", ondelete="SET NULL"), nullable=True)
    analysis: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), default="draft")  # draft|approved
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class Job(Base):
    __tablename__ = "jobs"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    edit_request_id: Mapped[str] = mapped_column(ForeignKey("edit_requests.id", ondelete="CASCADE"))
    parent_generation_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    kind: Mapped[str] = mapped_column(String(32), default="image_edit")
    status: Mapped[str] = mapped_column(String(16), default="queued")  # queued|running|succeeded|failed|cancelled
    progress: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(String(32), default="")
    model: Mapped[str] = mapped_column(String(128), default="")
    selection_mode: Mapped[str] = mapped_column(String(16), default="auto")
    selection: Mapped[dict] = mapped_column(JSON, default=dict)
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    prompt: Mapped[str] = mapped_column(Text, default="")
    estimated_cost: Mapped[float] = mapped_column(Float, default=0.0)
    actual_cost: Mapped[float] = mapped_column(Float, default=0.0)
    error: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)


class Generation(Base):
    __tablename__ = "generations"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), index=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("jobs.id", ondelete="CASCADE"))
    edit_request_id: Mapped[str] = mapped_column(ForeignKey("edit_requests.id", ondelete="CASCADE"))
    source_image_id: Mapped[str] = mapped_column(ForeignKey("source_images.id", ondelete="CASCADE"))
    version: Mapped[int] = mapped_column(Integer, default=1)
    raw_path: Mapped[str] = mapped_column(String(1024))
    final_path: Mapped[str] = mapped_column(String(1024))
    composited: Mapped[bool] = mapped_column(Boolean, default=False)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    validation: Mapped[dict] = mapped_column(JSON, default=dict)
    checklist: Mapped[dict] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(24), default="pending_review")  # pending_review|approved|rejected|revision_requested
    decided_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    decided_at: Mapped[dt.datetime | None] = mapped_column(DateTime, nullable=True)
    decision_reason: Mapped[str] = mapped_column(Text, default="")
    override_reason: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class ProviderCall(Base):
    __tablename__ = "provider_calls"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    job_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    provider: Mapped[str] = mapped_column(String(32))
    model: Mapped[str] = mapped_column(String(128), default="")
    operation: Mapped[str] = mapped_column(String(64))
    endpoint: Mapped[str] = mapped_column(String(255), default="")
    request_summary: Mapped[dict] = mapped_column(JSON, default=dict)
    response_status: Mapped[int] = mapped_column(Integer, default=0)
    response_summary: Mapped[dict] = mapped_column(JSON, default=dict)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class QALogEntry(Base):
    __tablename__ = "qa_log"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str | None] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"), nullable=True, index=True)
    scope: Mapped[str] = mapped_column(String(16), default="project")  # project|global
    category: Mapped[str] = mapped_column(String(32))
    title: Mapped[str] = mapped_column(String(512))
    detail: Mapped[str] = mapped_column(Text, default="")
    related: Mapped[dict] = mapped_column(JSON, default=dict)
    is_lesson: Mapped[bool] = mapped_column(Boolean, default=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str | None] = mapped_column(String(32), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)


class AuditEvent(Base):
    __tablename__ = "audit_events"
    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=_id)
    project_id: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    user_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    action: Mapped[str] = mapped_column(String(64))
    target: Mapped[str] = mapped_column(String(128), default="")
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime, default=now)
