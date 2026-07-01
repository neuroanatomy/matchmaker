"""
Unit tests for matchmaker.pipeline functions that had no test coverage:
spherize(), compute_curvature(), euler_characteristic().
"""
import gzip
import os

import igl
import numpy as np
import pytest

from matchmaker.pipeline import (
    compute_curvature,
    euler_characteristic,
    spherize,
)

PROJ = "/Volumes/T7/Documents/2026_06MatchMaker/data/external/project"
F02_PLY = f"{PROJ}/data/raw/meshes/F02_P0/mesh.ply"


def _icosphere_VF():
    """Tiny genus-0 icosphere as (V, F) numpy arrays."""
    t = (1 + 5 ** 0.5) / 2
    raw = np.array([
        [-1,  t,  0], [ 1,  t,  0], [-1, -t,  0], [ 1, -t,  0],
        [ 0, -1,  t], [ 0,  1,  t], [ 0, -1, -t], [ 0,  1, -t],
        [ t,  0, -1], [ t,  0,  1], [-t,  0, -1], [-t,  0,  1],
    ], dtype=np.float64)
    V = raw / np.linalg.norm(raw, axis=1, keepdims=True)
    F = np.array([
        [0, 11,  5], [0,  5,  1], [0,  1,  7], [0,  7, 10], [0, 10, 11],
        [1,  5,  9], [5, 11,  4], [11, 10,  2], [10,  7,  6], [7,  1,  8],
        [3,  9,  4], [3,  4,  2], [3,  2,  6], [3,  6,  8], [3,  8,  9],
        [4,  9,  5], [2,  4, 11], [6,  2, 10], [8,  6,  7], [9,  8,  1],
    ], dtype=np.int64)
    return V, F


def test_euler_characteristic_known_sphere():
    """A closed genus-0 mesh (icosphere) must have Euler characteristic 2."""
    _, F = _icosphere_VF()
    assert euler_characteristic(F) == 2


def test_euler_characteristic_test_project_mesh():
    """The bundled test mesh is also genus-0 (spherize requires this)."""
    _, F = igl.read_triangle_mesh(F02_PLY)
    assert euler_characteristic(F) == 2


@pytest.mark.slow
def test_spherize_produces_sphere_topology(tmp_path):
    out_dir = str(tmp_path / "spherize_out")
    result = spherize(F02_PLY, out_dir=out_dir)

    assert result["euler"] == 2
    assert os.path.exists(result["sphere_path"])

    V, F = igl.read_triangle_mesh(result["sphere_path"])
    assert euler_characteristic(F) == 2
    # Uniform-density resampling targets n=5000 vertices (hardcoded in pipeline.spherize)
    assert V.shape[0] > 0


@pytest.mark.slow
def test_compute_curvature_output_shapes(tmp_path):
    """sulc/curv output vertex count must match the input mesh's vertex count."""
    V_in, _ = igl.read_triangle_mesh(F02_PLY)
    n_expected = V_in.shape[0]

    # out_dir keeps output out of the repo's real test-data directory (legacy
    # no-out_dir mode would otherwise write curv/sulc .txt.gz next to mesh.ply).
    out_dir = str(tmp_path / "curvature_out")
    result = compute_curvature(F02_PLY, out_dir=out_dir)

    with gzip.open(result["curv_path"], "rt") as f:
        curv_lines = f.read().strip().splitlines()
    with gzip.open(result["sulc_path"], "rt") as f:
        sulc_lines = f.read().strip().splitlines()

    # First line is a header ("nVertices 1 3"), remaining lines are per-vertex values
    assert len(curv_lines) - 1 == n_expected
    assert len(sulc_lines) - 1 == n_expected
