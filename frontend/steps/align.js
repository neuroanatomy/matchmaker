import { el, setStatus } from '../dom-helpers.js';
import { state } from '../state.js';
import { meshUrl, apiGet, apiPut } from '../api.js';
import { parseRotMat } from '../components/morph.js';
import { StereoView } from '../components/stereoview.js';
import { StereographicOverlay } from '../components/stereographic.js';
import { renderStep } from '../app.js';

// ── Step 3 — Align ───────────────────────────────────────────────────────

export async function activateAlign(id) {
    const prevId = state.alignSubjectId;
    state.alignSubjectId        = id;
    state.alignHas3DOrientation = false;
    if (state.currentStep !== 3) return;

    if (id === prevId && state.alignOverlay && state.alignStereoView) return;

    state.viewer.clearAll();

    const targetMode = state.alignViewMode;
    if (state.alignViewMode === '3d') state.alignViewMode = 'flat';

    if (state.alignOverlay) {
        if (prevId) state.alignInMemory[prevId] = state.alignOverlay.toJSON();
        state.alignOverlay.destroy();
        state.alignOverlay = null;
    }
    if (state.alignStereoView) { state.alignStereoView.destroy(); state.alignStereoView = null; }

    const s = state.subjects[id];
    if (!s?.sphere) {
        setStatus(`No sphere for ${id} — run Preprocess first`);
        renderStep(state.currentStep);
        return;
    }

    let initR = null;
    if (s.rot) {
        const resp = await apiGet('/api/file', { path: s.rot }).catch(() => null);
        if (resp?.content) {
            try {
                const R9 = parseRotMat(resp.content);
                initR = [
                    [R9[0], R9[3], R9[6]],
                    [R9[1], R9[4], R9[7]],
                    [R9[2], R9[5], R9[8]],
                ];
            } catch { /* malformed rotation.txt */ }
        }
    }
    if (state.currentStep !== 3) return;

    setStatus('Loading sphere…');
    try {
        const scalars = s.sulc ? await apiGet('/api/scalar', { path: s.sulc }) : null;
        if (state.currentStep !== 3) return;

        const container = document.getElementById('viewer-container');
        state.alignStereoView = new StereoView(container);
        window._alignStereoView = state.alignStereoView;
        await state.alignStereoView.load(s.sphere, scalars, initR);
        if (state.currentStep !== 3) { state.alignStereoView.destroy(); state.alignStereoView = null; return; }

        state.alignStereoView.onRotationChange(() => {
            const { alpha, beta, gamma } = state.alignStereoView.getEulerZYX();
            const update = (domId, val) => {
                const el = document.getElementById(domId);
                if (!el) return;
                el.value = val;
                el.setAttribute('aria-valuenow', val);
                const span = el.nextElementSibling;
                if (span) span.textContent = `${val}°`;
            };
            update('rot-twist', alpha);
            update('rot-tiltv', beta);
            update('rot-tilth', gamma);
        });

        state.alignOverlay = new StereographicOverlay(container, state.alignStereoView);

        state.alignOverlay.onChange = () => {
            if (state.alignSubjectId) state.alignInMemory[state.alignSubjectId] = state.alignOverlay.toJSON();
        };

        const inMem     = state.alignInMemory[id];
        const sulciPath = s.sulci;
        if (inMem) {
            state.alignOverlay.fromJSON(inMem);
            setStatus(`Stereo view ready — ${state.alignOverlay.regions.length} landmarks restored`);
        } else if (sulciPath) {
            try {
                const data = await apiGet('/api/file', { path: sulciPath });
                state.alignOverlay.fromJSON(data);
                setStatus(`Loaded ${sulciPath.split('/').pop()} — ${state.alignOverlay.regions.length} landmarks`);
            } catch { /* no prior sulci.json */ }
        }

        if (!inMem && !sulciPath) setStatus('Stereo view ready — draw landmarks');
    } catch (e) {
        setStatus(`Align error: ${e.message}`);
        return;
    }

    if (state.currentStep !== 3) return;
    renderStep(state.currentStep);

    if (targetMode === '3d') await switchViewMode('3d');
}

export async function switchViewMode(mode) {
    if (state.alignViewMode === mode || !state.alignOverlay) return;
    state.alignViewMode = mode;
    renderStep(state.currentStep);
    if (mode === '3d') {
        state.alignStereoView._canvas.style.display = 'none';
        state.alignOverlay._canvas.style.display    = 'none';
        const s      = state.alignSubjectId ? state.subjects[state.alignSubjectId] : null;
        const native = s?.path;
        const scalar = s?.sulc || s?.curv;
        setStatus('Loading 3D view…');
        try {
            const scalars = scalar
                ? await apiGet('/api/scalar', { path: scalar }).catch(() => null)
                : null;
            const preserveOrientation = state.alignHas3DOrientation;
            if (scalars) {
                await state.viewer.loadMeshColored(meshUrl(native), scalars, { preserveOrientation });
            } else {
                await state.viewer.loadMesh(meshUrl(native), { preserveOrientation });
            }
            state.alignHas3DOrientation = true;
            if (state.alignWireframe) state.viewer.setWireframe(true);
            if (state.alignOverlay?.regions.length > 0) {
                const regions3d   = state.alignOverlay.getRegions3DSampled(10);
                const nativeVerts = state.viewer.getMainMeshVertexArray();
                if (nativeVerts) {
                    state.viewer.setLandmarkLinesOnMesh(
                        regions3d,
                        state.alignStereoView._rawVerts,
                        state.alignStereoView._nBase,
                        state.alignStereoView._tris,
                        nativeVerts,
                    );
                }
            }
            setStatus('3D view — orbit to verify; switch back to Flat to draw landmarks');
        } catch (e) {
            setStatus(`3D view error: ${e.message}`);
        }
    } else {
        state.viewer.clearAll();
        state.alignStereoView._canvas.style.display = '';
        state.alignOverlay._canvas.style.display    = '';
        state.alignStereoView._render();
        setStatus('Flat stereo view');
    }
}

export function toggleWireframe() {
    state.alignWireframe = !state.alignWireframe;
    if (state.alignViewMode === 'flat') {
        state.alignStereoView?.setWireframe(state.alignWireframe);
    } else {
        state.viewer.setWireframe(state.alignWireframe);
    }
    renderStep(state.currentStep);
}

export function renderAlignPanel(container) {
    container.innerHTML = '';

    if (state.subjectOrder.length === 0) {
        const msg = el('p', { className: 'coming-soon' });
        msg.textContent = 'No meshes loaded — go to Load (step 1) first.';
        container.appendChild(msg);
        return;
    }

    // Subject selector roster
    const roster = el('div', { className: 'subject-roster' });
    state.subjectOrder.forEach(id => {
        const s   = state.subjects[id];
        const row = el('div', { className: `subject-row${id === state.alignSubjectId ? ' active' : ''}` });
        row.dataset.subjectId = id;

        const info = el('div', { className: 'subject-row-info' });
        const idEl = el('span', { className: 'subject-row-id' });
        idEl.textContent = id;
        info.appendChild(idEl);

        if (s.sulci || state.alignInMemory[id]?.length > 0) {
            const badge = el('span', { className: 'sulci-badge' });
            badge.textContent = '✓ landmarks';
            info.appendChild(badge);
        }

        row.appendChild(info);
        row.onclick = () => activateAlign(id);
        roster.appendChild(row);
    });
    container.appendChild(roster);
    container.appendChild(el('div', { className: 'sph-divider' }));

    if (!state.alignSubjectId) {
        const msg = el('p', { className: 'coming-soon' });
        msg.textContent = 'Select a mesh above to start alignment.';
        container.appendChild(msg);
        // Auto-select first subject that has a sphere
        const firstWithSphere = state.subjectOrder.find(id => state.subjects[id]?.sphere);
        if (firstWithSphere) setTimeout(() => activateAlign(firstWithSphere), 0);
        return;
    }

    const sphere = state.subjects[state.alignSubjectId]?.sphere;
    if (!sphere) {
        const msg = el('p', { className: 'coming-soon' });
        msg.textContent = 'Preprocess this mesh first (step 2).';
        container.appendChild(msg);
        return;
    }

    // Tool buttons
    const TOOLS = [
        { id: 'draw',     label: 'Draw',   title: 'Freehand curve' },
        { id: 'select',   label: 'Select', title: 'Move points / handles' },
        { id: 'addpoint', label: '+Pt',    title: 'Add point to curve' },
        { id: 'delpoint', label: '-Pt',    title: 'Delete point from curve' },
    ];
    const toolBar = el('div', { className: 'align-tools' });
    const currentTool  = state.alignOverlay?.tool ?? 'draw';
    const editDisabled = state.alignViewMode === '3d';
    TOOLS.forEach(({ id, label, title }) => {
        const btn = el('button', { className: `tool-btn${currentTool === id ? ' active' : ''}` });
        btn.textContent = label;
        btn.title       = editDisabled ? 'Not available in 3D mode' : title;
        btn.disabled    = editDisabled;
        if (editDisabled) btn.tabIndex = -1;
        btn.onclick = () => {
            if (!state.alignOverlay || editDisabled) return;
            state.alignOverlay.setTool(id);
            renderStep(state.currentStep);
        };
        toolBar.appendChild(btn);
    });
    const rotBtn = el('button', {
        className: `tool-btn rotate${currentTool === 'rotate' ? ' active' : ''}`,
    });
    rotBtn.textContent = '↻';
    rotBtn.title    = editDisabled ? 'Not available in 3D mode' : 'Rotate sphere';
    rotBtn.disabled = editDisabled;
    if (editDisabled) rotBtn.tabIndex = -1;
    rotBtn.onclick = () => {
        if (!state.alignOverlay || editDisabled) return;
        const newTool = state.alignOverlay.tool === 'rotate' ? 'draw' : 'rotate';
        state.alignOverlay.setTool(newTool);
        renderStep(state.currentStep);
    };
    toolBar.appendChild(rotBtn);
    container.appendChild(toolBar);

    // View mode row
    const viewRow = el('div', { className: 'view-row' });
    viewRow.setAttribute('role', 'group');
    viewRow.setAttribute('aria-label', 'View controls');

    const viewLabel = el('span', { className: 'view-row-label' });
    viewLabel.textContent = 'VIEW';
    viewRow.appendChild(viewLabel);

    const flatBtn = el('button', { className: `view-btn${state.alignViewMode === 'flat' ? ' active' : ''}` });
    flatBtn.textContent = 'Flat';
    flatBtn.title = 'Flat disc — stereographic projection';
    flatBtn.setAttribute('aria-pressed', String(state.alignViewMode === 'flat'));
    flatBtn.setAttribute('aria-label', 'Flat projection');
    if (!state.alignOverlay) { flatBtn.disabled = true; flatBtn.tabIndex = -1; }
    flatBtn.onclick = () => switchViewMode('flat');
    viewRow.appendChild(flatBtn);

    const btn3d = el('button', { className: `view-btn${state.alignViewMode === '3d' ? ' active' : ''}` });
    btn3d.textContent = '3D';
    btn3d.title = '3D sphere — orbit to verify landmark placement';
    btn3d.setAttribute('aria-pressed', String(state.alignViewMode === '3d'));
    btn3d.setAttribute('aria-label', '3D sphere view');
    if (!state.alignOverlay) { btn3d.disabled = true; btn3d.tabIndex = -1; }
    btn3d.onclick = () => switchViewMode('3d');
    viewRow.appendChild(btn3d);

    const viewSep = el('span', { className: 'view-row-sep' });
    viewRow.appendChild(viewSep);

    const wireBtn = el('button', { className: `view-btn${state.alignWireframe ? ' active' : ''}` });
    wireBtn.textContent = '⊡ Wire';
    wireBtn.title = 'Toggle wireframe';
    wireBtn.setAttribute('aria-pressed', String(state.alignWireframe));
    wireBtn.setAttribute('aria-label', 'Wireframe rendering');
    if (!state.alignOverlay) { wireBtn.disabled = true; wireBtn.tabIndex = -1; }
    wireBtn.onclick = () => toggleWireframe();
    viewRow.appendChild(wireBtn);

    container.appendChild(viewRow);

    // Rotation sliders (flat mode only)
    if (state.alignViewMode === 'flat' && state.alignStereoView) {
        const { alpha, beta, gamma } = state.alignStereoView.getEulerZYX();

        const rotSection = el('div', { className: 'rot-section' });
        const rotLabel = el('div', { className: 'rot-label' });
        rotLabel.textContent = 'Rotation';
        rotSection.appendChild(rotLabel);

        const AXES = [
            { id: 'twist', label: 'Twist',  min: -180, max: 180, val: alpha,
              title: 'CW / CCW rotation (around the view axis)' },
            { id: 'tiltv', label: 'Tilt ↕', min: -90,  max: 90,  val: beta,
              title: 'North / south pole tilt' },
            { id: 'tilth', label: 'Spin ↔', min: -180, max: 180, val: gamma,
              title: 'East / west spin' },
        ];

        AXES.forEach(({ id, label, min, max, val, title }) => {
            const row = el('div', { className: 'rot-row' });

            const lbl = el('label', { className: 'rot-row-label', htmlFor: `rot-${id}`, title });
            lbl.textContent = label;
            row.appendChild(lbl);

            const slider = el('input');
            slider.type  = 'range';
            slider.id    = `rot-${id}`;
            slider.min   = min;
            slider.max   = max;
            slider.step  = 1;
            slider.value = val;
            slider.setAttribute('aria-label', label);
            slider.setAttribute('aria-valuemin', min);
            slider.setAttribute('aria-valuemax', max);
            slider.setAttribute('aria-valuenow', val);

            const valSpan = el('span', { className: 'rot-row-val' });
            valSpan.setAttribute('aria-live', 'polite');
            valSpan.textContent = `${val}°`;

            slider.oninput = () => {
                valSpan.textContent = `${slider.value}°`;
                valSpan.setAttribute('aria-valuenow', slider.value);
                slider.setAttribute('aria-valuenow', slider.value);
                const tw = parseInt(document.getElementById('rot-twist')?.value ?? alpha);
                const tv = parseInt(document.getElementById('rot-tiltv')?.value ?? beta);
                const th = parseInt(document.getElementById('rot-tilth')?.value ?? gamma);
                state.alignStereoView?.setEulerZYX(tw, tv, th);
            };

            row.appendChild(slider);
            row.appendChild(valSpan);
            rotSection.appendChild(row);
        });

        container.appendChild(rotSection);
    }

    // Add landmark button
    const addBtn = el('button', { className: 'load-btn' });
    addBtn.textContent = '+ New landmark';
    addBtn.style.marginTop = '0';
    addBtn.disabled = editDisabled || !state.alignOverlay;
    if (editDisabled) addBtn.title = 'Not available in 3D mode';
    addBtn.onclick = () => {
        if (!state.alignOverlay || editDisabled) return;
        state.alignOverlay.addRegion();
        renderStep(state.currentStep);
    };
    container.appendChild(addBtn);

    // Landmark list
    const listEl = el('div', { className: 'landmark-list' });
    const regions = state.alignOverlay?.regions ?? [];
    regions.forEach(reg => {
        const item = el('div', {
            className: `landmark-item${state.alignOverlay?.region === reg ? ' selected' : ''}`,
        });
        item.onclick = () => {
            if (!state.alignOverlay) return;
            state.alignOverlay.selectRegion(reg);
            renderStep(state.currentStep);
        };

        const dot = el('div', { className: 'landmark-dot' });
        dot.style.background = reg.path.strokeColor?.toCSS?.() ?? '#ff6b6b';
        item.appendChild(dot);

        const nameInput = el('input', { className: 'landmark-name', value: reg.name });
        nameInput.onclick = e => e.stopPropagation();
        nameInput.onchange = () => state.alignOverlay?.renameRegion(reg, nameInput.value);
        item.appendChild(nameInput);

        const delBtn = el('button', { className: 'landmark-del' });
        delBtn.textContent = '×';
        delBtn.title = 'Delete landmark';
        delBtn.onclick = e => {
            e.stopPropagation();
            state.alignOverlay?.deleteRegion(reg);
            renderStep(state.currentStep);
        };
        item.appendChild(delBtn);
        listEl.appendChild(item);
    });
    if (regions.length === 0) {
        const empty = el('div', { className: 'coming-soon' });
        empty.textContent = 'No landmarks yet — click "Draw" and trace a sulcus.';
        listEl.appendChild(empty);
    }
    container.appendChild(listEl);

    container.appendChild(el('div', { className: 'sph-divider' }));

    const loadSulciBtn = el('button', { className: 'load-btn' });
    loadSulciBtn.style.marginTop = '0';
    loadSulciBtn.textContent = 'Load sulci.json';
    loadSulciBtn.onclick = () => loadSulciJSON();
    container.appendChild(loadSulciBtn);

    const saveSulciBtn = el('button', { className: 'load-btn' });
    saveSulciBtn.style.background = 'var(--accent2)';
    saveSulciBtn.textContent = 'Save sulci.json';
    saveSulciBtn.onclick = () => saveSulciJSON();
    container.appendChild(saveSulciBtn);

    const saveRotBtn = el('button', { className: 'load-btn' });
    saveRotBtn.style.background = '#555';
    saveRotBtn.textContent = 'Save rotation.txt';
    saveRotBtn.onclick = () => saveRotationTxt();
    container.appendChild(saveRotBtn);

    if (!state.alignOverlay && sphere) {
        setTimeout(() => activateAlign(state.alignSubjectId), 0);
    }
}

export async function loadSulciJSON() {
    if (!state.alignOverlay) return;
    const sulciPath = state.subjects[state.alignSubjectId]?.sulci;
    if (!sulciPath) {
        setStatus('No sulci.json found for this subject');
        return;
    }
    try {
        const data = await apiGet('/api/file', { path: sulciPath });
        state.alignOverlay.fromJSON(data);
        setStatus(`Loaded ${sulciPath.split('/').pop()} — ${state.alignOverlay.regions.length} landmarks`);
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Load sulci error: ${e.message}`);
    }
}

export async function saveSulciJSON() {
    if (!state.alignOverlay || !state.alignSubjectId) return;
    const s = state.subjects[state.alignSubjectId];
    if (!s?.sphere) return;
    const dir      = s.sphere.substring(0, s.sphere.lastIndexOf('/'));
    const savePath = `${dir}/sulci.json`;
    try {
        const json = state.alignOverlay.toJSON();
        await apiPut('/api/file', { path: savePath, content: JSON.stringify(json, null, 2) });
        state.subjects[state.alignSubjectId].sulci = savePath;
        setStatus(`Saved ${savePath.split('/').pop()}`);
    } catch (e) {
        setStatus(`Save sulci error: ${e.message}`);
    }
}

export async function saveRotationTxt() {
    if (!state.alignOverlay || !state.alignSubjectId) return;
    const s = state.subjects[state.alignSubjectId];
    if (!s?.sphere) return;
    const dir      = s.sphere.substring(0, s.sphere.lastIndexOf('/'));
    const savePath = `${dir}/rotation.txt`;
    try {
        const txt = state.alignOverlay.getCameraRotationText();
        await apiPut('/api/file', { path: savePath, content: txt });
        state.subjects[state.alignSubjectId].rot = savePath;
        setStatus(`Saved ${savePath.split('/').pop()}`);
    } catch (e) {
        setStatus(`Save rotation error: ${e.message}`);
    }
}
