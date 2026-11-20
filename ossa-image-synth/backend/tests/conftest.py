import base64
import io
import json
import os
import re
from pathlib import Path

import httpx
import numpy as np
import pytest
from PIL import Image

EXAMPLES = Path(__file__).resolve().parents[2] / "examples" / "myers-park-halfway-house"
FAKE_KEY = "sk-test-NOT-A-REAL-KEY-1234567890"


class FakeOpenAI:
    """Test double for the OpenAI REST API (used only in tests via httpx.MockTransport)."""

    def __init__(self):
        self.models = ["gpt-image-1", "gpt-image-1-mini", "dall-e-2", "gpt-4.1", "gpt-image-9-unregistered"]
        self.edit_status = 200
        self.calls = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == f"Bearer {FAKE_KEY}"
        if request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": m} for m in self.models]})
        if request.url.path.endswith("/images/edits"):
            if self.edit_status != 200:
                return httpx.Response(self.edit_status, json={"error": {"message": "Invalid value for 'mask'."}})
            body = request.content.decode("latin-1")
            size = re.search(r'name="size"\r\n\r\n([0-9x]+)', body).group(1)
            w, h = (int(v) for v in size.split("x"))
            # Simulate a model that subtly changes EVERYTHING (as real models can) plus a strong edit.
            arr = np.full((h, w, 3), (123, 77, 40), dtype=np.uint8)
            arr[: h // 3] = (230, 230, 225)
            buf = io.BytesIO()
            Image.fromarray(arr).save(buf, "PNG")
            return httpx.Response(200, json={"created": 1, "data": [{"b64_json": base64.b64encode(buf.getvalue()).decode()}],
                                             "usage": {"input_tokens": 100, "output_tokens": 200}})
        return httpx.Response(404, json={"error": {"message": "not found"}})


@pytest.fixture
def fake_openai():
    return FakeOpenAI()


def _make_client(tmp_path, fake=None, key=FAKE_KEY):
    os.environ.update({"IMAGE_SYNTH_DATA_DIR": str(tmp_path), "ADMIN_PASSWORD": "admin-password-1", "RUN_WORKER": "0",
                       "SEED_REFERENCE_PROJECT": "1", "OPENAI_API_KEY": key, "DATABASE_URL": ""})
    from app import config
    config.reload_settings()
    from app.oscillator import engine
    from app.oscillator.providers.openai_adapter import OpenAIAdapter
    engine.reset_discovery()
    transport = httpx.MockTransport(fake.handler) if fake else None
    engine.register_adapter("openai", lambda recorder=None: OpenAIAdapter(api_key=key, base_url="https://api.openai.test/v1",
                                                                         transport=transport, recorder=recorder))
    from fastapi.testclient import TestClient
    from app.main import create_app
    return TestClient(create_app())


class Api:
    def __init__(self, client):
        self.c = client
        self.token = None

    def login(self, email="admin@ossa.studio", password="admin-password-1"):
        r = self.c.post("/api/auth/login", json={"email": email, "password": password})
        assert r.status_code == 200, r.text
        self.token = r.json()["token"]
        return self

    @property
    def h(self):
        return {"Authorization": f"Bearer {self.token}"}

    def get(self, url, **kw):
        return self.c.get(url, headers=self.h, **kw)

    def post(self, url, **kw):
        return self.c.post(url, headers=self.h, **kw)

    def patch(self, url, **kw):
        return self.c.patch(url, headers=self.h, **kw)

    def put(self, url, **kw):
        return self.c.put(url, headers=self.h, **kw)

    def project(self, name="Test Project"):
        r = self.post("/api/projects", json={"name": name})
        assert r.status_code == 200, r.text
        return r.json()["id"]

    def upload(self, pid, path: Path, name=None):
        r = self.post(f"/api/projects/{pid}/documents", files=[("files", (name or path.name, path.read_bytes()))])
        assert r.status_code == 200, r.text
        return r.json()[0]

    def modules(self, pid):
        return self.get(f"/api/projects/{pid}/modules").json()["modules"]

    def records(self, pid, module=None):
        return self.get(f"/api/projects/{pid}/records", params={"module": module} if module else None).json()

    def approve_all(self, pid, module, record_type=None):
        for r in self.records(pid, module):
            if r["status"] == "proposed" and (record_type is None or r["record_type"] == record_type):
                assert self.patch(f"/api/projects/{pid}/records/{r['id']}", json={"status": "approved"}).status_code == 200

    def reject_proposed(self, pid, module):
        for r in self.records(pid, module):
            if r["status"] == "proposed":
                self.patch(f"/api/projects/{pid}/records/{r['id']}", json={"status": "rejected"})

    def accept_mappings(self, pid):
        for d in self.get(f"/api/projects/{pid}/documents").json():
            for m in d["mappings"]:
                if m["status"] == "proposed":
                    self.patch(f"/api/projects/{pid}/mappings/{m['id']}", json={"status": "accepted"})


@pytest.fixture
def client(tmp_path, fake_openai):
    with _make_client(tmp_path, fake_openai) as c:
        yield c


@pytest.fixture
def api(client):
    return Api(client).login()


@pytest.fixture
def make_client():
    return _make_client


def ready_project(api: Api, pid: str, composite=True, with_protected=True, scope="local", instruction=None):
    """Bring a project to an executable state with the sample documents."""
    api.upload(pid, EXAMPLES / "MPCC-HH_Project_Description_SAMPLE.txt")
    api.upload(pid, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv")
    img = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    api.accept_mappings(pid)
    # Project understanding: approve identity + rooms; constraints approved too.
    api.approve_all(pid, "N01")
    api.approve_all(pid, "N02")
    iid = img["source_image_id"]
    assert api.patch(f"/api/projects/{pid}/images/{iid}", json={"status": "authorized"}).status_code == 200
    em = api.post(f"/api/projects/{pid}/images/{iid}/masks", data={"kind": "edit"},
                  files={"file": ("m.png", (EXAMPLES / "mask_cabinet_faces_edit.png").read_bytes())}).json()
    api.patch(f"/api/projects/{pid}/masks/{em['id']}", json={"status": "approved"})
    pm_id = None
    if with_protected:
        pm = api.post(f"/api/projects/{pid}/images/{iid}/masks", data={"kind": "protected"},
                      files={"file": ("p.png", (EXAMPLES / "mask_backsplash_protected.png").read_bytes())}).json()
        api.patch(f"/api/projects/{pid}/masks/{pm['id']}", json={"status": "approved"})
        pm_id = pm["id"]
    er = api.post(f"/api/projects/{pid}/edit-requests", json={
        "source_image_id": iid, "instruction": instruction or "Change the cabinet faces to PL2 wood laminate.",
        "scope": scope, "edit_mask_id": em["id"] if scope == "local" else None, "protected_mask_id": pm_id,
        "composite": composite, "global_authorized": scope == "global"}).json()
    r = api.patch(f"/api/projects/{pid}/edit-requests/{er['id']}", json={"status": "approved"})
    assert r.status_code == 200, r.text
    return {"image_id": iid, "edit_mask_id": em["id"], "protected_mask_id": pm_id, "edit_request_id": er["id"]}


def run_job(api: Api, pid: str, er_id: str):
    plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": er_id}).json()
    assert plan["ready"], json.dumps(plan, indent=1)[:3000]
    r = api.post(f"/api/projects/{pid}/jobs", json={"edit_request_id": er_id,
                                                     "confirm_estimated_cost_usd": plan["selection"]["estimated_cost_usd"]})
    assert r.status_code == 200, r.text
    from app import jobs
    jobs.execute(r.json()["id"])
    return api.get(f"/api/projects/{pid}/jobs/{r.json()['id']}").json()
