"""Tests for trajectory endpoints and pipeline."""
import json
import os
import pytest

PROJ = "/Volumes/T7/Documents/2026_06MatchMaker/data/external/project"
MATCH_DIR = os.path.join(PROJ, "data", "derived", "matches")


# ---------------------------------------------------------------------------
# Endpoint tests (use the standard client fixture from conftest.py)
# ---------------------------------------------------------------------------

def test_list_trajectories_no_root(client):
    """GET /api/trajectories without project_root returns 400."""
    r = client.get("/api/trajectories")
    assert r.status_code == 400
    assert "required" in r.get_json().get("error", "").lower()


def test_list_trajectories_empty(client, tmp_path):
    """GET /api/trajectories for a project with no trajectories returns []."""
    # Simulate a project with a trajectories dir but no entries
    traj_dir = tmp_path / "data" / "derived" / "trajectories"
    traj_dir.mkdir(parents=True)
    r = client.get(f"/api/trajectories?project_root={tmp_path}")
    assert r.status_code == 200
    assert r.get_json() == []


def test_list_trajectories_no_dir(client, tmp_path):
    """GET /api/trajectories for a project without the trajectories dir returns []."""
    r = client.get(f"/api/trajectories?project_root={tmp_path}")
    assert r.status_code == 200
    assert r.get_json() == []


def test_list_trajectories_finds_entry(client, tmp_path):
    """GET /api/trajectories lists a trajectory with params.json."""
    entry = tmp_path / "data" / "derived" / "trajectories" / "A-B"
    (entry / "trajectory").mkdir(parents=True)
    # Write a dummy PLY so n_frames > 0
    (entry / "trajectory" / "0.ply").write_bytes(b"ply\nend_header\n")
    params = {"seq": ["A", "B"], "mode": "raw", "n_frames": 1}
    (entry / "params.json").write_text(json.dumps(params))
    r = client.get(f"/api/trajectories?project_root={tmp_path}")
    assert r.status_code == 200
    result = r.get_json()
    assert len(result) == 1
    assert result[0]["name"] == "A-B"
    assert result[0]["n_frames"] == 1
    assert result[0]["done"] is True
    assert result[0]["params"]["mode"] == "raw"


def test_post_trajectory_no_root(client):
    """POST /api/trajectory without project_root returns 400."""
    r = client.post("/api/trajectory", json={"seq": ["A", "B"]},
                    content_type="application/json")
    assert r.status_code == 400


def test_post_trajectory_short_seq(client, tmp_path):
    """POST /api/trajectory with seq length 1 returns 400."""
    r = client.post("/api/trajectory",
                    json={"project_root": str(tmp_path), "seq": ["A"]},
                    content_type="application/json")
    assert r.status_code == 400


def test_post_trajectory_missing_match(client, tmp_path):
    """POST /api/trajectory rejects when neither direction has a match."""
    r = client.post("/api/trajectory",
                    json={"project_root": str(tmp_path), "seq": ["A", "B"]},
                    content_type="application/json")
    assert r.status_code == 400
    assert "match" in r.get_json()["error"].lower()


def test_post_trajectory_inverse_match_accepted(client, tmp_path):
    """POST /api/trajectory accepts inverse match (A_as_B when needing B_as_A for seq=[A,B])."""
    # seq=["A","B"] needs B_as_A; we only provide A_as_B (the inverse) with ref_surf.ply
    inv_dir = tmp_path / "data" / "derived" / "matches" / "A_as_B"
    inv_dir.mkdir(parents=True)
    (inv_dir / "surf.0.ply").write_bytes(b"ply\nend_header\n")
    (inv_dir / "ref_surf.ply").write_bytes(b"ply\nend_header\n")
    r = client.post("/api/trajectory",
                    json={"project_root": str(tmp_path), "seq": ["A", "B"]},
                    content_type="application/json")
    # Validation passes (job submitted), even though the file I/O will fail later
    assert r.status_code == 200
    assert "job_id" in r.get_json()


def test_post_trajectory_inverse_missing_ref_surf(client, tmp_path):
    """POST /api/trajectory accepts inverse match even without ref_surf.ply (computed on fly)."""
    # seq=["A","B"] needs B_as_A; only A_as_B exists, no ref_surf.ply — pipeline falls back
    inv_dir = tmp_path / "data" / "derived" / "matches" / "A_as_B"
    inv_dir.mkdir(parents=True)
    (inv_dir / "surf.0.ply").write_bytes(b"ply\nend_header\n")
    # ref_surf.ply intentionally absent — server still accepts; pipeline handles it
    r = client.post("/api/trajectory",
                    json={"project_root": str(tmp_path), "seq": ["A", "B"]},
                    content_type="application/json")
    assert r.status_code == 200
    assert "job_id" in r.get_json()


def test_delete_trajectory_no_traj_dir(client):
    """DELETE /api/project/trajectory without traj_dir returns 400."""
    r = client.delete("/api/project/trajectory", json={},
                      content_type="application/json")
    assert r.status_code == 400


def test_delete_trajectory_bad_path(client, tmp_path):
    """DELETE /api/project/trajectory rejects path not inside data/derived/trajectories/."""
    r = client.delete("/api/project/trajectory",
                      json={"traj_dir": str(tmp_path)},
                      content_type="application/json")
    assert r.status_code == 400
    assert "trajectories" in r.get_json()["error"].lower()


def test_delete_trajectory_not_found(client, tmp_path):
    """DELETE /api/project/trajectory returns 404 when dir does not exist."""
    traj_dir = tmp_path / "data" / "derived" / "trajectories" / "ghost"
    r = client.delete("/api/project/trajectory",
                      json={"traj_dir": str(traj_dir)},
                      content_type="application/json")
    assert r.status_code == 404


def test_delete_trajectory_ok(client, tmp_path):
    """DELETE /api/project/trajectory removes the directory."""
    traj_dir = tmp_path / "data" / "derived" / "trajectories" / "my-traj"
    traj_dir.mkdir(parents=True)
    (traj_dir / "params.json").write_text('{"seq":["A","B"]}')
    assert traj_dir.is_dir()
    r = client.delete("/api/project/trajectory",
                      json={"traj_dir": str(traj_dir)},
                      content_type="application/json")
    assert r.status_code == 200
    assert not traj_dir.exists()


# ---------------------------------------------------------------------------
# Pipeline integration test (requires real project data with a completed match)
# ---------------------------------------------------------------------------

def _has_test_match():
    """Return True if at least one completed match exists in the test project."""
    if not os.path.isdir(MATCH_DIR):
        return False
    for entry in os.scandir(MATCH_DIR):
        if entry.is_dir() and os.path.isfile(os.path.join(entry.path, "surf.0.ply")):
            return True
    return False


def _first_complete_match_pair():
    """Return (ref, mov) for the first match that has surf.0.ply, or None."""
    if not os.path.isdir(MATCH_DIR):
        return None
    for entry in sorted(os.scandir(MATCH_DIR), key=lambda e: e.name):
        if not entry.is_dir():
            continue
        sep = "_as_"
        idx = entry.name.find(sep)
        if idx == -1:
            continue
        mov = entry.name[:idx]
        ref = entry.name[idx + len(sep):]
        if os.path.isfile(os.path.join(entry.path, "surf.0.ply")):
            return ref, mov
    return None


@pytest.mark.skipif(not _has_test_match(), reason="no completed match in test project data")
def test_run_trajectory_raw(tmp_path):
    """run_trajectory() raw mode: outputs frame PLYs with matching vertex count."""
    import igl
    from matchmaker.pipeline import run_trajectory

    pair = _first_complete_match_pair()
    ref, mov = pair
    seq = [ref, mov]  # 2-subject trajectory

    result = run_trajectory(
        project_root=PROJ,
        seq=seq,
        out_dir=str(tmp_path / "traj"),
        mode="raw",
    )

    assert result["n_frames"] == 2  # youngest and oldest
    traj_dir = tmp_path / "traj" / "trajectory"
    frames = sorted(traj_dir.glob("*.ply"), key=lambda p: int(p.stem))
    assert len(frames) == 2

    # All frames must share the same vertex count and face count
    V0, F0 = igl.read_triangle_mesh(str(frames[0]))
    V1, F1 = igl.read_triangle_mesh(str(frames[1]))
    assert len(V0) == len(V1), "frames have different vertex counts"
    assert len(F0) == len(F1), "frames have different face counts"

    # params.json must exist and be valid
    params_path = tmp_path / "traj" / "params.json"
    assert params_path.exists()
    params = json.loads(params_path.read_text())
    assert params["seq"] == seq
    assert params["mode"] == "raw"
    assert params["n_frames"] == 2


@pytest.mark.skipif(not _has_test_match(), reason="no completed match in test project data")
def test_run_trajectory_creates_rotated_spheres(tmp_path):
    """run_trajectory() saves rotation-applied sphere for each subject."""
    import igl
    from matchmaker.pipeline import run_trajectory

    pair = _first_complete_match_pair()
    ref, mov = pair
    seq = [ref, mov]

    run_trajectory(
        project_root=PROJ,
        seq=seq,
        out_dir=str(tmp_path / "traj"),
        mode="raw",
    )

    for sid in seq:
        sph_path = tmp_path / "traj" / f"{sid}.sphere.ply"
        assert sph_path.exists(), f"missing rotated sphere for {sid}"
        V, F = igl.read_triangle_mesh(str(sph_path))
        assert len(V) > 0


@pytest.mark.skipif(not _has_test_match(), reason="no completed match in test project data")
def test_post_trajectory_submits_job(client):
    """POST /api/trajectory with valid pair submits a job and returns job_id."""
    from matchmaker.server import create_app

    # Use a client rooted at the test project's parent
    app = create_app(str(os.path.dirname(PROJ)))
    app.config["TESTING"] = True
    tc = app.test_client()

    pair = _first_complete_match_pair()
    ref, mov = pair

    r = tc.post("/api/trajectory",
                json={"project_root": PROJ, "seq": [ref, mov], "mode": "raw"},
                content_type="application/json")
    assert r.status_code == 200
    body = r.get_json()
    assert "job_id" in body
    assert "out_dir" in body


def _has_test_match_with_ref_surf():
    """Return True if any completed match also has ref_surf.ply."""
    if not os.path.isdir(MATCH_DIR):
        return False
    for entry in os.scandir(MATCH_DIR):
        if (entry.is_dir()
                and os.path.isfile(os.path.join(entry.path, "surf.0.ply"))
                and os.path.isfile(os.path.join(entry.path, "ref_surf.ply"))):
            return True
    return False


@pytest.mark.skipif(
    not _has_test_match_with_ref_surf(),
    reason="no match with ref_surf.ply in test project data",
)
def test_invert_pair_produces_correct_topology(tmp_path):
    """_invert_pair produces a surface in the opposite topology (same vertex count as
    the target annotation sphere)."""
    import numpy as np
    import igl
    from matchmaker.pipeline import _invert_pair, _read_ply

    pair = _first_complete_match_pair()
    if pair is None:
        pytest.skip("no completed match")
    ref, mov = pair  # match is {mov}_as_{ref}; invert to express {ref} in {mov} topology

    # Load annotation spheres for both subjects
    anns = os.path.join(PROJ, "data", "derived", "annotations")

    def _load_rotated(sid):
        V, F = _read_ply(os.path.join(anns, sid, "sphere.ply"))
        rows = [r.split() for r in open(os.path.join(anns, sid, "rotation.txt")).read().strip().splitlines() if r.strip()]
        rot = np.array([[float(v) for v in r] for r in rows])
        return (V.astype(np.float64) @ rot[:3, :3]).astype("float32"), F

    rot_spheres = {ref: _load_rotated(ref), mov: _load_rotated(mov)}

    from pathlib import Path
    matches = Path(PROJ) / "data" / "derived" / "matches"

    # _invert_pair(rot_spheres, ref_id=mov, mov_id=ref, matches) gives ref's surface in mov's topology
    V_inv, S_inv, F_inv = _invert_pair(rot_spheres, mov, ref, matches)

    # Output topology must match mov's annotation sphere vertex/face count
    _, F_mov = rot_spheres[mov]
    assert len(V_inv) == len(rot_spheres[mov][0]), "inverted surface vertex count mismatch"
    assert len(S_inv) == len(rot_spheres[mov][0]), "inverted sphere vertex count mismatch"
    assert len(F_inv) == len(F_mov), "inverted face count mismatch"
