"""
Integration tests for /api/save_sphere and /api/match endpoints (Checkpoint 1).
"""
import json
import time
import pytest
import igl
import numpy as np

DATA = "/Volumes/T7/Documents/2026_06MatchMaker/data/external"
F02  = f"{DATA}/F02_P0/seg-pial-t2"
F06  = f"{DATA}/F06_P4/seg-pial-t2"


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
    morph_path = f"{F02}/e2.sphere.ply"

    payload = {
        "ref_ply":      f"{F02}/e2.ply",
        "ref_sphere":   f"{F02}/e2.sphere.ply",
        "ref_rot":      f"{F02}/rotation.txt",
        "mov_ply":      f"{F06}/e2.ply",
        "mov_sphere":   f"{F06}/e2.sphere.ply",
        "mov_rot":      f"{F06}/rotation.txt",
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

@pytest.mark.slow
def test_match_creates_output_files(client, tmp_path):
    import os

    # Save morph sphere (use F06 sphere as initial guess)
    morph_path = str(tmp_path / "morph.sphere.ply")
    V, F = igl.read_triangle_mesh(f"{F06}/e2.sphere.ply")
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
        "ref_ply":      f"{F02}/e2.ply",
        "ref_sphere":   f"{F02}/e2.sphere.ply",
        "ref_rot":      f"{F02}/rotation.txt",
        "mov_ply":      f"{F06}/e2.ply",
        "mov_sphere":   f"{F06}/e2.sphere.ply",
        "mov_rot":      f"{F06}/rotation.txt",
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
    assert os.path.exists(os.path.join(out_dir, "surf.0.sphere.ply"))
