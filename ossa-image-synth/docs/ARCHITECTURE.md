# Architecture

```
browser (React + TypeScript + React Flow)
   │  JSON / multipart over HTTPS, bearer session token
   ▼
FastAPI (backend/app)
   ├─ routers/       auth · projects/documents/records/modules · images/masks/edit-requests · oscillator/jobs · outputs/qa/audit/export
   ├─ ingestion/     extract (pdf/image/csv/xlsx/text; DWG/RVT identify-only) → classify → parsers → pipeline
   ├─ modules.py     NODE 01–09 requirement evaluation → EMPTY / PROCESSING / NEEDS_REVIEW / VALIDATED / ERROR, execution gate
   ├─ intent.py      NODE 04 interpretation, blocking rules, prompt builder (finishes + lessons)
   ├─ oscillator/    capability registry, discovery, compatibility, AUTO/MANUAL selection, provider adapters (OpenAI)
   ├─ jobs.py        DB-backed queue + worker threads (concurrency limit, progress, no silent retries)
   ├─ imaging.py     mask algebra, uniform scale+pad for the provider, restore, inward-feather composite, diffs
   ├─ validation.py  measured checks + reviewer checklist
   └─ storage.py     project-scoped write-once files (O_EXCL, read-only, SHA-256), path containment
SQLite (default) or PostgreSQL via SQLAlchemy · /data volume
```

## Data separation
- **Document**: an uploaded file, immutable, with its hash, classification, evidence and status.
- **Record**: extracted information. Its `origin` is parser, ai, user or reference, and its `status` is
  proposed, approved or rejected. Only approved records satisfy requirements. AI output (`origin=ai`) is an
  assumption and never satisfies a finish or equipment requirement.
- **SourceImage**: an authorised render, never written to.
- **Mask**: an edit or protected region at the source's native resolution; it needs approval.
- **EditRequest**: an instruction plus its analysis, which must be approved.
- **Job / Generation**: a provider run and its output versions. The raw provider output and the final
  composite are stored separately, together with the validation report.
- **QALogEntry**: a project or global entry; lessons are flagged.
- **AuditEvent / ProviderCall**: the audit trail.

Every query is filtered by `project_id`. Cross-references (image ↔ mask ↔ edit request) are checked so they
cannot cross projects, and stored-file access verifies that the path is inside the project's own directory.

## How a local edit is executed
1. The gate checks that the modules the intent needs (N01, N04, N05, N07, plus N02 or N03 when required) are
   VALIDATED, the source is authorised and its hash matches, the request is approved, and the budget and cost
   cap allow the run.
2. The editable region is the approved edit mask minus any protected mask.
3. The source is **uniformly** scaled and padded (never stretched) to a provider size. The mask is converted to
   the provider's alpha convention.
4. Provider output is cropped and scaled back to the source geometry. When compositing is on, pixels outside
   the region are copied from the original bit-for-bit; feathering applies only inside the region.
5. Validation measures changes outside the region and in protected regions. Approval is blocked on failure
   unless an owner or reviewer records an override.

## Security
- Passwords are hashed with PBKDF2-SHA256 (240k iterations). Session tokens are random and stored hashed, and
  they expire.
- Provider keys are read only from the server environment. They are never returned by any endpoint and never
  stored in the database or exports. Provider-call logs record parameters and sizes only.
- Uploads are checked against an extension allow-list, a size limit and a pixel limit (decompression-bomb
  guard). Files are stored read-only under random names.
- Image `<img>` URLs carry the session token as a query parameter. Serve over HTTPS (see the Caddy profile)
  so it is not exposed in transit.

## Known limitations (explicit, not simulated)
- **DWG / RVT**: identified but not parsed, because no licensed reader (ODA, Autodesk Platform Services) is
  integrated. The adapter boundary is `ingestion/extract.py::identify_cad`.
- **OCR**: scanned PDFs without a text layer are flagged, but their text is not extracted.
- **Extraction** is rule-based (tables and patterns). Unusual schedule layouts may need manual entry or
  correction. AI-assisted document extraction is not implemented.
- **Equipment positions** in source images are confirmed by people, not detected automatically.
- **Only OpenAI** has a provider adapter. Other providers plug in through the adapter interface.
- The provider's mask is guidance for the model. Pixel retention is guaranteed **only by compositing**, and
  validation verifies it.
- **Costs** are registry estimates. Provider usage data is stored for reconciliation, but the API does not
  return prices.
- **Job queue** is in-process threads. That is suitable for a studio deployment; for horizontal scaling,
  replace it with a separate worker (e.g. RQ/Celery).
- No schema-migration tool yet, and no email or password-reset flow (administrators reset passwords).
