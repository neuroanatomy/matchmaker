import { el, setStatus, preItem } from './dom-helpers.js';
import { state } from './state.js';
import { Viewer3D } from './components/viewer3d.js';
import { FileBrowser } from './components/filebrowser.js';
import { TrajectoryPlayer } from './components/trajectory.js';
import { StereographicOverlay } from './components/stereographic.js';
import { StereoView } from './components/stereoview.js';

import { meshUrl, checkHealth, getConfig, apiGet, apiPost, apiPut, pollJob, createProject, addSubject, getProject, deleteSubject, getMatches, deleteMatch, getTrajectories, startTrajectory, deleteTrajectory } from './api.js';
import { ProjectModal, AddSubjectModal } from './components/projectmodal.js';
import { resampleMesh, parseRotMat, rotateVertsVR } from './components/morph.js';

window.app = (() => {
    // ── Quick-load datasets ──────────────────────────────────────────────────
    const DATASETS = [
        { label: 'F02_P0', rel: 'data/external/project/data/raw/meshes/F02_P0/mesh.ply' },
        { label: 'F06_P4', rel: 'data/external/project/data/raw/meshes/F06_P4/mesh.ply' },
        { label: 'F10_P8', rel: 'data/external/project/data/raw/meshes/F10_P8/mesh.ply' },
    ];

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
            _refreshViewer({ preserveOrientation: false });
        }
    }

    function _activateStep(n) {
        document.querySelectorAll('.step-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.step) === n);
        });
    }

    function renderStep(n) {
        const rpanel = document.getElementById('rpanel-content');
        const h2     = document.querySelector('#rpanel h2');

        if (n === 1) {
            h2.textContent = 'Load meshes';
            _renderLoadPanel(rpanel);
        } else if (n === 2) {
            h2.textContent = 'Preprocess';
            _renderPreprocessPanel(rpanel);
        } else if (n === 3) {
            h2.textContent = 'Align';
            _renderAlignPanel(rpanel);
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

    // ── Step 1 — Load meshes ─────────────────────────────────────────────────
    function _renderLoadPanel(container) {
        container.innerHTML = '';

        // Subject roster
        if (state.subjectOrder.length > 0) {
            const roster = el('div', { className: 'subject-roster' });
            state.subjectOrder.forEach(id => {
                const s   = state.subjects[id];
                const row = el('div', { className: `subject-row${id === state.activeSubjectId ? ' active' : ''}` });
                row.dataset.subjectId = id;

                const info = el('div', { className: 'subject-row-info' });

                const idEl = el('span', { className: 'subject-row-id' });
                idEl.textContent = id;
                info.appendChild(idEl);

                const fileEl = el('span', { className: 'subject-row-file' });
                fileEl.textContent = s.path ? '  ' + s.path.split('/').pop() : '';
                info.appendChild(fileEl);

                const dots = el('span', { className: 'subject-dots' });
                const _dot = (present, title) => {
                    const d = el('span', { className: `dot${present ? ' dot-on' : ''}`, title });
                    d.textContent = '●';
                    return d;
                };
                dots.appendChild(_dot(!!s.sphere,          'sphere'));
                dots.appendChild(_dot(!!(s.curv || s.sulc), 'maps'));
                dots.appendChild(_dot(!!s.sulci,            'landmarks'));
                info.appendChild(dots);

                row.appendChild(info);

                const rmBtn = el('button', { className: 'remove-btn' });
                rmBtn.textContent = '×';
                rmBtn.title = `Remove ${id}`;
                rmBtn.onclick = e => { e.stopPropagation(); _confirmRemoveSubject(id, row); };
                row.appendChild(rmBtn);

                row.onclick = async () => {
                    state.activeSubjectId = id;
                    if (state.viewedSubjectId !== id) {
                        state.viewedSubjectId = id;
                        if (!state.viewState[id]) state.viewState[id] = { meshType: 'native', texType: null };
                        else if (!state.viewState[id].meshType) state.viewState[id].meshType = 'native';
                        await _refreshViewer({ preserveOrientation: true });
                    }
                    _renderLoadPanel(container);
                };

                roster.appendChild(row);
            });
            container.appendChild(roster);
        }

        // View controls for active subject
        if (state.activeSubjectId && state.subjects[state.activeSubjectId]) {
            const id  = state.activeSubjectId;
            const s   = state.subjects[id];
            const vs  = state.viewState[id] || (state.viewState[id] = { meshType: null, texType: null });
            const isView = state.viewedSubjectId === id;

            const viewSec = el('div', { className: 'view-section' });

            const nativeEl = el('div', { className: 'sph-item sph-clickable' });
            const nativeOn = isView && vs.meshType === 'native';
            nativeEl.classList.toggle('sph-item-active', nativeOn);
            nativeEl.textContent = (nativeOn ? '▶ ' : '  ') + s.path.split('/').pop();
            nativeEl.onclick = () => _viewMesh(id, 'native');
            viewSec.appendChild(nativeEl);

            if (s.sphere) {
                const sphereEl = el('div', { className: 'sph-item sph-clickable' });
                const sphereOn = isView && vs.meshType === 'sphere';
                sphereEl.classList.toggle('sph-item-active', sphereOn);
                sphereEl.textContent = (sphereOn ? '▶ ' : '  ') + s.sphere.split('/').pop();
                sphereEl.onclick = () => _viewMesh(id, 'sphere');
                viewSec.appendChild(sphereEl);
            }

            if (s.sulc || s.curv) {
                viewSec.appendChild(el('div', { className: 'sph-divider' }));
                if (s.sulc) {
                    const sulcEl = el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'sulc';
                    sulcEl.classList.toggle('sph-tex-active', on);
                    sulcEl.textContent = (on ? '☑ ' : '☐ ') + 'sulcal depth';
                    sulcEl.onclick = () => _toggleTexture(id, 'sulc');
                    viewSec.appendChild(sulcEl);
                }
                if (s.curv) {
                    const curvEl = el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'curv';
                    curvEl.classList.toggle('sph-tex-active', on);
                    curvEl.textContent = (on ? '☑ ' : '☐ ') + 'curvature';
                    curvEl.onclick = () => _toggleTexture(id, 'curv');
                    viewSec.appendChild(curvEl);
                }
            }

            container.appendChild(viewSec);
        }

        // Quick-load pills
        const ql = el('div', { className: 'quickload-label' });
        ql.textContent = 'Quick load:';
        container.appendChild(ql);

        const pills = el('div', { className: 'quickload-pills' });
        DATASETS.forEach(ds => {
            const btn = el('button', { className: 'pill-btn' });
            btn.textContent = ds.label;
            btn.onclick = () => _loadSubject(state.dataRoot + '/' + ds.rel);
            pills.appendChild(btn);
        });
        container.appendChild(pills);

        const sep = el('div', { className: 'sep-label' });
        sep.textContent = '— or browse —';
        container.appendChild(sep);

        const fbContainer = el('div', { className: 'fb-container' });
        container.appendChild(fbContainer);

        const addBtn = el('button', { className: 'load-btn' });
        addBtn.textContent = '+ Add mesh';
        addBtn.disabled = true;

        const fb = new FileBrowser(fbContainer, {
            filter: name => name.endsWith('.ply') || name.endsWith('.ply.gz') || name === 'project.json',
            onSelect: path => {
                addBtn.disabled = false;
                addBtn.dataset.path = path;
                addBtn.textContent = path.endsWith('/project.json') ? 'Open project' : '+ Add mesh';
            },
        });
        fb.navigate(state.dataRoot || null);

        addBtn.onclick = () => _addMeshFromBrowser(addBtn.dataset.path);
        container.appendChild(addBtn);
    }

    async function _confirmRemoveSubject(id, rowEl) {
        const existing = rowEl.querySelector('.remove-confirm');
        if (existing) { existing.remove(); return; }

        const confirmEl = el('div', { className: 'remove-confirm' });
        confirmEl.textContent = `Remove ${id} and all derived files? `;

        const yesBtn = el('button', { className: 'remove-confirm-yes' });
        yesBtn.textContent = 'Remove';
        yesBtn.onclick = async e => {
            e.stopPropagation();
            try {
                if (state.projectRoot) await deleteSubject({ project_root: state.projectRoot, subject_id: id });
            } catch { /* still remove from local state */ }

            delete state.subjects[id];
            delete state.viewState[id];
            delete state.alignInMemory[id];
            state.subjectOrder = state.subjectOrder.filter(s => s !== id);
            if (state.activeSubjectId === id) state.activeSubjectId = state.subjectOrder[0] || null;
            if (state.viewedSubjectId === id) { state.viewedSubjectId = null; state.viewer.clearAll(); }
            if (state.alignSubjectId  === id) state.alignSubjectId = null;
            if (state.matchRefId      === id) { state.matchRefId = null; state.matchOutDir = null; state.morphResult = null; state.matchResult = null; state.morphSurface = null; state.matchSurface = null; }
            if (state.matchMovId      === id) { state.matchMovId = null; state.matchOutDir = null; state.morphResult = null; state.matchResult = null; state.morphSurface = null; state.matchSurface = null; }

            const c = document.getElementById('rpanel-content');
            if (c) renderStep(state.currentStep);
            setStatus(`Removed ${id}`);
        };
        confirmEl.appendChild(yesBtn);

        const noBtn = el('button', { className: 'remove-confirm-no' });
        noBtn.textContent = 'Cancel';
        noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
        confirmEl.appendChild(noBtn);

        rowEl.appendChild(confirmEl);
    }

    async function _loadSubject(absPath) {
        if (!absPath) return;
        const name = absPath.split('/').pop();
        setStatus(`Loading ${name}…`);
        try {
            // Detect project from path: .../data/raw/meshes/<id>/mesh.ply
            let id = null;
            const projMatch = absPath.match(/^(.+)\/data\/raw\/meshes\/([^/]+)\/mesh\.ply$/);
            if (projMatch) {
                if (!state.projectRoot) state.projectRoot = projMatch[1];
                id = projMatch[2];
            } else {
                id = _guessSubjectId(absPath);
            }

            // Ensure unique ID if collision
            if (state.subjects[id] && state.subjects[id].path !== absPath) {
                let n = 2;
                while (state.subjects[`${id}_${n}`]) n++;
                id = `${id}_${n}`;
            }

            if (!state.subjects[id]) {
                state.subjects[id] = { id, path: absPath, sphere: null, sulc: null, curv: null, sulci: null, rot: null };
                state.subjectOrder.push(id);
            } else {
                state.subjects[id].path = absPath;
            }

            state.viewState[id] = { meshType: 'native', texType: null };
            state.activeSubjectId = id;
            state.viewedSubjectId = id;

            // Auto-discover companion files
            const compParams = { path: absPath, subject_id: id };
            if (state.projectRoot) compParams.project_root = state.projectRoot;
            const comp = await apiGet('/api/companions', compParams).catch(() => ({}));
            state.subjects[id].sphere = comp.sphere        || null;
            state.subjects[id].sulc   = comp.sulc          || null;
            state.subjects[id].curv   = comp.curv          || null;
            state.subjects[id].sulci  = comp.sulci_json    || null;
            state.subjects[id].rot    = comp.rotation_txt  || null;

            await _refreshViewer({ preserveOrientation: false });

            const found = [];
            if (comp.sphere)       found.push('sphere');
            if (comp.sulc)         found.push('sulcal depth');
            if (comp.curv)         found.push('curvature');
            if (comp.sulci_json)   found.push('landmarks');
            if (comp.rotation_txt) found.push('rotation');
            setStatus(`${name} loaded${found.length ? ' — ' + found.join(', ') + ' available' : ''}`);

            if (state.currentStep === 1) {
                const c = document.getElementById('rpanel-content');
                if (c) _renderLoadPanel(c);
            } else {
                renderStep(state.currentStep);
            }
        } catch (e) {
            setStatus(`Load error: ${e.message}`);
        }
    }

    async function _loadProjectFile(projectJsonPath) {
        const root = projectJsonPath.replace(/\/project\.json$/, '');
        setStatus('Loading project…');
        try {
            const proj = await getProject(root);
            state.projectRoot = root;
            const ids = proj.subjects || [];
            if (ids.length === 0) { setStatus('Project has no subjects'); return; }
            for (const subjectId of ids) {
                await _loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
            }
            setStatus(`Project loaded — ${ids.length} subject${ids.length > 1 ? 's' : ''}`);
        } catch (e) {
            setStatus(`Project load error: ${e.message}`);
        }
    }

    async function _addMeshFromBrowser(path) {
        if (!path) return;

        // project.json selected — load entire project
        if (path.endsWith('/project.json')) {
            await _loadProjectFile(path);
            return;
        }

        // Path already inside a project structure — just load it
        const projMatch = path.match(/^(.+)\/data\/raw\/meshes\/([^/]+)\/mesh\.ply$/);
        if (projMatch) {
            await _loadSubject(path);
            return;
        }

        if (!state.projectRoot) {
            // No project yet — show create dialog
            await new Promise(resolve => {
                new ProjectModal(document.body, {
                    meshPath: path,
                    onConfirm: async ({ projectRoot: root, subjectId }) => {
                        try {
                            setStatus('Creating project…');
                            await createProject({ root_dir: root, ref_id: subjectId, ref_source_path: path });
                            state.projectRoot = root;
                            await _loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
                            setStatus('Project created');
                        } catch (e) {
                            setStatus(`Project creation failed: ${e.message}`);
                        }
                        resolve();
                    },
                    onCancel: () => resolve(),
                });
            });
        } else {
            // Project active — add this external mesh as a new subject
            await new Promise(resolve => {
                new AddSubjectModal(document.body, {
                    slot: 'ref',
                    meshPath: path,
                    projectRoot: state.projectRoot,
                    onConfirm: async ({ subjectId }) => {
                        try {
                            setStatus(`Adding ${subjectId} to project…`);
                            await addSubject({ project_root: state.projectRoot, subject_id: subjectId, source_path: path });
                            await _loadSubject(`${state.projectRoot}/data/raw/meshes/${subjectId}/mesh.ply`);
                        } catch (e) {
                            setStatus(`Failed to add subject: ${e.message}`);
                        }
                        resolve();
                    },
                    onCancel: () => resolve(),
                });
            });
        }
    }

    function _guessSubjectId(absPath) {
        if (!absPath) return 'subject';
        const GENERIC = new Set([
            'seg-pial-t2', 'seg-pial', 'seg-white', 'surfaces', 'surface',
            'external', 'data', 'landmarks', 'meshes', 'raw', 'derived',
        ]);
        const parts = absPath.split('/').filter(Boolean);
        for (let i = parts.length - 2; i >= 0; i--) {
            if (!GENERIC.has(parts[i])) return parts[i];
        }
        return parts[parts.length - 2] || 'subject';
    }

    function _annotationsDir(id) {
        return `${state.projectRoot}/data/derived/annotations/${id}`;
    }

    // ── Public shortcut used by E2E tests ────────────────────────────────────
    async function loadMeshByPath(absPath) {
        await _loadSubject(absPath);
    }

    // ── Step 2 — Preprocess ──────────────────────────────────────────────────
    function _renderPreprocessPanel(container) {
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
                c.textContent = (done ? '✓' : '✗') + ' ' + label;
                return c;
            };
            chips.appendChild(_chip('sph', !!s.sphere));
            chips.appendChild(_chip('maps', !!(s.curv && s.sulc)));
            info.appendChild(chips);

            row.appendChild(info);
            row.onclick = () => {
                state.activeSubjectId = id;
                _renderPreprocessPanel(container);
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
            btn.onclick = () => _spherize(id, fill, btn);
            section.appendChild(btn);
        }
        if (!s.curv || !s.sulc) {
            const bar  = el('div', { className: 'progress-bar-wrap' });
            const fill = el('div', { className: 'progress-bar' });
            bar.appendChild(fill); bar.style.display = 'none';
            section.appendChild(bar);
            const btn = el('button', { className: 'load-btn' });
            btn.textContent = 'Compute maps';
            btn.onclick = () => _computeCurvature(id, fill, btn);
            section.appendChild(btn);
        }

        container.appendChild(section);
    }

    async function _viewMesh(id, meshType) {
        if (state.viewedSubjectId === id && state.viewState[id]?.meshType === meshType) return;
        state.viewedSubjectId = id;
        if (!state.viewState[id]) state.viewState[id] = { meshType: null, texType: null };
        state.viewState[id].meshType = meshType;
        await _refreshViewer();
        renderStep(state.currentStep);
    }

    async function _toggleTexture(id, texType) {
        if (!state.viewState[id]) state.viewState[id] = { meshType: 'native', texType: null };
        state.viewState[id].texType = state.viewState[id].texType === texType ? null : texType;
        if (state.viewedSubjectId === id) await _refreshViewer({ preserveOrientation: true });
        renderStep(state.currentStep);
    }

    async function _refreshViewer({ preserveOrientation = false } = {}) {
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

    async function _spherize(id, fillEl, btn) {
        btn.disabled = true;
        const s    = state.subjects[id];
        const body = { path: s.path };
        if (state.projectRoot) body.out_dir = _annotationsDir(id);
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

    async function _computeCurvature(id, fillEl, btn) {
        btn.disabled = true;
        const s    = state.subjects[id];
        const body = { path: s.path };
        if (state.projectRoot) body.out_dir = _annotationsDir(id);
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

    // ── Step 3 — Align ───────────────────────────────────────────────────────

    async function _activateAlign(id) {
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

        if (targetMode === '3d') await _switchViewMode('3d');
    }

    async function _switchViewMode(mode) {
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

    function _toggleWireframe() {
        state.alignWireframe = !state.alignWireframe;
        if (state.alignViewMode === 'flat') {
            state.alignStereoView?.setWireframe(state.alignWireframe);
        } else {
            state.viewer.setWireframe(state.alignWireframe);
        }
        renderStep(state.currentStep);
    }

    function _renderAlignPanel(container) {
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
            row.onclick = () => _activateAlign(id);
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
            if (firstWithSphere) setTimeout(() => _activateAlign(firstWithSphere), 0);
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
        flatBtn.onclick = () => _switchViewMode('flat');
        viewRow.appendChild(flatBtn);

        const btn3d = el('button', { className: `view-btn${state.alignViewMode === '3d' ? ' active' : ''}` });
        btn3d.textContent = '3D';
        btn3d.title = '3D sphere — orbit to verify landmark placement';
        btn3d.setAttribute('aria-pressed', String(state.alignViewMode === '3d'));
        btn3d.setAttribute('aria-label', '3D sphere view');
        if (!state.alignOverlay) { btn3d.disabled = true; btn3d.tabIndex = -1; }
        btn3d.onclick = () => _switchViewMode('3d');
        viewRow.appendChild(btn3d);

        const viewSep = el('span', { className: 'view-row-sep' });
        viewRow.appendChild(viewSep);

        const wireBtn = el('button', { className: `view-btn${state.alignWireframe ? ' active' : ''}` });
        wireBtn.textContent = '⊡ Wire';
        wireBtn.title = 'Toggle wireframe';
        wireBtn.setAttribute('aria-pressed', String(state.alignWireframe));
        wireBtn.setAttribute('aria-label', 'Wireframe rendering');
        if (!state.alignOverlay) { wireBtn.disabled = true; wireBtn.tabIndex = -1; }
        wireBtn.onclick = () => _toggleWireframe();
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
        loadSulciBtn.onclick = () => _loadSulciJSON();
        container.appendChild(loadSulciBtn);

        const saveSulciBtn = el('button', { className: 'load-btn' });
        saveSulciBtn.style.background = 'var(--accent2)';
        saveSulciBtn.textContent = 'Save sulci.json';
        saveSulciBtn.onclick = () => _saveSulciJSON();
        container.appendChild(saveSulciBtn);

        const saveRotBtn = el('button', { className: 'load-btn' });
        saveRotBtn.style.background = '#555';
        saveRotBtn.textContent = 'Save rotation.txt';
        saveRotBtn.onclick = () => _saveRotationTxt();
        container.appendChild(saveRotBtn);

        if (!state.alignOverlay && sphere) {
            setTimeout(() => _activateAlign(state.alignSubjectId), 0);
        }
    }

    async function _loadSulciJSON() {
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

    async function _saveSulciJSON() {
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

    async function _saveRotationTxt() {
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
    return { init, goStep, loadMeshByPath };
})();

window.addEventListener('DOMContentLoaded', () => app.init());
