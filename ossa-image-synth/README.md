# OSSA Studio — Image Synth

A browser-based, document-grounded node editor for architectural visualization. Project documents (drawings,
finish schedules, equipment schedules, specifications) control AI-assisted editing of source renders such as
Enscape images. The source image is the visual authority: edits are local by default, confined to an approved
mask, composited back onto the untouched original, measured, and submitted for human approval.

## What it does

| Node | Purpose | Implemented behaviour |
|---|---|---|
| 09 Document Intake & Module Mapping | Central upload | Drag-and-drop for PDF, PNG, JPEG, WEBP, CSV, XLSX, TXT/MD. Rule-based classification with visible evidence and a confidence value. Proposed module mappings must be accepted. Manual reclassification is logged. DWG/RVT are stored and identified but **not parsed**. |
| 01 Project Understanding | Identity, rooms, sheets, constraints | Extracts `Project:`/`Client:`/… fields, numbered rooms, sheet references, and constraint language, each with a line reference. |
| 02 Finish Schedule Intelligence | Finish codes → products | Table and free-text parsing. Classifies paint, laminate, solid surface, tile, wood paneling and other materials from the code prefix plus the description, and flags disagreements. Detects conflicting records for the same code. Finishes come only from documents or user entries. |
| 03 Equipment & Food Service | Equipment IDs, models, locations | Parses equipment schedules. A schedule never validates locations: an equipment plan must be accepted, and a person must verify each location. |
| 04 Visual Intent Engine | Instruction → constrained job | Categorises the request, resolves finish codes against approved records, blocks geometry changes, unapproved object additions and unauthorised global edits, applies project lessons, and builds the provider prompt. |
| 05 Source Image Integrity | Authorised renders + masks | Write-once storage verified by SHA-256. Native-resolution mask editor (edit and protected regions). Masks need approval. |
| 07 Oscillator / AI Engine | Provider orchestration | Modular provider adapters (OpenAI implemented), model discovery via the provider's API, an editable capability registry, AUTO BEST or MANUAL selection, compatibility explanations, cost caps and budgets, a background job queue, and an audit of every provider call. |
| 08 Output & Validation | Compare and decide | Before/after slider, side by side, overlay, difference, mask and raw-output views. Measured outside-mask and protected-region change detection. Finish checklist. Approval is blocked on failures unless an owner or reviewer records an override reason. Version history and ZIP export. |
| 06 Learning & QA Log | Reviewable history | Corrections, failures, approvals, overrides and unauthorised-edit detections are logged automatically. Lessons are kept per project, separately from global rules, and are applied to prompts. |

## Quick start (Docker)

```bash
cp .env.example .env        # set SECRET_KEY, ADMIN_PASSWORD, OPENAI_API_KEY
docker compose up -d --build
open http://localhost:8000  # sign in with ADMIN_EMAIL / ADMIN_PASSWORD
```

Without `OPENAI_API_KEY` everything works except image generation. The Oscillator shows "credentials not
configured" and execution stays blocked. No output is ever simulated.

## Local development

```bash
# backend
cd backend && python -m venv .venv && . .venv/bin/activate && pip install -r requirements-dev.txt
ADMIN_PASSWORD=admin-password-1 uvicorn app.main:app --reload --port 8000
# frontend (separate shell)
cd frontend && npm install && npm run dev      # http://localhost:5173 (proxies /api to :8000)
```

## Tests

```bash
cd backend && python -m pytest -q          # 23 API/acceptance tests (mock OpenAI transport)
cd frontend && npm test                    # unit tests
# end-to-end browser workflow against a running server — see docs/ADMIN.md#end-to-end-test
node e2e/workflow.e2e.cjs http://localhost:8000 /tmp/shots
```

## Documentation

- [docs/USER_GUIDE.md](docs/USER_GUIDE.md): the workflow for designers (Jack's guide).
- [docs/ADMIN.md](docs/ADMIN.md): installation, configuration, users, backups, sharing, the capability registry.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): design, data model, security, and known limitations.

## Sample data

`examples/myers-park-halfway-house/` holds **sample** documents. The finish codes and products come from
the OSSA reference list. Room names, locations, equipment items and the render are **fictional** and exist only
for demonstration and tests. `render_bar_view_SYNTHETIC.png` is a flat synthetic image, not an Enscape render.
