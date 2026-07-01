import os
import gzip
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, jsonify, request, send_file, Response
import matchmaker
from matchmaker import jobs, pipeline


def _copy_mesh_into_project(root: Path, subject_id: str, source_path: str, now: str) -> Path:
    """Copy source_path into <root>/data/raw/meshes/<subject_id>/mesh.ply,
    decompressing .gz, and write origin.json. Returns the mesh_dir."""
    src = Path(source_path)
    mesh_dir = root / "data" / "raw" / "meshes" / subject_id
    mesh_dir.mkdir(parents=True, exist_ok=True)
    dst = mesh_dir / "mesh.ply"
    if str(src).endswith(".gz"):
        with gzip.open(str(src), "rb") as f_in, open(str(dst), "wb") as f_out:
            f_out.write(f_in.read())
    else:
        shutil.copy2(str(src), str(dst))
    (mesh_dir / "origin.json").write_text(
        json.dumps({"source_path": str(src.resolve()), "timestamp": now}, indent=2)
    )
    (root / "data" / "derived" / "annotations" / subject_id).mkdir(parents=True, exist_ok=True)
    return mesh_dir


def _parse_positive_int(body: dict, key: str, default: int, max_value: int) -> int:
    val = body.get(key, default)
    if not isinstance(val, int) or isinstance(val, bool) or not (1 <= val <= max_value):
        raise ValueError(f"{key} must be an integer in [1, {max_value}]")
    return val


def create_app(data_root: str) -> Flask:
    # Serve the frontend/ directory that lives next to this package
    pkg_dir = Path(__file__).parent
    frontend_dir = pkg_dir.parent / "frontend"

    app = Flask(__name__, static_folder=str(frontend_dir), static_url_path="")

    # ── CORS ──────────────────────────────────────────────────────────────────
    @app.after_request
    def _cors(response):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        return response

    @app.route("/")
    def index():
        return send_file(frontend_dir / "index.html")

    # ── Health ────────────────────────────────────────────────────────────────
    @app.route("/health")
    def health():
        return jsonify({"status": "ok", "version": matchmaker.__version__})

    # ── File browser ──────────────────────────────────────────────────────────
    @app.route("/api/files")
    def list_files():
        rel = request.args.get("dir", "")
        if rel and os.path.isabs(rel):
            target = Path(os.path.abspath(rel))
        elif rel:
            target = Path(os.path.abspath(os.path.join(data_root, rel)))
        else:
            target = Path(data_root)
        if not target.is_dir():
            return jsonify({"error": "Not a directory"}), 400

        entries = []
        for p in sorted(target.iterdir()):
            if p.name.startswith("."):
                continue
            entries.append({
                "name": p.name,
                "path": str(p),
                "is_dir": p.is_dir(),
                "size": p.stat().st_size if p.is_file() else None,
            })
        return jsonify(entries)

    # ── Match roster ─────────────────────────────────────────────────────────
    @app.route("/api/matches")
    def list_matches():
        project_root = request.args.get("project_root", "").strip()
        if not project_root:
            return jsonify({"error": "project_root required"}), 400

        matches_dir = Path(os.path.abspath(project_root)) / "data" / "derived" / "matches"
        if not matches_dir.is_dir():
            return jsonify([])

        results = []
        for entry in sorted(matches_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue

            name = entry.name
            sep  = "_as_"
            idx  = name.find(sep)
            if idx == -1:
                mov_id, ref_id = name, None
            else:
                mov_id = name[:idx]
                ref_id = name[idx + len(sep):]

            has_morph = (entry / "morph.sphere.ply").exists()
            has_match = (entry / "surf.0.ply").exists() or (entry / "surf.0.ply.gz").exists()

            params = None
            params_file = entry / "params.json"
            if params_file.exists():
                try:
                    params = json.loads(params_file.read_text())
                except Exception:
                    pass

            results.append({
                "name":      name,
                "dir":       str(entry),
                "mov_id":    mov_id,
                "ref_id":    ref_id,
                "has_morph": has_morph,
                "has_match": has_match,
                "params":    params,
            })

        return jsonify(results)

    # ── Mesh serving ──────────────────────────────────────────────────────────
    @app.route("/api/mesh")
    def serve_mesh():
        path_str = request.args.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403

        if not (target.suffix == ".ply" or str(target).endswith(".ply.gz")):
            return jsonify({"error": "Not a PLY file"}), 400

        if str(target).endswith(".gz"):
            with gzip.open(target, "rb") as f:
                data = f.read()
            return Response(data, mimetype="application/octet-stream",
                            headers={"Content-Disposition": f'inline; filename="{target.stem}"'})

        return send_file(str(target), mimetype="application/octet-stream")

    # ── Companion files ───────────────────────────────────────────────────────
    @app.route("/api/companions")
    def get_companions():
        path_str    = request.args.get("path", "")
        project_root = request.args.get("project_root", "")
        subject_id   = request.args.get("subject_id", "")

        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        if not str(target).endswith(".ply"):
            return jsonify({"error": "Not a PLY file"}), 400

        def _existing(p):
            return str(p) if Path(p).exists() else None

        # Project-aware lookup: check annotations dir first
        if project_root and subject_id:
            ann = Path(project_root) / "data" / "derived" / "annotations" / subject_id
            result = {
                "sphere":       _existing(ann / "sphere.ply"),
                "sulc":         _existing(ann / "sulc.txt.gz"),
                "curv":         _existing(ann / "curv.txt.gz"),
                "sulci_json":   _existing(ann / "sulci.json"),
                "rotation_txt": _existing(ann / "rotation.txt"),
            }
            # Fall back to sibling files for any missing companions
            base   = str(target)[:-4]
            parent = target.parent
            if not result["sphere"]:       result["sphere"]       = _existing(base + ".sphere.ply")
            if not result["sulc"]:         result["sulc"]         = _existing(base + ".sulc.txt.gz")
            if not result["curv"]:         result["curv"]         = _existing(base + ".curv.txt.gz")
            if not result["sulci_json"]:   result["sulci_json"]   = _existing(parent / "sulci.json")
            if not result["rotation_txt"]: result["rotation_txt"] = _existing(parent / "rotation.txt")
            return jsonify(result)

        # Legacy sibling-file lookup
        base   = str(target)[:-4]
        parent = target.parent
        return jsonify({
            "sphere":       _existing(base + ".sphere.ply"),
            "sulc":         _existing(base + ".sulc.txt.gz"),
            "curv":         _existing(base + ".curv.txt.gz"),
            "sulci_json":   _existing(parent / "sulci.json"),
            "rotation_txt": _existing(parent / "rotation.txt"),
        })

    # ── Raw mesh geometry (vertices + face indices) ───────────────────────────
    @app.route("/api/mesh_raw")
    def serve_mesh_raw():
        path_str = request.args.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        name = str(target)
        if not (name.endswith(".ply") or name.endswith(".ply.gz")):
            return jsonify({"error": "Not a PLY file"}), 400
        import io as _io
        import trimesh as _trimesh
        if name.endswith(".gz"):
            with gzip.open(target, "rb") as f:
                data = f.read()
            mesh = _trimesh.load(_io.BytesIO(data), file_type="ply", process=False)
        else:
            mesh = _trimesh.load(name, process=False)
        c = mesh.vertices.mean(axis=0)
        verts = (mesh.vertices - c).tolist()
        faces = mesh.faces.tolist()
        return jsonify({"vertices": verts, "faces": faces})

    # ── Spherize ──────────────────────────────────────────────────────────────
    @app.route("/api/spherize", methods=["POST", "OPTIONS"])
    def do_spherize():
        if request.method == "OPTIONS":
            return "", 204
        body = request.get_json(force=True)
        path_str = body.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        if not str(target).endswith(".ply"):
            return jsonify({"error": "Not a PLY file"}), 400
        out_dir = body.get("out_dir") or None
        if out_dir:
            out_dir = str(_safe_path(data_root, out_dir, allow_any=True) or "")
            if not out_dir:
                return jsonify({"error": "Forbidden: out_dir"}), 403
        job_id = jobs.submit(pipeline.spherize, str(target), out_dir=out_dir)
        return jsonify({"job_id": job_id})

    # ── Curvature ─────────────────────────────────────────────────────────────
    @app.route("/api/curvature", methods=["POST", "OPTIONS"])
    def do_curvature():
        if request.method == "OPTIONS":
            return "", 204
        body = request.get_json(force=True)
        path_str = body.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        if not str(target).endswith(".ply"):
            return jsonify({"error": "Not a PLY file"}), 400
        out_dir = body.get("out_dir") or None
        if out_dir:
            out_dir = str(_safe_path(data_root, out_dir, allow_any=True) or "")
            if not out_dir:
                return jsonify({"error": "Forbidden: out_dir"}), 403
        job_id = jobs.submit(pipeline.compute_curvature, str(target), out_dir=out_dir)
        return jsonify({"job_id": job_id})

    # ── Morph ─────────────────────────────────────────────────────────────────
    @app.route("/api/morph", methods=["POST", "OPTIONS"])
    def do_morph():
        if request.method == "OPTIONS":
            return "", 204
        body = request.get_json(force=True)
        ref_sphere = _safe_path(data_root, body.get("ref_sphere", ""), allow_any=True)
        out_dir    = _safe_path(data_root, body.get("out_dir",    ""), allow_any=True)
        if ref_sphere is None:
            return jsonify({"error": "Forbidden: ref_sphere"}), 403
        if out_dir is None:
            return jsonify({"error": "Forbidden: out_dir"}), 403
        sulci_ref = body.get("sulci_ref")
        sulci_mov = body.get("sulci_mov")
        if not isinstance(sulci_ref, list) or not isinstance(sulci_mov, list) or not sulci_ref or not sulci_mov:
            return jsonify({"error": "sulci_ref and sulci_mov are required and must be lists"}), 400
        rot_ref_path = body.get("rot_ref_path")
        rot_mov_path = body.get("rot_mov_path")
        if rot_ref_path:
            p = _safe_path(data_root, rot_ref_path, allow_any=True)
            if p is None:
                return jsonify({"error": "Forbidden: rot_ref_path"}), 403
            rot_ref_path = str(p)
        if rot_mov_path:
            p = _safe_path(data_root, rot_mov_path, allow_any=True)
            if p is None:
                return jsonify({"error": "Forbidden: rot_mov_path"}), 403
            rot_mov_path = str(p)
        job_id = jobs.submit(
            pipeline.run_morph,
            str(ref_sphere), sulci_ref, sulci_mov, str(out_dir),
            rot_ref_path=rot_ref_path, rot_mov_path=rot_mov_path,
        )
        return jsonify({"job_id": job_id})

    # ── Save sphere PLY ───────────────────────────────────────────────────────
    @app.route("/api/save_sphere", methods=["POST", "OPTIONS"])
    def do_save_sphere():
        if request.method == "OPTIONS":
            return "", 204
        import numpy as _np
        import igl as _igl
        body = request.get_json(force=True)
        path_str = body.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        verts = _np.array(body["vertices"], dtype=_np.float32).reshape(-1, 3)
        faces = _np.array(body["faces"], dtype=_np.int32).reshape(-1, 3)
        target.parent.mkdir(parents=True, exist_ok=True)
        _igl.write_triangle_mesh(str(target), verts, faces)
        return jsonify({"path": str(target)})

    # ── Match ─────────────────────────────────────────────────────────────────
    @app.route("/api/match", methods=["POST", "OPTIONS"])
    def do_match():
        if request.method == "OPTIONS":
            return "", 204
        body = request.get_json(force=True)
        ref_ply    = _safe_path(data_root, body.get("ref_ply", ""),    allow_any=True)
        ref_sphere = _safe_path(data_root, body.get("ref_sphere", ""), allow_any=True)
        mov_ply    = _safe_path(data_root, body.get("mov_ply", ""),    allow_any=True)
        mov_sphere = _safe_path(data_root, body.get("mov_sphere", ""), allow_any=True)
        morph      = _safe_path(data_root, body.get("morph_sphere", ""), allow_any=True)
        out_dir    = _safe_path(data_root, body.get("out_dir", ""),    allow_any=True)
        for p, name in [
            (ref_ply,    "ref_ply"),
            (ref_sphere, "ref_sphere"),
            (mov_ply,    "mov_ply"),
            (mov_sphere, "mov_sphere"),
            (morph,      "morph_sphere"),
            (out_dir,    "out_dir"),
        ]:
            if p is None:
                return jsonify({"error": f"Forbidden: {name}"}), 403
        ref_rot = body.get("ref_rot")
        mov_rot = body.get("mov_rot")
        try:
            k      = _parse_positive_int(body, "k", 100, 1000)
            nsteps = _parse_positive_int(body, "nsteps", 1, 20)
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        w_smooth  = float(body.get("w_smooth", 1.0))
        w_deform  = float(body.get("w_deform", 10.0))
        w_project = float(body.get("w_project", 1.0))
        job_id = jobs.submit(
            pipeline.run_match,
            str(ref_ply), str(ref_sphere), ref_rot,
            str(mov_ply), str(mov_sphere), mov_rot,
            str(morph), str(out_dir),
            k=k, nsteps=nsteps,
            w_smooth=w_smooth, w_deform=w_deform, w_project=w_project,
        )
        return jsonify({"job_id": job_id})

    # ── Scalar data (curvature / sulcal depth txt.gz) ─────────────────────────
    @app.route("/api/scalar")
    def serve_scalar():
        path_str = request.args.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        name = str(target)
        if not (name.endswith(".txt") or name.endswith(".txt.gz")):
            return jsonify({"error": "Not a scalar txt file"}), 400
        if name.endswith(".gz"):
            with gzip.open(target, "rt") as f:
                lines = f.read().strip().splitlines()
        else:
            with open(target, "r") as f:
                lines = f.read().strip().splitlines()
        # First line is header: "nVertices 1 3" — skip it
        values = [float(l) for l in lines[1:] if l.strip()]
        return jsonify(values)

    # ── Job status ────────────────────────────────────────────────────────────
    @app.route("/api/jobs/<job_id>")
    def get_job(job_id):
        job = jobs.get(job_id)
        if job is None:
            return jsonify({"error": "Not found"}), 404
        return jsonify(job)

    # ── Config ───────────────────────────────────────────────────────────────
    @app.route("/api/config")
    def get_config():
        return jsonify({"data_root": str(Path(data_root).resolve())})

    # ── Read / save file (sulci.json / rotation.txt) ─────────────────────────
    @app.route("/api/file", methods=["GET", "PUT", "OPTIONS"])
    def file_endpoint():
        if request.method == "OPTIONS":
            return "", 204
        if request.method == "GET":
            path_str = request.args.get("path", "")
            target = _safe_path(data_root, path_str, allow_any=True)
            if target is None:
                return jsonify({"error": "Forbidden"}), 403
            if target.suffix not in (".json", ".txt"):
                return jsonify({"error": "Only .json and .txt files can be read"}), 400
            if not target.exists():
                return jsonify({"error": "Not found"}), 404
            content = target.read_text(encoding="utf-8")
            if target.suffix == ".json":
                return jsonify(json.loads(content))
            return jsonify({"content": content})
        # PUT
        body = request.get_json(force=True)
        path_str = body.get("path", "")
        content = body.get("content", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        if target.suffix not in (".json", ".txt"):
            return jsonify({"error": "Only .json and .txt files can be saved"}), 400
        target.write_text(content, encoding="utf-8")
        return jsonify({"ok": True})

    # ── Project management ────────────────────────────────────────────────────

    @app.route("/api/project", methods=["GET"])
    def get_project():
        root = request.args.get("root", "")
        if not root:
            return jsonify({"error": "root required"}), 400
        proj_file = Path(root) / "project.json"
        if not proj_file.exists():
            return jsonify({"error": "No project.json found"}), 404
        return jsonify(json.loads(proj_file.read_text()))

    @app.route("/api/project/create", methods=["POST", "OPTIONS"])
    def create_project():
        if request.method == "OPTIONS":
            return "", 204
        body       = request.get_json(force=True)
        root_dir   = (body.get("root_dir") or "").strip()
        ref_id     = (body.get("ref_id") or "").strip()
        ref_source = (body.get("ref_source_path") or "").strip()
        mov_id     = (body.get("mov_id") or "").strip()
        mov_source = (body.get("mov_source_path") or "").strip()

        if not all([root_dir, ref_id, ref_source]):
            return jsonify({"error": "root_dir, ref_id, ref_source_path required"}), 400
        if mov_id and not mov_source:
            return jsonify({"error": "mov_source_path required when mov_id is provided"}), 400
        if mov_id and ref_id == mov_id:
            return jsonify({"error": "ref_id and mov_id must be different"}), 400

        root = Path(root_dir)
        now  = datetime.now(timezone.utc).isoformat()

        subjects_to_create = [(ref_id, ref_source)]
        if mov_id and mov_source:
            subjects_to_create.append((mov_id, mov_source))

        for subject_id, source_path in subjects_to_create:
            if not Path(source_path).exists():
                return jsonify({"error": f"Source not found: {source_path}"}), 400
            _copy_mesh_into_project(root, subject_id, source_path, now)

        (root / "data" / "derived" / "matches").mkdir(parents=True, exist_ok=True)
        (root / "data" / "derived" / "trajectories").mkdir(parents=True, exist_ok=True)

        subjects_list = [ref_id] + ([mov_id] if mov_id else [])
        project = {"version": "1.0", "created": now, "subjects": subjects_list}
        (root / "project.json").write_text(json.dumps(project, indent=2))

        return jsonify({"project_root": str(root), "ref_id": ref_id, "mov_id": mov_id or None})

    @app.route("/api/project/add_subject", methods=["POST", "OPTIONS"])
    def add_subject():
        if request.method == "OPTIONS":
            return "", 204
        body         = request.get_json(force=True)
        root_dir     = body.get("project_root", "").strip()
        subject_id   = body.get("subject_id", "").strip()
        source_path  = body.get("source_path", "").strip()

        if not all([root_dir, subject_id, source_path]):
            return jsonify({"error": "project_root, subject_id, source_path required"}), 400

        root = Path(root_dir)
        proj_file = root / "project.json"
        if not proj_file.exists():
            return jsonify({"error": "No project.json found at root_dir"}), 404

        if not Path(source_path).exists():
            return jsonify({"error": f"Source not found: {source_path}"}), 400

        now = datetime.now(timezone.utc).isoformat()
        _copy_mesh_into_project(root, subject_id, source_path, now)

        project = json.loads(proj_file.read_text())
        if subject_id not in project.get("subjects", []):
            project.setdefault("subjects", []).append(subject_id)
            proj_file.write_text(json.dumps(project, indent=2))

        return jsonify({"project_root": str(root), "subject_id": subject_id})

    @app.route("/api/project/subject", methods=["DELETE", "OPTIONS"])
    def delete_subject():
        if request.method == "OPTIONS":
            return "", 204
        body       = request.get_json(force=True)
        root_dir   = (body.get("project_root") or "").strip()
        subject_id = (body.get("subject_id") or "").strip()

        if not all([root_dir, subject_id]):
            return jsonify({"error": "project_root and subject_id required"}), 400

        root      = Path(root_dir)
        proj_file = root / "project.json"
        if not proj_file.exists():
            return jsonify({"error": "No project.json found at project_root"}), 404

        project = json.loads(proj_file.read_text())
        if subject_id not in project.get("subjects", []):
            return jsonify({"error": f"Subject '{subject_id}' not in project"}), 400

        project["subjects"] = [s for s in project["subjects"] if s != subject_id]
        proj_file.write_text(json.dumps(project, indent=2))

        shutil.rmtree(root / "data" / "raw" / "meshes" / subject_id, ignore_errors=True)
        shutil.rmtree(root / "data" / "derived" / "annotations" / subject_id, ignore_errors=True)

        return jsonify({"removed": subject_id, "project_root": str(root)})

    # ── Trajectory roster ─────────────────────────────────────────────────────

    @app.route("/api/trajectories")
    def list_trajectories():
        project_root = request.args.get("project_root", "").strip()
        if not project_root:
            return jsonify({"error": "project_root required"}), 400

        traj_dir = Path(os.path.abspath(project_root)) / "data" / "derived" / "trajectories"
        if not traj_dir.is_dir():
            return jsonify([])

        results = []
        for entry in sorted(traj_dir.iterdir()):
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            params = None
            params_file = entry / "params.json"
            if params_file.exists():
                try:
                    params = json.loads(params_file.read_text())
                except Exception:
                    pass
            traj_subdir = entry / "trajectory"
            n_frames = len(list(traj_subdir.glob("*.ply"))) if traj_subdir.is_dir() else 0
            results.append({
                "name":     entry.name,
                "dir":      str(entry),
                "n_frames": n_frames,
                "done":     n_frames > 0,
                "params":   params,
            })

        return jsonify(results)

    @app.route("/api/trajectory", methods=["POST", "OPTIONS"])
    def build_trajectory():
        if request.method == "OPTIONS":
            return "", 204
        body         = request.get_json(force=True)
        project_root = (body.get("project_root") or "").strip()
        seq          = body.get("seq") or []
        traj_name    = (body.get("traj_name") or "").strip()
        mode         = body.get("mode", "raw")

        if not project_root or len(seq) < 2:
            return jsonify({"error": "project_root and seq (≥2 subjects) required"}), 400

        if not traj_name:
            suffix = "_smooth" if mode == "smooth" else ""
            traj_name = "-".join(seq) + suffix

        out_dir = str(
            Path(os.path.abspath(project_root)) / "data" / "derived" / "trajectories" / traj_name
        )

        # Validate that required adjacent-pair matches exist (forward or inverse)
        matches_base = Path(os.path.abspath(project_root)) / "data" / "derived" / "matches"
        for ref, mov in zip(seq, seq[1:]):
            fwd_dir = matches_base / f"{mov}_as_{ref}"
            inv_dir = matches_base / f"{ref}_as_{mov}"
            if (fwd_dir / "surf.0.ply").exists():
                pass  # forward match available
            elif (inv_dir / "surf.0.ply").exists():
                pass  # inverse match accepted; ref_surf.ply computed on the fly if absent
            else:
                return jsonify({
                    "error": f"No match found for {mov}_as_{ref} (tried both directions)"
                }), 400

        params = {
            k: body.get(k, default)
            for k, default in [
                ("n_deformation_smooth", 5),
                ("do_icp", False),
                ("n_trajectory_smooth", 1),
                ("n_spatial_smooth", 1),
                ("lambda_spatial", 0.005),
            ]
        }

        job_id = jobs.submit(
            pipeline.run_trajectory,
            project_root, seq, out_dir, mode=mode, **params,
        )
        return jsonify({"job_id": job_id, "out_dir": out_dir, "traj_name": traj_name})

    @app.route("/api/project/trajectory", methods=["DELETE", "OPTIONS"])
    def delete_trajectory():
        if request.method == "OPTIONS":
            return "", 204
        body     = request.get_json(force=True)
        traj_dir = (body.get("traj_dir") or "").strip()

        if not traj_dir:
            return jsonify({"error": "traj_dir required"}), 400

        target = Path(os.path.abspath(traj_dir))
        parts  = target.parts
        if (len(parts) < 4
                or parts[-2] != "trajectories"
                or parts[-3] != "derived"
                or parts[-4] != "data"):
            return jsonify({"error": "traj_dir is not inside data/derived/trajectories/"}), 400

        if not target.is_dir():
            return jsonify({"error": "Directory not found"}), 404

        shutil.rmtree(str(target))
        return jsonify({"removed": str(target)})

    @app.route("/api/project/match", methods=["DELETE", "OPTIONS"])
    def delete_match():
        if request.method == "OPTIONS":
            return "", 204
        body      = request.get_json(force=True)
        match_dir = (body.get("match_dir") or "").strip()

        if not match_dir:
            return jsonify({"error": "match_dir required"}), 400

        target = Path(os.path.abspath(match_dir))
        parts  = target.parts
        if len(parts) < 4 or parts[-2] != "matches" or parts[-3] != "derived" or parts[-4] != "data":
            return jsonify({"error": "match_dir is not inside data/derived/matches/"}), 400

        if not target.is_dir():
            return jsonify({"error": "Directory not found"}), 404

        shutil.rmtree(str(target))
        return jsonify({"removed": str(target)})

    return app


def _safe_path(root: str, rel: str, allow_absolute: bool = False, allow_any: bool = False) -> "Path | None":
    """Return the normalised path only if it stays inside root.

    allow_any=True skips the root check for absolute paths (used by data-serving
    endpoints so users can open files anywhere on the filesystem).
    Uses os.path.abspath (not Path.resolve) so that symlinks *within* the
    project tree (e.g. trajectoryviewer/) are accessible without following
    them out of the root.
    """
    if allow_any and os.path.isabs(rel):
        return Path(os.path.abspath(rel))

    root_norm = os.path.abspath(root)

    if allow_absolute and os.path.isabs(rel):
        candidate = os.path.abspath(rel)
    else:
        candidate = os.path.abspath(os.path.join(root_norm, rel))

    if candidate == root_norm or candidate.startswith(root_norm + os.sep):
        return Path(candidate)
    return None
