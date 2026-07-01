import { el, setStatus, preItem } from '../dom-helpers.js';
import { state } from '../state.js';
import { apiGet, apiPost, apiPut, pollJob, getMatches, deleteMatch } from '../api.js';
import { resampleMesh, parseRotMat, rotateVertsVR } from '../components/morph.js';
import { renderStep } from '../app.js';

// ── Step 4 — Match ───────────────────────────────────────────────────────

export function renderMatchPanel(container) {
    container.innerHTML = '';

    // Auto-populate pickers on first render
    if (!state.matchRefId && state.subjectOrder.length >= 1) state.matchRefId = state.subjectOrder[0];
    if (!state.matchMovId && state.subjectOrder.length >= 2) state.matchMovId = state.subjectOrder[1];

    const ref = state.matchRefId ? state.subjects[state.matchRefId] : null;
    const mov = state.matchMovId ? state.subjects[state.matchMovId] : null;

    // Auto-derive output dir
    if (!state.matchOutDir && state.matchRefId && state.matchMovId) {
        if (state.projectRoot) {
            state.matchOutDir = `${state.projectRoot}/data/derived/matches/${state.matchMovId}_as_${state.matchRefId}`;
        } else if (mov?.path && ref?.path) {
            const movDir  = mov.path.substring(0, mov.path.lastIndexOf('/'));
            const refStem = ref.path.split('/').pop().replace(/\.ply(\.gz)?$/, '');
            state.matchOutDir = `${movDir}/match_${refStem}`;
        }
    }

    // ── Existing matches roster ──────────────────────────────────────────
    if (state.existingMatches.length > 0) {
        const rosterSection = el('div', { className: 'sph-section' });
        const rosterHdr = el('div', { className: 'sph-label' });
        rosterHdr.textContent = 'Existing matches';
        rosterSection.appendChild(rosterHdr);

        state.existingMatches.forEach(m => {
            const row = el('div', { className: 'match-roster-row' });
            row.setAttribute('aria-label', `Match ${m.mov_id} → ${m.ref_id}`);

            const nameEl = el('span', { className: 'match-roster-name' });
            nameEl.textContent = `${m.mov_id} → ${m.ref_id}`;
            row.appendChild(nameEl);

            const statusEl = el('span', { className: 'match-roster-status' });
            statusEl.textContent = `${m.has_morph ? '◉' : '○'} morph  ${m.has_match ? '◉' : '○'} match`;
            statusEl.title = `morph.sphere.ply: ${m.has_morph ? 'present' : 'missing'} · surf.0.ply: ${m.has_match ? 'present' : 'missing'}`;
            row.appendChild(statusEl);

            const loadBtn = el('button', { className: 'roster-load-btn' });
            loadBtn.textContent = 'Load';
            loadBtn.disabled = !m.has_match;
            loadBtn.setAttribute('aria-label', `Load match ${m.name}`);
            loadBtn.onclick = () => loadMatchFromDisk(m);
            row.appendChild(loadBtn);

            const delBtn = el('button', { className: 'roster-del-btn' });
            delBtn.textContent = '✕';
            delBtn.setAttribute('aria-label', `Delete match ${m.name}`);
            delBtn.onclick = () => confirmDeleteMatch(m, row, rosterSection);
            row.appendChild(delBtn);

            rosterSection.appendChild(row);
        });

        container.appendChild(rosterSection);
        container.appendChild(el('div', { className: 'sph-divider' }));
    }

    // ── Ref / Mov pickers ────────────────────────────────────────────────
    const pickerSection = el('div', { className: 'sph-section' });
    const pickerHdr = el('div', { className: 'sph-label' });
    pickerHdr.textContent = 'New match';
    pickerSection.appendChild(pickerHdr);

    const _makePickerRow = (label, currentId, selId, onSet) => {
        const row = el('div', { className: 'param-row' });
        const lbl = el('span', { className: 'param-label' });
        lbl.textContent = label;
        row.appendChild(lbl);
        const sel = el('select');
        sel.id = selId;
        sel.className = 'match-subject-select';
        sel.setAttribute('aria-label', `${label} subject`);
        const emptyOpt = el('option');
        emptyOpt.value = ''; emptyOpt.textContent = '— select —';
        sel.appendChild(emptyOpt);
        state.subjectOrder.forEach(id => {
            const opt = el('option');
            opt.value = id; opt.textContent = id;
            if (id === currentId) opt.selected = true;
            sel.appendChild(opt);
        });
        sel.onchange = () => {
            onSet(sel.value || null);
            state.matchOutDir = null; state.morphResult = null; state.matchResult = null;
            state.morphSurface = null; state.matchSurface = null;
            renderStep(state.currentStep);
        };
        row.appendChild(sel);
        return row;
    };

    pickerSection.appendChild(_makePickerRow('Ref', state.matchRefId, 'match-ref-select', v => { state.matchRefId = v; }));
    pickerSection.appendChild(_makePickerRow('Mov', state.matchMovId, 'match-mov-select', v => { state.matchMovId = v; }));
    container.appendChild(pickerSection);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // ── Inputs checklist ─────────────────────────────────────────────────
    const inputsSection = el('div', { className: 'sph-section' });
    const inputsHdr = el('div', { className: 'sph-label' });
    inputsHdr.textContent = 'Inputs';
    inputsSection.appendChild(inputsHdr);

    inputsSection.appendChild(preItem(state.matchRefId ? `Ref: ${state.matchRefId}` : 'Ref: not selected', !!ref?.path));
    inputsSection.appendChild(preItem(state.matchMovId ? `Mov: ${state.matchMovId}` : 'Mov: not selected', !!mov?.path));

    const bothSpheres = !!(ref?.sphere && mov?.sphere);
    const sphereLabel = !ref?.sphere && !mov?.sphere ? 'Spheres: neither computed'
                      : !ref?.sphere                  ? 'Spheres: ref missing'
                      : !mov?.sphere                  ? 'Spheres: mov missing'
                      : 'Spheres computed';
    inputsSection.appendChild(preItem(sphereLabel, bothSpheres));

    const hasRefSulci = !!(state.alignInMemory[state.matchRefId]?.length || ref?.sulci);
    const hasMovSulci = !!(state.alignInMemory[state.matchMovId]?.length || mov?.sulci);
    const lmkLabel = `Landmarks: ref ${hasRefSulci ? '✓' : '✗'} · mov ${hasMovSulci ? '✓' : '✗'}`;
    inputsSection.appendChild(preItem(lmkLabel, hasRefSulci && hasMovSulci));

    if (ref?.rot || mov?.rot) {
        const bothRot  = !!(ref?.rot && mov?.rot);
        const rotLabel = !ref?.rot ? 'Rotations: ref missing'
                       : !mov?.rot ? 'Rotations: mov missing'
                       : 'Rotations';
        inputsSection.appendChild(preItem(rotLabel, bothRot));
    }

    container.appendChild(inputsSection);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // ── Output directory ─────────────────────────────────────────────────
    const outSection = el('div', { className: 'sph-section' });
    const outHdr = el('div', { className: 'sph-label' });
    outHdr.textContent = 'Output directory';
    outSection.appendChild(outHdr);

    const outInput = el('input', { className: 'out-dir-input' });
    outInput.type = 'text';
    outInput.value = state.matchOutDir || '';
    outInput.setAttribute('aria-label', 'Match output directory');
    outInput.onchange = () => { state.matchOutDir = outInput.value.trim() || null; };
    outSection.appendChild(outInput);
    container.appendChild(outSection);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // ── Viewer mode ──────────────────────────────────────────────────────
    const viewSection = el('div', { className: 'sph-section' });
    const viewSHdr = el('div', { className: 'sph-label' });
    viewSHdr.textContent = 'Viewer';
    viewSection.appendChild(viewSHdr);

    const viewModeRow = el('div', { className: 'view-row' });
    viewModeRow.setAttribute('role', 'group');
    viewModeRow.setAttribute('aria-label', 'Match viewer mode');
    const VIEW_MODES = [
        { id: 'morph', label: 'Morph', ok: !!state.morphSurface, title: 'Ref → Mov retopology blend' },
        { id: 'match', label: 'Match', ok: !!state.matchResult,  title: 'Matched surface' },
    ];
    VIEW_MODES.forEach(({ id, label, ok, title }) => {
        const b = el('button', { className: `view-btn${state.matchViewMode === id ? ' active' : ''}` });
        b.textContent = label; b.title = title; b.disabled = !ok;
        b.setAttribute('aria-pressed', String(state.matchViewMode === id));
        b.setAttribute('aria-label', title);
        b.onclick = () => {
            if (!ok) return;
            state.matchViewMode = id;
            refreshMatchViewer({ preserveOrientation: true });
            renderStep(state.currentStep);
        };
        viewModeRow.appendChild(b);
    });
    viewSection.appendChild(viewModeRow);

    if (state.morphSurface || state.matchSurface) {
        const blendRow = el('div', { className: 'param-row' });
        const blendLbl = el('label', { className: 'param-label', htmlFor: 'morph-blend' });
        blendLbl.textContent = 'Ref → Mov';
        blendRow.appendChild(blendLbl);
        const blendSl = el('input');
        blendSl.type = 'range'; blendSl.id = 'morph-blend';
        blendSl.min = '0'; blendSl.max = '1'; blendSl.step = '0.01';
        blendSl.value = String(state.morphInterpT);
        blendSl.setAttribute('aria-label', 'Morph blend: Ref to Mov');
        const blendVal = el('input');
        blendVal.type = 'number'; blendVal.className = 'param-val';
        blendVal.min = '0'; blendVal.max = '100'; blendVal.step = '1';
        blendVal.value = String(Math.round(state.morphInterpT * 100));
        blendVal.setAttribute('aria-label', 'Blend percentage');
        blendSl.oninput = () => {
            state.morphInterpT = parseFloat(blendSl.value);
            blendVal.value = String(Math.round(state.morphInterpT * 100));
            state.viewer.setBlendT(state.morphInterpT);
        };
        blendVal.oninput = () => {
            const pct = Math.max(0, Math.min(100, parseInt(blendVal.value) || 0));
            state.morphInterpT = pct / 100;
            blendSl.value = String(state.morphInterpT);
            state.viewer.setBlendT(state.morphInterpT);
        };
        blendRow.appendChild(blendSl); blendRow.appendChild(blendVal);
        viewSection.appendChild(blendRow);
    }

    container.appendChild(viewSection);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // ── Phase 1: Morph ───────────────────────────────────────────────────
    const morphSection = el('div', { className: 'sph-section' });
    const morphHdr = el('div', { className: 'sph-label' });
    morphHdr.textContent = 'Phase 1: Morph';
    morphSection.appendChild(morphHdr);

    const morphDesc = el('p', { className: 'match-desc' });
    morphDesc.textContent = 'Fast landmark-guided spherical warp (~5 s)';
    morphSection.appendChild(morphDesc);

    const morphBarWrap = el('div', { className: 'progress-bar-wrap' });
    morphBarWrap.id = 'morph-progress';
    morphBarWrap.style.display = state.morphResult ? 'block' : 'none';
    const morphBarFill = el('div', { className: 'progress-bar' });
    morphBarFill.setAttribute('role', 'progressbar');
    morphBarFill.setAttribute('aria-valuenow', state.morphResult ? '100' : '0');
    morphBarFill.setAttribute('aria-valuemax', '100');
    if (state.morphResult) morphBarFill.style.width = '100%';
    morphBarWrap.appendChild(morphBarFill);
    morphSection.appendChild(morphBarWrap);

    const canMorph = !!(ref?.path && mov?.path && ref?.sphere && mov?.sphere && hasRefSulci && hasMovSulci);
    const morphBtn = el('button', { className: 'load-btn' });
    morphBtn.id = 'btn-run-morph';
    morphBtn.textContent = '▶ Run Morph';
    morphBtn.disabled = !canMorph;
    morphBtn.setAttribute('aria-label', 'Run spherical morph');
    if (!canMorph) morphBtn.setAttribute('aria-disabled', 'true');
    morphBtn.onclick = () => runMorph(morphBarFill, morphBtn);
    morphSection.appendChild(morphBtn);

    if (state.morphResult) {
        const done = el('div', { className: 'pre-check pre-done' });
        done.textContent = '✓ morph.sphere.ply saved';
        morphSection.appendChild(done);
    }


    container.appendChild(morphSection);
    container.appendChild(el('div', { className: 'sph-divider' }));

    // ── Phase 2: Match ───────────────────────────────────────────────────
    const matchSection = el('div', { className: 'sph-section' });
    const matchHdr = el('div', { className: 'sph-label' });
    matchHdr.textContent = 'Phase 2: Match';
    matchSection.appendChild(matchHdr);

    const matchDesc = el('p', { className: 'match-desc' });
    matchDesc.textContent = 'Laplacian eigenvector optimisation (~1 min)';
    matchSection.appendChild(matchDesc);

    const kRow = el('div', { className: 'param-row' });
    const kLabel = el('label', { className: 'param-label', htmlFor: 'match-k' });
    kLabel.textContent = 'k eigenvectors';
    kRow.appendChild(kLabel);
    const kSlider = el('input');
    kSlider.type = 'range'; kSlider.id = 'match-k';
    kSlider.min = '20'; kSlider.max = '200'; kSlider.step = '5';
    kSlider.value = String(state.matchK);
    kSlider.setAttribute('aria-label', 'k eigenvectors');
    const kVal = el('input');
    kVal.type = 'number'; kVal.className = 'param-val';
    kVal.min = '20'; kVal.max = '200'; kVal.step = '5';
    kVal.value = String(state.matchK);
    kVal.setAttribute('aria-label', 'k eigenvectors value');
    kSlider.oninput = () => { state.matchK = parseInt(kSlider.value); kVal.value = kSlider.value; };
    kVal.oninput = () => {
        const v = Math.max(20, Math.min(200, parseInt(kVal.value) || 20));
        state.matchK = v; kSlider.value = String(v);
    };
    kRow.appendChild(kSlider); kRow.appendChild(kVal);
    matchSection.appendChild(kRow);

    const stepsRow = el('div', { className: 'param-row' });
    const stepsLabel = el('span', { className: 'param-label' });
    stepsLabel.textContent = 'Refinement steps';
    stepsRow.appendChild(stepsLabel);
    const stepsGroup = el('div', { className: 'steps-group' });
    stepsGroup.setAttribute('role', 'group');
    stepsGroup.setAttribute('aria-label', 'Refinement steps');
    [1, 2, 3, 4, 5].forEach(n => {
        const btn = el('button', { className: `step-seg${state.matchNsteps === n ? ' active' : ''}` });
        btn.textContent = String(n);
        btn.setAttribute('aria-pressed', String(state.matchNsteps === n));
        btn.onclick = () => { state.matchNsteps = n; renderStep(state.currentStep); };
        stepsGroup.appendChild(btn);
    });
    stepsRow.appendChild(stepsGroup);
    matchSection.appendChild(stepsRow);

    const adv = el('details', { className: 'advanced-details' });
    const advSum = el('summary');
    advSum.textContent = 'Advanced';
    adv.appendChild(advSum);
    [
        { id: 'w-smooth',  label: 'Smooth weight',  min: 0, max: 10, step: 0.1, get: () => state.matchWSmooth,  set: v => { state.matchWSmooth  = v; } },
        { id: 'w-deform',  label: 'Deform weight',  min: 0, max: 50, step: 0.5, get: () => state.matchWDeform,  set: v => { state.matchWDeform  = v; } },
        { id: 'w-project', label: 'Project weight', min: 0, max: 10, step: 0.1, get: () => state.matchWProject, set: v => { state.matchWProject = v; } },
    ].forEach(({ id, label, min, max, step, get, set }) => {
        const row = el('div', { className: 'param-row' });
        const lbl = el('label', { className: 'param-label', htmlFor: `match-${id}` });
        lbl.textContent = label;
        row.appendChild(lbl);
        const sl = el('input');
        sl.type = 'range'; sl.id = `match-${id}`;
        sl.min = String(min); sl.max = String(max); sl.step = String(step);
        sl.value = String(get());
        sl.setAttribute('aria-label', label);
        const vl = el('input');
        vl.type = 'number'; vl.className = 'param-val';
        vl.min = String(min); vl.max = String(max); vl.step = String(step);
        vl.value = get().toFixed(1);
        vl.setAttribute('aria-label', `${label} value`);
        sl.oninput = () => { set(parseFloat(sl.value)); vl.value = parseFloat(sl.value).toFixed(1); };
        vl.oninput = () => {
            const v = Math.max(min, Math.min(max, parseFloat(vl.value) || min));
            set(v); sl.value = String(v);
        };
        row.appendChild(sl); row.appendChild(vl);
        adv.appendChild(row);
    });
    matchSection.appendChild(adv);

    const matchBarWrap = el('div', { className: 'progress-bar-wrap' });
    matchBarWrap.id = 'match-progress';
    matchBarWrap.style.display = 'none';
    const matchBarFill = el('div', { className: 'progress-bar pulsing' });
    matchBarFill.setAttribute('role', 'progressbar');
    matchBarWrap.appendChild(matchBarFill);
    matchSection.appendChild(matchBarWrap);

    const matchBtn = el('button', { className: 'load-btn' });
    matchBtn.id = 'btn-run-match';
    matchBtn.textContent = '▶ Run Match';
    matchBtn.disabled = !state.morphResult;
    matchBtn.setAttribute('aria-label', 'Run match optimisation');
    if (!state.morphResult) matchBtn.setAttribute('aria-disabled', 'true');
    matchBtn.onclick = () => runMatch(matchBarWrap, matchBarFill, matchBtn);
    matchSection.appendChild(matchBtn);

    if (state.matchResult) {
        const done = el('div', { className: 'pre-check pre-done' });
        done.textContent = `✓ ${state.matchResult.matched_ply.split('/').pop()} saved`;
        matchSection.appendChild(done);

    }

    container.appendChild(matchSection);
}

export async function refreshMatchViewer({ preserveOrientation = false } = {}) {
    if (!state.matchRefId || !state.subjects[state.matchRefId]) return;

    if (state.matchViewMode === 'morph' || !state.matchResult) {
        state.viewer.clearAll();
        if (state.morphSurface) {
            state.viewer.loadBlendMesh(state.morphSurface.refVerts, state.morphSurface.morphVerts, state.morphSurface.faces);
            state.viewer.setBlendT(state.morphInterpT);
        } else if (state.morphSphereData) {
            state.viewer.loadMatchFromData(state.morphSphereData.vertices, state.morphSphereData.faces, { opacity: 1.0 });
        }
        return;
    }
    state.viewer.clearAll();
    if (state.matchSurface) {
        state.viewer.loadBlendMesh(state.matchSurface.refVerts, state.matchSurface.matchVerts, state.matchSurface.faces);
        state.viewer.setBlendT(state.morphInterpT);
    }
}

export async function runMorph(fillEl, btn) {
    btn.disabled = true;
    fillEl.parentElement.style.display = 'block';
    fillEl.style.width = '5%';
    setStatus('Running morph…');
    try {
        const ref = state.subjects[state.matchRefId];
        const mov = state.subjects[state.matchMovId];

        const sulciRefData = state.alignInMemory[state.matchRefId] ?? await apiGet('/api/file', { path: ref.sulci });
        const sulciMovData = state.alignInMemory[state.matchMovId] ?? await apiGet('/api/file', { path: mov.sulci });
        fillEl.style.width = '15%';

        if (!state.matchOutDir) {
            if (state.projectRoot) {
                state.matchOutDir = `${state.projectRoot}/data/derived/matches/${state.matchMovId}_as_${state.matchRefId}`;
            } else {
                const movDir  = mov.path.substring(0, mov.path.lastIndexOf('/'));
                const refStem = ref.path.split('/').pop().replace(/\.ply(\.gz)?$/, '');
                state.matchOutDir = `${movDir}/match_${refStem}`;
            }
        }

        const body = {
            ref_sphere: ref.sphere,
            sulci_ref:  sulciRefData,
            sulci_mov:  sulciMovData,
            out_dir:    state.matchOutDir,
        };
        if (ref.rot) body.rot_ref_path = ref.rot;
        if (mov.rot) body.rot_mov_path = mov.rot;

        const { job_id } = await apiPost('/api/morph', body);
        fillEl.style.width = '25%';

        const result = await pollJob(job_id, {
            onProgress: p => { fillEl.style.width = `${Math.round(25 + p * 50)}%`; },
        });
        fillEl.style.width = '75%';

        const [morphSphRaw, movSphRaw, movNat, refNat, refSphRaw] = await Promise.all([
            apiGet('/api/mesh_raw', { path: result.morph_sphere_path }),
            apiGet('/api/mesh_raw', { path: mov.sphere }),
            apiGet('/api/mesh_raw', { path: mov.path }),
            apiGet('/api/mesh_raw', { path: ref.path }),
            apiGet('/api/mesh_raw', { path: ref.sphere }),
        ]);

        let R_mov = null;
        if (mov.rot) {
            const rotMovData = await apiGet('/api/file', { path: mov.rot });
            const rotMovTxt = typeof rotMovData === 'string' ? rotMovData : (rotMovData?.content ?? '');
            if (rotMovTxt) R_mov = parseRotMat(rotMovTxt);
        }
        const _unitVec = ([x, y, z]) => { const r = Math.sqrt(x*x+y*y+z*z)||1; return [x/r, y/r, z/r]; };
        const movSphUnit   = movSphRaw.vertices.map(_unitVec);
        const movSphForNN  = R_mov ? rotateVertsVR(movSphUnit, R_mov) : movSphUnit;
        const remeshed = resampleMesh(
            movSphRaw.faces,
            movSphForNN,
            movNat.vertices,
            morphSphRaw.vertices,
        );
        state.morphSurface    = { refVerts: refNat.vertices, morphVerts: remeshed, faces: refSphRaw.faces };
        state.morphResult     = { morph_sphere_path: result.morph_sphere_path };
        state.morphSphereData = { vertices: morphSphRaw.vertices, faces: refSphRaw.faces };
        state.matchViewMode   = 'morph';
        fillEl.style.width = '100%';

        await refreshMatchViewer({ preserveOrientation: false });
        setStatus('Morph done — retopology complete');
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Morph error: ${e.message}`);
        btn.disabled = false;
        fillEl.parentElement.style.display = 'none';
    }
}

export async function runMatch(barWrap, fillEl, btn) {
    if (!state.morphResult || !state.matchOutDir) return;
    btn.disabled = true;
    barWrap.style.display = 'block';
    setStatus('Running match optimisation…');
    try {
        const ref = state.subjects[state.matchRefId];
        const mov = state.subjects[state.matchMovId];

        // matchmesh2 naming: "ref" = brain to project onto = UI's mov
        //                    "mov" = sphere to deform      = UI's ref
        const body = {
            ref_ply:      mov.path,
            ref_sphere:   mov.sphere,
            mov_ply:      ref.path,
            mov_sphere:   ref.sphere,
            morph_sphere: state.morphResult.morph_sphere_path,
            out_dir:      state.matchOutDir,
            k:            state.matchK,
            nsteps:       state.matchNsteps,
            w_smooth:     state.matchWSmooth,
            w_deform:     state.matchWDeform,
            w_project:    state.matchWProject,
        };
        if (mov.rot) body.ref_rot = mov.rot;
        if (ref.rot) body.mov_rot = ref.rot;

        const { job_id } = await apiPost('/api/match', body);
        const result = await pollJob(job_id);
        state.matchResult   = result;
        state.matchViewMode = 'match';
        barWrap.style.display = 'none';

        const params = {
            ref_id:    state.matchRefId,
            mov_id:    state.matchMovId,
            timestamp: new Date().toISOString(),
            match: {
                k:         state.matchK,
                nsteps:    state.matchNsteps,
                w_smooth:  state.matchWSmooth,
                w_deform:  state.matchWDeform,
                w_project: state.matchWProject,
            },
        };
        apiPut('/api/file', {
            path:    `${state.matchOutDir}/params.json`,
            content: JSON.stringify(params, null, 2),
        }).catch(() => {});

        const matchedNatRaw = await apiGet('/api/mesh_raw', { path: result.matched_ply });
        const refVerts = state.morphSurface ? state.morphSurface.refVerts
            : (await apiGet('/api/mesh_raw', { path: ref.path })).vertices;
        const refFaces = state.morphSurface ? state.morphSurface.faces : matchedNatRaw.faces;
        state.matchSurface = { refVerts, matchVerts: matchedNatRaw.vertices, faces: refFaces };

        await refreshMatchViewer({ preserveOrientation: true });
        setStatus(`Match done — ${result.matched_ply.split('/').pop()}`);
        await loadExistingMatches();
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Match error: ${e.message}`);
        btn.disabled = false;
        barWrap.style.display = 'none';
    }
}

// ── Match roster helpers ─────────────────────────────────────────────────

export async function loadExistingMatches() {
    if (!state.projectRoot) { state.existingMatches = []; return; }
    try {
        state.existingMatches = await getMatches(state.projectRoot);
    } catch {
        state.existingMatches = [];
    }
}

export async function loadMatchFromDisk(m) {
    if (!m.has_match) return;
    setStatus(`Loading match ${m.name}…`);

    state.matchRefId  = m.ref_id;
    state.matchMovId  = m.mov_id;
    state.matchOutDir = m.dir;
    state.matchResult  = { matched_ply: `${m.dir}/surf.0.ply` };
    state.matchViewMode = 'match';
    state.morphResult  = m.has_morph ? { morph_sphere_path: `${m.dir}/morph.sphere.ply` } : null;
    state.morphSurface = null;

    try {
        const matchedPly    = `${m.dir}/surf.0.ply`;
        const matchedNatRaw = await apiGet('/api/mesh_raw', { path: matchedPly });

        const ref = state.subjects[state.matchRefId];
        const refVerts = ref?.path
            ? (await apiGet('/api/mesh_raw', { path: ref.path })).vertices
            : matchedNatRaw.vertices;

        state.matchSurface = { refVerts, matchVerts: matchedNatRaw.vertices, faces: matchedNatRaw.faces };

        await refreshMatchViewer({ preserveOrientation: false });
        setStatus(`Loaded ${m.name}`);
        renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Load error: ${e.message}`);
        state.matchResult = null; state.matchSurface = null;
        renderStep(state.currentStep);
    }
}

export function confirmDeleteMatch(m, rowEl, sectionEl) {
    const existing = rowEl.querySelector('.remove-confirm');
    if (existing) { existing.remove(); return; }

    const confirmEl = el('div', { className: 'remove-confirm' });
    confirmEl.textContent = `Delete ${m.name}? `;

    const yesBtn = el('button', { className: 'remove-confirm-yes' });
    yesBtn.textContent = 'Delete';
    yesBtn.onclick = async e => {
        e.stopPropagation();
        try { await deleteMatch({ match_dir: m.dir }); } catch { /* still remove row */ }
        rowEl.remove();
        state.existingMatches = state.existingMatches.filter(x => x.dir !== m.dir);
        if (state.matchOutDir === m.dir) {
            state.matchOutDir = null; state.morphResult = null; state.matchResult = null;
            state.morphSurface = null; state.matchSurface = null;
            state.viewer.clearAll();
        }
        if (sectionEl.querySelectorAll('.match-roster-row').length === 0) {
            sectionEl.remove();
        }
        setStatus(`Deleted ${m.name}`);
    };
    confirmEl.appendChild(yesBtn);

    const noBtn = el('button', { className: 'remove-confirm-no' });
    noBtn.textContent = 'Cancel';
    noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
    confirmEl.appendChild(noBtn);

    rowEl.appendChild(confirmEl);
}
