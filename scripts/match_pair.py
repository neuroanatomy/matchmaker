#!/usr/bin/env python3
"""
match_pair.py — Run the full morph + match pipeline for a pair of surfaces.

Usage:
    conda run -n py310 python scripts/match_pair.py REF_PLY MOV_PLY [options]

Arguments:
    REF_PLY     Path to the reference surface PLY (e.g. data/.../F02_P0/.../e2.ply)
    MOV_PLY     Path to the moving  surface PLY (e.g. data/.../F10_P8/.../e2.ply)

For each PLY the script auto-discovers in the same directory:
    {stem}.sphere.ply   spherical parameterisation (required)
    sulci.json          landmarks                   (required for morph)
    rotation.txt        sphere rotation matrix      (optional)

Options:
    --out-dir DIR    Output directory (default: <mov_dir>/match_<ref_stem>)
    --k INT          Laplacian eigenvectors (default: 100)
    --nsteps INT     Refinement steps (default: 1)
    --w-smooth F     Sphere-smoothness weight (default: 1.0)
    --w-deform F     Deformation-smoothness weight (default: 10.0)
    --w-project F    Surface-alignment weight (default: 1.0)
    --skip-morph     Use MOV sphere as-is (no SBN morph) — for testing only

Example:
    conda run -n py310 python scripts/match_pair.py \\
        data/external/F02_P0/seg-pial-t2/e2.ply \\
        data/external/F10_P8/seg-pial-t2/e2.ply \\
        --k 50 --nsteps 1
"""
import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import igl
import numpy as np

HERE = Path(__file__).resolve().parent.parent   # repo root
MORPH_RUNNER = HERE / "matchmaker" / "morph_runner.mjs"
MATCH_RUNNER = HERE / "matchmaker" / "matchmesh_runner.py"


def _companion(ply: Path, name: str) -> Path | None:
    p = ply.parent / name
    return p if p.exists() else None


def run_morph(ref_sphere: Path, ref_ply: Path, mov_ply: Path, out_dir: Path) -> Path:
    """Deform REF sphere toward MOV landmarks via SBN.

    Dual-rotation convention (matches original morph.js):
      rotRef (v@R) → applied to REF sphere and l1 (ref landmarks).
      rotMov (v@R) → applied to l2 (mov landmarks).
      Output is already in rotRef frame — matchmesh2 receives it directly.
    """
    sulci_mov = mov_ply.parent / "sulci.json"
    sulci_ref = ref_ply.parent / "sulci.json"
    rot_ref   = ref_ply.parent / "rotation.txt"
    rot_mov   = mov_ply.parent / "rotation.txt"

    if not sulci_mov.exists():
        sys.exit(f"Error: sulci.json not found in {mov_ply.parent}")
    if not sulci_ref.exists():
        sys.exit(f"Error: sulci.json not found in {ref_ply.parent}")

    V, F = igl.read_triangle_mesh(str(ref_sphere))  # REF sphere
    payload = {
        "vertices":       V.tolist(),
        "faces":          F.tolist(),
        "sulci_mov_path": str(sulci_mov),
        "sulci_ref_path": str(sulci_ref),
    }
    if rot_ref.exists():
        payload["rot_ref_path"] = str(rot_ref)
    if rot_mov.exists():
        payload["rot_mov_path"] = str(rot_mov)

    print("Running SBN morph…")
    proc = subprocess.run(
        ["node", str(MORPH_RUNNER)],
        input=json.dumps(payload),
        capture_output=True, text=True, timeout=120,
    )
    if proc.returncode != 0:
        sys.exit(f"Morph failed:\n{proc.stderr}")

    morphed_V = np.array(json.loads(proc.stdout)["vertices"], dtype=np.float32)
    # morph_runner.mjs applies dual rotation internally; output is already in rotRef frame.

    norms = np.linalg.norm(morphed_V, axis=1)
    print(f"  vertices={morphed_V.shape[0]}, mean norm={norms.mean():.4f}")

    morph_path = out_dir / "morph.sphere.ply"
    igl.write_triangle_mesh(str(morph_path), morphed_V, F)
    print(f"  saved → {morph_path}")
    return morph_path


def stage_dirs(ref_ply: Path, ref_sphere: Path, mov_ply: Path, mov_sphere: Path,
               out_dir: Path) -> tuple[Path, Path]:
    ref_dir = out_dir / "ref"
    mov_dir = out_dir / "mov"
    ref_dir.mkdir(parents=True, exist_ok=True)
    mov_dir.mkdir(parents=True, exist_ok=True)

    def _link(src: Path, dst: Path):
        if src.exists():
            if dst.is_symlink() or dst.exists():
                dst.unlink()
            dst.symlink_to(src.resolve())

    _link(ref_ply,    ref_dir / "surf.ply")
    _link(ref_sphere, ref_dir / "surf.sphere.ply")
    rot_ref = ref_ply.parent / "rotation.txt"
    if rot_ref.exists():
        _link(rot_ref, ref_dir / "rotation.txt")

    _link(mov_ply,    mov_dir / "surf.ply")
    _link(mov_sphere, mov_dir / "surf.sphere.ply")
    rot_mov = mov_ply.parent / "rotation.txt"
    if rot_mov.exists():
        _link(rot_mov, mov_dir / "rotation.txt")

    return ref_dir, mov_dir


def run_match(ref_dir: Path, mov_dir: Path, morph_path: Path, out_dir: Path,
              k: int, nsteps: int, w_smooth: float, w_deform: float, w_project: float):
    # matchmesh2 "ref" = UI's mov (brain to project onto) = mov_dir
    # matchmesh2 "mov" = UI's ref (sphere to deform)      = ref_dir
    print(f"Running matchmesh2 (k={k}, nsteps={nsteps})…")
    cmd = [
        sys.executable, str(MATCH_RUNNER),
        str(mov_dir), str(ref_dir), str(morph_path), str(out_dir),  # swap: mov→mm_ref, ref→mm_mov
        str(nsteps), str(k), str(w_smooth), str(w_deform), str(w_project),
    ]
    proc = subprocess.run(cmd, timeout=600)
    if proc.returncode != 0:
        sys.exit("Match failed")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("ref_ply", type=Path)
    ap.add_argument("mov_ply", type=Path)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument("--k",         type=int,   default=100)
    ap.add_argument("--nsteps",    type=int,   default=1)
    ap.add_argument("--w-smooth",  type=float, default=1.0)
    ap.add_argument("--w-deform",  type=float, default=10.0)
    ap.add_argument("--w-project", type=float, default=1.0)
    ap.add_argument("--skip-morph", action="store_true")
    args = ap.parse_args()

    ref_ply = args.ref_ply.resolve()
    mov_ply = args.mov_ply.resolve()

    ref_sphere = ref_ply.parent / (ref_ply.stem + ".sphere.ply")
    mov_sphere = mov_ply.parent / (mov_ply.stem + ".sphere.ply")
    for p in [ref_ply, mov_ply, ref_sphere, mov_sphere]:
        if not p.exists():
            sys.exit(f"Error: {p} not found")

    out_dir = args.out_dir or (mov_ply.parent / f"match_{ref_ply.stem}")
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Ref:  {ref_ply}")
    print(f"Mov:  {mov_ply}")
    print(f"Out:  {out_dir}")

    ref_dir, mov_dir = stage_dirs(ref_ply, ref_sphere, mov_ply, mov_sphere, out_dir)

    if args.skip_morph:
        morph_path = ref_sphere  # matchmesh2 path_mov=ref expects ref sphere topology
        print(f"Skipping morph — using {morph_path} as initial guess")
    else:
        morph_path = run_morph(ref_sphere, ref_ply, mov_ply, out_dir)

    run_match(ref_dir, mov_dir, morph_path, out_dir,
              args.k, args.nsteps, args.w_smooth, args.w_deform, args.w_project)

    last_step = args.nsteps - 1
    out_ply = out_dir / f"surf.{last_step}.ply"
    if out_ply.exists():
        V, F = igl.read_triangle_mesh(str(out_ply))
        print(f"\nDone. {out_ply.name}: vertices={V.shape[0]}, faces={F.shape[0]}")
    else:
        print(f"\nWarning: expected output {out_ply} not found")


if __name__ == "__main__":
    main()
