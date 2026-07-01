#!/usr/bin/env python3
"""
matchmaker-match — Run the full morph + match pipeline for a pair of surfaces.

Usage:
    conda run -n py310 matchmaker-match REF_PLY MOV_PLY [options]

Arguments:
    REF_PLY     Path to the reference surface PLY
    MOV_PLY     Path to the moving surface PLY

Companion files (sphere.ply, sulci.json, rotation.txt) are discovered from
the project's annotations directory when the mesh lives inside a MatchMaker
project (data/raw/meshes/<id>/mesh.ply); otherwise they are read from the
same directory as the PLY (legacy layout).

Options:
    --out-dir DIR    Output directory (default: project layout or <mov_dir>/match_<ref_stem>)
    --k INT          Laplacian eigenvectors (default: 100)
    --nsteps INT     Refinement steps (default: 1)
    --w-smooth F     Sphere-smoothness weight (default: 1.0)
    --w-deform F     Deformation-smoothness weight (default: 10.0)
    --w-project F    Surface-alignment weight (default: 1.0)
    --skip-morph     Use MOV sphere as-is (no SBN morph) — for testing only
"""
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from matchmaker import pipeline


def _find_project_root(ply: Path) -> Path | None:
    """Walk up directory tree looking for project.json."""
    p = ply.parent
    for _ in range(10):
        if (p / "project.json").exists():
            return p
        if p == p.parent:
            break
        p = p.parent
    return None


def _discover_companions(ply: Path) -> dict:
    """Return companion paths for a mesh, using project or legacy layout."""
    project_root = _find_project_root(ply)

    if project_root is not None:
        try:
            rel = ply.relative_to(project_root / "data" / "raw" / "meshes")
            subject_id = rel.parts[0]
            ann = project_root / "data" / "derived" / "annotations" / subject_id
            sphere = ann / "sphere.ply"
            sulci  = ann / "sulci.json"
            rot    = ann / "rotation.txt"
            return {
                "sphere":       sphere if sphere.exists() else None,
                "sulci":        sulci  if sulci.exists()  else None,
                "rotation":     rot    if rot.exists()    else None,
                "project_root": project_root,
                "subject_id":   subject_id,
            }
        except ValueError:
            pass  # ply not inside data/raw/meshes — fall through to legacy

    # Legacy: companions alongside the PLY
    stem   = ply.stem
    parent = ply.parent
    sphere = parent / f"{stem}.sphere.ply"
    sulci  = parent / "sulci.json"
    rot    = parent / "rotation.txt"
    return {
        "sphere":       sphere if sphere.exists() else None,
        "sulci":        sulci  if sulci.exists()  else None,
        "rotation":     rot    if rot.exists()    else None,
        "project_root": None,
        "subject_id":   None,
    }


def main():
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("ref_ply", type=Path)
    ap.add_argument("mov_ply", type=Path)
    ap.add_argument("--out-dir",   type=Path, default=None)
    ap.add_argument("--k",         type=int,   default=100)
    ap.add_argument("--nsteps",    type=int,   default=1)
    ap.add_argument("--w-smooth",  type=float, default=1.0)
    ap.add_argument("--w-deform",  type=float, default=10.0)
    ap.add_argument("--w-project", type=float, default=1.0)
    ap.add_argument("--skip-morph", action="store_true")
    args = ap.parse_args()

    ref_ply = args.ref_ply.resolve()
    mov_ply = args.mov_ply.resolve()

    for p in (ref_ply, mov_ply):
        if not p.exists():
            sys.exit(f"Error: {p} not found")

    ref_comp = _discover_companions(ref_ply)
    mov_comp = _discover_companions(mov_ply)

    ref_sphere = ref_comp["sphere"]
    mov_sphere = mov_comp["sphere"]

    for label, p in [("ref sphere", ref_sphere), ("mov sphere", mov_sphere)]:
        if p is None:
            sys.exit(f"Error: {label} not found — run spherize first")

    ref_sulci = ref_comp["sulci"]
    mov_sulci = mov_comp["sulci"]

    if not args.skip_morph:
        for label, p in [("ref sulci.json", ref_sulci), ("mov sulci.json", mov_sulci)]:
            if p is None:
                sys.exit(f"Error: {label} not found — run Align step first")

    # Determine output directory
    out_dir = args.out_dir
    if out_dir is None:
        ref_proj = ref_comp["project_root"]
        mov_proj = mov_comp["project_root"]
        if ref_proj and mov_proj and ref_proj == mov_proj:
            out_dir = ref_proj / "data" / "derived" / "matches" / f"{mov_comp['subject_id']}_as_{ref_comp['subject_id']}"
        else:
            out_dir = mov_ply.parent / f"match_{ref_ply.stem}"
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Ref:  {ref_ply}")
    print(f"Mov:  {mov_ply}")
    print(f"Out:  {out_dir}")

    if args.skip_morph:
        morph_path = str(ref_sphere)
        print(f"Skipping morph — using {morph_path} as initial guess")
    else:
        sulci_ref = json.loads(Path(ref_sulci).read_text())
        sulci_mov = json.loads(Path(mov_sulci).read_text())
        result = pipeline.run_morph(
            str(ref_sphere),
            sulci_ref,
            sulci_mov,
            str(out_dir),
            rot_ref_path=str(ref_comp["rotation"]) if ref_comp["rotation"] else None,
            rot_mov_path=str(mov_comp["rotation"]) if mov_comp["rotation"] else None,
        )
        morph_path = result["morph_sphere_path"]
        print(f"Morph done → {morph_path}")

    result = pipeline.run_match(
        str(ref_ply), str(ref_sphere), str(ref_comp["rotation"]) if ref_comp["rotation"] else None,
        str(mov_ply), str(mov_sphere), str(mov_comp["rotation"]) if mov_comp["rotation"] else None,
        morph_path, str(out_dir),
        k=args.k,
        nsteps=args.nsteps,
        w_smooth=args.w_smooth,
        w_deform=args.w_deform,
        w_project=args.w_project,
    )

    # Write params.json for provenance
    ref_id = ref_comp["subject_id"] or ref_ply.stem
    mov_id = mov_comp["subject_id"] or mov_ply.stem
    params = {
        "ref_id":  ref_id,
        "mov_id":  mov_id,
        "ref_ply": str(ref_ply),
        "mov_ply": str(mov_ply),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "match": {
            "k":         args.k,
            "nsteps":    args.nsteps,
            "w_smooth":  args.w_smooth,
            "w_deform":  args.w_deform,
            "w_project": args.w_project,
        },
    }
    (out_dir / "params.json").write_text(json.dumps(params, indent=2))

    matched_ply = result["matched_ply"]
    print(f"\nDone. Output: {matched_ply}")
    if not Path(matched_ply).exists():
        print(f"Warning: expected output {matched_ply} not found")


if __name__ == "__main__":
    main()
