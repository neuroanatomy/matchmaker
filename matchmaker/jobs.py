import threading
import uuid
import traceback

_jobs: dict = {}
_lock = threading.Lock()
_MAX_JOBS = 200


def _prune_oldest_finished():
    """Drop the oldest done/error jobs (FIFO by insertion order) until under _MAX_JOBS.
    Must be called with _lock held."""
    finished = [jid for jid, j in _jobs.items() if j["status"] in ("done", "error")]
    for jid in finished[: len(_jobs) - _MAX_JOBS]:
        del _jobs[jid]


def submit(fn, *args, **kwargs) -> str:
    """Run fn(*args, progress=<callable>, **kwargs) in a background thread.
    Returns a job_id that can be passed to get()."""
    job_id = uuid.uuid4().hex[:8]
    job = {"status": "queued", "progress": 0.0, "result": None, "error": None}
    with _lock:
        _jobs[job_id] = job
        if len(_jobs) > _MAX_JOBS:
            _prune_oldest_finished()

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
