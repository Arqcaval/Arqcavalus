"""Acceptance tests from the build directive, section 9."""
import io
import zipfile

import numpy as np
from PIL import Image

from tests.conftest import EXAMPLES, FAKE_KEY, Api, ready_project, run_job


def test_finish_schedule_populates_module_with_cited_records(api):
    pid = api.project()
    doc = api.upload(pid, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv")
    assert doc["doc_type"] == "finish_schedule"
    assert [m["module_key"] for m in doc["mappings"]] == ["N02"]
    recs = {r["key"]: r for r in api.records(pid, "N02")}
    assert set(recs) == {"P1", "P2", "P3", "P4", "PL2", "SS1", "SS2", "WCP1"}
    pl2 = recs["PL2"]
    assert pl2["data"]["manufacturer"] == "Formica"
    assert "Planked Urban Oak" in pl2["data"]["product"]
    assert pl2["data"]["category"] == "laminate"
    assert recs["SS2"]["data"]["category"] == "solid_surface"
    assert recs["P1"]["data"]["category"] == "paint"
    assert recs["WCP1"]["data"]["category"] == "wood_paneling"
    assert pl2["source_ref"] == "row 6" and pl2["document_name"] == "MPCC-HH_Finish_Schedule_SAMPLE.csv"
    assert pl2["evidence"] and pl2["status"] == "proposed" and pl2["origin"] == "parser"
    # Upload alone does not validate.
    assert api.modules(pid)["N02"]["state"] == "NEEDS_REVIEW"
    api.approve_all(pid, "N02")
    assert api.modules(pid)["N02"]["state"] == "VALIDATED"


def test_equipment_schedule_does_not_validate_locations(api):
    pid = api.project()
    api.upload(pid, EXAMPLES / "MPCC-HH_Equipment_Schedule_SAMPLE.csv")
    api.accept_mappings(pid)
    eq = api.records(pid, "N03")
    assert len(eq) == 5 and all(r["data"]["location_verified"] is False for r in eq)
    api.approve_all(pid, "N03")
    n03 = api.modules(pid)["N03"]
    assert n03["state"] == "NEEDS_REVIEW"
    assert any("Equipment plan" in m for m in n03["missing"])
    assert any("location verified" in m for m in n03["missing"])
    # Plan upload proposes evidence but still does not validate.
    plan = api.upload(pid, EXAMPLES / "MPCC-HH_Equipment_Plan_SAMPLE.pdf")
    assert plan["doc_type"] == "equipment_plan"
    api.accept_mappings(pid)
    locs = [r for r in api.records(pid, "N03") if r["record_type"] == "equipment_location"]
    assert {r["key"] for r in locs} == {"FS-01", "FS-02", "FS-03", "FS-04"}  # FS-05 not on plan
    assert api.modules(pid)["N03"]["state"] == "NEEDS_REVIEW"
    api.approve_all(pid, "N03", "equipment_location")
    api.reject_proposed(pid, "N01")
    n03 = api.modules(pid)["N03"]
    assert n03["state"] == "NEEDS_REVIEW"
    assert any("FS-05" in m for m in n03["missing"])  # not found on plan → still unverified
    fs05 = next(r for r in api.records(pid, "N03") if r["key"] == "FS-05" and r["record_type"] == "equipment")
    api.patch(f"/api/projects/{pid}/records/{fs05['id']}", json={"data": {"location_verified": True}})
    assert api.modules(pid)["N03"]["state"] == "VALIDATED"


def test_incomplete_module_lists_missing_requirements(api):
    pid = api.project()
    mods = api.modules(pid)
    for k in ("N01", "N02", "N03", "N05"):
        assert mods[k]["state"] == "EMPTY" and mods[k]["missing"], k
    api.upload(pid, EXAMPLES / "MPCC-HH_Project_Description_SAMPLE.txt")
    n01 = api.modules(pid)["N01"]
    assert n01["state"] == "NEEDS_REVIEW"
    assert "Project identity (name) approved" in n01["missing"][0]


def test_project_isolation(api, client):
    a = api.project("Project A")
    b = api.project("Project B")
    doc = api.upload(a, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv")
    img = api.upload(a, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    assert api.records(b) == []
    assert api.get(f"/api/projects/{b}/documents").json() == []
    assert api.get(f"/api/projects/{b}/documents/{doc['id']}").status_code == 404
    assert api.get(f"/api/projects/{b}/documents/{doc['id']}/file").status_code == 404
    assert api.get(f"/api/projects/{b}/images/{img['source_image_id']}/file").status_code == 404
    rid = api.records(a)[0]["id"]
    assert api.patch(f"/api/projects/{b}/records/{rid}", json={"status": "approved"}).status_code == 404
    # B cannot build an edit request on A's image, nor resolve A's finish codes.
    r = api.post(f"/api/projects/{b}/edit-requests", json={"source_image_id": img["source_image_id"], "instruction": "PL2"})
    assert r.status_code == 404
    api.upload(b, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    bimg = api.get(f"/api/projects/{b}/images").json()[0]
    er = api.post(f"/api/projects/{b}/edit-requests", json={"source_image_id": bimg["id"], "instruction": "Apply PL2 to cabinets",
                                                             "scope": "global", "global_authorized": True}).json()
    assert any(i["code"] == "finish_unknown" for i in er["analysis"]["issues"])
    # A non-member cannot see project A at all.
    api.post("/api/admin/users", json={"email": "other@ossa.studio", "password": "other-password-1"})
    other = Api(client).login("other@ossa.studio", "other-password-1")
    assert other.get(f"/api/projects/{a}").status_code == 404
    assert other.get("/api/projects").json() == []


def test_manual_classification_override(api):
    pid = api.project()
    doc = api.upload(pid, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv", name="schedule.csv")
    assert doc["doc_type"] == "finish_schedule"
    r = api.patch(f"/api/projects/{pid}/documents/{doc['id']}", json={"doc_type": "project_description", "reason": "test"})
    assert r.status_code == 200
    d = r.json()
    assert d["doc_type"] == "project_description" and d["classification_source"] == "manual"
    assert [m["module_key"] for m in d["mappings"]] == ["N01"]
    assert api.records(pid, "N02") == []  # unreviewed proposals from the old classification removed
    qa = api.get(f"/api/projects/{pid}/qa").json()["project"]
    assert any(e["category"] == "user_correction" and "reclassified" in e["title"] for e in qa)
    # Reprocessing keeps the manual choice.
    assert api.post(f"/api/projects/{pid}/documents/{doc['id']}/reprocess").json()["doc_type"] == "project_description"


def test_source_unchanged_mask_required_and_composite_retains_pixels(api, fake_openai):
    pid = api.project()
    st = ready_project(api, pid, composite=True)
    src_bytes = (EXAMPLES / "render_bar_view_SYNTHETIC.png").read_bytes()
    job = run_job(api, pid, st["edit_request_id"])
    assert job["status"] == "succeeded", job
    assert ("POST", "/v1/images/edits") in fake_openai.calls
    # Source image stored unchanged.
    v = api.get(f"/api/projects/{pid}/images/{st['image_id']}/verify").json()
    assert v["unchanged"]
    assert api.get(f"/api/projects/{pid}/images/{st['image_id']}/file").content == src_bytes
    gen = api.get(f"/api/projects/{pid}/generations").json()[0]
    checks = {c["id"]: c for c in gen["validation"]["checks"]}
    assert checks["outside_region"]["passed"] and "VERIFIED pixel-identical" in checks["outside_region"]["detail"]
    assert checks["protected"]["passed"] and checks["edit_visible"]["passed"]
    # Independently verify pixel retention outside the mask.
    src = np.asarray(Image.open(io.BytesIO(src_bytes)).convert("RGB"))
    out = np.asarray(Image.open(io.BytesIO(api.get(f"/api/projects/{pid}/generations/{gen['id']}/file").content)).convert("RGB"))
    mask = np.asarray(Image.open(EXAMPLES / "mask_cabinet_faces_edit.png")) > 127
    assert out.shape == src.shape
    assert np.array_equal(out[~mask], src[~mask])
    assert not np.array_equal(out[mask], src[mask])
    # The raw provider output is kept separately and does differ outside the mask.
    raw = api.get(f"/api/projects/{pid}/generations/{gen['id']}/file", params={"variant": "raw"})
    assert raw.status_code == 200
    for variant in ("diff", "mask", "source"):
        assert api.get(f"/api/projects/{pid}/generations/{gen['id']}/file", params={"variant": variant}).status_code == 200


def test_local_edit_without_mask_is_blocked(api):
    pid = api.project()
    img = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    er = api.post(f"/api/projects/{pid}/edit-requests", json={"source_image_id": img["source_image_id"],
                                                               "instruction": "Make the cabinet faces lighter", "scope": "local"}).json()
    assert any(i["code"] == "mask_missing" for i in er["analysis"]["issues"])
    r = api.patch(f"/api/projects/{pid}/edit-requests/{er['id']}", json={"status": "approved"})
    assert r.status_code == 409


def test_non_composited_output_blocks_approval_until_override(api):
    pid = api.project()
    st = ready_project(api, pid, composite=False)
    assert run_job(api, pid, st["edit_request_id"])["status"] == "succeeded"
    gen = api.get(f"/api/projects/{pid}/generations").json()[0]
    assert not gen["validation"]["automated_passed"]
    assert gen["approval_blocked"]
    r = api.post(f"/api/projects/{pid}/generations/{gen['id']}/decision", json={"decision": "approve"})
    assert r.status_code == 409
    r = api.post(f"/api/projects/{pid}/generations/{gen['id']}/decision",
                 json={"decision": "approve", "override_reason": "Client accepts global relight for concept review"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    qa = api.get(f"/api/projects/{pid}/qa").json()["project"]
    assert any(e["category"] == "override" for e in qa)
    assert any(e["category"] == "unauthorized_edit" for e in qa)


def test_compare_accept_reject_and_revise(api):
    pid = api.project()
    st = ready_project(api, pid)
    run_job(api, pid, st["edit_request_id"])
    gen = api.get(f"/api/projects/{pid}/generations").json()[0]
    assert gen["validation"]["automated_passed"] and not gen["checklist_complete"]
    assert api.post(f"/api/projects/{pid}/generations/{gen['id']}/decision", json={"decision": "approve"}).status_code == 409
    items = {i["id"]: True for i in gen["checklist"]["items"]}
    assert "finish_PL2" in items
    api.patch(f"/api/projects/{pid}/generations/{gen['id']}/checklist", json={"items": items})
    r = api.post(f"/api/projects/{pid}/generations/{gen['id']}/decision", json={"decision": "approve", "reason": "matches PL2"})
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert api.modules(pid)["N08"]["state"] == "VALIDATED"
    # Second iteration: reject, then revise.
    run_job(api, pid, st["edit_request_id"])
    g2 = api.get(f"/api/projects/{pid}/generations").json()[0]
    assert g2["version"] == 2
    r = api.post(f"/api/projects/{pid}/generations/{g2['id']}/decision",
                 json={"decision": "revise", "reason": "grain direction wrong", "qa_category": "material_error",
                       "revised_instruction": "Change the cabinet faces to PL2 with horizontal grain."})
    assert r.status_code == 200 and r.json()["status"] == "revision_requested" and r.json()["new_edit_request_id"]
    qa = api.get(f"/api/projects/{pid}/qa").json()["project"]
    assert any(e["category"] == "material_error" for e in qa) and any(e["category"] == "approved_result" for e in qa)
    z = zipfile.ZipFile(io.BytesIO(api.get(f"/api/projects/{pid}/export").content))
    names = z.namelist()
    assert "project.json" in names and any(n.startswith("approved/") for n in names)
    assert FAKE_KEY not in z.read("project.json").decode()


def test_oscillator_auto_and_manual(api):
    pid = api.project()
    st = ready_project(api, pid)
    plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()
    assert plan["selection"]["mode"] == "auto" and plan["selection"]["model"] == "gpt-image-1"
    cands = {c["model"]: c for c in plan["selection"]["candidates"]}
    assert not cands["dall-e-2"]["compatible"] and any("square" in r for r in cands["dall-e-2"]["reasons"])
    assert not cands["gpt-4.1"]["compatible"] and any("does not support 'image_edit'" in r for r in cands["gpt-4.1"]["reasons"])
    assert not cands["gpt-4o"]["available"]  # registered but not returned by discovery
    assert any("not in the capability registry" in r for r in cands["gpt-image-9-unregistered"]["reasons"])
    # Manual: compatible model
    api.put(f"/api/projects/{pid}/oscillator", json={"mode": "manual", "manual_provider": "openai", "manual_model": "gpt-image-1-mini"})
    plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()
    assert plan["ready"] and plan["selection"]["model"] == "gpt-image-1-mini" and plan["selection"]["mode"] == "manual"
    # Manual: incompatible model → explained, no automatic switch, job blocked.
    api.put(f"/api/projects/{pid}/oscillator", json={"mode": "manual", "manual_provider": "openai", "manual_model": "dall-e-2"})
    plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()
    assert not plan["ready"] and "square" in plan["selection"]["error"]
    assert plan["selection"]["suggested_alternative"]["model"] == "gpt-image-1"
    r = api.post(f"/api/projects/{pid}/jobs", json={"edit_request_id": st["edit_request_id"], "confirm_estimated_cost_usd": 0})
    assert r.status_code == 409
    api.put(f"/api/projects/{pid}/oscillator", json={"mode": "auto"})
    assert api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()["selection"]["mode"] == "auto"


def test_provider_failure_is_visible_without_output(api, fake_openai):
    pid = api.project()
    st = ready_project(api, pid)
    fake_openai.edit_status = 400
    job = run_job(api, pid, st["edit_request_id"])
    assert job["status"] == "failed" and "Invalid value for 'mask'" in job["error"]
    assert api.get(f"/api/projects/{pid}/generations").json() == []
    assert api.modules(pid)["N08"]["state"] == "ERROR"
    calls = api.get(f"/api/projects/{pid}/audit").json()["provider_calls"]
    assert any(c["operation"] == "image_edit" and c["response_status"] == 400 for c in calls)
    assert all(FAKE_KEY not in str(c) for c in calls)


def test_no_credentials_blocks_execution(tmp_path, make_client):
    with make_client(tmp_path, None, key="") as c:
        api = Api(c).login()
        pid = api.project()
        st = ready_project(api, pid)
        mods = api.modules(pid)
        assert mods["N07"]["state"] == "EMPTY"
        assert any("credentials" in m.lower() for m in mods["N07"]["missing"])
        plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()
        assert not plan["ready"] and any(b["module"] == "N07" for b in plan["gate"]["blockers"])
        r = api.post(f"/api/projects/{pid}/jobs", json={"edit_request_id": st["edit_request_id"], "confirm_estimated_cost_usd": 0})
        assert r.status_code == 409


def test_state_survives_restart(tmp_path, fake_openai, make_client):
    with make_client(tmp_path, fake_openai) as c:
        api = Api(c).login()
        pid = api.project("Persistent")
        api.upload(pid, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv")
        api.approve_all(pid, "N02")
        api.put(f"/api/projects/{pid}/canvas", json={"canvas": {"nodes": [{"id": "N02", "position": {"x": 5, "y": 6}}]}})
        api.put(f"/api/projects/{pid}/oscillator", json={"mode": "manual", "manual_provider": "openai", "manual_model": "gpt-image-1"})
        token = api.token
    with make_client(tmp_path, fake_openai) as c2:
        api2 = Api(c2)
        api2.token = token  # session also persists
        p = api2.get(f"/api/projects/{pid}").json()
        assert p["canvas"]["nodes"][0]["position"] == {"x": 5, "y": 6}
        assert p["oscillator"]["mode"] == "manual"
        assert api2.modules(pid)["N02"]["state"] == "VALIDATED"


def test_interrupted_job_marked_failed_on_restart(tmp_path, fake_openai, make_client):
    with make_client(tmp_path, fake_openai) as c:
        api = Api(c).login()
        pid = api.project()
        st = ready_project(api, pid)
        plan = api.post(f"/api/projects/{pid}/oscillator/plan", json={"edit_request_id": st["edit_request_id"]}).json()
        jid = api.post(f"/api/projects/{pid}/jobs", json={"edit_request_id": st["edit_request_id"],
                                                           "confirm_estimated_cost_usd": plan["selection"]["estimated_cost_usd"]}).json()["id"]
        from app.db import session_scope
        from app.models import Job
        with session_scope() as db:
            db.get(Job, jid).status = "running"
        from app import jobs
        jobs.recover_interrupted()
        j = api.get(f"/api/projects/{pid}/jobs/{jid}").json()
        assert j["status"] == "failed" and "Interrupted" in j["error"]
