from tests.conftest import EXAMPLES, Api


def test_reference_project_records_are_not_validated(api):
    projects = api.get("/api/projects").json()
    ref = next(p for p in projects if p["is_reference"])
    recs = {r["key"]: r for r in api.records(ref["id"], "N02")}
    assert set(recs) == {"P1", "P2", "P3", "P4", "PL2", "SS1", "SS2", "WCP1"}
    assert all(r["origin"] == "reference" and r["status"] == "proposed" for r in recs.values())
    assert api.modules(ref["id"])["N02"]["state"] == "NEEDS_REVIEW"
    qa = api.get(f"/api/projects/{ref['id']}/qa").json()
    lessons = [e["title"] for e in qa["project"] if e["is_lesson"]]
    assert "A PL2 wood laminate must not be replaced with gray paint." in lessons
    assert len(lessons) == 8 and qa["global"]


def test_conflict_between_reference_and_uploaded_schedule(api):
    ref = next(p for p in api.get("/api/projects").json() if p["is_reference"])
    pid = ref["id"]
    path = EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv"
    data = path.read_text().replace("SW 6254 Lazy Gray", "SW 7015 Repose Gray")
    r = api.post(f"/api/projects/{pid}/documents", files=[("files", ("finish_schedule_rev.csv", data.encode()))])
    assert r.status_code == 200
    n02 = api.modules(pid)["N02"]
    conflict = next(q for q in n02["requirements"] if q["id"] == "conflicts")
    assert not conflict["satisfied"] and "P2" in conflict["detail"]


def test_geometry_and_object_additions_blocked(api):
    pid = api.project()
    img = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    iid = img["source_image_id"]
    for text, code in [("Move the window to the left", "geometry_change"), ("Add plants on the counter", "object_addition"),
                       ("Change the camera angle", "geometry_change")]:
        er = api.post(f"/api/projects/{pid}/edit-requests", json={"source_image_id": iid, "instruction": text, "scope": "global",
                                                                   "global_authorized": True}).json()
        assert any(i["code"] == code for i in er["analysis"]["issues"]), text
        assert er["analysis"]["blocking"]


def test_unapproved_finish_reference_blocks(api):
    pid = api.project()
    api.upload(pid, EXAMPLES / "MPCC-HH_Finish_Schedule_SAMPLE.csv")
    img = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    er = api.post(f"/api/projects/{pid}/edit-requests", json={"source_image_id": img["source_image_id"],
                                                               "instruction": "Apply SS2 to the backsplash", "scope": "global",
                                                               "global_authorized": True}).json()
    assert any(i["code"] == "finish_unapproved" for i in er["analysis"]["issues"])
    assert "N02" in er["analysis"]["requires_modules"]


def test_prompt_contains_finish_and_lessons(api):
    ref = next(p for p in api.get("/api/projects").json() if p["is_reference"])
    pid = ref["id"]
    api.approve_all(pid, "N02")
    img = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    er = api.post(f"/api/projects/{pid}/edit-requests", json={"source_image_id": img["source_image_id"],
                                                               "instruction": "Change cabinet doors to PL2"}).json()
    p = er["analysis"]["prompt"]
    assert "PL2: Formica 09312 Planked Urban Oak" in p
    assert "Keep existing slim black separators unless instructed otherwise." in p
    assert "Edit ONLY the transparent (masked) region" in p


def test_cad_files_are_not_falsely_parsed(api):
    pid = api.project()
    r = api.post(f"/api/projects/{pid}/documents", files=[("files", ("model.dwg", b"AC1032" + b"\0" * 100)),
                                                          ("files", ("model.rvt", bytes.fromhex("D0CF11E0A1B11AE1") + b"\0" * 100)),
                                                          ("files", ("virus.exe", b"MZ"))])
    out = r.json()
    assert out[0]["status"] == "unsupported" and "not implemented" in out[0]["error"]
    assert out[1]["status"] == "unsupported" and "Autodesk Platform Services" in out[1]["error"]
    assert "Unsupported file type" in out[2]["error"]
    assert out[0]["mappings"] == []


def test_mask_from_other_image_rejected(api):
    pid = api.project()
    a = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png", name="render_a.png")
    b = api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png", name="render_b.png")
    m = api.post(f"/api/projects/{pid}/images/{a['source_image_id']}/masks", data={"kind": "edit"},
                 files={"file": ("m.png", (EXAMPLES / "mask_cabinet_faces_edit.png").read_bytes())}).json()
    r = api.post(f"/api/projects/{pid}/edit-requests", json={"source_image_id": b["source_image_id"], "instruction": "x",
                                                              "edit_mask_id": m["id"]})
    assert r.status_code == 400
    # Wrong size masks are refused.
    r = api.post(f"/api/projects/{pid}/images/{a['source_image_id']}/masks", data={"kind": "edit"},
                 files={"file": ("m.png", (EXAMPLES / "render_bar_view_SYNTHETIC.png").read_bytes()[:50])})
    assert r.status_code == 400


def test_roles(api, client):
    pid = api.project()
    api.post("/api/admin/users", json={"email": "viewer@ossa.studio", "password": "viewer-password-1"})
    api.post(f"/api/projects/{pid}/members", json={"email": "viewer@ossa.studio", "role": "viewer"})
    v = Api(client).login("viewer@ossa.studio", "viewer-password-1")
    assert v.get(f"/api/projects/{pid}/modules").status_code == 200
    r = v.post(f"/api/projects/{pid}/documents", files=[("files", ("a.txt", b"Project: X"))])
    assert r.status_code == 403
    assert v.get("/api/admin/users").status_code == 403
    assert client.get(f"/api/projects/{pid}").status_code == 401


def test_storage_is_write_once(api, tmp_path):
    import os
    pid = api.project()
    api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")
    api.upload(pid, EXAMPLES / "render_bar_view_SYNTHETIC.png")  # same content → new file, original untouched
    files = list((tmp_path / "projects" / pid / "documents").iterdir())
    assert len(files) == 2
    assert all(not os.access(f, os.W_OK) or os.geteuid() == 0 for f in files)
    assert all((f.stat().st_mode & 0o222) == 0 for f in files)
