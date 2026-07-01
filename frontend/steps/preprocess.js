import { el, setStatus, preItem } from '../dom-helpers.js';
import { state } from '../state.js';
import { meshUrl, apiGet, apiPost, pollJob } from '../api.js';
import { annotationsDir } from './load.js';
import { renderStep } from '../app.js';

// ── Step 2 — Preprocess ──────────────────────────────────────────────────
export function renderPreprocessPanel(container) {
    container.innerHTML = '';

    if (state.subjectOrder.length === 0) {
        const msg = el('p', { className: 'coming-soon' });
        msg.textContent = 'No meshes loaded — go to Load (step 1) first.';
        container.appendChild(msg);
        return;
    }

    // Subject roster with inline status chips
    const roster = el('div', { className: 'subject-roster' });
    state.subjectOrder.forEach(id => {
        const s   = state.subjects[id];
        const row = el('div', { className: `subject-row${id === state.activeSubjectId ? ' active' : ''}` });
        row.dataset.subjectId = id;

        const info = el('div', { className: 'subject-row-info' });
        const idEl = el('span', { className: 'subject-row-id' });
        idEl.textContent = id;
        info.appendChild(idEl);

        const chips = el('span', { className: 'pre-chips' });
        const _chip = (label, done) => {
            const c = el('span', { className: `pre-chip ${done ? 'pre-done' : 'pre-missing'}` });
            c.textContent = (done ? '✓' : '✗') + ' ' + label;
            return c;
        };
        chips.appendChild(_chip('sph', !!s.sphere));
        chips.appendChild(_chip('maps', !!(s.curv && s.sulc)));
        info.appendChild(chips);

        row.appendChild(info);
        row.onclick = () => {
            state.activeSubjectId = id;
            renderPreprocessPanel(container);
        };
        roster.appendChild(row);
    });
    container.appendChild(roster);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // Detail section for active subject
    if (!state.activeSubjectId || !state.subjects[state.activeSubjectId]) return;

    const id  = state.activeSubjectId;
    const s   = state.subjects[id];

    const section = el('div', { className: 'sph-section' });

    const hdr = el('div', { className: 'pre-header' });
    const lbl = el('span', { className: 'sph-label' });
    lbl.textContent = id;
    hdr.appendChild(lbl);
    const fname = el('span', { className: 'pre-filename' });
    fname.textContent = s.path ? '  ' + s.path.split('/').pop() : '';
    hdr.appendChild(fname);
    section.appendChild(hdr);

    section.appendChild(preItem('Sphere',       !!s.sphere));
    section.appendChild(preItem('Curvature',    !!s.curv));
    section.appendChild(preItem('Sulcal depth', !!s.sulc));

    if (!s.sphere) {
        const bar  = el('div', { className: 'progress-bar-wrap' });
        const fill = el('div', { className: 'progress-bar' });
        bar.appendChild(fill); bar.style.display = 'none';
        section.appendChild(bar);
        const btn = el('button', { className: 'load-btn' });
        btn.textContent = 'Spherize';
        btn.onclick = () => spherize(id, fill, btn);
        section.appendChild(btn);
    }
    if (!s.curv || !s.sulc) {
        const bar  = el('div', { className: 'progress-bar-wrap' });
        const fill = el('div', { className: 'progress-bar' });
        bar.appendChild(fill); bar.style.display = 'none';
        section.appendChild(bar);
        const btn = el('button', { className: 'load-btn' });
        btn.textContent = 'Compute maps';
        btn.onclick = () => computeCurvature(id, fill, btn);
        section.appendChild(btn);
    }

    container.appendChild(section);
}

export async function viewMesh(id, meshType) {
    if (state.viewedSubjectId === id && state.viewState[id]?.meshType === meshType) return;
    state.viewedSubjectId = id;
    if (!state.viewState[id]) state.viewState[id] = { meshType: null, texType: null };
    state.viewState[id].meshType = meshType;
    await refreshViewer();
    renderStep(state.currentStep);
}

export async function toggleTexture(id, texType) {
    if (!state.viewState[id]) state.viewState[id] = { meshType: 'native', texType: null };
    state.viewState[id].texType = state.viewState[id].texType === texType ? null : texType;
    if (state.viewedSubjectId === id) await refreshViewer({ preserveOrientation: true });
    renderStep(state.currentStep);
}

export async function refreshViewer({ preserveOrientation = false } = {}) {
    if (!state.viewedSubjectId || !state.viewState[state.viewedSubjectId]?.meshType) return;
    const id      = state.viewedSubjectId;
    const s       = state.subjects[id];
    if (!s) return;
    const vs      = state.viewState[id];
    const meshPath = vs.meshType === 'sphere' ? s.sphere : s.path;
    if (!meshPath) return;

    const texType = vs.texType;
    if (texType === 'sulc' || texType === 'curv') {
        const scalarPath = texType === 'sulc' ? s.sulc : s.curv;
        if (scalarPath) {
            try {
                const scalars = await apiGet('/api/scalar', { path: scalarPath });
                await state.viewer.loadMeshColored(meshUrl(meshPath), scalars, { preserveOrientation });
                setStatus(`${meshPath.split('/').pop()} — ${texType === 'sulc' ? 'sulcal depth' : 'curvature'}`);
            } catch (e) { setStatus(`Error: ${e.message}`); }
            return;
        }
    }
    await state.viewer.loadMesh(meshUrl(meshPath), { preserveOrientation });
    setStatus(meshPath.split('/').pop());
}

export async function spherize(id, fillEl, btn) {
    btn.disabled = true;
    const s    = state.subjects[id];
    const body = { path: s.path };
    if (state.projectRoot) body.out_dir = annotationsDir(id);
    fillEl.parentElement.style.display = 'block';
    setStatus(`Spherizing ${s.path.split('/').pop()}…`);
    try {
        const { job_id } = await apiPost('/api/spherize', body);
        const result = await pollJob(job_id, {
            onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
        });
        state.subjects[id].sphere = result.sphere_path;
        setStatus(`Sphere ready: ${result.sphere_path.split('/').pop()}`);
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Spherize error: ${e.message}`);
        btn.disabled = false;
    }
}

export async function computeCurvature(id, fillEl, btn) {
    btn.disabled = true;
    const s    = state.subjects[id];
    const body = { path: s.path };
    if (state.projectRoot) body.out_dir = annotationsDir(id);
    fillEl.parentElement.style.display = 'block';
    setStatus(`Computing maps for ${s.path.split('/').pop()}…`);
    try {
        const { job_id } = await apiPost('/api/curvature', body);
        const result = await pollJob(job_id, {
            onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
        });
        state.subjects[id].curv = result.curv_path;
        state.subjects[id].sulc = result.sulc_path;
        setStatus(`Maps ready: ${result.sulc_path.split('/').pop()}`);
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Maps error: ${e.message}`);
        btn.disabled = false;
    }
}
