"""
Tests for pipeline.run_morph and /api/morph endpoint.
"""
import json
import os
import time

import igl
import numpy as np
import pytest

DATA = "/Volumes/T7/Documents/2026_06MatchMaker/data/external"
F02  = f"{DATA}/F02_P0/seg-pial-t2"
F06  = f"{DATA}/F06_P4/seg-pial-t2"

# Minimal sulci: one named landmark with two straight-line points.
_SULCI_STUB = [{"name": "IHF", "path0": [
    {"px": 0.1, "py": 0.2, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0},
    {"px": 0.3, "py": 0.4, "ix": 0.0, "iy": 0.0, "ox": 0.0, "oy": 0.0},
]}]


# ---------------------------------------------------------------------------
# Unit test: pipeline.run_morph
# ---------------------------------------------------------------------------

@pytest.mark.slow
def test_run_morph_creates_file(tmp_path):
    from matchmaker import pipeline

    sulci_ref = json.load(open(f"{F02}/sulci.json"))
    sulci_mov = json.load(open(f"{F06}/sulci.json"))

    result = pipeline.run_morph(
        f"{F02}/e2.sphere.ply",
        sulci_ref, sulci_mov,
        str(tmp_path),
        rot_ref_path=f"{F02}/rotation.txt",
        rot_mov_path=f"{F06}/rotation.txt",
    )

    assert "morph_sphere_path" in result
    morph_path = result["morph_sphere_path"]
    assert os.path.exists(morph_path)

    V, F = igl.read_triangle_mesh(morph_path)
    assert V.shape[1] == 3
    assert F.shape[1] == 3
    assert not np.any(np.isnan(V)), "morph.sphere.ply contains NaN vertices"

    # Vertices should be approximately on the unit sphere
    norms = np.linalg.norm(V, axis=1)
    assert np.abs(norms.mean() - 1.0) < 0.05, f"mean norm = {norms.mean():.4f}"


# ---------------------------------------------------------------------------
# Endpoint tests: /api/morph
# ---------------------------------------------------------------------------

def test_morph_endpoint_returns_job(client, tmp_path):
    out_dir = str(tmp_path / "morph_out")
    payload = {
        "ref_sphere": f"{F02}/e2.sphere.ply",
        "sulci_ref":  _SULCI_STUB,
        "sulci_mov":  _SULCI_STUB,
        "out_dir":    out_dir,
    }
    resp = client.post(
        "/api/morph",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 200
    body = resp.get_json()
    assert "job_id" in body


def test_morph_endpoint_missing_sulci_returns_400(client, tmp_path):
    out_dir = str(tmp_path / "morph_out")
    payload = {
        "ref_sphere": f"{F02}/e2.sphere.ply",
        "out_dir":    out_dir,
        # sulci_ref and sulci_mov intentionally omitted
    }
    resp = client.post(
        "/api/morph",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 400


@pytest.mark.slow
def test_morph_endpoint_end_to_end(client, tmp_path):
    out_dir = str(tmp_path / "morph_out")

    sulci_ref = json.load(open(f"{F02}/sulci.json"))
    sulci_mov = json.load(open(f"{F06}/sulci.json"))

    payload = {
        "ref_sphere":   f"{F02}/e2.sphere.ply",
        "sulci_ref":    sulci_ref,
        "sulci_mov":    sulci_mov,
        "rot_ref_path": f"{F02}/rotation.txt",
        "rot_mov_path": f"{F06}/rotation.txt",
        "out_dir":      out_dir,
    }

    resp = client.post(
        "/api/morph",
        data=json.dumps(payload),
        content_type="application/json",
    )
    assert resp.status_code == 200
    job_id = resp.get_json()["job_id"]

    deadline = time.time() + 60
    status = "queued"
    d = {}
    while time.time() < deadline and status not in ("done", "error"):
        r = client.get(f"/api/jobs/{job_id}")
        d = r.get_json()
        status = d["status"]
        time.sleep(1)

    assert status == "done", f"Job ended with status={status}: {d.get('error')}"
    assert os.path.exists(os.path.join(out_dir, "morph.sphere.ply"))

    # Verify output quality
    V, _ = igl.read_triangle_mesh(os.path.join(out_dir, "morph.sphere.ply"))
    assert not np.any(np.isnan(V)), "morph.sphere.ply contains NaN vertices"
