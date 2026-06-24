import os
import gzip
import json
from pathlib import Path
from flask import Flask, jsonify, request, send_file, Response
import matchmaker
from matchmaker import jobs, pipeline


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
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS"
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
        path_str = request.args.get("path", "")
        target = _safe_path(data_root, path_str, allow_any=True)
        if target is None:
            return jsonify({"error": "Forbidden"}), 403
        if not str(target).endswith(".ply"):
            return jsonify({"error": "Not a PLY file"}), 400
        base = str(target)[:-4]
        parent = target.parent
        def _existing(p):
            return p if Path(p).exists() else None
        return jsonify({
            "sphere":       _existing(base + ".sphere.ply"),
            "sulc":         _existing(base + ".sulc.txt.gz"),
            "curv":         _existing(base + ".curv.txt.gz"),
            "sulci_json":   _existing(str(parent / "sulci.json")),
            "rotation_txt": _existing(str(parent / "rotation.txt")),
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
        job_id = jobs.submit(pipeline.spherize, str(target))
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
        job_id = jobs.submit(pipeline.compute_curvature, str(target))
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
        if not sulci_ref or not sulci_mov:
            return jsonify({"error": "sulci_ref and sulci_mov are required"}), 400
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
        k         = int(body.get("k", 100))
        nsteps    = int(body.get("nsteps", 1))
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
