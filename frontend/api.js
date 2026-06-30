// Auto-detect the server URL.
// When served by the local Flask server, origin == server, so we use that.
// When hosted remotely (GitHub Pages), fall back to a stored or default port.
export const API = (() => {
    if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
        return `${location.protocol}//${location.host}`;
    }
    const port = localStorage.getItem('mm_port') || '5000';
    return `http://localhost:${port}`;
})();

export async function apiGet(path, params = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
    return res.json();
}

export async function apiPost(path, body = {}) {
    const res = await fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
    return res.json();
}

export async function apiPut(path, body = {}) {
    const res = await fetch(API + path, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT ${path} → ${res.status}`);
    return res.json();
}

export function meshUrl(filePath) {
    return `${API}/api/mesh?path=${encodeURIComponent(filePath)}`;
}

export async function createProject(body) {
    return apiPost('/api/project/create', body);
}

export async function addSubject(body) {
    return apiPost('/api/project/add_subject', body);
}

export async function getProject(root) {
    return apiGet('/api/project', { root });
}

export async function deleteSubject(body) {
    const res = await fetch(API + '/api/project/subject', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DELETE /api/project/subject → ${res.status}`);
    return res.json();
}

export async function getMatches(projectRoot) {
    return apiGet('/api/matches', { project_root: projectRoot });
}

export async function deleteMatch(body) {
    const res = await fetch(API + '/api/project/match', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`DELETE /api/project/match → ${res.status}`);
    return res.json();
}

export async function checkHealth() {
    try {
        const data = await apiGet('/health');
        return data.status === 'ok' ? data : null;
    } catch {
        return null;
    }
}

export async function getConfig() {
    try {
        return await apiGet('/api/config');
    } catch {
        return null;
    }
}

/**
 * Poll a job until it reaches done or error.
 * onProgress(0..1) is called on each tick; returns the result object.
 */
export async function pollJob(jobId, { onProgress = () => {}, intervalMs = 1000 } = {}) {
    return new Promise((resolve, reject) => {
        const tick = async () => {
            let job;
            try { job = await apiGet(`/api/jobs/${jobId}`); }
            catch (e) { return reject(e); }

            onProgress(job.progress ?? 0);

            if (job.status === 'done') return resolve(job.result);
            if (job.status === 'error') return reject(new Error(job.error));
            setTimeout(tick, intervalMs);
        };
        tick();
    });
}
