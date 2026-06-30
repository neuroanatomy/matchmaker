"""
Integration tests for /api/save_sphere, /api/match, and /api/project/subject endpoints.
"""
import json
import os
import time
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
