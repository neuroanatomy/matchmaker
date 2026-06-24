"""
Thin wrapper around matchmesh/matchmesh2.py.
Patches module-level globals (k, energy weights) before calling main().
Called as a subprocess by pipeline.run_match().

Usage:
  python matchmesh_runner.py path_ref path_mov path_morph out_dir nsteps k w_smooth w_deform w_project
"""
import sys
import os
import importlib.util


def _load_matchmesh2():
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.normpath(os.path.join(here, "..", "matchmesh", "matchmesh2.py"))
    if not os.path.exists(candidate):
        raise FileNotFoundError(f"matchmesh2.py not found at {candidate}")
    spec = importlib.util.spec_from_file_location("matchmesh2", candidate)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    args = sys.argv[1:]
    if len(args) != 9:
        print(
            "Usage: matchmesh_runner.py "
            "path_ref path_mov path_morph out_dir nsteps k w_smooth w_deform w_project",
            file=sys.stderr,
        )
        sys.exit(1)

    path_ref, path_mov, path_morph, out_dir = args[0], args[1], args[2], args[3]
    nsteps    = int(args[4])
    k         = int(args[5])
    w_smooth  = float(args[6])
    w_deform  = float(args[7])
    w_project = float(args[8])

    mm = _load_matchmesh2()

    # Patch number of eigenvectors
    mm.k = k

    # Replace energy() to use caller-supplied weights
    _ws, _wd, _wp = w_smooth, w_deform, w_project

    def patched_energy(coords):
        sph       = mm.sphere(coords)
        E_smooth  = mm.smooth_energy(sph)
        E_def     = mm.deformation_smooth_energy(sph)
        E_project = mm.project_energy(sph)
        return _ws * E_smooth + _wd * E_def + _wp * E_project

    mm.energy = patched_energy

    mm.main(path_ref, path_mov, path_morph, out_dir, nsteps)


if __name__ == "__main__":
    main()
