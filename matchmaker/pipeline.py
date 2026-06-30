import gzip as gz
import os
import subprocess as sp
import sys
from pathlib import Path

import igl

_pkg_dir = Path(__file__).parent
# Binaries: matchmaker/bin/ (installed) → matchmaker_prev/bin/ (dev)
_bin_roots = [
    _pkg_dir / "bin",
    _pkg_dir.parent / "matchmaker_prev" / "bin",
]
# Python tools: homogeneous/ symlink lives next to the package
_tool_roots = [
    _pkg_dir / "tools",
    _pkg_dir.parent / "homogeneous",
]


def _find_bin(rel: str) -> str:
    for root in _bin_roots:
        p = root / rel
        if p.exists():
            return str(p)
    raise FileNotFoundError(
        f"Binary not found: {rel}\nSearched: {[str(r) for r in _bin_roots]}"
    )


def _find_tool(name: str) -> str:
    for root in _tool_roots:
        p = root / name
        if p.exists():
            return str(p)
    raise FileNotFoundError(
        f"Tool not found: {name}\nSearched: {[str(r) for r in _tool_roots]}"
    )


def _read_ply(path):
    """Read a PLY file (or .ply.gz) into (V, F) arrays."""
    import tempfile
    path = str(path)
    if path.endswith(".gz"):
        with gz.open(path, "rb") as f:
            data = f.read()
        tmp = tempfile.NamedTemporaryFile(suffix=".ply", delete=False)
        try:
            tmp.write(data); tmp.close()
            V, F = igl.read_triangle_mesh(tmp.name)
        finally:
            os.unlink(tmp.name)
    else:
        V, F = igl.read_triangle_mesh(path)
    return V, F


def euler_characteristic(f) -> int:
    nf = len(f)
    nv = int(f.max()) + 1
    ne = len(igl.edges(f))
    return nv - ne + nf


def spherize(input_path: str, *, out_dir: str = None, progress=None) -> dict:
    """Spherize a surface PLY mesh.

    Steps:
      1. Euler characteristic check (must be 2)
      2. meshparam_mac  → initial sphere parameterisation
      3. meshgeometry_mac → Laplace-smoothed normalised sphere
      4. node homogeneous.js → uniform vertex density

    If ``out_dir`` is given, writes ``sphere.ply`` there; otherwise writes
    ``<stem>.sphere.ply`` alongside the input (legacy behaviour).
    Returns ``{"sphere_path": str, "euler": int}``.
    """
    input_path = str(input_path)
    if not input_path.endswith(".ply"):
        raise ValueError("Input must be a .ply file")

    dir_ = os.path.dirname(input_path)
    base = os.path.splitext(os.path.basename(input_path))[0]

    if out_dir is not None:
        os.makedirs(str(out_dir), exist_ok=True)
        sphere_path = os.path.join(str(out_dir), "sphere.ply")
    else:
        sphere_path = input_path[:-4] + ".sphere.ply"

    tmp1 = os.path.join(dir_, f".{base}.mm_tmp1.ply")
    tmp2 = os.path.join(dir_, f".{base}.mm_tmp2.ply")

    meshparam    = _find_bin("meshparam/meshparam_mac")
    meshgeometry = _find_bin("meshgeometry/meshgeometry_mac")
    homogeneous  = _find_tool("homogeneous.py")

    def _emit(p):
        if progress:
            progress(p)

    # ── Step 1: Euler characteristic ─────────────────────────────────────────
    _emit(0.05)
    _, f = igl.read_triangle_mesh(input_path)
    euler = euler_characteristic(f)
    if euler != 2:
        raise ValueError(
            f"Euler characteristic = {euler} (expected 2). "
            "Mesh must have sphere topology."
        )
    _emit(0.10)

    try:
        # ── Step 2: meshparam ────────────────────────────────────────────────
        r = sp.run(
            [meshparam, "-i", input_path, "-o", tmp1],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"meshparam failed:\n{r.stderr or r.stdout}")
        _emit(0.40)

        # ── Step 3: meshgeometry ─────────────────────────────────────────────
        r = sp.run(
            [meshgeometry, "-i", tmp1,
             "-normalise", "-scale", "0.01",
             "-sphereLaplaceSmooth", "1", "5000",
             "-o", tmp2],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"meshgeometry failed:\n{r.stderr or r.stdout}")
        _emit(0.70)

        # ── Step 4: homogeneous.py (Taichi CPU) ──────────────────────────────
        r = sp.run(
            [sys.executable, homogeneous,
             "-i", tmp2,
             "-o", sphere_path,
             "-n", "5000",
             "-s", "0.3",   # alpha
             "-t", "0.5",   # tau
             "-a", "25"],   # aspect-ratio
            capture_output=True,
        )
        if r.returncode != 0:
            stderr = r.stderr.decode(errors="replace")
            stdout = r.stdout.decode(errors="replace")
            raise RuntimeError(f"homogeneous.py failed:\n{stderr or stdout}")
        _emit(1.0)

    finally:
        for p in (tmp1, tmp2):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass

    return {"sphere_path": sphere_path, "euler": euler}


def run_morph(ref_sphere_path, sulci_ref, sulci_mov, out_dir,
              *, rot_ref_path=None, rot_mov_path=None, progress=None) -> dict:
    """Run SBN morph via morph_runner.mjs and save morph.sphere.ply.

    sulci_ref, sulci_mov: parsed sulci.json content (list of dicts).
    Writes morph.sphere.ply into out_dir.
    Returns {"morph_sphere_path": str}.
    """
    import json as _json
    import tempfile as _tmp
    import numpy as _np

    out_dir = str(out_dir)
    os.makedirs(out_dir, exist_ok=True)
    morph_path = os.path.join(out_dir, "morph.sphere.ply")

    def _emit(p):
        if progress:
            progress(p)

    _emit(0.05)
    V, F = _read_ply(ref_sphere_path)
    # Do NOT mean-centre V here — morph_runner.mjs normalises to the unit sphere,
    # and centring before normalisation shifts vertices to slightly different unit-sphere
    # positions than the reference (which normalises the raw vertices directly).
    _emit(0.15)

    runner = str(Path(__file__).parent / "morph_runner.mjs")

    tmp_ref = _tmp.NamedTemporaryFile(mode="w", suffix="_sulci_ref.json", delete=False)
    tmp_mov = _tmp.NamedTemporaryFile(mode="w", suffix="_sulci_mov.json", delete=False)
    try:
        _json.dump(sulci_ref, tmp_ref); tmp_ref.close()
        _json.dump(sulci_mov, tmp_mov); tmp_mov.close()

        stdin_payload = {
            "vertices":     V.tolist(),
            "faces":        F.tolist(),
            "sulci_ref_path": tmp_ref.name,
            "sulci_mov_path": tmp_mov.name,
        }
        if rot_ref_path:
            stdin_payload["rot_ref_path"] = str(rot_ref_path)
        if rot_mov_path:
            stdin_payload["rot_mov_path"] = str(rot_mov_path)

        _emit(0.20)
        r = sp.run(
            ["node", runner],
            input=_json.dumps(stdin_payload),
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"morph_runner.mjs failed:\n{r.stderr or r.stdout}")
        _emit(0.85)

        out = _json.loads(r.stdout)
        morphed = _np.array(out["vertices"], dtype=_np.float32)
        igl.write_triangle_mesh(morph_path, morphed, F)
        _emit(1.0)

    finally:
        for p in (tmp_ref.name, tmp_mov.name):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass

    return {"morph_sphere_path": morph_path}


def run_match(ref_ply, ref_sphere, ref_rot,
              mov_ply, mov_sphere, mov_rot,
              morph_sphere_path, out_dir,
              *, k=100, nsteps=1,
              w_smooth=1.0, w_deform=10.0, w_project=1.0,
              progress=None) -> dict:
    """Run matchmesh2 to align the moving sphere to the reference sphere.

    Creates ref/ and mov/ staging dirs under out_dir with symlinks, then
    calls matchmesh_runner.py as a subprocess. Progress pulses between
    0.15 and 0.85 as optimisation iterations arrive on stdout.

    Returns {"matched_ply": str, "matched_sphere": str}.
    """
    out_dir = str(out_dir)

    def _emit(p):
        if progress:
            progress(p)

    # Create staging directories
    ref_dir = os.path.join(out_dir, "ref")
    mov_dir = os.path.join(out_dir, "mov")
    os.makedirs(ref_dir, exist_ok=True)
    os.makedirs(mov_dir, exist_ok=True)
    _emit(0.05)

    def _link(src, dst):
        if src and os.path.exists(str(src)):
            if os.path.lexists(dst):
                os.unlink(dst)
            os.symlink(os.path.abspath(str(src)), dst)

    _link(ref_ply,    os.path.join(ref_dir, "surf.ply"))
    _link(ref_sphere, os.path.join(ref_dir, "surf.sphere.ply"))
    if ref_rot:
        _link(ref_rot, os.path.join(ref_dir, "rotation.txt"))
    _link(mov_ply,    os.path.join(mov_dir, "surf.ply"))
    _link(mov_sphere, os.path.join(mov_dir, "surf.sphere.ply"))
    if mov_rot:
        _link(mov_rot, os.path.join(mov_dir, "rotation.txt"))
    _emit(0.10)

    runner = str(Path(__file__).parent / "matchmesh_runner.py")
    cmd = [
        sys.executable, runner,
        ref_dir, mov_dir, str(morph_sphere_path), out_dir,
        str(nsteps), str(k), str(w_smooth), str(w_deform), str(w_project),
    ]

    proc = sp.Popen(cmd, stdout=sp.PIPE, stderr=sp.STDOUT, text=True)
    iter_count = 0
    for line in proc.stdout:
        print(line, end="", flush=True)
        if "iter:" in line:
            iter_count += 1
            phase = (iter_count // 10) % 2
            _emit(0.85 if phase else 0.15)

    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"matchmesh_runner failed (exit {proc.returncode})")

    _emit(1.0)
    matched_ply    = os.path.join(out_dir, f"surf.{nsteps - 1}.ply")
    matched_sphere = os.path.join(out_dir, f"surf.{nsteps - 1}.sphere.ply")
    return {"matched_ply": matched_ply, "matched_sphere": matched_sphere}


def compute_curvature(mesh_path: str, *, out_dir: str = None, progress=None) -> dict:
    """Compute mean curvature and sulcal depth for a surface PLY mesh.

    Runs a single meshgeometry call:
      -centre  +  -laplaceSmooth 0.5 5  (pre-smooth before measuring)
      -curv  -oformat txt1             → per-vertex mean curvature
      -icurv 20  -oformat txt1         → integrated curvature (sulcal depth, 20 diffusion steps)

    If ``out_dir`` is given, writes ``curv.txt.gz`` and ``sulc.txt.gz`` there;
    otherwise writes ``<base>.curv/sulc.txt.gz`` alongside the input (legacy).
    Returns ``{"curv_path": str, "sulc_path": str}``.
    """
    mesh_path = str(mesh_path)
    if not mesh_path.endswith(".ply"):
        raise ValueError("Input must be a .ply file")

    meshgeometry = _find_bin("meshgeometry/meshgeometry_mac")

    dir_     = os.path.dirname(mesh_path)
    base     = os.path.splitext(os.path.basename(mesh_path))[0]
    tmp_ply  = os.path.join(dir_, f".{base}.mm_curv_tmp.ply")
    curv_txt = os.path.join(dir_, f"{base}.curv.txt")
    sulc_txt = os.path.join(dir_, f"{base}.sulc.txt")

    if out_dir is not None:
        os.makedirs(str(out_dir), exist_ok=True)
        curv_gz = os.path.join(str(out_dir), "curv.txt.gz")
        sulc_gz = os.path.join(str(out_dir), "sulc.txt.gz")
    else:
        curv_gz = curv_txt + ".gz"
        sulc_gz = sulc_txt + ".gz"

    def _emit(p):
        if progress:
            progress(p)

    _emit(0.05)
    try:
        r = sp.run(
            [meshgeometry,
             "-i", mesh_path,
             "-centre",
             "-o", tmp_ply,
             "-laplaceSmooth", "0.5", "5",
             "-curv", "-oformat", "txt1", "-o", curv_txt,
             "-icurv", "20", "-oformat", "txt1", "-o", sulc_txt],
            capture_output=True, text=True,
        )
        if r.returncode != 0:
            raise RuntimeError(f"meshgeometry failed:\n{r.stderr or r.stdout}")
        _emit(0.80)

        for src, dst in [(curv_txt, curv_gz), (sulc_txt, sulc_gz)]:
            with open(src, "rb") as f_in, gz.open(dst, "wb") as f_out:
                f_out.write(f_in.read())
        _emit(1.0)

    finally:
        for p in (tmp_ply, curv_txt, sulc_txt):
            try:
                os.unlink(p)
            except FileNotFoundError:
                pass

    return {"curv_path": curv_gz, "sulc_path": sulc_gz}
