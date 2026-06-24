import threading
import uuid
import traceback

_jobs: dict = {}
_lock = threading.Lock()


def submit(fn, *args, **kwargs) -> str:
    """Run fn(*args, progress=<callable>, **kwargs) in a background thread.
    Returns a job_id that can be passed to get()."""
    job_id = uuid.uuid4().hex[:8]
    job = {"status": "queued", "progress": 0.0, "result": None, "error": None}
    with _lock:
        _jobs[job_id] = job

    def _progress(p: float):
        job["progress"] = float(p)
        if job["status"] == "queued":
            job["status"] = "running"

    def _run():
        job["status"] = "running"
        try:
            result = fn(*args, progress=_progress, **kwargs)
            job["result"] = result
            job["progress"] = 1.0
            job["status"] = "done"
        except Exception:
            job["error"] = traceback.format_exc()
            job["status"] = "error"

    threading.Thread(target=_run, daemon=True).start()
    return job_id


def get(job_id: str) -> "dict | None":
    with _lock:
        return _jobs.get(job_id)
