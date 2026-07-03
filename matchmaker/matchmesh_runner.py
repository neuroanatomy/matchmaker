"""
Thin wrapper around matchmesh/matchmesh4.py.
Patches module-level globals (k, energy weights) before calling main().
Called as a subprocess by pipeline.run_match().

matchmesh4.py minimises with the closed-form analytic gradient (energy_grad)
instead of matchmesh2.py's finite-difference approximation — see
matchmesh/docs/4.benchmark.md. matchmesh2's default finite-difference run
burns its evaluation budget on gradient estimation and typically exits via
"TOTAL NO. OF F,G EVALUATIONS EXCEEDS LIMIT" without converging; matchmesh4
reliably reaches warnflag=0 in far fewer, far cheaper iterations.

Usage:
  python matchmesh_runner.py path_ref path_mov path_morph out_dir nsteps k w_smooth w_deform w_project
"""
import sys
import os
import importlib.util


def _load_matchmesh4():
    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.normpath(os.path.join(here, "..", "matchmesh", "matchmesh4.py"))
    if not os.path.exists(candidate):
        raise FileNotFoundError(f"matchmesh4.py not found at {candidate}")
    spec = importlib.util.spec_from_file_location("matchmesh4", candidate)
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

    mm = _load_matchmesh4()

    # Patch number of eigenvectors
    mm.k = k

    # Replace energy()/energy_grad() to use caller-supplied weights.
    # minimisation() calls energy_grad() (analytic gradient); energy() is kept
    # in sync too since check_energy_grad() and any direct callers use it.
    _ws, _wd, _wp = w_smooth, w_deform, w_project

    def patched_energy(coords):
        sph       = mm.sphere(coords)
        E_smooth  = mm.smooth_energy(sph)
        E_def     = mm.deformation_smooth_energy(sph)
        E_project = mm.project_energy(sph)
        return _ws * E_smooth + _wd * E_def + _wp * E_project

    def patched_energy_grad(coords):
        sph, pre, nrm = mm.sphere_fwd(coords, alpha=1)
        E_smooth, g_smooth = mm.smooth_energy_grad(sph)
        E_def, g_def       = mm.deformation_smooth_energy_grad(sph)
        E_project, g_project = mm.project_energy_grad(sph)

        E     = _ws * E_smooth  + _wd * E_def  + _wp * E_project
        g_sph = _ws * g_smooth  + _wd * g_def  + _wp * g_project
        grad  = mm.sphere_bwd(g_sph, pre, nrm, alpha=1)

        mm._last_E = E
        return E, grad

    mm.energy = patched_energy
    mm.energy_grad = patched_energy_grad

    mm.main(path_ref, path_mov, path_morph, out_dir, nsteps)


if __name__ == "__main__":
    main()
