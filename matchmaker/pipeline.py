import gzip as gz
import os
import subprocess as sp
import sys
from pathlib import Path

import igl
import numpy as np

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

# spherize()'s homogeneous.py resampling parameters — fixed for reproducibility
# (see CLAUDE.md "Match Parameters and Reproducibility"); not user-configurable.
_SPHERIZE_N = 5000  # target vertex count
_SPHERIZE_S = 0.3   # alpha
_SPHERIZE_T = 0.5   # tau
_SPHERIZE_A = 25    # aspect-ratio


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
             "-n", str(_SPHERIZE_N),
             "-s", str(_SPHERIZE_S),
             "-t", str(_SPHERIZE_T),
             "-a", str(_SPHERIZE_A)],
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

    # Save UI-ref's native surface for trajectory use.
    # sphere.ply and raw mesh share the same topology (same vertex/face count),
    # so the raw mesh vertices ARE the native surface at sphere topology — no projection.
    # mov_ply = matchmesh2's "mov" = UI's ref (template).
    try:
        ref_V2, ref_F2 = _read_ply(mov_ply)
        igl.write_triangle_mesh(os.path.join(out_dir, "ref_surf.ply"), ref_V2, ref_F2)
    except Exception:
        pass  # non-fatal; trajectory falls back on-the-fly

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


# ── Trajectory helpers ────────────────────────────────────────────────────────

def _sphere_retopo(Sit, Sii, Ssi, Vsi, Ft, Fi):
    """Barycentric retopology: express (Vsi, Ssi) in the target topology Ft.

    Sit, Ft  — intermediate sphere in target topology
    Sii, Fi  — intermediate sphere in intermediate topology (rotation-applied annotation sphere)
    Ssi      — source sphere in intermediate topology (surf.0.sphere.ply)
    Vsi      — source native in intermediate topology (surf.0.ply)

    Returns (Vst, Sst, Ft).
    """
    _, I, C, _ = igl.signed_distance(
        Sit.astype(np.float64), Sii.astype(np.float64), Fi
    )
    F_idx = Fi[I, :]
    Va = Sii[F_idx[:, 0]].astype(np.float64)
    Vb = Sii[F_idx[:, 1]].astype(np.float64)
    Vc = Sii[F_idx[:, 2]].astype(np.float64)
    B = igl.barycentric_coordinates(C.astype(np.float64), Va, Vb, Vc)

    def _interp(src):
        a = src[F_idx[:, 0]].astype(np.float64)
        b = src[F_idx[:, 1]].astype(np.float64)
        c = src[F_idx[:, 2]].astype(np.float64)
        return (a * B[:, 0:1] + b * B[:, 1:2] + c * B[:, 2:3]).astype(np.float32)

    return _interp(Vsi), _interp(Ssi), Ft


def _uniform_laplacian(F):
    """Uniform Laplacian: adjacency matrix minus degree matrix."""
    import scipy.sparse
    A = igl.adjacency_matrix(F)
    deg = np.array(A.sum(axis=1)).ravel()
    D = scipy.sparse.diags(deg, format="csr")
    return (A - D).astype(np.float64)


def _project_onto_surface(V_query, V_ref, F_ref):
    """Return closest point on (V_ref, F_ref) for each vertex in V_query."""
    _, _, C, _ = igl.signed_distance(
        V_query.astype(np.float64), V_ref.astype(np.float64), F_ref
    )
    return C.astype(np.float32)


def _sphere_project_onto_mesh(sphere_V, raw_V, raw_F):
    """Project unit-sphere vertices onto a native-scale mesh.

    The sphere (radius ~1, centred at origin) and the raw mesh live in different
    coordinate spaces.  This normalises the raw mesh to unit-sphere scale before
    the signed-distance query, then maps the result back to mm coordinates.

    sphere_V — (N, 3) float, unit-sphere vertices (pre-rotation annotation sphere)
    raw_V    — (M, 3) float, native mesh vertices (mm scale, any centroid)
    raw_F    — (K, 3) int,   native mesh faces

    Returns (N, 3) float32 — surface positions in the native (mm) coordinate frame.
    """
    raw_d = raw_V.astype(np.float64)
    centroid = raw_d.mean(axis=0)
    max_rad = float(np.linalg.norm(raw_d - centroid, axis=1).max())
    if max_rad < 1e-8:
        raise ValueError("Raw mesh has zero spatial extent")
    raw_norm = (raw_d - centroid) / max_rad
    _, _, C_norm, _ = igl.signed_distance(
        sphere_V.astype(np.float64), raw_norm, raw_F
    )
    return (C_norm * max_rad + centroid).astype(np.float32)


def _icp(V_ref, F_ref, V_mov, maxiter=100, tol=1e-6):
    """Rigid ICP: align V_mov toward the surface (V_ref, F_ref)."""
    V = V_mov.astype(np.float64).copy()
    Vr = V_ref.astype(np.float64)
    dist0 = -1.0
    for _ in range(maxiter):
        _, _, C, _ = igl.signed_distance(V, Vr, F_ref)
        omov = V.mean(axis=0)
        oout = C.mean(axis=0)
        cov = (V - omov).T @ (C - oout)
        U, _, Vt = np.linalg.svd(cov)
        R = U @ Vt
        t = omov - oout @ R
        V = V @ R - t
        dist = float(np.arccos(np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)))
        dist += float(np.sum(t ** 2))
        diff = dist if dist0 < 0 else abs(dist - dist0)
        if diff < tol:
            break
        dist0 = dist
    return V.astype(np.float32)


def _invert_pair(rot_spheres, ref_id, mov_id, matches, project_root=None):
    """Compute mov_id's surface in ref_id's topology by inverting match {ref_id}_as_{mov_id}.

    In that match, ref_id played the mov role and mov_id played the ref role, so:
      surf.0.sphere.ply = ref_id's optimised sphere in mov_id's face topology
      ref_surf.ply      = mov_id's native surface in mov_id's sphere topology

    If ref_surf.ply is absent (pre-dates trajectory support), falls back to projecting
    mov_id's raw mesh onto its annotation sphere — requires project_root to be set.

    Returns (V, S, F): mov_id's surface and sphere expressed in ref_id's face topology.
    """
    inv_dir = matches / f"{ref_id}_as_{mov_id}"
    Sii, Fi = _read_ply(str(inv_dir / "surf.0.sphere.ply"))  # ref_id's sphere in mov_id topology
    Sit, Ft = rot_spheres[ref_id]                             # ref_id's annotation sphere (target)
    Ssi, _  = rot_spheres[mov_id]                             # mov_id's annotation sphere
    ref_surf_p = inv_dir / "ref_surf.ply"
    if ref_surf_p.exists():
        Vsi, _ = _read_ply(str(ref_surf_p))                  # mov_id's surface in mov_id topology
    elif project_root is not None:
        raw_p = Path(project_root) / "data" / "raw" / "meshes" / mov_id / "mesh.ply"
        if not raw_p.exists():
            raise FileNotFoundError(
                f"ref_surf.ply missing in {inv_dir} and raw mesh not found at {raw_p}"
            )
        # sphere.ply and raw mesh share the same topology; raw mesh vertices = surface at
        # sphere topology directly — no projection needed.
        Vsi, _ = _read_ply(str(raw_p))
    else:
        raise FileNotFoundError(
            f"ref_surf.ply missing in {inv_dir}; re-run the match to regenerate it"
        )
    return _sphere_retopo(Sit, Sii, Ssi, Vsi, Ft, Fi)


# ── run_trajectory phases ─────────────────────────────────────────────────────

def _load_rotated_spheres(seq, anns_dir, dest_dir):
    """Load each subject's annotation sphere, apply its rotation.txt, and write
    {sid}.sphere.ply into dest_dir. Returns {sid: (rotated_V float32, F int32)}."""
    rot_spheres = {}
    for sid in seq:
        sph_v, sph_f = _read_ply(str(anns_dir / sid / "sphere.ply"))
        rot_txt = (anns_dir / sid / "rotation.txt").read_text()
        rows = [r.split() for r in rot_txt.strip().splitlines() if r.strip()]
        rot = np.array([[float(v) for v in r] for r in rows])
        with np.errstate(divide='ignore', over='ignore', invalid='ignore'):
            rotated = (sph_v.astype(np.float64) @ rot[:3, :3]).astype(np.float32)
        rot_spheres[sid] = (rotated, sph_f)
        igl.write_triangle_mesh(str(dest_dir / f"{sid}.sphere.ply"), rotated, sph_f)
    return rot_spheres


def _smooth_pairwise_deformations(seq, matches_dir, dest_dir, rot_spheres, project_root,
                                   mode, n_deformation_smooth, _emit=None):
    """For each adjacent (ref, mov) pair in seq, get mov's matched surface/sphere in ref
    topology (inverting the match if only the reverse direction was computed), optionally
    smoothing the deformation field toward the ref surface. Writes {mov}_as_{ref}.ply/
    .sphere.ply into dest_dir. Returns (pair_plys, pair_sphere_plys), each keyed by
    (mov, ref) -> path str."""
    import shutil as _shutil

    pair_plys        = {}  # {(mov, ref): path to matched native in ref topology}
    pair_sphere_plys = {}  # {(mov, ref): path to matched sphere in ref topology}
    n_pairs = len(seq) - 1
    for k, (ref, mov) in enumerate(zip(seq, seq[1:])):
        fwd_dir = matches_dir / f"{mov}_as_{ref}"
        inv_dir = matches_dir / f"{ref}_as_{mov}"
        use_inverse = not (fwd_dir / "surf.0.ply").exists() and (inv_dir / "surf.0.ply").exists()

        dst_ply = str(dest_dir / f"{mov}_as_{ref}.ply")
        sph_ply = str(dest_dir / f"{mov}_as_{ref}.sphere.ply")

        if use_inverse:
            V_inv, S_inv, F_inv = _invert_pair(rot_spheres, ref, mov, matches_dir,
                                                project_root=project_root)
            igl.write_triangle_mesh(dst_ply, V_inv, F_inv)
            igl.write_triangle_mesh(sph_ply, S_inv, F_inv)
            pair_plys[(mov, ref)]        = dst_ply
            pair_sphere_plys[(mov, ref)] = sph_ply
        else:
            m_dir   = fwd_dir
            src_ply = str(m_dir / "surf.0.ply")

            if mode == "smooth" and n_deformation_smooth > 0:
                # Va = ref native surface in sphere topology (= raw mesh, same topology).
                # ref_surf.ply (written by run_match) is canonical; fall back to raw mesh.
                ref_surf_p = m_dir / "ref_surf.ply"
                _, surf_F = _read_ply(src_ply)
                if ref_surf_p.exists():
                    Va_tmp, _ = _read_ply(str(ref_surf_p))
                    if len(Va_tmp) == len(surf_F):  # sanity: same topology
                        Va, F = Va_tmp, surf_F
                    else:
                        Va = None
                else:
                    Va = None
                if Va is None:
                    raw_p = Path(project_root) / "data" / "raw" / "meshes" / ref / "mesh.ply"
                    if raw_p.exists():
                        Va, F = _read_ply(str(raw_p))  # same topology as sphere.ply
                    else:
                        Va, F = _read_ply(src_ply)  # last resort

                Vb, _ = _read_ply(src_ply)
                L = _uniform_laplacian(F)
                vres = Vb.astype(np.float64)
                Va_d = Va.astype(np.float64)
                Vref_d = Va_d.copy()
                for _ in range(n_deformation_smooth):
                    delta = Va_d - vres
                    smooth_d = delta + L @ delta  # one uniform Laplacian step
                    vtmp = (Va_d - smooth_d).astype(np.float32)
                    vres = _project_onto_surface(vtmp, Vref_d.astype(np.float32), F).astype(np.float64)
                igl.write_triangle_mesh(dst_ply, vres.astype(np.float32), F)
            else:
                _shutil.copy2(src_ply, dst_ply)

            pair_plys[(mov, ref)]        = dst_ply
            pair_sphere_plys[(mov, ref)] = str(m_dir / "surf.0.sphere.ply")

        if _emit:
            _emit(0.10 + 0.30 * (k + 1) / n_pairs)

    return pair_plys, pair_sphere_plys


def _retopologize_chain(seq, dest_dir, rot_spheres, pair_plys, pair_sphere_plys, _emit=None):
    """Chain barycentric retopology maps so every subject in seq[1:] is expressed in
    seq[0]'s face topology. Writes {mov}_as_{seq[0]}.ply/.sphere.ply into dest_dir.
    Returns (ref_F, retopo) where retopo = {sid: V native-surface array}."""
    V0, ref_F = _read_ply(pair_plys[(seq[1], seq[0])])        # seq[0] face topology
    S0, _     = _read_ply(pair_sphere_plys[(seq[1], seq[0])])  # sphere in seq[0] topology

    igl.write_triangle_mesh(str(dest_dir / f"{seq[1]}_as_{seq[0]}.ply"),    V0,  ref_F)
    igl.write_triangle_mesh(str(dest_dir / f"{seq[1]}_as_{seq[0]}.sphere.ply"), S0, ref_F)
    retopo = {seq[1]: V0}

    n_pairs = len(seq) - 1
    for k, (ref, mov) in enumerate(zip(seq[1:], seq[2:]), start=1):
        Sit, Ft = _read_ply(str(dest_dir / f"{ref}_as_{seq[0]}.sphere.ply"))
        Sii, Fi = rot_spheres[ref]
        Ssi, _  = _read_ply(pair_sphere_plys[(mov, ref)])
        Vsi, _  = _read_ply(pair_plys[(mov, ref)])
        V, S, Ft = _sphere_retopo(Sit, Sii, Ssi, Vsi, Ft, Fi)
        igl.write_triangle_mesh(str(dest_dir / f"{mov}_as_{seq[0]}.ply"),         V, Ft)
        igl.write_triangle_mesh(str(dest_dir / f"{mov}_as_{seq[0]}.sphere.ply"), S, Ft)
        retopo[mov] = V
        if _emit:
            _emit(0.40 + 0.30 * k / n_pairs)

    return ref_F, retopo


def _build_frame_list(seq, matches_dir, project_root, rot_spheres, retopo):
    """Assemble the ordered list of native-surface arrays for playback, youngest→oldest:
    seq[1:] reversed (already retopologized to seq[0]'s topology in `retopo`) followed by
    seq[0]'s own native surface (found via ref_surf.ply from the first pairwise match,
    falling back to the raw mesh, falling back to retopo[seq[1]] as a last resort).
    Returns list[np.ndarray]."""
    # sphere.ply and raw mesh share the same topology (meshparam runs on the raw mesh),
    # so raw_mesh[i] IS the surface position for sphere vertex i — no projection needed.
    # ref_surf.ply (written by run_match since the fix) is equivalent; use it when the
    # vertex count matches, otherwise fall back to the raw mesh directly.
    first_m = matches_dir / f"{seq[1]}_as_{seq[0]}"
    ref_surf_p = first_m / "ref_surf.ply"
    V_ref_native = None
    if ref_surf_p.exists():
        Vtmp, _ = _read_ply(str(ref_surf_p))
        if len(Vtmp) == len(rot_spheres[seq[0]][0]):
            V_ref_native = Vtmp  # correct topology
    if V_ref_native is None:
        raw_p = Path(project_root) / "data" / "raw" / "meshes" / seq[0] / "mesh.ply"
        if raw_p.exists():
            V_ref_native, _ = _read_ply(str(raw_p))
        else:
            V_ref_native = retopo[seq[1]].copy()  # last resort: duplicate first retopo frame

    V_frames = [retopo[mov] for mov in reversed(seq[1:])]  # youngest first
    V_frames.append(V_ref_native)                           # oldest last
    return V_frames


def _smooth_trajectory_frames(V_frames, ref_F, mode, do_icp,
                               n_trajectory_smooth, n_spatial_smooth, lambda_spatial):
    """If mode == 'smooth', interpolate midpoints between keyframes (optionally ICP-aligned)
    and apply temporal + spatial smoothing across the sequence. Returns V_frames unchanged
    (same list, same length) if mode != 'smooth' or no smoothing was requested."""
    if not (mode == "smooth" and (n_trajectory_smooth > 0 or do_icp)):
        return V_frames

    nf = len(V_frames)
    ns = nf * 2 - 1
    V_all = [None] * ns
    for i, V in enumerate(V_frames):
        V_all[i * 2] = V.astype(np.float64)

    if do_icp:
        for i in range(0, ns - 1, 2):
            V_all[i + 2] = _icp(
                V_all[i].astype(np.float32), ref_F,
                V_all[i + 2].astype(np.float32),
            ).astype(np.float64)

    # Insert midpoint interpolants
    for i in range(0, ns - 1, 2):
        V_all[i + 1] = (V_all[i] + V_all[i + 2]) / 2

    # Pull keyframes toward their neighbours
    for i in range(2, ns - 1, 2):
        V_all[i] = V_all[i - 1] / 8 + V_all[i] * (3 / 4) + V_all[i + 1] / 8

    # Temporal + spatial smoothing
    for _ in range(n_trajectory_smooth):
        tr = list(V_all)
        for j in range(1, ns - 1):
            tr[j] = V_all[j - 1] / 8 + V_all[j] * (3 / 4) + V_all[j + 1] / 8
        V_all = tr
        if n_spatial_smooth > 0 and lambda_spatial > 0:
            L = _uniform_laplacian(ref_F)
            for j in range(ns):
                Vj = V_all[j].copy()
                for _ in range(n_spatial_smooth):
                    Vj = Vj + lambda_spatial * (L @ Vj)
                V_all[j] = Vj

    return [V_all[i].astype(np.float32) for i in range(0, ns, 2)]


def _write_trajectory_output(dest_dir, V_frames, ref_F, params):
    """Center each frame (recording its translation), write playback frames to
    {dest_dir}/trajectory/{i*2}.ply, and write params.json (adding created/n_frames/
    translations to the given params dict). Returns {"trajectory_dir": str, "n_frames": int}."""
    import json as _json
    from datetime import datetime as _dt, timezone as _tz

    translations = []
    centered_frames = []
    for V in V_frames:
        c = V.mean(axis=0)
        translations.append(c.tolist())
        centered_frames.append((V - c).astype(np.float32))

    traj_dir = dest_dir / "trajectory"
    traj_dir.mkdir(exist_ok=True)
    for i, V in enumerate(centered_frames):
        igl.write_triangle_mesh(str(traj_dir / f"{i * 2}.ply"), V, ref_F)

    params = dict(params)
    params["created"]      = _dt.now(_tz.utc).isoformat()
    params["n_frames"]     = len(centered_frames)
    params["translations"] = translations
    (dest_dir / "params.json").write_text(_json.dumps(params, indent=2))

    return {"trajectory_dir": str(dest_dir), "n_frames": len(centered_frames)}


# ── run_trajectory ────────────────────────────────────────────────────────────

def run_trajectory(
    project_root, seq, out_dir, *,
    mode="raw",
    n_deformation_smooth=5,
    do_icp=False,
    n_trajectory_smooth=1,
    n_spatial_smooth=1,
    lambda_spatial=0.005,
    progress=None,
) -> dict:
    """Build a developmental trajectory from a sequence of matched subjects.

    seq        — ordered list of subject IDs, oldest first (seq[0] is the reference topology).
    out_dir    — destination directory; created if absent.
    mode       — 'raw' (no smoothing) or 'smooth' (deformation + temporal + spatial smoothing).

    Outputs:
      {out_dir}/{sid}.sphere.ply              — rotation-applied annotation spheres
      {out_dir}/{mov}_as_{ref}.ply            — pairwise matched surface (smoothed in smooth mode)
      {out_dir}/{mov}_as_{seq[0]}.ply         — retopologized to seq[0] topology
      {out_dir}/{mov}_as_{seq[0]}.sphere.ply  — retopologized sphere
      {out_dir}/trajectory/{0,2,4,...}.ply    — final playback frames (youngest → oldest)
      {out_dir}/params.json                   — all parameters + timestamps

    Returns {"trajectory_dir": str, "n_frames": int}.
    """
    root    = Path(project_root)
    anns    = root / "data" / "derived" / "annotations"
    matches = root / "data" / "derived" / "matches"
    dest    = Path(out_dir)
    dest.mkdir(parents=True, exist_ok=True)

    def _emit(p):
        if progress:
            progress(p)

    # rough progress milestones: spheres (10%), deform (40%), retopo (70%), frames (90%), done (100%)
    rot_spheres = _load_rotated_spheres(seq, anns, dest)
    _emit(0.10)

    pair_plys, pair_sphere_plys = _smooth_pairwise_deformations(
        seq, matches, dest, rot_spheres, str(root), mode, n_deformation_smooth, _emit=_emit,
    )

    ref_F, retopo = _retopologize_chain(
        seq, dest, rot_spheres, pair_plys, pair_sphere_plys, _emit=_emit,
    )

    V_frames = _build_frame_list(seq, matches, str(root), rot_spheres, retopo)
    V_frames = _smooth_trajectory_frames(
        V_frames, ref_F, mode, do_icp, n_trajectory_smooth, n_spatial_smooth, lambda_spatial,
    )
    _emit(0.90)

    params = {
        "seq": list(seq),
        "mode": mode,
        "n_deformation_smooth": n_deformation_smooth,
        "do_icp": do_icp,
        "n_trajectory_smooth": n_trajectory_smooth,
        "n_spatial_smooth": n_spatial_smooth,
        "lambda_spatial": lambda_spatial,
    }
    result = _write_trajectory_output(dest, V_frames, ref_F, params)
    _emit(1.0)

    return result
