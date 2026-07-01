"""
Integration tests for /api/save_sphere, /api/match, and /api/project/subject endpoints.
"""
import json
import os
import time
from pathlib import Path
import pytest
import igl
import numpy as np

PROJ    = "/Volumes/T7/Documents/2026_06MatchMaker/data/external/project"
F02_PLY = f"{PROJ}/data/raw/meshes/F02_P0/mesh.ply"
F06_PLY = f"{PROJ}/data/raw/meshes/F06_P4/mesh.ply"
F02_ANN = f"{PROJ}/data/derived/annotations/F02_P0"
F06_ANN = f"{PROJ}/data/derived/annotations/F06_P4"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _icosphere():
    """Return a tiny icosphere (vertices, faces) as flat lists."""
    t = (1 + 5 ** 0.5) / 2
    raw = [
        [-1,  t,  0], [ 1,  t,  0], [-1, -t,  0], [ 1, -t,  0],
        [ 0, -1,  t], [ 0,  1,  t], [ 0, -1, -t], [ 0,  1, -t],
        [ t,  0, -1], [ t,  0,  1], [-t,  0, -1], [-t,  0,  1],
    ]
    verts = []
    for x, y, z in raw:
        n = (x**2 + y**2 + z**2) ** 0.5
        verts.extend([x / n, y / n, z / n])
    faces = [
        0, 11,  5,   0,  5,  1,   0,  1,  7,   0,  7, 10,   0, 10, 11,
        1,  5,  9,   5, 11,  4,  11, 10,  2,  10,  7,  6,   7,  1,  8,
        3,  9,  4,   3,  4,  2,   3,  2,  6,   3,  6,  8,   3,  8,  9,
        4,  9,  5,   2,  4, 11,   6,  2, 10,   8,  6,  7,   9,  8,  1,
    ]
    return verts, faces


# ---------------------------------------------------------------------------
# test_save_sphere_endpoint
# ---------------------------------------------------------------------------

def test_save_sphere_endpoint(client, tmp_path):
    out_path = str(tmp_path / "test.sphere.ply")
    verts, faces = _icosphere()

    resp = client.post(
        "/api/save_sphere",
        data=json.dumps({"path": out_path, "vertices": verts, "faces": faces}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["path"] == out_path

    # File must exist and be readable as a triangle mesh
    import os
    assert os.path.exists(out_path)
    V, F = igl.read_triangle_mesh(out_path)
    assert V.shape == (12, 3)
    assert F.shape == (20, 3)


# ---------------------------------------------------------------------------
# test_match_endpoint_returns_job
# ---------------------------------------------------------------------------

def test_match_endpoint_returns_job(client, tmp_path):
    out_dir = str(tmp_path / "match_out")

    # Use e2.sphere.ply as a stand-in for morph.sphere.ply (valid PLY exists)
    morph_path = f"{F02_ANN}/sphere.ply"

    payload = {
        "ref_ply":      F02_PLY,
        "ref_sphere":   f"{F02_ANN}/sphere.ply",
        "ref_rot":      f"{F02_ANN}/rotation.txt",
        "mov_ply":      F06_PLY,
        "mov_sphere":   f"{F06_ANN}/sphere.ply",
        "mov_rot":      f"{F06_ANN}/rotation.txt",
        "morph_sphere": morph_path,
        "out_dir":      out_dir,
        "k":            20,
        "nsteps":       1,
    }

    resp = client.post(
        "/api/match",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert "job_id" in body

    # Poll until job leaves "queued" state (should be near-instant)
    job_id = body["job_id"]
    deadline = time.time() + 5
    status = "queued"
    while time.time() < deadline and status == "queued":
        r = client.get(f"/api/jobs/{job_id}")
        status = r.get_json()["status"]
        time.sleep(0.1)

    assert status in ("running", "done", "error"), f"Unexpected status: {status}"


def test_match_rejects_out_of_range_k(client, tmp_path):
    out_dir = str(tmp_path / "match_out")
    payload = {
        "ref_ply":      F02_PLY,
        "ref_sphere":   f"{F02_ANN}/sphere.ply",
        "mov_ply":      F06_PLY,
        "mov_sphere":   f"{F06_ANN}/sphere.ply",
        "morph_sphere": f"{F02_ANN}/sphere.ply",
        "out_dir":      out_dir,
        "k":            99999,
    }
    resp = client.post(
        "/api/match",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_match_rejects_non_integer_nsteps(client, tmp_path):
    out_dir = str(tmp_path / "match_out")
    payload = {
        "ref_ply":      F02_PLY,
        "ref_sphere":   f"{F02_ANN}/sphere.ply",
        "mov_ply":      F06_PLY,
        "mov_sphere":   f"{F06_ANN}/sphere.ply",
        "morph_sphere": f"{F02_ANN}/sphere.ply",
        "out_dir":      out_dir,
        "nsteps":       "abc",
    }
    resp = client.post(
        "/api/match",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# test_match_creates_output_files  (slow — runs matchmesh2 end-to-end)
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# GET /api/matches
# ---------------------------------------------------------------------------

def test_list_matches_empty(client, tmp_path):
    resp = client.get(f"/api/matches?project_root={tmp_path}")
    assert resp.status_code == 200
    assert resp.get_json() == []


def test_list_matches_no_project_root(client):
    resp = client.get("/api/matches")
    assert resp.status_code == 400


def test_list_matches_structure(client, tmp_path):
    match_dir = tmp_path / "data" / "derived" / "matches" / "F06_P4_as_F02_P0"
    match_dir.mkdir(parents=True)
    (match_dir / "morph.sphere.ply").write_bytes(b"PLY")

    resp = client.get(f"/api/matches?project_root={tmp_path}")
    assert resp.status_code == 200
    data = resp.get_json()
    assert len(data) == 1
    m = data[0]
    assert m["name"] == "F06_P4_as_F02_P0"
    assert m["mov_id"] == "F06_P4"
    assert m["ref_id"] == "F02_P0"
    assert m["has_morph"] is True
    assert m["has_match"] is False
    assert m["dir"] == str(match_dir)


def test_list_matches_complete(client, tmp_path):
    match_dir = tmp_path / "data" / "derived" / "matches" / "F10_P8_as_F02_P0"
    match_dir.mkdir(parents=True)
    (match_dir / "morph.sphere.ply").write_bytes(b"PLY")
    (match_dir / "surf.0.ply").write_bytes(b"PLY")

    resp = client.get(f"/api/matches?project_root={tmp_path}")
    data = resp.get_json()
    assert data[0]["has_match"] is True


def test_list_matches_reads_params(client, tmp_path):
    match_dir = tmp_path / "data" / "derived" / "matches" / "F06_P4_as_F02_P0"
    match_dir.mkdir(parents=True)
    params = {"ref_id": "F02_P0", "mov_id": "F06_P4", "match": {"k": 50}}
    (match_dir / "params.json").write_text(json.dumps(params))

    resp = client.get(f"/api/matches?project_root={tmp_path}")
    data = resp.get_json()
    assert data[0]["params"]["match"]["k"] == 50


# ---------------------------------------------------------------------------
# DELETE /api/project/match
# ---------------------------------------------------------------------------

def test_delete_match_endpoint(client, tmp_path):
    match_dir = tmp_path / "data" / "derived" / "matches" / "F06_P4_as_F02_P0"
    match_dir.mkdir(parents=True)
    (match_dir / "surf.0.ply").write_bytes(b"PLY")

    resp = client.delete(
        "/api/project/match",
        data=json.dumps({"match_dir": str(match_dir)}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    assert not match_dir.exists()


def test_delete_match_missing_body(client):
    resp = client.delete(
        "/api/project/match",
        data=json.dumps({}),
        content_type="application/json",
    )
    assert resp.status_code == 400


def test_delete_match_safety_check(client, tmp_path):
    bad_dir = tmp_path / "some_random_dir"
    bad_dir.mkdir()
    resp = client.delete(
        "/api/project/match",
        data=json.dumps({"match_dir": str(bad_dir)}),
        content_type="application/json",
    )
    assert resp.status_code == 400
    assert bad_dir.exists()


# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_match_creates_output_files(client, tmp_path):
    import os

    # Save morph sphere (use F06 sphere as initial guess)
    morph_path = str(tmp_path / "morph.sphere.ply")
    V, F = igl.read_triangle_mesh(f"{F06_ANN}/sphere.ply")
    verts_flat = V.flatten().tolist()
    faces_flat = F.flatten().tolist()

    resp = client.post(
        "/api/save_sphere",
        data=json.dumps({"path": morph_path, "vertices": verts_flat, "faces": faces_flat}),
        content_type="application/json",
    )
    assert resp.status_code == 200

    out_dir = str(tmp_path / "match_out")
    payload = {
        "ref_ply":      F02_PLY,
        "ref_sphere":   f"{F02_ANN}/sphere.ply",
        "ref_rot":      f"{F02_ANN}/rotation.txt",
        "mov_ply":      F06_PLY,
        "mov_sphere":   f"{F06_ANN}/sphere.ply",
        "mov_rot":      f"{F06_ANN}/rotation.txt",
        "morph_sphere": morph_path,
        "out_dir":      out_dir,
        "k":            20,
        "nsteps":       1,
    }

    resp = client.post(
        "/api/match",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 200
    job_id = resp.get_json()["job_id"]

    # Poll until done or error (allow up to 2 min for real matchmesh run)
    deadline = time.time() + 120
    status = "queued"
    while time.time() < deadline and status not in ("done", "error"):
        r = client.get(f"/api/jobs/{job_id}")
        d = r.get_json()
        status = d["status"]
        time.sleep(2)

    assert status == "done", f"Job ended with status={status}"
    assert os.path.exists(os.path.join(out_dir, "surf.0.ply"))


# ---------------------------------------------------------------------------
# test_remove_subject_endpoint
# ---------------------------------------------------------------------------

def test_remove_subject_endpoint(client, tmp_path):
    """DELETE /api/project/subject removes subject from project.json and filesystem."""
    # Create project with two subjects using the icosphere as a stand-in mesh
    verts, faces = _icosphere()
    sphere_path = str(tmp_path / "ico.ply")
    client.post("/api/save_sphere", json={"path": sphere_path, "vertices": verts, "faces": faces})

    project_root = str(tmp_path / "proj")
    resp = client.post("/api/project/create", json={
        "root_dir":         project_root,
        "ref_id":           "SubA",
        "ref_source_path":  sphere_path,
        "mov_id":           "SubB",
        "mov_source_path":  sphere_path,
    })
    assert resp.status_code == 200

    mesh_a = os.path.join(project_root, "data", "raw", "meshes", "SubA")
    mesh_b = os.path.join(project_root, "data", "raw", "meshes", "SubB")
    ann_b  = os.path.join(project_root, "data", "derived", "annotations", "SubB")
    assert os.path.isdir(mesh_b)

    # Remove SubB
    r = client.delete("/api/project/subject", json={
        "project_root": project_root,
        "subject_id":   "SubB",
    })
    assert r.status_code == 200
    data = r.get_json()
    assert data["removed"] == "SubB"

    # Filesystem cleaned up
    assert not os.path.exists(mesh_b)
    assert not os.path.exists(ann_b)
    # SubA untouched
    assert os.path.isdir(mesh_a)

    # project.json updated
    proj_file = os.path.join(project_root, "project.json")
    project   = json.loads(open(proj_file).read())
    assert "SubB" not in project["subjects"]
    assert "SubA" in project["subjects"]


def test_remove_subject_not_found(client, tmp_path):
    """DELETE with unknown subject_id returns 400."""
    verts, faces = _icosphere()
    sphere_path = str(tmp_path / "ico.ply")
    client.post("/api/save_sphere", json={"path": sphere_path, "vertices": verts, "faces": faces})

    project_root = str(tmp_path / "proj2")
    client.post("/api/project/create", json={
        "root_dir":        project_root,
        "ref_id":          "SubA",
        "ref_source_path": sphere_path,
    })

    r = client.delete("/api/project/subject", json={
        "project_root": project_root,
        "subject_id":   "NonExistent",
    })
    assert r.status_code == 400


def test_remove_subject_no_project(client, tmp_path):
    """DELETE returns 404 when project.json is absent."""
    r = client.delete("/api/project/subject", json={
        "project_root": str(tmp_path / "no_such_project"),
        "subject_id":   "SubA",
    })
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/files
# ---------------------------------------------------------------------------

def test_api_files_lists_directory(client, tmp_path):
    (tmp_path / "sub").mkdir()
    (tmp_path / "file.txt").write_text("hello")

    resp = client.get("/api/files")
    assert resp.status_code == 200
    entries = resp.get_json()

    by_name = {e["name"]: e for e in entries}
    assert by_name["sub"]["is_dir"] is True
    assert by_name["sub"]["size"] is None
    assert by_name["file.txt"]["is_dir"] is False
    assert by_name["file.txt"]["size"] == 5
    assert by_name["file.txt"]["path"] == str(tmp_path / "file.txt")


def test_api_files_rejects_non_directory(client, tmp_path):
    f = tmp_path / "file.txt"
    f.write_text("hello")
    resp = client.get(f"/api/files?dir={f}")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/config
# ---------------------------------------------------------------------------

def test_api_config_returns_data_root(client, tmp_path):
    resp = client.get("/api/config")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["data_root"] == str(tmp_path.resolve())


# ---------------------------------------------------------------------------
# GET /api/mesh_raw
# ---------------------------------------------------------------------------

def test_api_mesh_raw_returns_vertices_faces(client):
    resp = client.get(f"/api/mesh_raw?path={F02_PLY}")
    assert resp.status_code == 200
    body = resp.get_json()

    V, F = igl.read_triangle_mesh(F02_PLY)
    assert len(body["vertices"]) == V.shape[0]
    assert len(body["faces"]) == F.shape[0]
    assert len(body["vertices"][0]) == 3
    assert len(body["faces"][0]) == 3


def test_api_mesh_raw_rejects_non_ply(client, tmp_path):
    bad = tmp_path / "notes.txt"
    bad.write_text("hi")
    resp = client.get(f"/api/mesh_raw?path={bad}")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/companions
# ---------------------------------------------------------------------------

def test_api_companions_finds_sibling_files(client):
    resp = client.get(
        f"/api/companions?path={F02_PLY}&project_root={PROJ}&subject_id=F02_P0"
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["sphere"] == f"{F02_ANN}/sphere.ply"
    assert body["sulc"] == f"{F02_ANN}/sulc.txt.gz"
    assert body["curv"] == f"{F02_ANN}/curv.txt.gz"
    assert body["sulci_json"] == f"{F02_ANN}/sulci.json"
    assert body["rotation_txt"] == f"{F02_ANN}/rotation.txt"


def test_api_companions_missing_returns_none(client, tmp_path):
    lone_ply = tmp_path / "lone.ply"
    lone_ply.write_bytes(b"PLY")
    resp = client.get(f"/api/companions?path={lone_ply}")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["sphere"] is None
    assert body["sulci_json"] is None


# ---------------------------------------------------------------------------
# GET /api/scalar
# ---------------------------------------------------------------------------

def test_api_scalar_returns_float_list(client):
    import gzip as _gzip
    sulc_path = f"{F02_ANN}/sulc.txt.gz"
    with _gzip.open(sulc_path, "rt") as f:
        lines = f.read().strip().splitlines()
    expected_len = len(lines) - 1  # first line is a "nVertices 1 3" header

    resp = client.get(f"/api/scalar?path={sulc_path}")
    assert resp.status_code == 200
    values = resp.get_json()
    assert len(values) == expected_len
    assert all(isinstance(v, float) for v in values)


def test_api_scalar_rejects_wrong_extension(client, tmp_path):
    bad = tmp_path / "data.json"
    bad.write_text("{}")
    resp = client.get(f"/api/scalar?path={bad}")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/project
# ---------------------------------------------------------------------------

def test_get_project_returns_json(client, tmp_path):
    verts, faces = _icosphere()
    sphere_path = str(tmp_path / "ico.ply")
    client.post("/api/save_sphere", json={"path": sphere_path, "vertices": verts, "faces": faces})

    project_root = str(tmp_path / "proj_get")
    r = client.post("/api/project/create", json={
        "root_dir":        project_root,
        "ref_id":          "SubA",
        "ref_source_path": sphere_path,
    })
    assert r.status_code == 200

    resp = client.get(f"/api/project?root={project_root}")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["subjects"] == ["SubA"]
    assert "created" in body
    assert body["version"] == "1.0"


def test_get_project_missing_returns_404(client, tmp_path):
    resp = client.get(f"/api/project?root={tmp_path / 'no_such_project'}")
    assert resp.status_code == 404


def test_get_project_no_root_returns_400(client):
    resp = client.get("/api/project")
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# POST /api/project/add_subject
#
# add_subject() previously had zero test coverage anywhere in the repo
# (verified by grep across tests/*.py and tests/*.js). This is a prerequisite
# for docs/29 Phase 2b, which de-duplicates its mesh-copy logic against
# create_project()'s — refactoring it without a regression test would be
# unsafe.
# ---------------------------------------------------------------------------

def test_add_subject_endpoint(client, tmp_path):
    verts, faces = _icosphere()
    sphere_path = str(tmp_path / "ico.ply")
    client.post("/api/save_sphere", json={"path": sphere_path, "vertices": verts, "faces": faces})

    project_root = str(tmp_path / "proj_add")
    r = client.post("/api/project/create", json={
        "root_dir":        project_root,
        "ref_id":          "SubA",
        "ref_source_path": sphere_path,
    })
    assert r.status_code == 200

    r2 = client.post("/api/project/add_subject", json={
        "project_root": project_root,
        "subject_id":   "SubB",
        "source_path":  sphere_path,
    })
    assert r2.status_code == 200
    body = r2.get_json()
    assert body["subject_id"] == "SubB"
    assert body["project_root"] == project_root

    mesh_b   = os.path.join(project_root, "data", "raw", "meshes", "SubB", "mesh.ply")
    origin_b = os.path.join(project_root, "data", "raw", "meshes", "SubB", "origin.json")
    ann_b    = os.path.join(project_root, "data", "derived", "annotations", "SubB")
    assert os.path.exists(mesh_b)
    assert os.path.exists(origin_b)
    assert os.path.isdir(ann_b)

    origin = json.loads(open(origin_b).read())
    assert origin["source_path"] == str(Path(sphere_path).resolve())
    assert "timestamp" in origin

    project = json.loads(open(os.path.join(project_root, "project.json")).read())
    assert "SubA" in project["subjects"]
    assert "SubB" in project["subjects"]

    # Re-reading the mesh must succeed (proves the copy is a valid PLY)
    V, F = igl.read_triangle_mesh(mesh_b)
    assert V.shape == (12, 3)


def test_add_subject_missing_project(client, tmp_path):
    verts, faces = _icosphere()
    sphere_path = str(tmp_path / "ico.ply")
    client.post("/api/save_sphere", json={"path": sphere_path, "vertices": verts, "faces": faces})

    r = client.post("/api/project/add_subject", json={
        "project_root": str(tmp_path / "no_such_project"),
        "subject_id":   "SubX",
        "source_path":  sphere_path,
    })
    assert r.status_code == 404


def test_add_subject_missing_required_fields(client, tmp_path):
    r = client.post("/api/project/add_subject", json={
        "project_root": str(tmp_path),
    })
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# GET / PUT /api/file
# ---------------------------------------------------------------------------

def test_api_file_get_and_put_roundtrip(client, tmp_path):
    path = str(tmp_path / "sulci.json")
    content = json.dumps({"hello": "world"})

    r = client.put("/api/file", json={"path": path, "content": content})
    assert r.status_code == 200
    assert r.get_json() == {"ok": True}

    r2 = client.get(f"/api/file?path={path}")
    assert r2.status_code == 200
    assert r2.get_json() == {"hello": "world"}


def test_api_file_txt_roundtrip(client, tmp_path):
    path = str(tmp_path / "rotation.txt")
    r = client.put("/api/file", json={"path": path, "content": "1 0 0\n0 1 0\n0 0 1\n"})
    assert r.status_code == 200

    r2 = client.get(f"/api/file?path={path}")
    assert r2.status_code == 200
    assert r2.get_json() == {"content": "1 0 0\n0 1 0\n0 0 1\n"}


def test_api_file_rejects_non_json_txt_extension(client, tmp_path):
    path = str(tmp_path / "mesh.ply")
    r = client.put("/api/file", json={"path": path, "content": "data"})
    assert r.status_code == 400


def test_api_file_get_missing_returns_404(client, tmp_path):
    path = str(tmp_path / "does_not_exist.json")
    r = client.get(f"/api/file?path={path}")
    assert r.status_code == 404
