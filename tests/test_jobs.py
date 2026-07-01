import threading
import time

import pytest

from matchmaker import jobs


@pytest.fixture(autouse=True)
def _clear_jobs():
    jobs._jobs.clear()
    yield
    jobs._jobs.clear()


def _trivial(progress):
    progress(1.0)
    return "ok"


def test_submit_returns_job_id_and_get_tracks_status():
    job_id = jobs.submit(_trivial)
    assert job_id
    for _ in range(50):
        status = jobs.get(job_id)
        if status["status"] == "done":
            break
        time.sleep(0.01)
    assert status["status"] == "done"
    assert status["result"] == "ok"


def test_prune_keeps_under_cap():
    for _ in range(jobs._MAX_JOBS + 50):
        job_id = jobs.submit(_trivial)
        for _ in range(50):
            if jobs.get(job_id)["status"] in ("done", "error"):
                break
            time.sleep(0.01)
    assert len(jobs._jobs) <= jobs._MAX_JOBS


def test_prune_never_drops_running_jobs():
    release = threading.Event()

    def _blocking(progress):
        release.wait(timeout=5)
        return "unblocked"

    running_id = jobs.submit(_blocking)
    for _ in range(50):
        if jobs.get(running_id)["status"] == "running":
            break
        time.sleep(0.01)

    for _ in range(jobs._MAX_JOBS + 50):
        job_id = jobs.submit(_trivial)
        for _ in range(50):
            if jobs.get(job_id)["status"] in ("done", "error"):
                break
            time.sleep(0.01)

    assert running_id in jobs._jobs
    assert len(jobs._jobs) <= jobs._MAX_JOBS + 1

    release.set()
    for _ in range(50):
        if jobs.get(running_id)["status"] == "done":
            break
        time.sleep(0.01)
