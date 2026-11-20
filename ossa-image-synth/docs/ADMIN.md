# Image Synth: administrator guide

## Requirements
- Docker 24+ with Compose v2. Or Python 3.11+ and Node 20+ to run without containers.
- An **OpenAI API key** from platform.openai.com with access to an image-editing model such as `gpt-image-1`.
  A ChatGPT Plus/Pro/Team subscription does **not** include API access. Image Synth uses only the official API
  with an API key; it never uses ChatGPT sessions or cookies. Some OpenAI image models require organisation
  verification in the OpenAI dashboard before your key can use them. If so, discovery will not list them.

## Install
```bash
git clone <your repository> image-synth && cd image-synth
cp .env.example .env
python3 -c "import secrets;print(secrets.token_urlsafe(48))"   # paste into SECRET_KEY
# set ADMIN_EMAIL, ADMIN_PASSWORD (≥10 chars), OPENAI_API_KEY
docker compose up -d --build
docker compose logs -f image-synth        # wait for "Application startup complete"
```
Open `http://<host>:8000`. If `ADMIN_PASSWORD` is empty on first start, a random password is written to
`/data/INITIAL_ADMIN_PASSWORD.txt` in the volume:
`docker compose exec image-synth cat /data/INITIAL_ADMIN_PASSWORD.txt`.

If Docker Hub rate-limits base-image pulls, build through a mirror:
`docker compose build --build-arg REGISTRY=mirror.gcr.io/library/`.

## Configuration (`.env`)
| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Hashes session tokens. Changing it signs everyone out. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First administrator; only used when that account does not exist yet. |
| `OPENAI_API_KEY`, `OPENAI_ORG_ID`, `OPENAI_BASE_URL` | Provider credentials. Held only in the server process; never sent to browsers, never written to the database or exports. |
| `MAX_UPLOAD_MB`, `MAX_IMAGE_PIXELS` | Upload limits. |
| `MAX_CONCURRENT_JOBS` | Worker threads and the per-project limit on running jobs. |
| `MAX_COST_PER_JOB_USD`, `DEFAULT_PROJECT_BUDGET_USD` | Cost safeguards. Each project's budget can be changed in Team & settings. |
| `DATABASE_URL` | Default is SQLite in `/data`. PostgreSQL works via SQLAlchemy; add the `psycopg[binary]` driver. |
| `SEED_REFERENCE_PROJECT` | `1` creates the Myers Park reference project on first start. |

After changing `.env`, run `docker compose up -d` to apply it.

## Users and roles
Create accounts in **Team & settings → User accounts**, or from the CLI:
```bash
docker compose exec image-synth python -m app.cli create-user jack@ossa.studio "Jack Ossa"   # prints a temporary password
docker compose exec image-synth python -m app.cli list-projects
docker compose exec image-synth python -m app.cli add-member jack@ossa.studio <project-id> owner
docker compose exec image-synth python -m app.cli reset-password jack@ossa.studio
```
Project roles:
- **owner**: everything, including members, budget and overriding failed checks.
- **editor**: upload, review records, draw masks, edit requests, run jobs.
- **reviewer**: approve, reject or revise outputs, override failed checks with a reason, QA log.
- **viewer**: read only.

Administrators see every project, and also manage users, global rules and the capability registry.

## Sharing the application with Jack
Image Synth is a web app, so Jack needs only a browser and an account.
1. **Same office network:** run it on a studio machine or server. Jack opens `http://<server-ip>:8000`.
2. **Over the internet, recommended:** run it on a small cloud VM (2 vCPU / 4 GB is enough; images go to the
   provider). Point a DNS name at the VM, set `DOMAIN=synth.example.com` in `.env`, and run
   `docker compose --profile https up -d`. Caddy obtains a TLS certificate automatically. Share
   `https://synth.example.com`. Open ports 80 and 443 only.
3. **Private access without a public server:** put the host on Tailscale or another VPN and share the tailnet
   address.

Then create Jack's account. Make him an administrator if he should manage users. Send him the URL and his
temporary password through a separate channel, and ask him to change it under **Team & settings → My password**.
Do not expose port 8000 to the internet without HTTPS.

## Oscillator capability registry
**Team & settings → Oscillator capability registry** is a JSON list of models and what each can do:
operations, mask support, accepted formats, output sizes, quality levels, whether it requires square input,
the evaluation `score`, and cost estimates. Edits are saved to `/data/capability_registry.json`; the copy
shipped with the app is never changed.

Rules the engine enforces:
- A model is selectable only if it is in the registry **and** returned by the provider's `/models` discovery for
  your key.
- AUTO BEST ranks by `score` plus a bounded, visible adjustment from this project's recorded approvals,
  rejections and failures. Release date plays no part.
- Discovered image models that are not registered appear as "capabilities unknown" and are never used until
  you add them.
- Cost figures are planning estimates. Check them against OpenAI's current pricing and update them.

When OpenAI releases a new image model, add an entry with conservative values. Run evaluations in a test
project, then raise its `score` if it preserves geometry and materials better.

### Adding another provider
Implement `ProviderAdapter` (`backend/app/oscillator/providers/base.py`) and register it with
`engine.register_adapter("name", factory)`. Then add registry entries with `"provider": "name"`. Adapters
must raise `UnsupportedOperation` rather than fabricate output.

## Backups
Everything lives in the `synth-data` volume: the database, write-once project files, the registry override,
and the initial admin password. Back it up while the app is running:
```bash
docker run --rm -v image-synth_synth-data:/data -v "$PWD":/backup alpine tar czf /backup/synth-$(date +%F).tgz -C /data .
```
To restore, stop the stack, extract the archive into an empty volume, and start the stack again.

## Upgrades
`git pull && docker compose up -d --build`. The schema is created automatically. The current release has no
migration tool, so back up before upgrading.

## Auditing
**Audit & provider calls** shows every action and every provider request for the project: operation, model,
HTTP status, duration, parameters and sizes. Image bytes and keys are never recorded. The project export ZIP
contains the same data.

## End-to-end test
```bash
python backend/tests/fake_openai_server.py 8099 &          # test double, used only for this test
IMAGE_SYNTH_DATA_DIR=/tmp/e2e ADMIN_PASSWORD=admin-password-1 OPENAI_API_KEY=sk-test \
  OPENAI_BASE_URL=http://127.0.0.1:8099/v1 STATIC_DIR=frontend/dist \
  uvicorn app.main:app --app-dir backend --port 8010 &
node e2e/workflow.e2e.cjs http://localhost:8010 /tmp/shots   # needs the 'playwright' npm package + Chromium
```
