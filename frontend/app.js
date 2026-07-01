import { el, setStatus, preItem } from './dom-helpers.js';
import { state } from './state.js';
import { Viewer3D } from './components/viewer3d.js';
import { TrajectoryPlayer } from './components/trajectory.js';

import { meshUrl, checkHealth, getConfig, apiGet, apiPost, apiPut, pollJob, getMatches, deleteMatch, getTrajectories, startTrajectory, deleteTrajectory } from './api.js';
import { resampleMesh, parseRotMat, rotateVertsVR } from './components/morph.js';
import { loadMeshByPath, renderLoadPanel } from './steps/load.js';
import { renderPreprocessPanel, refreshViewer } from './steps/preprocess.js';
import { renderAlignPanel } from './steps/align.js';

const TRAJ_DEMO_RELS = [0, 2, 4, 6, 8].map(n => `trajectoryviewer/${n}.ply`);

    // ── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        state.viewer = new Viewer3D(document.getElementById('viewer-container'));
        window._viewer = state.viewer;

        document.getElementById('edges-cb')
            ?.addEventListener('change', e => state.viewer.setEdges(e.target.checked));

        _startHealthPolling();

        const cfg = await getConfig();
        if (cfg) state.dataRoot = cfg.data_root;

        renderStep(1);
        _activateStep(1);
    }

    // ── Connection polling ───────────────────────────────────────────────────
    function _startHealthPolling() {
        async function poll() {
            const dot = document.getElementById('status-dot');
            const txt = document.getElementById('status-text');
            const data = await checkHealth();
            if (data) {
                dot.className = 'connected';
                txt.textContent = `Connected (v${data.version})`;
            } else {
                dot.className = 'disconnected';
                txt.textContent = 'Server not running';
            }
        }
        poll();
        setInterval(poll, 3000);
    }

    // ── Step management ──────────────────────────────────────────────────────
    function goStep(n) {
        const prev = state.currentStep;
        if (prev === 3 && n !== 3) {
            if (state.alignOverlay && state.alignSubjectId) {
                state.alignInMemory[state.alignSubjectId] = state.alignOverlay.toJSON();
                state.alignOverlay.destroy();
                state.alignOverlay = null;
            }
            if (state.alignStereoView) { state.alignStereoView.destroy(); state.alignStereoView = null; }
            if (state.alignViewMode === '3d') state.viewer.clearAll();
            state.alignViewMode         = 'flat';
            state.alignWireframe        = false;
            state.alignHas3DOrientation = false;
        }
        if (prev === 4 && n !== 4) {
            state.viewer.clearAll();
        }
        if (prev === 5 && n !== 5) {
            state.player?.pause();
            state.viewer.clearAll();
        }
        state.currentStep = n;
        _activateStep(n);
        renderStep(n);
        if (n === 4 && prev !== 4) {
            _refreshMatchViewer();
        }
        if (n === 5 && prev !== 5) {
            state.viewer.clearAll();
            if (state.player?.isLoaded) {
                state.player.reattach(state.viewer);
            }
        }
        if (prev === 4 && (n === 1 || n === 2) && state.viewedSubjectId && state.viewState[state.viewedSubjectId]?.meshType) {
            refreshViewer({ preserveOrientation: false });
        }
    }

    function _activateStep(n) {
        document.querySelectorAll('.step-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.step) === n);
        });
    }

export function renderStep(n) {
        const rpanel = document.getElementById('rpanel-content');
        const h2     = document.querySelector('#rpanel h2');

        if (n === 1) {
            h2.textContent = 'Load meshes';
            renderLoadPanel(rpanel);
        } else if (n === 2) {
            h2.textContent = 'Preprocess';
            renderPreprocessPanel(rpanel);
        } else if (n === 3) {
            h2.textContent = 'Align';
            renderAlignPanel(rpanel);
        } else if (n === 4) {
            h2.textContent = 'Match';
            _loadExistingMatches().then(() => _renderMatchPanel(rpanel));
        } else if (n === 5) {
            h2.textContent = 'Trajectory';
            Promise.all([_loadExistingTrajectories(), _loadExistingMatches()])
                .then(() => _renderTrajectoryPanel(rpanel));
        } else {
            const labels = ['', 'Load', 'Preprocess', 'Align', 'Match', 'View'];
            h2.textContent = labels[n] || `Step ${n}`;
            rpanel.innerHTML = `<p class="coming-soon">Coming in a future phase.</p>`;
        }
    }

    // ── Step 4 — Match ───────────────────────────────────────────────────────

    function _renderMatchPanel(container) {
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
                loadBtn.onclick = () => _loadMatchFromDisk(m);
                row.appendChild(loadBtn);

                const delBtn = el('button', { className: 'roster-del-btn' });
                delBtn.textContent = '✕';
                delBtn.setAttribute('aria-label', `Delete match ${m.name}`);
                delBtn.onclick = () => _confirmDeleteMatch(m, row, rosterSection);
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
                _refreshMatchViewer({ preserveOrientation: true });
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
        morphBtn.onclick = () => _runMorph(morphBarFill, morphBtn);
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
        matchBtn.onclick = () => _runMatch(matchBarWrap, matchBarFill, matchBtn);
        matchSection.appendChild(matchBtn);

        if (state.matchResult) {
            const done = el('div', { className: 'pre-check pre-done' });
            done.textContent = `✓ ${state.matchResult.matched_ply.split('/').pop()} saved`;
            matchSection.appendChild(done);

        }

        container.appendChild(matchSection);
    }

    async function _refreshMatchViewer({ preserveOrientation = false } = {}) {
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

    async function _runMorph(fillEl, btn) {
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

            await _refreshMatchViewer({ preserveOrientation: false });
            setStatus('Morph done — retopology complete');
            renderStep(state.currentStep);
        } catch (e) {
            setStatus(`Morph error: ${e.message}`);
            btn.disabled = false;
            fillEl.parentElement.style.display = 'none';
        }
    }

    async function _runMatch(barWrap, fillEl, btn) {
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

            await _refreshMatchViewer({ preserveOrientation: true });
            setStatus(`Match done — ${result.matched_ply.split('/').pop()}`);
            await _loadExistingMatches();
            renderStep(state.currentStep);
        } catch (e) {
            setStatus(`Match error: ${e.message}`);
            btn.disabled = false;
            barWrap.style.display = 'none';
        }
    }

    // ── Match roster helpers ─────────────────────────────────────────────────

    async function _loadExistingMatches() {
        if (!state.projectRoot) { state.existingMatches = []; return; }
        try {
            state.existingMatches = await getMatches(state.projectRoot);
        } catch {
            state.existingMatches = [];
        }
    }

    async function _loadMatchFromDisk(m) {
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

            await _refreshMatchViewer({ preserveOrientation: false });
            setStatus(`Loaded ${m.name}`);
            renderStep(state.currentStep);
        } catch (e) {
            setStatus(`Load error: ${e.message}`);
            state.matchResult = null; state.matchSurface = null;
            renderStep(state.currentStep);
        }
    }

    function _confirmDeleteMatch(m, rowEl, sectionEl) {
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

    // ── Step 5 — Trajectory ──────────────────────────────────────────────────

    async function _loadExistingTrajectories() {
        if (!state.projectRoot) { state.existingTrajectories = []; return; }
        try { state.existingTrajectories = await getTrajectories(state.projectRoot); }
        catch { state.existingTrajectories = []; }
    }

    function _renderTrajectoryPanel(container) {
        container.innerHTML = '';

        // ── Existing trajectories roster ─────────────────────────────────────
        if (state.existingTrajectories.length > 0) {
            const sec = el('div', { className: 'sph-section' });
            const hdr = el('div', { className: 'sph-label' });
            hdr.textContent = 'Existing trajectories';
            sec.appendChild(hdr);

            state.existingTrajectories.forEach(t => {
                const row = el('div', { className: 'match-roster-row' });

                const nameEl = el('span', { className: 'match-roster-name' });
                nameEl.textContent = t.name;
                nameEl.title = t.params?.seq?.join(' → ') || t.name;
                row.appendChild(nameEl);

                const info = el('span', { className: 'match-roster-status' });
                const mode = t.params?.mode || 'raw';
                info.textContent = `${t.n_frames} frames · ${mode}`;
                row.appendChild(info);

                const loadBtn = el('button', { className: 'roster-load-btn' });
                loadBtn.textContent = state.loadedTrajDir === t.dir ? 'Loaded' : 'Load';
                loadBtn.disabled = !t.done || state.loadedTrajDir === t.dir;
                loadBtn.setAttribute('aria-label', `Load trajectory ${t.name}`);
                loadBtn.onclick = () => _loadTrajectoryFromDisk(t);
                row.appendChild(loadBtn);

                const delBtn = el('button', { className: 'roster-del-btn' });
                delBtn.textContent = '✕';
                delBtn.setAttribute('aria-label', `Delete trajectory ${t.name}`);
                delBtn.onclick = () => _confirmDeleteTrajectory(t, row, sec);
                row.appendChild(delBtn);

                sec.appendChild(row);
            });

            container.appendChild(sec);
            container.appendChild(el('div', { className: 'sph-divider' }));
        }

        // ── New trajectory ────────────────────────────────────────────────────
        if (state.projectRoot) {
            const newSec = el('div', { className: 'sph-section' });
            const newHdr = el('div', { className: 'sph-label' });
            newHdr.textContent = 'New trajectory';
            newSec.appendChild(newHdr);

            // Sequence list
            const seqLabel = el('div', { className: 'traj-seq-label' });
            seqLabel.textContent = 'Sequence (oldest → youngest)';
            newSec.appendChild(seqLabel);

            const seqList = el('div', { className: 'traj-seq-list' });
            state.trajSeq.forEach((id, i) => {
                const pill = el('div', { className: 'traj-seq-row' });

                const idEl = el('span', { className: 'traj-seq-id' });
                idEl.textContent = id;
                pill.appendChild(idEl);

                const upBtn = el('button', { className: 'traj-seq-btn' });
                upBtn.textContent = '▲'; upBtn.title = 'Move up';
                upBtn.disabled = i === 0;
                upBtn.onclick = () => { state.trajSeq.splice(i - 1, 0, state.trajSeq.splice(i, 1)[0]); renderStep(state.currentStep); };
                pill.appendChild(upBtn);

                const dnBtn = el('button', { className: 'traj-seq-btn' });
                dnBtn.textContent = '▼'; dnBtn.title = 'Move down';
                dnBtn.disabled = i === state.trajSeq.length - 1;
                dnBtn.onclick = () => { state.trajSeq.splice(i + 1, 0, state.trajSeq.splice(i, 1)[0]); renderStep(state.currentStep); };
                pill.appendChild(dnBtn);

                const rmBtn = el('button', { className: 'traj-seq-btn traj-seq-rm' });
                rmBtn.textContent = '✕';
                rmBtn.onclick = () => { state.trajSeq.splice(i, 1); renderStep(state.currentStep); };
                pill.appendChild(rmBtn);

                seqList.appendChild(pill);
            });

            // Add subject row
            const addRow = el('div', { className: 'traj-add-row' });
            const addSel = el('select', { className: 'traj-add-select', id: 'traj-add-subject' });
            const blankOpt = el('option');
            blankOpt.value = ''; blankOpt.textContent = '— add subject —';
            addSel.appendChild(blankOpt);
            state.subjectOrder.forEach(sid => {
                if (state.trajSeq.includes(sid)) return;
                const opt = el('option');
                opt.value = sid; opt.textContent = sid;
                addSel.appendChild(opt);
            });
            addSel.onchange = () => {
                if (addSel.value) { state.trajSeq.push(addSel.value); renderStep(state.currentStep); }
            };
            addRow.appendChild(addSel);
            seqList.appendChild(addRow);
            newSec.appendChild(seqList);

            // Required pairs validation
            if (state.trajSeq.length >= 2) {
                const pairsDiv = el('div', { className: 'traj-pairs' });
                const pairsLbl = el('div', { className: 'sph-label' });
                pairsLbl.textContent = 'Required matches';
                pairsLbl.style.marginTop = '6px';
                pairsDiv.appendChild(pairsLbl);

                let allPairsOk = true;
                for (let i = 0; i < state.trajSeq.length - 1; i++) {
                    const ref    = state.trajSeq[i];
                    const mov    = state.trajSeq[i + 1];
                    const fwdOk  = state.existingMatches.some(m => m.mov_id === mov && m.ref_id === ref && m.has_match);
                    const invOk  = !fwdOk && state.existingMatches.some(m => m.mov_id === ref && m.ref_id === mov && m.has_match);
                    const ok     = fwdOk || invOk;
                    if (!ok) allPairsOk = false;
                    const icon   = ok ? '◉' : '○';
                    const label  = invOk ? `${ref}_as_${mov} (inv)` : `${mov}_as_${ref}`;
                    const cls    = fwdOk ? 'traj-pair-ok' : (invOk ? 'traj-pair-inv' : 'traj-pair-miss');
                    const pairRow = el('div', { className: 'traj-pair-row' });
                    pairRow.innerHTML = `<span class="traj-pair-icon">${icon}</span>
                        <span class="traj-pair-name ${cls}">${label}</span>`;
                    pairsDiv.appendChild(pairRow);
                }
                newSec.appendChild(pairsDiv);

                // Mode selector
                const modeRow = el('div', { className: 'param-row' });
                const modeLbl = el('span', { className: 'param-label' });
                modeLbl.textContent = 'Mode';
                modeRow.appendChild(modeLbl);
                const modeGrp = el('div', { className: 'steps-group' });
                ['raw', 'smooth'].forEach(m => {
                    const btn = el('button', { className: `step-seg${state.trajMode === m ? ' active' : ''}` });
                    btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
                    btn.onclick = () => { state.trajMode = m; renderStep(state.currentStep); };
                    modeGrp.appendChild(btn);
                });
                modeRow.appendChild(modeGrp);
                newSec.appendChild(modeRow);

                // Advanced parameters (smooth mode only)
                if (state.trajMode === 'smooth') {
                    const adv = el('details', { className: 'advanced-details' });
                    const sum = el('summary');
                    sum.textContent = 'Advanced';
                    adv.appendChild(sum);

                    const _paramRow = (label, get, set, min, max, step) => {
                        const row = el('div', { className: 'param-row' });
                        const lbl = el('span', { className: 'param-label' }); lbl.textContent = label; row.appendChild(lbl);
                        const slider = el('input'); slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = get();
                        const num = el('input', { type: 'number', className: 'param-val' }); num.min = min; num.max = max; num.step = step; num.value = get();
                        slider.oninput = () => { set(parseFloat(slider.value)); num.value = slider.value; };
                        num.oninput = () => { const v = Math.min(max, Math.max(min, parseFloat(num.value) || min)); set(v); slider.value = v; };
                        row.appendChild(slider); row.appendChild(num);
                        return row;
                    };

                    adv.appendChild(_paramRow('Deform smooth', () => state.trajNDeformSmooth, v => { state.trajNDeformSmooth = v; }, 0, 20, 1));
                    adv.appendChild(_paramRow('Traj smooth', () => state.trajNTrajSmooth, v => { state.trajNTrajSmooth = v; }, 0, 10, 1));
                    adv.appendChild(_paramRow('Spatial smooth', () => state.trajNSpatialSmooth, v => { state.trajNSpatialSmooth = v; }, 0, 10, 1));
                    adv.appendChild(_paramRow('λ spatial', () => state.trajLambdaSpatial, v => { state.trajLambdaSpatial = v; }, 0.001, 0.1, 0.001));

                    const icpRow = el('div', { className: 'param-row' });
                    const icpLbl = el('span', { className: 'param-label' }); icpLbl.textContent = 'ICP align'; icpRow.appendChild(icpLbl);
                    const icpCb = el('input'); icpCb.type = 'checkbox'; icpCb.checked = state.trajDoIcp;
                    icpCb.onchange = () => { state.trajDoIcp = icpCb.checked; };
                    icpRow.appendChild(icpCb);
                    adv.appendChild(icpRow);

                    newSec.appendChild(adv);
                }

                // Run button
                const runBtn = el('button', { className: 'load-btn', style: 'margin-top:8px' });
                runBtn.textContent = 'Run Trajectory';
                runBtn.disabled = !allPairsOk;
                runBtn.onclick = () => _runTrajectory();
                newSec.appendChild(runBtn);
            } else {
                const hint = el('div', { className: 'match-desc' });
                hint.textContent = 'Add ≥ 2 subjects to define a trajectory sequence.';
                newSec.appendChild(hint);
            }

            container.appendChild(newSec);
            container.appendChild(el('div', { className: 'sph-divider' }));
        }

        // ── Playback ──────────────────────────────────────────────────────────
        const playSec = el('div', { className: 'sph-section' });
        const playHdr = el('div', { className: 'sph-label' });
        playHdr.textContent = 'Playback';
        playSec.appendChild(playHdr);

        if (!state.projectRoot && !state.player?.isLoaded) {
            const demoBtn = el('button', { className: 'load-btn' });
            demoBtn.textContent = 'Load demo trajectory';
            demoBtn.onclick = () => _loadTrajectoryDemo();
            playSec.appendChild(demoBtn);
        }

        if (state.player?.isLoaded) {
            const info = el('div', { className: 'traj-info' });
            info.textContent = `${state.player.frameCount} frames`;
            if (state.loadedTrajDir) {
                const traj = state.existingTrajectories.find(t => t.dir === state.loadedTrajDir);
                if (traj) info.textContent += ` · ${traj.name}`;
            }
            playSec.appendChild(info);

            // Play/pause + scrubber row
            const ctrlRow = el('div', { className: 'traj-ctrl-row' });

            const playBtn = el('button', { className: 'traj-play-rp', id: 'rp-traj-play' });
            playBtn.textContent = state.player.isPlaying ? '⏸' : '▶';
            playBtn.title = 'Play / Pause';
            playBtn.setAttribute('aria-label', 'Play / Pause trajectory');
            playBtn.onclick = () => {
                if (state.player.isPlaying) { state.player.pause(); playBtn.textContent = '▶'; }
                else                   { state.player.play();  playBtn.textContent = '⏸'; }
            };
            ctrlRow.appendChild(playBtn);

            const scrubber = el('input');
            scrubber.type = 'range'; scrubber.id = 'rp-traj-scrubber';
            scrubber.className = 'traj-scrub-rp';
            scrubber.min = '0'; scrubber.max = '1000'; scrubber.step = '1';
            scrubber.value = String(Math.round(state.player.t * 1000));
            scrubber.setAttribute('aria-label', 'Trajectory position');
            scrubber.oninput = () => {
                const t = parseInt(scrubber.value) / 1000;
                document.getElementById('rp-traj-time').textContent = t.toFixed(2);
                state.player.seek(t);
            };
            ctrlRow.appendChild(scrubber);

            const timeEl = el('span', { className: 'traj-time-rp', id: 'rp-traj-time' });
            timeEl.textContent = state.player.t.toFixed(2);
            ctrlRow.appendChild(timeEl);
            playSec.appendChild(ctrlRow);

            const speedRow = el('div', { className: 'traj-row' });
            speedRow.innerHTML = '<label>Speed</label>';
            const speedInput = el('input');
            speedInput.type = 'range'; speedInput.min = '1'; speedInput.max = '12';
            speedInput.step = '0.5';
            // player.speed is one-direction duration (seconds); invert so slider right = faster
            speedInput.value = String(13 - state.player.speed);
            speedInput.className = 'traj-speed';
            speedInput.oninput = () => { state.player.speed = 13 - parseFloat(speedInput.value); };
            speedRow.appendChild(speedInput);
            playSec.appendChild(speedRow);

            const ppRow = el('div', { className: 'traj-row' });
            const ppLabel = el('label', { className: 'traj-pp-label' });
            const ppCheck = el('input');
            ppCheck.type = 'checkbox'; ppCheck.id = 'rp-traj-pingpong';
            ppCheck.checked = state.player.pingPong;
            ppCheck.setAttribute('aria-label', 'Forth and back playback');
            ppCheck.onchange = () => { state.player.pingPong = ppCheck.checked; };
            ppLabel.appendChild(ppCheck);
            ppLabel.append(' Forth & back');
            ppRow.appendChild(ppLabel);
            playSec.appendChild(ppRow);
        } else {
            const hint = el('div', { className: 'match-desc' });
            hint.textContent = 'No trajectory loaded.';
            playSec.appendChild(hint);
        }

        container.appendChild(playSec);
    }

    async function _loadTrajectoryFromDisk(traj) {
        setStatus(`Loading trajectory ${traj.name}…`);
        try {
            const trajPath = traj.dir + '/trajectory';
            const files = await apiGet('/api/files', { dir: trajPath });
            const urls = files
                .filter(f => f.name.endsWith('.ply'))
                .sort((a, b) => parseInt(a.name) - parseInt(b.name))
                .map(f => meshUrl(f.path));
            if (!urls.length) throw new Error('No PLY frames found in trajectory/');
            if (!state.player) {
                state.player = new TrajectoryPlayer(state.viewer);
                state.player.onSeek(t => _updateScrubber(t));
                window._player = state.player;
            }
            await state.player.load(urls);
            state.loadedTrajDir = traj.dir;
            // Populate the builder form from saved params so user can recompute
            if (traj.params) {
                const p = traj.params;
                if (Array.isArray(p.seq) && p.seq.length >= 2) state.trajSeq = [...p.seq];
                if (p.mode === 'raw' || p.mode === 'smooth') state.trajMode = p.mode;
                if (p.n_deformation_smooth != null) state.trajNDeformSmooth = p.n_deformation_smooth;
                if (p.do_icp != null)               state.trajDoIcp         = !!p.do_icp;
                if (p.n_trajectory_smooth != null)  state.trajNTrajSmooth   = p.n_trajectory_smooth;
                if (p.n_spatial_smooth != null)     state.trajNSpatialSmooth = p.n_spatial_smooth;
                if (p.lambda_spatial != null)       state.trajLambdaSpatial  = p.lambda_spatial;
            }
            setStatus(`Trajectory loaded — ${state.player.frameCount} frames`);
            renderStep(state.currentStep);
        } catch (e) {
            setStatus(`Trajectory load error: ${e.message}`);
        }
    }

    async function _runTrajectory() {
        if (!state.projectRoot || state.trajSeq.length < 2) return;
        const suffix    = state.trajMode === 'smooth' ? '_smooth' : '';
        const traj_name = state.trajSeq.join('-') + suffix;
        setStatus('Submitting trajectory job…');
        try {
            const { job_id, out_dir } = await startTrajectory({
                project_root:        state.projectRoot,
                seq:                 state.trajSeq,
                traj_name,
                mode:                state.trajMode,
                n_deformation_smooth: state.trajNDeformSmooth,
                do_icp:              state.trajDoIcp,
                n_trajectory_smooth: state.trajNTrajSmooth,
                n_spatial_smooth:    state.trajNSpatialSmooth,
                lambda_spatial:      state.trajLambdaSpatial,
            });
            await pollJob(job_id, { onProgress: p => setStatus(`Trajectory: ${Math.round(p * 100)}%`) });
            setStatus('Trajectory done — loading…');
            await _loadExistingTrajectories();
            const traj = state.existingTrajectories.find(t => t.dir === out_dir);
            if (traj) await _loadTrajectoryFromDisk(traj);
            else renderStep(state.currentStep);
        } catch (e) {
            setStatus(`Trajectory error: ${e.message}`);
            renderStep(state.currentStep);
        }
    }

    function _confirmDeleteTrajectory(traj, rowEl, secEl) {
        const existing = rowEl.querySelector('.remove-confirm');
        if (existing) { existing.remove(); return; }

        const confirmEl = el('div', { className: 'remove-confirm' });
        confirmEl.textContent = `Delete ${traj.name}? `;

        const yesBtn = el('button', { className: 'remove-confirm-yes' });
        yesBtn.textContent = 'Delete';
        yesBtn.onclick = async e => {
            e.stopPropagation();
            try { await deleteTrajectory(traj.dir); } catch { /* still remove row */ }
            rowEl.remove();
            state.existingTrajectories = state.existingTrajectories.filter(t => t.dir !== traj.dir);
            if (state.loadedTrajDir === traj.dir) {
                state.player?.dispose(); state.player = null; state.loadedTrajDir = null;
                _renderTrajectoryPanel(document.getElementById('rpanel-content'));
            }
            if (secEl.querySelectorAll('.match-roster-row').length === 0) {
                secEl.remove();
            }
            setStatus(`Deleted ${traj.name}`);
        };
        confirmEl.appendChild(yesBtn);

        const noBtn = el('button', { className: 'remove-confirm-no' });
        noBtn.textContent = 'Cancel';
        noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
        confirmEl.appendChild(noBtn);

        rowEl.appendChild(confirmEl);
    }

    async function _loadTrajectoryDemo() {
        setStatus('Loading trajectory demo…');
        const urls = TRAJ_DEMO_RELS.map(rel => meshUrl(state.dataRoot + '/' + rel));
        try {
            if (!state.player) {
                state.player = new TrajectoryPlayer(state.viewer);
                state.player.onSeek(t => _updateScrubber(t));
            }
            window._player = state.player;
            await state.player.load(urls);
            state.loadedTrajDir = null;
            setStatus(`Trajectory loaded — ${state.player.frameCount} frames`);
            _renderTrajectoryPanel(document.getElementById('rpanel-content'));
        } catch (e) {
            setStatus(`Trajectory error: ${e.message}`);
        }
    }

    // ── Trajectory helpers ───────────────────────────────────────────────────
    function _updateScrubber(t) {
        const scrubber = document.getElementById('rp-traj-scrubber');
        if (scrubber) scrubber.value = Math.round(t * 1000);
        const timeEl = document.getElementById('rp-traj-time');
        if (timeEl) timeEl.textContent = t.toFixed(2);
        const playBtn = document.getElementById('rp-traj-play');
        if (playBtn && state.player) playBtn.textContent = state.player.isPlaying ? '⏸' : '▶';
    }

    // ── Debug helpers (manual testing only, see debug.js) ────────────────────
    if (new URLSearchParams(location.search).has('debug')) {
        import('./debug.js').then(({ installDebugHelpers }) => installDebugHelpers({
            getAlignSubjectId: () => state.alignSubjectId,
            getAlignOverlay:   () => state.alignOverlay,
            getAlignInMemory:  () => state.alignInMemory,
            getMatchRefId:     () => state.matchRefId,
        }));
    }

// ── Public API ───────────────────────────────────────────────────────────
window.app = { init, goStep, loadMeshByPath };

window.addEventListener('DOMContentLoaded', () => app.init());
