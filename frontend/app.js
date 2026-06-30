import { Viewer3D } from './components/viewer3d.js';
import { FileBrowser } from './components/filebrowser.js';
import { TrajectoryPlayer } from './components/trajectory.js';
import { StereographicOverlay } from './components/stereographic.js';
import { StereoView } from './components/stereoview.js';

import { meshUrl, checkHealth, getConfig, apiGet, apiPost, apiPut, pollJob, createProject, addSubject, getProject, deleteSubject, getMatches, deleteMatch, getTrajectories, startTrajectory, deleteTrajectory } from './api.js';
import { ProjectModal, AddSubjectModal } from './components/projectmodal.js';
import { resampleMesh, parseRotMat, rotateVertsVR } from './components/morph.js';

window.app = (() => {
    let viewer = null;
    let player = null;
    let dataRoot = '';

    // ── Subject roster ────────────────────────────────────────────────────────
    let subjects     = {};   // { [id]: { id, path, sphere, sulc, curv, sulci, rot } }
    let subjectOrder = [];   // IDs in insertion order
    let activeSubjectId = null;  // selected in Load / Preprocess / Align
    let viewedSubjectId = null;  // whose mesh is in the 3D viewer

    // viewState keyed by subject ID
    const viewState = {};    // { [id]: { meshType: null|'native'|'sphere', texType: null|'sulc'|'curv' } }

    // ── Project state ─────────────────────────────────────────────────────────
    let projectRoot = null;

    // ── Match step ────────────────────────────────────────────────────────────
    let existingMatches = [];   // [{name, dir, mov_id, ref_id, has_morph, has_match, params}]
    let matchRefId      = null;
    let matchMovId      = null;
    let matchOutDir     = null;
    let morphResult     = null;
    let matchResult     = null;
    let matchK          = 100;
    let matchNsteps     = 1;
    let matchWSmooth    = 1.0;
    let matchWDeform    = 10.0;
    let matchWProject   = 1.0;
    let matchViewMode   = 'morph';
    let matchViewOpacity = 0.6;
    let morphSphereData = null;
    let morphSurface    = null;
    let matchSurface    = null;
    let morphInterpT    = 0;

    // ── View / Trajectory step ────────────────────────────────────────────────
    let existingTrajectories = [];   // [{name, dir, n_frames, done, params}]
    let trajSeq              = [];   // ordered subject IDs oldest→youngest for new trajectory
    let trajMode             = 'raw';
    let trajNDeformSmooth    = 5;
    let trajDoIcp            = false;
    let trajNTrajSmooth      = 1;
    let trajNSpatialSmooth   = 1;
    let trajLambdaSpatial    = 0.005;
    let loadedTrajDir        = null; // which trajectory is currently in the player

    // ── Align step ────────────────────────────────────────────────────────────
    let alignSubjectId        = null;
    let alignInMemory         = {};   // { [id]: overlayJSON }
    let alignStereoView       = null;
    let alignOverlay          = null;
    let alignViewMode         = 'flat';
    let alignWireframe        = false;
    let alignHas3DOrientation = false;

    let currentStep = 1;

    // ── Quick-load datasets ──────────────────────────────────────────────────
    const DATASETS = [
        { label: 'F02_P0', rel: 'data/external/project/data/raw/meshes/F02_P0/mesh.ply' },
        { label: 'F06_P4', rel: 'data/external/project/data/raw/meshes/F06_P4/mesh.ply' },
        { label: 'F10_P8', rel: 'data/external/project/data/raw/meshes/F10_P8/mesh.ply' },
    ];

    const TRAJ_DEMO_RELS = [0, 2, 4, 6, 8].map(n => `trajectoryviewer/${n}.ply`);

    // ── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        viewer = new Viewer3D(document.getElementById('viewer-container'));
        window._viewer = viewer;

        _startHealthPolling();

        const cfg = await getConfig();
        if (cfg) dataRoot = cfg.data_root;

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
        const prev = currentStep;
        if (prev === 3 && n !== 3) {
            if (alignOverlay && alignSubjectId) {
                alignInMemory[alignSubjectId] = alignOverlay.toJSON();
                alignOverlay.destroy();
                alignOverlay = null;
            }
            if (alignStereoView) { alignStereoView.destroy(); alignStereoView = null; }
            if (alignViewMode === '3d') viewer.clearAll();
            alignViewMode         = 'flat';
            alignWireframe        = false;
            alignHas3DOrientation = false;
        }
        if (prev === 4 && n !== 4) {
            viewer.clearAll();
        }
        if (prev === 5 && n !== 5) {
            player?.pause();
            viewer.clearAll();
            _showTrajectoryBar(false);
        }
        currentStep = n;
        _activateStep(n);
        renderStep(n);
        if (n === 4 && prev !== 4) {
            _refreshMatchViewer();
        }
        if (n === 5 && prev !== 5) {
            viewer.clearAll();
            if (player?.isLoaded) {
                player.reattach(viewer);
                _showTrajectoryBar(true);
            }
        }
        if (prev === 4 && (n === 1 || n === 2) && viewedSubjectId && viewState[viewedSubjectId]?.meshType) {
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
        if (subjectOrder.length > 0) {
            const roster = _el('div', { className: 'subject-roster' });
            subjectOrder.forEach(id => {
                const s   = subjects[id];
                const row = _el('div', { className: `subject-row${id === activeSubjectId ? ' active' : ''}` });
                row.dataset.subjectId = id;

                const info = _el('div', { className: 'subject-row-info' });

                const idEl = _el('span', { className: 'subject-row-id' });
                idEl.textContent = id;
                info.appendChild(idEl);

                const fileEl = _el('span', { className: 'subject-row-file' });
                fileEl.textContent = s.path ? '  ' + s.path.split('/').pop() : '';
                info.appendChild(fileEl);

                const dots = _el('span', { className: 'subject-dots' });
                const _dot = (present, title) => {
                    const d = _el('span', { className: `dot${present ? ' dot-on' : ''}`, title });
                    d.textContent = '●';
                    return d;
                };
                dots.appendChild(_dot(!!s.sphere,          'sphere'));
                dots.appendChild(_dot(!!(s.curv || s.sulc), 'maps'));
                dots.appendChild(_dot(!!s.sulci,            'landmarks'));
                info.appendChild(dots);

                row.appendChild(info);

                const rmBtn = _el('button', { className: 'remove-btn' });
                rmBtn.textContent = '×';
                rmBtn.title = `Remove ${id}`;
                rmBtn.onclick = e => { e.stopPropagation(); _confirmRemoveSubject(id, row); };
                row.appendChild(rmBtn);

                row.onclick = async () => {
                    activeSubjectId = id;
                    if (viewedSubjectId !== id) {
                        viewedSubjectId = id;
                        if (!viewState[id]) viewState[id] = { meshType: 'native', texType: null };
                        else if (!viewState[id].meshType) viewState[id].meshType = 'native';
                        await _refreshViewer({ preserveOrientation: true });
                    }
                    _renderLoadPanel(container);
                };

                roster.appendChild(row);
            });
            container.appendChild(roster);
        }

        // View controls for active subject
        if (activeSubjectId && subjects[activeSubjectId]) {
            const id  = activeSubjectId;
            const s   = subjects[id];
            const vs  = viewState[id] || (viewState[id] = { meshType: null, texType: null });
            const isView = viewedSubjectId === id;

            const viewSec = _el('div', { className: 'view-section' });

            const nativeEl = _el('div', { className: 'sph-item sph-clickable' });
            const nativeOn = isView && vs.meshType === 'native';
            nativeEl.classList.toggle('sph-item-active', nativeOn);
            nativeEl.textContent = (nativeOn ? '▶ ' : '  ') + s.path.split('/').pop();
            nativeEl.onclick = () => _viewMesh(id, 'native');
            viewSec.appendChild(nativeEl);

            if (s.sphere) {
                const sphereEl = _el('div', { className: 'sph-item sph-clickable' });
                const sphereOn = isView && vs.meshType === 'sphere';
                sphereEl.classList.toggle('sph-item-active', sphereOn);
                sphereEl.textContent = (sphereOn ? '▶ ' : '  ') + s.sphere.split('/').pop();
                sphereEl.onclick = () => _viewMesh(id, 'sphere');
                viewSec.appendChild(sphereEl);
            }

            if (s.sulc || s.curv) {
                viewSec.appendChild(_el('div', { className: 'sph-divider' }));
                if (s.sulc) {
                    const el = _el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'sulc';
                    el.classList.toggle('sph-tex-active', on);
                    el.textContent = (on ? '☑ ' : '☐ ') + 'sulcal depth';
                    el.onclick = () => _toggleTexture(id, 'sulc');
                    viewSec.appendChild(el);
                }
                if (s.curv) {
                    const el = _el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'curv';
                    el.classList.toggle('sph-tex-active', on);
                    el.textContent = (on ? '☑ ' : '☐ ') + 'curvature';
                    el.onclick = () => _toggleTexture(id, 'curv');
                    viewSec.appendChild(el);
                }
            }

            container.appendChild(viewSec);
        }

        // Quick-load pills
        const ql = _el('div', { className: 'quickload-label' });
        ql.textContent = 'Quick load:';
        container.appendChild(ql);

        const pills = _el('div', { className: 'quickload-pills' });
        DATASETS.forEach(ds => {
            const btn = _el('button', { className: 'pill-btn' });
            btn.textContent = ds.label;
            btn.onclick = () => _loadSubject(dataRoot + '/' + ds.rel);
            pills.appendChild(btn);
        });
        container.appendChild(pills);

        const sep = _el('div', { className: 'sep-label' });
        sep.textContent = '— or browse —';
        container.appendChild(sep);

        const fbContainer = _el('div', { className: 'fb-container' });
        container.appendChild(fbContainer);

        const addBtn = _el('button', { className: 'load-btn' });
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
        fb.navigate(dataRoot || null);

        addBtn.onclick = () => _addMeshFromBrowser(addBtn.dataset.path);
        container.appendChild(addBtn);
    }

    async function _confirmRemoveSubject(id, rowEl) {
        const existing = rowEl.querySelector('.remove-confirm');
        if (existing) { existing.remove(); return; }

        const confirmEl = _el('div', { className: 'remove-confirm' });
        confirmEl.textContent = `Remove ${id} and all derived files? `;

        const yesBtn = _el('button', { className: 'remove-confirm-yes' });
        yesBtn.textContent = 'Remove';
        yesBtn.onclick = async e => {
            e.stopPropagation();
            try {
                if (projectRoot) await deleteSubject({ project_root: projectRoot, subject_id: id });
            } catch { /* still remove from local state */ }

            delete subjects[id];
            delete viewState[id];
            delete alignInMemory[id];
            subjectOrder = subjectOrder.filter(s => s !== id);
            if (activeSubjectId === id) activeSubjectId = subjectOrder[0] || null;
            if (viewedSubjectId === id) { viewedSubjectId = null; viewer.clearAll(); }
            if (alignSubjectId  === id) alignSubjectId = null;
            if (matchRefId      === id) { matchRefId = null; matchOutDir = null; morphResult = null; matchResult = null; morphSurface = null; matchSurface = null; }
            if (matchMovId      === id) { matchMovId = null; matchOutDir = null; morphResult = null; matchResult = null; morphSurface = null; matchSurface = null; }

            const c = document.getElementById('rpanel-content');
            if (c) renderStep(currentStep);
            _setStatus(`Removed ${id}`);
        };
        confirmEl.appendChild(yesBtn);

        const noBtn = _el('button', { className: 'remove-confirm-no' });
        noBtn.textContent = 'Cancel';
        noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
        confirmEl.appendChild(noBtn);

        rowEl.appendChild(confirmEl);
    }

    async function _loadSubject(absPath) {
        if (!absPath) return;
        const name = absPath.split('/').pop();
        _setStatus(`Loading ${name}…`);
        try {
            // Detect project from path: .../data/raw/meshes/<id>/mesh.ply
            let id = null;
            const projMatch = absPath.match(/^(.+)\/data\/raw\/meshes\/([^/]+)\/mesh\.ply$/);
            if (projMatch) {
                if (!projectRoot) projectRoot = projMatch[1];
                id = projMatch[2];
            } else {
                id = _guessSubjectId(absPath);
            }

            // Ensure unique ID if collision
            if (subjects[id] && subjects[id].path !== absPath) {
                let n = 2;
                while (subjects[`${id}_${n}`]) n++;
                id = `${id}_${n}`;
            }

            if (!subjects[id]) {
                subjects[id] = { id, path: absPath, sphere: null, sulc: null, curv: null, sulci: null, rot: null };
                subjectOrder.push(id);
            } else {
                subjects[id].path = absPath;
            }

            viewState[id] = { meshType: 'native', texType: null };
            activeSubjectId = id;
            viewedSubjectId = id;

            // Auto-discover companion files
            const compParams = { path: absPath, subject_id: id };
            if (projectRoot) compParams.project_root = projectRoot;
            const comp = await apiGet('/api/companions', compParams).catch(() => ({}));
            subjects[id].sphere = comp.sphere        || null;
            subjects[id].sulc   = comp.sulc          || null;
            subjects[id].curv   = comp.curv          || null;
            subjects[id].sulci  = comp.sulci_json    || null;
            subjects[id].rot    = comp.rotation_txt  || null;

            await _refreshViewer({ preserveOrientation: false });

            const found = [];
            if (comp.sphere)       found.push('sphere');
            if (comp.sulc)         found.push('sulcal depth');
            if (comp.curv)         found.push('curvature');
            if (comp.sulci_json)   found.push('landmarks');
            if (comp.rotation_txt) found.push('rotation');
            _setStatus(`${name} loaded${found.length ? ' — ' + found.join(', ') + ' available' : ''}`);

            if (currentStep === 1) {
                const c = document.getElementById('rpanel-content');
                if (c) _renderLoadPanel(c);
            } else {
                renderStep(currentStep);
            }
        } catch (e) {
            _setStatus(`Load error: ${e.message}`);
        }
    }

    async function _loadProjectFile(projectJsonPath) {
        const root = projectJsonPath.replace(/\/project\.json$/, '');
        _setStatus('Loading project…');
        try {
            const proj = await getProject(root);
            projectRoot = root;
            const ids = proj.subjects || [];
            if (ids.length === 0) { _setStatus('Project has no subjects'); return; }
            for (const subjectId of ids) {
                await _loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
            }
            _setStatus(`Project loaded — ${ids.length} subject${ids.length > 1 ? 's' : ''}`);
        } catch (e) {
            _setStatus(`Project load error: ${e.message}`);
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

        if (!projectRoot) {
            // No project yet — show create dialog
            await new Promise(resolve => {
                new ProjectModal(document.body, {
                    meshPath: path,
                    onConfirm: async ({ projectRoot: root, subjectId }) => {
                        try {
                            _setStatus('Creating project…');
                            await createProject({ root_dir: root, ref_id: subjectId, ref_source_path: path });
                            projectRoot = root;
                            await _loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
                            _setStatus('Project created');
                        } catch (e) {
                            _setStatus(`Project creation failed: ${e.message}`);
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
                    projectRoot,
                    onConfirm: async ({ subjectId }) => {
                        try {
                            _setStatus(`Adding ${subjectId} to project…`);
                            await addSubject({ project_root: projectRoot, subject_id: subjectId, source_path: path });
                            await _loadSubject(`${projectRoot}/data/raw/meshes/${subjectId}/mesh.ply`);
                        } catch (e) {
                            _setStatus(`Failed to add subject: ${e.message}`);
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
        return `${projectRoot}/data/derived/annotations/${id}`;
    }

    // ── Public shortcut used by E2E tests ────────────────────────────────────
    async function loadMeshByPath(absPath) {
        await _loadSubject(absPath);
    }

    // ── Step 2 — Preprocess ──────────────────────────────────────────────────
    function _renderPreprocessPanel(container) {
        container.innerHTML = '';

        if (subjectOrder.length === 0) {
            const msg = _el('p', { className: 'coming-soon' });
            msg.textContent = 'No meshes loaded — go to Load (step 1) first.';
            container.appendChild(msg);
            return;
        }

        // Subject roster with inline status chips
        const roster = _el('div', { className: 'subject-roster' });
        subjectOrder.forEach(id => {
            const s   = subjects[id];
            const row = _el('div', { className: `subject-row${id === activeSubjectId ? ' active' : ''}` });
            row.dataset.subjectId = id;

            const info = _el('div', { className: 'subject-row-info' });
            const idEl = _el('span', { className: 'subject-row-id' });
            idEl.textContent = id;
            info.appendChild(idEl);

            const chips = _el('span', { className: 'pre-chips' });
            const _chip = (label, done) => {
                const c = _el('span', { className: `pre-chip ${done ? 'pre-done' : 'pre-missing'}` });
                c.textContent = (done ? '✓' : '✗') + ' ' + label;
                return c;
            };
            chips.appendChild(_chip('sph', !!s.sphere));
            chips.appendChild(_chip('maps', !!(s.curv && s.sulc)));
            info.appendChild(chips);

            row.appendChild(info);
            row.onclick = () => {
                activeSubjectId = id;
                _renderPreprocessPanel(container);
            };
            roster.appendChild(row);
        });
        container.appendChild(roster);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // Detail section for active subject
        if (!activeSubjectId || !subjects[activeSubjectId]) return;

        const id  = activeSubjectId;
        const s   = subjects[id];

        const section = _el('div', { className: 'sph-section' });

        const hdr = _el('div', { className: 'pre-header' });
        const lbl = _el('span', { className: 'sph-label' });
        lbl.textContent = id;
        hdr.appendChild(lbl);
        const fname = _el('span', { className: 'pre-filename' });
        fname.textContent = s.path ? '  ' + s.path.split('/').pop() : '';
        hdr.appendChild(fname);
        section.appendChild(hdr);

        section.appendChild(_preItem('Sphere',       !!s.sphere));
        section.appendChild(_preItem('Curvature',    !!s.curv));
        section.appendChild(_preItem('Sulcal depth', !!s.sulc));

        if (!s.sphere) {
            const bar  = _el('div', { className: 'progress-bar-wrap' });
            const fill = _el('div', { className: 'progress-bar' });
            bar.appendChild(fill); bar.style.display = 'none';
            section.appendChild(bar);
            const btn = _el('button', { className: 'load-btn' });
            btn.textContent = 'Spherize';
            btn.onclick = () => _spherize(id, fill, btn);
            section.appendChild(btn);
        }
        if (!s.curv || !s.sulc) {
            const bar  = _el('div', { className: 'progress-bar-wrap' });
            const fill = _el('div', { className: 'progress-bar' });
            bar.appendChild(fill); bar.style.display = 'none';
            section.appendChild(bar);
            const btn = _el('button', { className: 'load-btn' });
            btn.textContent = 'Compute maps';
            btn.onclick = () => _computeCurvature(id, fill, btn);
            section.appendChild(btn);
        }

        container.appendChild(section);
    }

    function _preItem(label, done) {
        const el = _el('div', { className: `pre-check ${done ? 'pre-done' : 'pre-missing'}` });
        el.textContent = (done ? '✓ ' : '✗ ') + label;
        return el;
    }

    async function _viewMesh(id, meshType) {
        if (viewedSubjectId === id && viewState[id]?.meshType === meshType) return;
        viewedSubjectId = id;
        if (!viewState[id]) viewState[id] = { meshType: null, texType: null };
        viewState[id].meshType = meshType;
        await _refreshViewer();
        renderStep(currentStep);
    }

    async function _toggleTexture(id, texType) {
        if (!viewState[id]) viewState[id] = { meshType: 'native', texType: null };
        viewState[id].texType = viewState[id].texType === texType ? null : texType;
        if (viewedSubjectId === id) await _refreshViewer({ preserveOrientation: true });
        renderStep(currentStep);
    }

    async function _refreshViewer({ preserveOrientation = false } = {}) {
        if (!viewedSubjectId || !viewState[viewedSubjectId]?.meshType) return;
        const id      = viewedSubjectId;
        const s       = subjects[id];
        if (!s) return;
        const vs      = viewState[id];
        const meshPath = vs.meshType === 'sphere' ? s.sphere : s.path;
        if (!meshPath) return;

        const texType = vs.texType;
        if (texType === 'sulc' || texType === 'curv') {
            const scalarPath = texType === 'sulc' ? s.sulc : s.curv;
            if (scalarPath) {
                try {
                    const scalars = await apiGet('/api/scalar', { path: scalarPath });
                    await viewer.loadMeshColored(meshUrl(meshPath), scalars, { preserveOrientation });
                    _setStatus(`${meshPath.split('/').pop()} — ${texType === 'sulc' ? 'sulcal depth' : 'curvature'}`);
                } catch (e) { _setStatus(`Error: ${e.message}`); }
                return;
            }
        }
        await viewer.loadMesh(meshUrl(meshPath), { preserveOrientation });
        _setStatus(meshPath.split('/').pop());
    }

    async function _spherize(id, fillEl, btn) {
        btn.disabled = true;
        const s    = subjects[id];
        const body = { path: s.path };
        if (projectRoot) body.out_dir = _annotationsDir(id);
        fillEl.parentElement.style.display = 'block';
        _setStatus(`Spherizing ${s.path.split('/').pop()}…`);
        try {
            const { job_id } = await apiPost('/api/spherize', body);
            const result = await pollJob(job_id, {
                onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
            });
            subjects[id].sphere = result.sphere_path;
            _setStatus(`Sphere ready: ${result.sphere_path.split('/').pop()}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Spherize error: ${e.message}`);
            btn.disabled = false;
        }
    }

    async function _computeCurvature(id, fillEl, btn) {
        btn.disabled = true;
        const s    = subjects[id];
        const body = { path: s.path };
        if (projectRoot) body.out_dir = _annotationsDir(id);
        fillEl.parentElement.style.display = 'block';
        _setStatus(`Computing maps for ${s.path.split('/').pop()}…`);
        try {
            const { job_id } = await apiPost('/api/curvature', body);
            const result = await pollJob(job_id, {
                onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
            });
            subjects[id].curv = result.curv_path;
            subjects[id].sulc = result.sulc_path;
            _setStatus(`Maps ready: ${result.sulc_path.split('/').pop()}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Maps error: ${e.message}`);
            btn.disabled = false;
        }
    }

    // ── Step 3 — Align ───────────────────────────────────────────────────────

    async function _activateAlign(id) {
        const prevId = alignSubjectId;
        alignSubjectId        = id;
        alignHas3DOrientation = false;
        if (currentStep !== 3) return;

        if (id === prevId && alignOverlay && alignStereoView) return;

        viewer.clearAll();

        const targetMode = alignViewMode;
        if (alignViewMode === '3d') alignViewMode = 'flat';

        if (alignOverlay) {
            if (prevId) alignInMemory[prevId] = alignOverlay.toJSON();
            alignOverlay.destroy();
            alignOverlay = null;
        }
        if (alignStereoView) { alignStereoView.destroy(); alignStereoView = null; }

        const s = subjects[id];
        if (!s?.sphere) {
            _setStatus(`No sphere for ${id} — run Preprocess first`);
            renderStep(currentStep);
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
        if (currentStep !== 3) return;

        _setStatus('Loading sphere…');
        try {
            const scalars = s.sulc ? await apiGet('/api/scalar', { path: s.sulc }) : null;
            if (currentStep !== 3) return;

            const container = document.getElementById('viewer-container');
            alignStereoView = new StereoView(container);
            window._alignStereoView = alignStereoView;
            await alignStereoView.load(s.sphere, scalars, initR);
            if (currentStep !== 3) { alignStereoView.destroy(); alignStereoView = null; return; }

            alignStereoView.onRotationChange(() => {
                const { alpha, beta, gamma } = alignStereoView.getEulerZYX();
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

            alignOverlay = new StereographicOverlay(container, alignStereoView);

            alignOverlay.onChange = () => {
                if (alignSubjectId) alignInMemory[alignSubjectId] = alignOverlay.toJSON();
            };

            const inMem     = alignInMemory[id];
            const sulciPath = s.sulci;
            if (inMem) {
                alignOverlay.fromJSON(inMem);
                _setStatus(`Stereo view ready — ${alignOverlay.regions.length} landmarks restored`);
            } else if (sulciPath) {
                try {
                    const data = await apiGet('/api/file', { path: sulciPath });
                    alignOverlay.fromJSON(data);
                    _setStatus(`Loaded ${sulciPath.split('/').pop()} — ${alignOverlay.regions.length} landmarks`);
                } catch { /* no prior sulci.json */ }
            }

            if (!inMem && !sulciPath) _setStatus('Stereo view ready — draw landmarks');
        } catch (e) {
            _setStatus(`Align error: ${e.message}`);
            return;
        }

        if (currentStep !== 3) return;
        renderStep(currentStep);

        if (targetMode === '3d') await _switchViewMode('3d');
    }

    async function _switchViewMode(mode) {
        if (alignViewMode === mode || !alignOverlay) return;
        alignViewMode = mode;
        renderStep(currentStep);
        if (mode === '3d') {
            alignStereoView._canvas.style.display = 'none';
            alignOverlay._canvas.style.display    = 'none';
            const s      = alignSubjectId ? subjects[alignSubjectId] : null;
            const native = s?.path;
            const scalar = s?.sulc || s?.curv;
            _setStatus('Loading 3D view…');
            try {
                const scalars = scalar
                    ? await apiGet('/api/scalar', { path: scalar }).catch(() => null)
                    : null;
                const preserveOrientation = alignHas3DOrientation;
                if (scalars) {
                    await viewer.loadMeshColored(meshUrl(native), scalars, { preserveOrientation });
                } else {
                    await viewer.loadMesh(meshUrl(native), { preserveOrientation });
                }
                alignHas3DOrientation = true;
                if (alignWireframe) viewer.setWireframe(true);
                if (alignOverlay?.regions.length > 0) {
                    const regions3d   = alignOverlay.getRegions3DSampled(10);
                    const nativeVerts = viewer.getMainMeshVertexArray();
                    if (nativeVerts) {
                        viewer.setLandmarkLinesOnMesh(
                            regions3d,
                            alignStereoView._rawVerts,
                            alignStereoView._nBase,
                            alignStereoView._tris,
                            nativeVerts,
                        );
                    }
                }
                _setStatus('3D view — orbit to verify; switch back to Flat to draw landmarks');
            } catch (e) {
                _setStatus(`3D view error: ${e.message}`);
            }
        } else {
            viewer.clearAll();
            alignStereoView._canvas.style.display = '';
            alignOverlay._canvas.style.display    = '';
            alignStereoView._render();
            _setStatus('Flat stereo view');
        }
    }

    function _toggleWireframe() {
        alignWireframe = !alignWireframe;
        if (alignViewMode === 'flat') {
            alignStereoView?.setWireframe(alignWireframe);
        } else {
            viewer.setWireframe(alignWireframe);
        }
        renderStep(currentStep);
    }

    function _renderAlignPanel(container) {
        container.innerHTML = '';

        if (subjectOrder.length === 0) {
            const msg = _el('p', { className: 'coming-soon' });
            msg.textContent = 'No meshes loaded — go to Load (step 1) first.';
            container.appendChild(msg);
            return;
        }

        // Subject selector roster
        const roster = _el('div', { className: 'subject-roster' });
        subjectOrder.forEach(id => {
            const s   = subjects[id];
            const row = _el('div', { className: `subject-row${id === alignSubjectId ? ' active' : ''}` });
            row.dataset.subjectId = id;

            const info = _el('div', { className: 'subject-row-info' });
            const idEl = _el('span', { className: 'subject-row-id' });
            idEl.textContent = id;
            info.appendChild(idEl);

            if (s.sulci || alignInMemory[id]?.length > 0) {
                const badge = _el('span', { className: 'sulci-badge' });
                badge.textContent = '✓ landmarks';
                info.appendChild(badge);
            }

            row.appendChild(info);
            row.onclick = () => _activateAlign(id);
            roster.appendChild(row);
        });
        container.appendChild(roster);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        if (!alignSubjectId) {
            const msg = _el('p', { className: 'coming-soon' });
            msg.textContent = 'Select a mesh above to start alignment.';
            container.appendChild(msg);
            // Auto-select first subject that has a sphere
            const firstWithSphere = subjectOrder.find(id => subjects[id]?.sphere);
            if (firstWithSphere) setTimeout(() => _activateAlign(firstWithSphere), 0);
            return;
        }

        const sphere = subjects[alignSubjectId]?.sphere;
        if (!sphere) {
            const msg = _el('p', { className: 'coming-soon' });
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
        const toolBar = _el('div', { className: 'align-tools' });
        const currentTool  = alignOverlay?.tool ?? 'draw';
        const editDisabled = alignViewMode === '3d';
        TOOLS.forEach(({ id, label, title }) => {
            const btn = _el('button', { className: `tool-btn${currentTool === id ? ' active' : ''}` });
            btn.textContent = label;
            btn.title       = editDisabled ? 'Not available in 3D mode' : title;
            btn.disabled    = editDisabled;
            if (editDisabled) btn.tabIndex = -1;
            btn.onclick = () => {
                if (!alignOverlay || editDisabled) return;
                alignOverlay.setTool(id);
                renderStep(currentStep);
            };
            toolBar.appendChild(btn);
        });
        const rotBtn = _el('button', {
            className: `tool-btn rotate${currentTool === 'rotate' ? ' active' : ''}`,
        });
        rotBtn.textContent = '↻';
        rotBtn.title    = editDisabled ? 'Not available in 3D mode' : 'Rotate sphere';
        rotBtn.disabled = editDisabled;
        if (editDisabled) rotBtn.tabIndex = -1;
        rotBtn.onclick = () => {
            if (!alignOverlay || editDisabled) return;
            const newTool = alignOverlay.tool === 'rotate' ? 'draw' : 'rotate';
            alignOverlay.setTool(newTool);
            renderStep(currentStep);
        };
        toolBar.appendChild(rotBtn);
        container.appendChild(toolBar);

        // View mode row
        const viewRow = _el('div', { className: 'view-row' });
        viewRow.setAttribute('role', 'group');
        viewRow.setAttribute('aria-label', 'View controls');

        const viewLabel = _el('span', { className: 'view-row-label' });
        viewLabel.textContent = 'VIEW';
        viewRow.appendChild(viewLabel);

        const flatBtn = _el('button', { className: `view-btn${alignViewMode === 'flat' ? ' active' : ''}` });
        flatBtn.textContent = 'Flat';
        flatBtn.title = 'Flat disc — stereographic projection';
        flatBtn.setAttribute('aria-pressed', String(alignViewMode === 'flat'));
        flatBtn.setAttribute('aria-label', 'Flat projection');
        if (!alignOverlay) { flatBtn.disabled = true; flatBtn.tabIndex = -1; }
        flatBtn.onclick = () => _switchViewMode('flat');
        viewRow.appendChild(flatBtn);

        const btn3d = _el('button', { className: `view-btn${alignViewMode === '3d' ? ' active' : ''}` });
        btn3d.textContent = '3D';
        btn3d.title = '3D sphere — orbit to verify landmark placement';
        btn3d.setAttribute('aria-pressed', String(alignViewMode === '3d'));
        btn3d.setAttribute('aria-label', '3D sphere view');
        if (!alignOverlay) { btn3d.disabled = true; btn3d.tabIndex = -1; }
        btn3d.onclick = () => _switchViewMode('3d');
        viewRow.appendChild(btn3d);

        const viewSep = _el('span', { className: 'view-row-sep' });
        viewRow.appendChild(viewSep);

        const wireBtn = _el('button', { className: `view-btn${alignWireframe ? ' active' : ''}` });
        wireBtn.textContent = '⊡ Wire';
        wireBtn.title = 'Toggle wireframe';
        wireBtn.setAttribute('aria-pressed', String(alignWireframe));
        wireBtn.setAttribute('aria-label', 'Wireframe rendering');
        if (!alignOverlay) { wireBtn.disabled = true; wireBtn.tabIndex = -1; }
        wireBtn.onclick = () => _toggleWireframe();
        viewRow.appendChild(wireBtn);

        container.appendChild(viewRow);

        // Rotation sliders (flat mode only)
        if (alignViewMode === 'flat' && alignStereoView) {
            const { alpha, beta, gamma } = alignStereoView.getEulerZYX();

            const rotSection = _el('div', { className: 'rot-section' });
            const rotLabel = _el('div', { className: 'rot-label' });
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
                const row = _el('div', { className: 'rot-row' });

                const lbl = _el('label', { className: 'rot-row-label', htmlFor: `rot-${id}`, title });
                lbl.textContent = label;
                row.appendChild(lbl);

                const slider = _el('input');
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

                const valSpan = _el('span', { className: 'rot-row-val' });
                valSpan.setAttribute('aria-live', 'polite');
                valSpan.textContent = `${val}°`;

                slider.oninput = () => {
                    valSpan.textContent = `${slider.value}°`;
                    valSpan.setAttribute('aria-valuenow', slider.value);
                    slider.setAttribute('aria-valuenow', slider.value);
                    const tw = parseInt(document.getElementById('rot-twist')?.value ?? alpha);
                    const tv = parseInt(document.getElementById('rot-tiltv')?.value ?? beta);
                    const th = parseInt(document.getElementById('rot-tilth')?.value ?? gamma);
                    alignStereoView?.setEulerZYX(tw, tv, th);
                };

                row.appendChild(slider);
                row.appendChild(valSpan);
                rotSection.appendChild(row);
            });

            container.appendChild(rotSection);
        }

        // Add landmark button
        const addBtn = _el('button', { className: 'load-btn' });
        addBtn.textContent = '+ New landmark';
        addBtn.style.marginTop = '0';
        addBtn.disabled = editDisabled || !alignOverlay;
        if (editDisabled) addBtn.title = 'Not available in 3D mode';
        addBtn.onclick = () => {
            if (!alignOverlay || editDisabled) return;
            alignOverlay.addRegion();
            renderStep(currentStep);
        };
        container.appendChild(addBtn);

        // Landmark list
        const listEl = _el('div', { className: 'landmark-list' });
        const regions = alignOverlay?.regions ?? [];
        regions.forEach(reg => {
            const item = _el('div', {
                className: `landmark-item${alignOverlay?.region === reg ? ' selected' : ''}`,
            });
            item.onclick = () => {
                if (!alignOverlay) return;
                alignOverlay.selectRegion(reg);
                renderStep(currentStep);
            };

            const dot = _el('div', { className: 'landmark-dot' });
            dot.style.background = reg.path.strokeColor?.toCSS?.() ?? '#ff6b6b';
            item.appendChild(dot);

            const nameInput = _el('input', { className: 'landmark-name', value: reg.name });
            nameInput.onclick = e => e.stopPropagation();
            nameInput.onchange = () => alignOverlay?.renameRegion(reg, nameInput.value);
            item.appendChild(nameInput);

            const delBtn = _el('button', { className: 'landmark-del' });
            delBtn.textContent = '×';
            delBtn.title = 'Delete landmark';
            delBtn.onclick = e => {
                e.stopPropagation();
                alignOverlay?.deleteRegion(reg);
                renderStep(currentStep);
            };
            item.appendChild(delBtn);
            listEl.appendChild(item);
        });
        if (regions.length === 0) {
            const empty = _el('div', { className: 'coming-soon' });
            empty.textContent = 'No landmarks yet — click "Draw" and trace a sulcus.';
            listEl.appendChild(empty);
        }
        container.appendChild(listEl);

        container.appendChild(_el('div', { className: 'sph-divider' }));

        const loadSulciBtn = _el('button', { className: 'load-btn' });
        loadSulciBtn.style.marginTop = '0';
        loadSulciBtn.textContent = 'Load sulci.json';
        loadSulciBtn.onclick = () => _loadSulciJSON();
        container.appendChild(loadSulciBtn);

        const saveSulciBtn = _el('button', { className: 'load-btn' });
        saveSulciBtn.style.background = 'var(--accent2)';
        saveSulciBtn.textContent = 'Save sulci.json';
        saveSulciBtn.onclick = () => _saveSulciJSON();
        container.appendChild(saveSulciBtn);

        const saveRotBtn = _el('button', { className: 'load-btn' });
        saveRotBtn.style.background = '#555';
        saveRotBtn.textContent = 'Save rotation.txt';
        saveRotBtn.onclick = () => _saveRotationTxt();
        container.appendChild(saveRotBtn);

        if (!alignOverlay && sphere) {
            setTimeout(() => _activateAlign(alignSubjectId), 0);
        }
    }

    async function _loadSulciJSON() {
        if (!alignOverlay) return;
        const sulciPath = subjects[alignSubjectId]?.sulci;
        if (!sulciPath) {
            _setStatus('No sulci.json found for this subject');
            return;
        }
        try {
            const data = await apiGet('/api/file', { path: sulciPath });
            alignOverlay.fromJSON(data);
            _setStatus(`Loaded ${sulciPath.split('/').pop()} — ${alignOverlay.regions.length} landmarks`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Load sulci error: ${e.message}`);
        }
    }

    async function _saveSulciJSON() {
        if (!alignOverlay || !alignSubjectId) return;
        const s = subjects[alignSubjectId];
        if (!s?.sphere) return;
        const dir      = s.sphere.substring(0, s.sphere.lastIndexOf('/'));
        const savePath = `${dir}/sulci.json`;
        try {
            const json = alignOverlay.toJSON();
            await apiPut('/api/file', { path: savePath, content: JSON.stringify(json, null, 2) });
            subjects[alignSubjectId].sulci = savePath;
            _setStatus(`Saved ${savePath.split('/').pop()}`);
        } catch (e) {
            _setStatus(`Save sulci error: ${e.message}`);
        }
    }

    async function _saveRotationTxt() {
        if (!alignOverlay || !alignSubjectId) return;
        const s = subjects[alignSubjectId];
        if (!s?.sphere) return;
        const dir      = s.sphere.substring(0, s.sphere.lastIndexOf('/'));
        const savePath = `${dir}/rotation.txt`;
        try {
            const txt = alignOverlay.getCameraRotationText();
            await apiPut('/api/file', { path: savePath, content: txt });
            subjects[alignSubjectId].rot = savePath;
            _setStatus(`Saved ${savePath.split('/').pop()}`);
        } catch (e) {
            _setStatus(`Save rotation error: ${e.message}`);
        }
    }

    // ── Step 4 — Match ───────────────────────────────────────────────────────

    function _renderMatchPanel(container) {
        container.innerHTML = '';

        // Auto-populate pickers on first render
        if (!matchRefId && subjectOrder.length >= 1) matchRefId = subjectOrder[0];
        if (!matchMovId && subjectOrder.length >= 2) matchMovId = subjectOrder[1];

        const ref = matchRefId ? subjects[matchRefId] : null;
        const mov = matchMovId ? subjects[matchMovId] : null;

        // Auto-derive output dir
        if (!matchOutDir && matchRefId && matchMovId) {
            if (projectRoot) {
                matchOutDir = `${projectRoot}/data/derived/matches/${matchMovId}_as_${matchRefId}`;
            } else if (mov?.path && ref?.path) {
                const movDir  = mov.path.substring(0, mov.path.lastIndexOf('/'));
                const refStem = ref.path.split('/').pop().replace(/\.ply(\.gz)?$/, '');
                matchOutDir = `${movDir}/match_${refStem}`;
            }
        }

        // ── Existing matches roster ──────────────────────────────────────────
        if (existingMatches.length > 0) {
            const rosterSection = _el('div', { className: 'sph-section' });
            const rosterHdr = _el('div', { className: 'sph-label' });
            rosterHdr.textContent = 'Existing matches';
            rosterSection.appendChild(rosterHdr);

            existingMatches.forEach(m => {
                const row = _el('div', { className: 'match-roster-row' });
                row.setAttribute('aria-label', `Match ${m.mov_id} → ${m.ref_id}`);

                const nameEl = _el('span', { className: 'match-roster-name' });
                nameEl.textContent = `${m.mov_id} → ${m.ref_id}`;
                row.appendChild(nameEl);

                const statusEl = _el('span', { className: 'match-roster-status' });
                statusEl.textContent = `${m.has_morph ? '◉' : '○'} morph  ${m.has_match ? '◉' : '○'} match`;
                statusEl.title = `morph.sphere.ply: ${m.has_morph ? 'present' : 'missing'} · surf.0.ply: ${m.has_match ? 'present' : 'missing'}`;
                row.appendChild(statusEl);

                const loadBtn = _el('button', { className: 'roster-load-btn' });
                loadBtn.textContent = 'Load';
                loadBtn.disabled = !m.has_match;
                loadBtn.setAttribute('aria-label', `Load match ${m.name}`);
                loadBtn.onclick = () => _loadMatchFromDisk(m);
                row.appendChild(loadBtn);

                const delBtn = _el('button', { className: 'roster-del-btn' });
                delBtn.textContent = '✕';
                delBtn.setAttribute('aria-label', `Delete match ${m.name}`);
                delBtn.onclick = () => _confirmDeleteMatch(m, row, rosterSection);
                row.appendChild(delBtn);

                rosterSection.appendChild(row);
            });

            container.appendChild(rosterSection);
            container.appendChild(_el('div', { className: 'sph-divider' }));
        }

        // ── Ref / Mov pickers ────────────────────────────────────────────────
        const pickerSection = _el('div', { className: 'sph-section' });
        const pickerHdr = _el('div', { className: 'sph-label' });
        pickerHdr.textContent = 'New match';
        pickerSection.appendChild(pickerHdr);

        const _makePickerRow = (label, currentId, selId, onSet) => {
            const row = _el('div', { className: 'param-row' });
            const lbl = _el('span', { className: 'param-label' });
            lbl.textContent = label;
            row.appendChild(lbl);
            const sel = _el('select');
            sel.id = selId;
            sel.className = 'match-subject-select';
            sel.setAttribute('aria-label', `${label} subject`);
            const emptyOpt = _el('option');
            emptyOpt.value = ''; emptyOpt.textContent = '— select —';
            sel.appendChild(emptyOpt);
            subjectOrder.forEach(id => {
                const opt = _el('option');
                opt.value = id; opt.textContent = id;
                if (id === currentId) opt.selected = true;
                sel.appendChild(opt);
            });
            sel.onchange = () => {
                onSet(sel.value || null);
                matchOutDir = null; morphResult = null; matchResult = null;
                morphSurface = null; matchSurface = null;
                renderStep(currentStep);
            };
            row.appendChild(sel);
            return row;
        };

        pickerSection.appendChild(_makePickerRow('Ref', matchRefId, 'match-ref-select', v => { matchRefId = v; }));
        pickerSection.appendChild(_makePickerRow('Mov', matchMovId, 'match-mov-select', v => { matchMovId = v; }));
        container.appendChild(pickerSection);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // ── Inputs checklist ─────────────────────────────────────────────────
        const inputsSection = _el('div', { className: 'sph-section' });
        const inputsHdr = _el('div', { className: 'sph-label' });
        inputsHdr.textContent = 'Inputs';
        inputsSection.appendChild(inputsHdr);

        inputsSection.appendChild(_preItem(matchRefId ? `Ref: ${matchRefId}` : 'Ref: not selected', !!ref?.path));
        inputsSection.appendChild(_preItem(matchMovId ? `Mov: ${matchMovId}` : 'Mov: not selected', !!mov?.path));

        const bothSpheres = !!(ref?.sphere && mov?.sphere);
        const sphereLabel = !ref?.sphere && !mov?.sphere ? 'Spheres: neither computed'
                          : !ref?.sphere                  ? 'Spheres: ref missing'
                          : !mov?.sphere                  ? 'Spheres: mov missing'
                          : 'Spheres computed';
        inputsSection.appendChild(_preItem(sphereLabel, bothSpheres));

        const hasRefSulci = !!(alignInMemory[matchRefId]?.length || ref?.sulci);
        const hasMovSulci = !!(alignInMemory[matchMovId]?.length || mov?.sulci);
        const lmkLabel = `Landmarks: ref ${hasRefSulci ? '✓' : '✗'} · mov ${hasMovSulci ? '✓' : '✗'}`;
        inputsSection.appendChild(_preItem(lmkLabel, hasRefSulci && hasMovSulci));

        if (ref?.rot || mov?.rot) {
            const bothRot  = !!(ref?.rot && mov?.rot);
            const rotLabel = !ref?.rot ? 'Rotations: ref missing'
                           : !mov?.rot ? 'Rotations: mov missing'
                           : 'Rotations';
            inputsSection.appendChild(_preItem(rotLabel, bothRot));
        }

        container.appendChild(inputsSection);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // ── Output directory ─────────────────────────────────────────────────
        const outSection = _el('div', { className: 'sph-section' });
        const outHdr = _el('div', { className: 'sph-label' });
        outHdr.textContent = 'Output directory';
        outSection.appendChild(outHdr);

        const outInput = _el('input', { className: 'out-dir-input' });
        outInput.type = 'text';
        outInput.value = matchOutDir || '';
        outInput.setAttribute('aria-label', 'Match output directory');
        outInput.onchange = () => { matchOutDir = outInput.value.trim() || null; };
        outSection.appendChild(outInput);
        container.appendChild(outSection);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // ── Viewer mode ──────────────────────────────────────────────────────
        const viewSection = _el('div', { className: 'sph-section' });
        const viewSHdr = _el('div', { className: 'sph-label' });
        viewSHdr.textContent = 'Viewer';
        viewSection.appendChild(viewSHdr);

        const viewModeRow = _el('div', { className: 'view-row' });
        viewModeRow.setAttribute('role', 'group');
        viewModeRow.setAttribute('aria-label', 'Match viewer mode');
        const VIEW_MODES = [
            { id: 'morph', label: 'Morph', ok: !!morphSurface, title: 'Ref → Mov retopology blend' },
            { id: 'match', label: 'Match', ok: !!matchResult,  title: 'Matched surface' },
        ];
        VIEW_MODES.forEach(({ id, label, ok, title }) => {
            const b = _el('button', { className: `view-btn${matchViewMode === id ? ' active' : ''}` });
            b.textContent = label; b.title = title; b.disabled = !ok;
            b.setAttribute('aria-pressed', String(matchViewMode === id));
            b.setAttribute('aria-label', title);
            b.onclick = () => {
                if (!ok) return;
                matchViewMode = id;
                _refreshMatchViewer({ preserveOrientation: true });
                renderStep(currentStep);
            };
            viewModeRow.appendChild(b);
        });
        viewSection.appendChild(viewModeRow);

        if (morphSurface || matchSurface) {
            const blendRow = _el('div', { className: 'param-row' });
            const blendLbl = _el('label', { className: 'param-label', htmlFor: 'morph-blend' });
            blendLbl.textContent = 'Ref → Mov';
            blendRow.appendChild(blendLbl);
            const blendSl = _el('input');
            blendSl.type = 'range'; blendSl.id = 'morph-blend';
            blendSl.min = '0'; blendSl.max = '1'; blendSl.step = '0.01';
            blendSl.value = String(morphInterpT);
            blendSl.setAttribute('aria-label', 'Morph blend: Ref to Mov');
            const blendVal = _el('input');
            blendVal.type = 'number'; blendVal.className = 'param-val';
            blendVal.min = '0'; blendVal.max = '100'; blendVal.step = '1';
            blendVal.value = String(Math.round(morphInterpT * 100));
            blendVal.setAttribute('aria-label', 'Blend percentage');
            blendSl.oninput = () => {
                morphInterpT = parseFloat(blendSl.value);
                blendVal.value = String(Math.round(morphInterpT * 100));
                viewer.setBlendT(morphInterpT);
            };
            blendVal.oninput = () => {
                const pct = Math.max(0, Math.min(100, parseInt(blendVal.value) || 0));
                morphInterpT = pct / 100;
                blendSl.value = String(morphInterpT);
                viewer.setBlendT(morphInterpT);
            };
            blendRow.appendChild(blendSl); blendRow.appendChild(blendVal);
            viewSection.appendChild(blendRow);
        }

        container.appendChild(viewSection);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // ── Phase 1: Morph ───────────────────────────────────────────────────
        const morphSection = _el('div', { className: 'sph-section' });
        const morphHdr = _el('div', { className: 'sph-label' });
        morphHdr.textContent = 'Phase 1: Morph';
        morphSection.appendChild(morphHdr);

        const morphDesc = _el('p', { className: 'match-desc' });
        morphDesc.textContent = 'Fast landmark-guided spherical warp (~5 s)';
        morphSection.appendChild(morphDesc);

        const morphBarWrap = _el('div', { className: 'progress-bar-wrap' });
        morphBarWrap.id = 'morph-progress';
        morphBarWrap.style.display = morphResult ? 'block' : 'none';
        const morphBarFill = _el('div', { className: 'progress-bar' });
        morphBarFill.setAttribute('role', 'progressbar');
        morphBarFill.setAttribute('aria-valuenow', morphResult ? '100' : '0');
        morphBarFill.setAttribute('aria-valuemax', '100');
        if (morphResult) morphBarFill.style.width = '100%';
        morphBarWrap.appendChild(morphBarFill);
        morphSection.appendChild(morphBarWrap);

        const canMorph = !!(ref?.path && mov?.path && ref?.sphere && mov?.sphere && hasRefSulci && hasMovSulci);
        const morphBtn = _el('button', { className: 'load-btn' });
        morphBtn.id = 'btn-run-morph';
        morphBtn.textContent = '▶ Run Morph';
        morphBtn.disabled = !canMorph;
        morphBtn.setAttribute('aria-label', 'Run spherical morph');
        if (!canMorph) morphBtn.setAttribute('aria-disabled', 'true');
        morphBtn.onclick = () => _runMorph(morphBarFill, morphBtn);
        morphSection.appendChild(morphBtn);

        if (morphResult) {
            const done = _el('div', { className: 'pre-check pre-done' });
            done.textContent = '✓ morph.sphere.ply saved';
            morphSection.appendChild(done);
        }


        container.appendChild(morphSection);
        container.appendChild(_el('div', { className: 'sph-divider' }));

        // ── Phase 2: Match ───────────────────────────────────────────────────
        const matchSection = _el('div', { className: 'sph-section' });
        const matchHdr = _el('div', { className: 'sph-label' });
        matchHdr.textContent = 'Phase 2: Match';
        matchSection.appendChild(matchHdr);

        const matchDesc = _el('p', { className: 'match-desc' });
        matchDesc.textContent = 'Laplacian eigenvector optimisation (~1 min)';
        matchSection.appendChild(matchDesc);

        const kRow = _el('div', { className: 'param-row' });
        const kLabel = _el('label', { className: 'param-label', htmlFor: 'match-k' });
        kLabel.textContent = 'k eigenvectors';
        kRow.appendChild(kLabel);
        const kSlider = _el('input');
        kSlider.type = 'range'; kSlider.id = 'match-k';
        kSlider.min = '20'; kSlider.max = '200'; kSlider.step = '5';
        kSlider.value = String(matchK);
        kSlider.setAttribute('aria-label', 'k eigenvectors');
        const kVal = _el('input');
        kVal.type = 'number'; kVal.className = 'param-val';
        kVal.min = '20'; kVal.max = '200'; kVal.step = '5';
        kVal.value = String(matchK);
        kVal.setAttribute('aria-label', 'k eigenvectors value');
        kSlider.oninput = () => { matchK = parseInt(kSlider.value); kVal.value = kSlider.value; };
        kVal.oninput = () => {
            const v = Math.max(20, Math.min(200, parseInt(kVal.value) || 20));
            matchK = v; kSlider.value = String(v);
        };
        kRow.appendChild(kSlider); kRow.appendChild(kVal);
        matchSection.appendChild(kRow);

        const stepsRow = _el('div', { className: 'param-row' });
        const stepsLabel = _el('span', { className: 'param-label' });
        stepsLabel.textContent = 'Refinement steps';
        stepsRow.appendChild(stepsLabel);
        const stepsGroup = _el('div', { className: 'steps-group' });
        stepsGroup.setAttribute('role', 'group');
        stepsGroup.setAttribute('aria-label', 'Refinement steps');
        [1, 2, 3, 4, 5].forEach(n => {
            const btn = _el('button', { className: `step-seg${matchNsteps === n ? ' active' : ''}` });
            btn.textContent = String(n);
            btn.setAttribute('aria-pressed', String(matchNsteps === n));
            btn.onclick = () => { matchNsteps = n; renderStep(currentStep); };
            stepsGroup.appendChild(btn);
        });
        stepsRow.appendChild(stepsGroup);
        matchSection.appendChild(stepsRow);

        const adv = _el('details', { className: 'advanced-details' });
        const advSum = _el('summary');
        advSum.textContent = 'Advanced';
        adv.appendChild(advSum);
        [
            { id: 'w-smooth',  label: 'Smooth weight',  min: 0, max: 10, step: 0.1, get: () => matchWSmooth,  set: v => { matchWSmooth  = v; } },
            { id: 'w-deform',  label: 'Deform weight',  min: 0, max: 50, step: 0.5, get: () => matchWDeform,  set: v => { matchWDeform  = v; } },
            { id: 'w-project', label: 'Project weight', min: 0, max: 10, step: 0.1, get: () => matchWProject, set: v => { matchWProject = v; } },
        ].forEach(({ id, label, min, max, step, get, set }) => {
            const row = _el('div', { className: 'param-row' });
            const lbl = _el('label', { className: 'param-label', htmlFor: `match-${id}` });
            lbl.textContent = label;
            row.appendChild(lbl);
            const sl = _el('input');
            sl.type = 'range'; sl.id = `match-${id}`;
            sl.min = String(min); sl.max = String(max); sl.step = String(step);
            sl.value = String(get());
            sl.setAttribute('aria-label', label);
            const vl = _el('input');
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

        const matchBarWrap = _el('div', { className: 'progress-bar-wrap' });
        matchBarWrap.id = 'match-progress';
        matchBarWrap.style.display = 'none';
        const matchBarFill = _el('div', { className: 'progress-bar pulsing' });
        matchBarFill.setAttribute('role', 'progressbar');
        matchBarWrap.appendChild(matchBarFill);
        matchSection.appendChild(matchBarWrap);

        const matchBtn = _el('button', { className: 'load-btn' });
        matchBtn.id = 'btn-run-match';
        matchBtn.textContent = '▶ Run Match';
        matchBtn.disabled = !morphResult;
        matchBtn.setAttribute('aria-label', 'Run match optimisation');
        if (!morphResult) matchBtn.setAttribute('aria-disabled', 'true');
        matchBtn.onclick = () => _runMatch(matchBarWrap, matchBarFill, matchBtn);
        matchSection.appendChild(matchBtn);

        if (matchResult) {
            const done = _el('div', { className: 'pre-check pre-done' });
            done.textContent = `✓ ${matchResult.matched_ply.split('/').pop()} saved`;
            matchSection.appendChild(done);

        }

        container.appendChild(matchSection);
    }

    async function _refreshMatchViewer({ preserveOrientation = false } = {}) {
        if (!matchRefId || !subjects[matchRefId]) return;

        if (matchViewMode === 'morph' || !matchResult) {
            viewer.clearAll();
            if (morphSurface) {
                viewer.loadBlendMesh(morphSurface.refVerts, morphSurface.morphVerts, morphSurface.faces);
                viewer.setBlendT(morphInterpT);
            } else if (morphSphereData) {
                viewer.loadMatchFromData(morphSphereData.vertices, morphSphereData.faces, { opacity: 1.0 });
            }
            return;
        }
        viewer.clearAll();
        if (matchSurface) {
            viewer.loadBlendMesh(matchSurface.refVerts, matchSurface.matchVerts, matchSurface.faces);
            viewer.setBlendT(morphInterpT);
        }
    }

    async function _runMorph(fillEl, btn) {
        btn.disabled = true;
        fillEl.parentElement.style.display = 'block';
        fillEl.style.width = '5%';
        _setStatus('Running morph…');
        try {
            const ref = subjects[matchRefId];
            const mov = subjects[matchMovId];

            const sulciRefData = alignInMemory[matchRefId] ?? await apiGet('/api/file', { path: ref.sulci });
            const sulciMovData = alignInMemory[matchMovId] ?? await apiGet('/api/file', { path: mov.sulci });
            console.log('[runMorph] ref:', alignInMemory[matchRefId] ? `in-memory (${alignInMemory[matchRefId].length} regions)` : `disk (${ref.sulci})`);
            console.log('[runMorph] mov:', alignInMemory[matchMovId] ? `in-memory (${alignInMemory[matchMovId].length} regions)` : `disk (${mov.sulci})`);
            fillEl.style.width = '15%';

            if (!matchOutDir) {
                if (projectRoot) {
                    matchOutDir = `${projectRoot}/data/derived/matches/${matchMovId}_as_${matchRefId}`;
                } else {
                    const movDir  = mov.path.substring(0, mov.path.lastIndexOf('/'));
                    const refStem = ref.path.split('/').pop().replace(/\.ply(\.gz)?$/, '');
                    matchOutDir = `${movDir}/match_${refStem}`;
                }
            }

            const body = {
                ref_sphere: ref.sphere,
                sulci_ref:  sulciRefData,
                sulci_mov:  sulciMovData,
                out_dir:    matchOutDir,
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
            morphSurface    = { refVerts: refNat.vertices, morphVerts: remeshed, faces: refSphRaw.faces };
            morphResult     = { morph_sphere_path: result.morph_sphere_path };
            morphSphereData = { vertices: morphSphRaw.vertices, faces: refSphRaw.faces };
            matchViewMode   = 'morph';
            fillEl.style.width = '100%';

            await _refreshMatchViewer({ preserveOrientation: false });
            _setStatus('Morph done — retopology complete');
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Morph error: ${e.message}`);
            btn.disabled = false;
            fillEl.parentElement.style.display = 'none';
        }
    }

    async function _runMatch(barWrap, fillEl, btn) {
        if (!morphResult || !matchOutDir) return;
        btn.disabled = true;
        barWrap.style.display = 'block';
        _setStatus('Running match optimisation…');
        try {
            const ref = subjects[matchRefId];
            const mov = subjects[matchMovId];

            // matchmesh2 naming: "ref" = brain to project onto = UI's mov
            //                    "mov" = sphere to deform      = UI's ref
            const body = {
                ref_ply:      mov.path,
                ref_sphere:   mov.sphere,
                mov_ply:      ref.path,
                mov_sphere:   ref.sphere,
                morph_sphere: morphResult.morph_sphere_path,
                out_dir:      matchOutDir,
                k:            matchK,
                nsteps:       matchNsteps,
                w_smooth:     matchWSmooth,
                w_deform:     matchWDeform,
                w_project:    matchWProject,
            };
            if (mov.rot) body.ref_rot = mov.rot;
            if (ref.rot) body.mov_rot = ref.rot;

            const { job_id } = await apiPost('/api/match', body);
            const result = await pollJob(job_id);
            matchResult   = result;
            matchViewMode = 'match';
            barWrap.style.display = 'none';

            const params = {
                ref_id:    matchRefId,
                mov_id:    matchMovId,
                timestamp: new Date().toISOString(),
                match: {
                    k:         matchK,
                    nsteps:    matchNsteps,
                    w_smooth:  matchWSmooth,
                    w_deform:  matchWDeform,
                    w_project: matchWProject,
                },
            };
            apiPut('/api/file', {
                path:    `${matchOutDir}/params.json`,
                content: JSON.stringify(params, null, 2),
            }).catch(() => {});

            const matchedNatRaw = await apiGet('/api/mesh_raw', { path: result.matched_ply });
            const refVerts = morphSurface ? morphSurface.refVerts
                : (await apiGet('/api/mesh_raw', { path: ref.path })).vertices;
            const refFaces = morphSurface ? morphSurface.faces : matchedNatRaw.faces;
            matchSurface = { refVerts, matchVerts: matchedNatRaw.vertices, faces: refFaces };

            await _refreshMatchViewer({ preserveOrientation: true });
            _setStatus(`Match done — ${result.matched_ply.split('/').pop()}`);
            await _loadExistingMatches();
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Match error: ${e.message}`);
            btn.disabled = false;
            barWrap.style.display = 'none';
        }
    }

    // ── Match roster helpers ─────────────────────────────────────────────────

    async function _loadExistingMatches() {
        if (!projectRoot) { existingMatches = []; return; }
        try {
            existingMatches = await getMatches(projectRoot);
        } catch {
            existingMatches = [];
        }
    }

    async function _loadMatchFromDisk(m) {
        if (!m.has_match) return;
        _setStatus(`Loading match ${m.name}…`);

        matchRefId  = m.ref_id;
        matchMovId  = m.mov_id;
        matchOutDir = m.dir;
        matchResult  = { matched_ply: `${m.dir}/surf.0.ply` };
        matchViewMode = 'match';
        morphResult  = m.has_morph ? { morph_sphere_path: `${m.dir}/morph.sphere.ply` } : null;
        morphSurface = null;

        try {
            const matchedPly    = `${m.dir}/surf.0.ply`;
            const matchedNatRaw = await apiGet('/api/mesh_raw', { path: matchedPly });

            const ref = subjects[matchRefId];
            const refVerts = ref?.path
                ? (await apiGet('/api/mesh_raw', { path: ref.path })).vertices
                : matchedNatRaw.vertices;

            matchSurface = { refVerts, matchVerts: matchedNatRaw.vertices, faces: matchedNatRaw.faces };

            await _refreshMatchViewer({ preserveOrientation: false });
            _setStatus(`Loaded ${m.name}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Load error: ${e.message}`);
            matchResult = null; matchSurface = null;
            renderStep(currentStep);
        }
    }

    function _confirmDeleteMatch(m, rowEl, sectionEl) {
        const existing = rowEl.querySelector('.remove-confirm');
        if (existing) { existing.remove(); return; }

        const confirmEl = _el('div', { className: 'remove-confirm' });
        confirmEl.textContent = `Delete ${m.name}? `;

        const yesBtn = _el('button', { className: 'remove-confirm-yes' });
        yesBtn.textContent = 'Delete';
        yesBtn.onclick = async e => {
            e.stopPropagation();
            try { await deleteMatch({ match_dir: m.dir }); } catch { /* still remove row */ }
            rowEl.remove();
            existingMatches = existingMatches.filter(x => x.dir !== m.dir);
            if (matchOutDir === m.dir) {
                matchOutDir = null; morphResult = null; matchResult = null;
                morphSurface = null; matchSurface = null;
                viewer.clearAll();
            }
            if (sectionEl.querySelectorAll('.match-roster-row').length === 0) {
                sectionEl.remove();
            }
            _setStatus(`Deleted ${m.name}`);
        };
        confirmEl.appendChild(yesBtn);

        const noBtn = _el('button', { className: 'remove-confirm-no' });
        noBtn.textContent = 'Cancel';
        noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
        confirmEl.appendChild(noBtn);

        rowEl.appendChild(confirmEl);
    }

    // ── Step 5 — Trajectory ──────────────────────────────────────────────────

    async function _loadExistingTrajectories() {
        if (!projectRoot) { existingTrajectories = []; return; }
        try { existingTrajectories = await getTrajectories(projectRoot); }
        catch { existingTrajectories = []; }
    }

    function _renderTrajectoryPanel(container) {
        container.innerHTML = '';

        // ── Existing trajectories roster ─────────────────────────────────────
        if (existingTrajectories.length > 0) {
            const sec = _el('div', { className: 'sph-section' });
            const hdr = _el('div', { className: 'sph-label' });
            hdr.textContent = 'Existing trajectories';
            sec.appendChild(hdr);

            existingTrajectories.forEach(t => {
                const row = _el('div', { className: 'match-roster-row' });

                const nameEl = _el('span', { className: 'match-roster-name' });
                nameEl.textContent = t.name;
                nameEl.title = t.params?.seq?.join(' → ') || t.name;
                row.appendChild(nameEl);

                const info = _el('span', { className: 'match-roster-status' });
                const mode = t.params?.mode || 'raw';
                info.textContent = `${t.n_frames} frames · ${mode}`;
                row.appendChild(info);

                const loadBtn = _el('button', { className: 'roster-load-btn' });
                loadBtn.textContent = loadedTrajDir === t.dir ? 'Loaded' : 'Load';
                loadBtn.disabled = !t.done || loadedTrajDir === t.dir;
                loadBtn.setAttribute('aria-label', `Load trajectory ${t.name}`);
                loadBtn.onclick = () => _loadTrajectoryFromDisk(t);
                row.appendChild(loadBtn);

                const delBtn = _el('button', { className: 'roster-del-btn' });
                delBtn.textContent = '✕';
                delBtn.setAttribute('aria-label', `Delete trajectory ${t.name}`);
                delBtn.onclick = () => _confirmDeleteTrajectory(t, row, sec);
                row.appendChild(delBtn);

                sec.appendChild(row);
            });

            container.appendChild(sec);
            container.appendChild(_el('div', { className: 'sph-divider' }));
        }

        // ── New trajectory ────────────────────────────────────────────────────
        if (projectRoot) {
            const newSec = _el('div', { className: 'sph-section' });
            const newHdr = _el('div', { className: 'sph-label' });
            newHdr.textContent = 'New trajectory';
            newSec.appendChild(newHdr);

            // Sequence list
            const seqLabel = _el('div', { className: 'traj-seq-label' });
            seqLabel.textContent = 'Sequence (oldest → youngest)';
            newSec.appendChild(seqLabel);

            const seqList = _el('div', { className: 'traj-seq-list' });
            trajSeq.forEach((id, i) => {
                const pill = _el('div', { className: 'traj-seq-row' });

                const idEl = _el('span', { className: 'traj-seq-id' });
                idEl.textContent = id;
                pill.appendChild(idEl);

                const upBtn = _el('button', { className: 'traj-seq-btn' });
                upBtn.textContent = '▲'; upBtn.title = 'Move up';
                upBtn.disabled = i === 0;
                upBtn.onclick = () => { trajSeq.splice(i - 1, 0, trajSeq.splice(i, 1)[0]); renderStep(currentStep); };
                pill.appendChild(upBtn);

                const dnBtn = _el('button', { className: 'traj-seq-btn' });
                dnBtn.textContent = '▼'; dnBtn.title = 'Move down';
                dnBtn.disabled = i === trajSeq.length - 1;
                dnBtn.onclick = () => { trajSeq.splice(i + 1, 0, trajSeq.splice(i, 1)[0]); renderStep(currentStep); };
                pill.appendChild(dnBtn);

                const rmBtn = _el('button', { className: 'traj-seq-btn traj-seq-rm' });
                rmBtn.textContent = '✕';
                rmBtn.onclick = () => { trajSeq.splice(i, 1); renderStep(currentStep); };
                pill.appendChild(rmBtn);

                seqList.appendChild(pill);
            });

            // Add subject row
            const addRow = _el('div', { className: 'traj-add-row' });
            const addSel = _el('select', { className: 'traj-add-select', id: 'traj-add-subject' });
            const blankOpt = _el('option');
            blankOpt.value = ''; blankOpt.textContent = '— add subject —';
            addSel.appendChild(blankOpt);
            subjectOrder.forEach(sid => {
                if (trajSeq.includes(sid)) return;
                const opt = _el('option');
                opt.value = sid; opt.textContent = sid;
                addSel.appendChild(opt);
            });
            addSel.onchange = () => {
                if (addSel.value) { trajSeq.push(addSel.value); renderStep(currentStep); }
            };
            addRow.appendChild(addSel);
            seqList.appendChild(addRow);
            newSec.appendChild(seqList);

            // Required pairs validation
            if (trajSeq.length >= 2) {
                const pairsDiv = _el('div', { className: 'traj-pairs' });
                const pairsLbl = _el('div', { className: 'sph-label' });
                pairsLbl.textContent = 'Required matches';
                pairsLbl.style.marginTop = '6px';
                pairsDiv.appendChild(pairsLbl);

                let allPairsOk = true;
                for (let i = 0; i < trajSeq.length - 1; i++) {
                    const ref    = trajSeq[i];
                    const mov    = trajSeq[i + 1];
                    const fwdOk  = existingMatches.some(m => m.mov_id === mov && m.ref_id === ref && m.has_match);
                    const invOk  = !fwdOk && existingMatches.some(m => m.mov_id === ref && m.ref_id === mov && m.has_match);
                    const ok     = fwdOk || invOk;
                    if (!ok) allPairsOk = false;
                    const icon   = ok ? '◉' : '○';
                    const label  = invOk ? `${ref}_as_${mov} (inv)` : `${mov}_as_${ref}`;
                    const cls    = fwdOk ? 'traj-pair-ok' : (invOk ? 'traj-pair-inv' : 'traj-pair-miss');
                    const pairRow = _el('div', { className: 'traj-pair-row' });
                    pairRow.innerHTML = `<span class="traj-pair-icon">${icon}</span>
                        <span class="traj-pair-name ${cls}">${label}</span>`;
                    pairsDiv.appendChild(pairRow);
                }
                newSec.appendChild(pairsDiv);

                // Mode selector
                const modeRow = _el('div', { className: 'param-row' });
                const modeLbl = _el('span', { className: 'param-label' });
                modeLbl.textContent = 'Mode';
                modeRow.appendChild(modeLbl);
                const modeGrp = _el('div', { className: 'steps-group' });
                ['raw', 'smooth'].forEach(m => {
                    const btn = _el('button', { className: `step-seg${trajMode === m ? ' active' : ''}` });
                    btn.textContent = m.charAt(0).toUpperCase() + m.slice(1);
                    btn.onclick = () => { trajMode = m; renderStep(currentStep); };
                    modeGrp.appendChild(btn);
                });
                modeRow.appendChild(modeGrp);
                newSec.appendChild(modeRow);

                // Advanced parameters (smooth mode only)
                if (trajMode === 'smooth') {
                    const adv = _el('details', { className: 'advanced-details' });
                    const sum = _el('summary');
                    sum.textContent = 'Advanced';
                    adv.appendChild(sum);

                    const _paramRow = (label, get, set, min, max, step) => {
                        const row = _el('div', { className: 'param-row' });
                        const lbl = _el('span', { className: 'param-label' }); lbl.textContent = label; row.appendChild(lbl);
                        const slider = _el('input'); slider.type = 'range'; slider.min = min; slider.max = max; slider.step = step; slider.value = get();
                        const num = _el('input', { type: 'number', className: 'param-val' }); num.min = min; num.max = max; num.step = step; num.value = get();
                        slider.oninput = () => { set(parseFloat(slider.value)); num.value = slider.value; };
                        num.oninput = () => { const v = Math.min(max, Math.max(min, parseFloat(num.value) || min)); set(v); slider.value = v; };
                        row.appendChild(slider); row.appendChild(num);
                        return row;
                    };

                    adv.appendChild(_paramRow('Deform smooth', () => trajNDeformSmooth, v => { trajNDeformSmooth = v; }, 0, 20, 1));
                    adv.appendChild(_paramRow('Traj smooth', () => trajNTrajSmooth, v => { trajNTrajSmooth = v; }, 0, 10, 1));
                    adv.appendChild(_paramRow('Spatial smooth', () => trajNSpatialSmooth, v => { trajNSpatialSmooth = v; }, 0, 10, 1));
                    adv.appendChild(_paramRow('λ spatial', () => trajLambdaSpatial, v => { trajLambdaSpatial = v; }, 0.001, 0.1, 0.001));

                    const icpRow = _el('div', { className: 'param-row' });
                    const icpLbl = _el('span', { className: 'param-label' }); icpLbl.textContent = 'ICP align'; icpRow.appendChild(icpLbl);
                    const icpCb = _el('input'); icpCb.type = 'checkbox'; icpCb.checked = trajDoIcp;
                    icpCb.onchange = () => { trajDoIcp = icpCb.checked; };
                    icpRow.appendChild(icpCb);
                    adv.appendChild(icpRow);

                    newSec.appendChild(adv);
                }

                // Run button
                const runBtn = _el('button', { className: 'load-btn', style: 'margin-top:8px' });
                runBtn.textContent = 'Run Trajectory';
                runBtn.disabled = !allPairsOk;
                runBtn.onclick = () => _runTrajectory();
                newSec.appendChild(runBtn);
            } else {
                const hint = _el('div', { className: 'match-desc' });
                hint.textContent = 'Add ≥ 2 subjects to define a trajectory sequence.';
                newSec.appendChild(hint);
            }

            container.appendChild(newSec);
            container.appendChild(_el('div', { className: 'sph-divider' }));
        }

        // ── Playback ──────────────────────────────────────────────────────────
        const playSec = _el('div', { className: 'sph-section' });
        const playHdr = _el('div', { className: 'sph-label' });
        playHdr.textContent = 'Playback';
        playSec.appendChild(playHdr);

        if (!projectRoot && !player?.isLoaded) {
            const demoBtn = _el('button', { className: 'load-btn' });
            demoBtn.textContent = 'Load demo trajectory';
            demoBtn.onclick = () => _loadTrajectoryDemo();
            playSec.appendChild(demoBtn);
        }

        if (player?.isLoaded) {
            const info = _el('div', { className: 'traj-info' });
            info.textContent = `${player.frameCount} frames`;
            if (loadedTrajDir) {
                const traj = existingTrajectories.find(t => t.dir === loadedTrajDir);
                if (traj) info.textContent += ` · ${traj.name}`;
            }
            playSec.appendChild(info);

            // Play/pause + scrubber row
            const ctrlRow = _el('div', { className: 'traj-ctrl-row' });

            const playBtn = _el('button', { className: 'traj-play-rp', id: 'rp-traj-play' });
            playBtn.textContent = player.isPlaying ? '⏸' : '▶';
            playBtn.title = 'Play / Pause';
            playBtn.setAttribute('aria-label', 'Play / Pause trajectory');
            playBtn.onclick = () => {
                if (player.isPlaying) { player.pause(); playBtn.textContent = '▶'; }
                else                   { player.play();  playBtn.textContent = '⏸'; }
            };
            ctrlRow.appendChild(playBtn);

            const scrubber = _el('input');
            scrubber.type = 'range'; scrubber.id = 'rp-traj-scrubber';
            scrubber.className = 'traj-scrub-rp';
            scrubber.min = '0'; scrubber.max = '1000'; scrubber.step = '1';
            scrubber.value = String(Math.round(player.t * 1000));
            scrubber.setAttribute('aria-label', 'Trajectory position');
            scrubber.oninput = () => {
                const t = parseInt(scrubber.value) / 1000;
                document.getElementById('rp-traj-time').textContent = t.toFixed(2);
                player.seek(t);
            };
            ctrlRow.appendChild(scrubber);

            const timeEl = _el('span', { className: 'traj-time-rp', id: 'rp-traj-time' });
            timeEl.textContent = player.t.toFixed(2);
            ctrlRow.appendChild(timeEl);
            playSec.appendChild(ctrlRow);

            const speedRow = _el('div', { className: 'traj-row' });
            speedRow.innerHTML = '<label>Speed</label>';
            const speedInput = _el('input');
            speedInput.type = 'range'; speedInput.min = '1'; speedInput.max = '12';
            speedInput.step = '0.5';
            // player.speed is one-direction duration (seconds); invert so slider right = faster
            speedInput.value = String(13 - player.speed);
            speedInput.className = 'traj-speed';
            speedInput.oninput = () => { player.speed = 13 - parseFloat(speedInput.value); };
            speedRow.appendChild(speedInput);
            playSec.appendChild(speedRow);

            const ppRow = _el('div', { className: 'traj-row' });
            const ppLabel = _el('label', { className: 'traj-pp-label' });
            const ppCheck = _el('input');
            ppCheck.type = 'checkbox'; ppCheck.id = 'rp-traj-pingpong';
            ppCheck.checked = player.pingPong;
            ppCheck.setAttribute('aria-label', 'Forth and back playback');
            ppCheck.onchange = () => { player.pingPong = ppCheck.checked; };
            ppLabel.appendChild(ppCheck);
            ppLabel.append(' Forth & back');
            ppRow.appendChild(ppLabel);
            playSec.appendChild(ppRow);
        } else {
            const hint = _el('div', { className: 'match-desc' });
            hint.textContent = 'No trajectory loaded.';
            playSec.appendChild(hint);
        }

        container.appendChild(playSec);
    }

    async function _loadTrajectoryFromDisk(traj) {
        _setStatus(`Loading trajectory ${traj.name}…`);
        try {
            const trajPath = traj.dir + '/trajectory';
            const files = await apiGet('/api/files', { dir: trajPath });
            const urls = files
                .filter(f => f.name.endsWith('.ply'))
                .sort((a, b) => parseInt(a.name) - parseInt(b.name))
                .map(f => meshUrl(f.path));
            if (!urls.length) throw new Error('No PLY frames found in trajectory/');
            if (!player) {
                player = new TrajectoryPlayer(viewer);
                player.onSeek(t => _updateScrubber(t));
                window._player = player;
            }
            await player.load(urls);
            loadedTrajDir = traj.dir;
            // Populate the builder form from saved params so user can recompute
            if (traj.params) {
                const p = traj.params;
                if (Array.isArray(p.seq) && p.seq.length >= 2) trajSeq = [...p.seq];
                if (p.mode === 'raw' || p.mode === 'smooth') trajMode = p.mode;
                if (p.n_deformation_smooth != null) trajNDeformSmooth = p.n_deformation_smooth;
                if (p.do_icp != null)               trajDoIcp         = !!p.do_icp;
                if (p.n_trajectory_smooth != null)  trajNTrajSmooth   = p.n_trajectory_smooth;
                if (p.n_spatial_smooth != null)     trajNSpatialSmooth = p.n_spatial_smooth;
                if (p.lambda_spatial != null)       trajLambdaSpatial  = p.lambda_spatial;
            }
            _setStatus(`Trajectory loaded — ${player.frameCount} frames`);
            _showTrajectoryBar(true);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Trajectory load error: ${e.message}`);
        }
    }

    async function _runTrajectory() {
        if (!projectRoot || trajSeq.length < 2) return;
        const suffix    = trajMode === 'smooth' ? '_smooth' : '';
        const traj_name = trajSeq.join('-') + suffix;
        _setStatus('Submitting trajectory job…');
        try {
            const { job_id, out_dir } = await startTrajectory({
                project_root:        projectRoot,
                seq:                 trajSeq,
                traj_name,
                mode:                trajMode,
                n_deformation_smooth: trajNDeformSmooth,
                do_icp:              trajDoIcp,
                n_trajectory_smooth: trajNTrajSmooth,
                n_spatial_smooth:    trajNSpatialSmooth,
                lambda_spatial:      trajLambdaSpatial,
            });
            await pollJob(job_id, { onProgress: p => _setStatus(`Trajectory: ${Math.round(p * 100)}%`) });
            _setStatus('Trajectory done — loading…');
            await _loadExistingTrajectories();
            const traj = existingTrajectories.find(t => t.dir === out_dir);
            if (traj) await _loadTrajectoryFromDisk(traj);
            else renderStep(currentStep);
        } catch (e) {
            _setStatus(`Trajectory error: ${e.message}`);
            renderStep(currentStep);
        }
    }

    function _confirmDeleteTrajectory(traj, rowEl, secEl) {
        const existing = rowEl.querySelector('.remove-confirm');
        if (existing) { existing.remove(); return; }

        const confirmEl = _el('div', { className: 'remove-confirm' });
        confirmEl.textContent = `Delete ${traj.name}? `;

        const yesBtn = _el('button', { className: 'remove-confirm-yes' });
        yesBtn.textContent = 'Delete';
        yesBtn.onclick = async e => {
            e.stopPropagation();
            try { await deleteTrajectory(traj.dir); } catch { /* still remove row */ }
            rowEl.remove();
            existingTrajectories = existingTrajectories.filter(t => t.dir !== traj.dir);
            if (loadedTrajDir === traj.dir) {
                player?.dispose(); player = null; loadedTrajDir = null;
                _renderTrajectoryPanel(document.getElementById('rpanel-content'));
            }
            if (secEl.querySelectorAll('.match-roster-row').length === 0) {
                secEl.remove();
            }
            _setStatus(`Deleted ${traj.name}`);
        };
        confirmEl.appendChild(yesBtn);

        const noBtn = _el('button', { className: 'remove-confirm-no' });
        noBtn.textContent = 'Cancel';
        noBtn.onclick = e => { e.stopPropagation(); confirmEl.remove(); };
        confirmEl.appendChild(noBtn);

        rowEl.appendChild(confirmEl);
    }

    async function _loadTrajectoryDemo() {
        _setStatus('Loading trajectory demo…');
        const urls = TRAJ_DEMO_RELS.map(rel => meshUrl(dataRoot + '/' + rel));
        try {
            if (!player) {
                player = new TrajectoryPlayer(viewer);
                player.onSeek(t => _updateScrubber(t));
            }
            window._player = player;
            await player.load(urls);
            loadedTrajDir = null;
            _setStatus(`Trajectory loaded — ${player.frameCount} frames`);
            _showTrajectoryBar(true);
            _renderTrajectoryPanel(document.getElementById('rpanel-content'));
        } catch (e) {
            _setStatus(`Trajectory error: ${e.message}`);
        }
    }

    // ── Trajectory helpers ───────────────────────────────────────────────────
    function _showTrajectoryBar(_show) { /* scrubber now lives in the right panel */ }

    function _updateScrubber(t) {
        const scrubber = document.getElementById('rp-traj-scrubber');
        if (scrubber) scrubber.value = Math.round(t * 1000);
        const timeEl = document.getElementById('rp-traj-time');
        if (timeEl) timeEl.textContent = t.toFixed(2);
        const playBtn = document.getElementById('rp-traj-play');
        if (playBtn && player) playBtn.textContent = player.isPlaying ? '⏸' : '▶';
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function _el(tag, props = {}) {
        return Object.assign(document.createElement(tag), props);
    }

    function _setStatus(msg) {
        document.getElementById('status-msg').textContent = msg;
    }

    // ── Debug helpers ────────────────────────────────────────────────────────
    function _showLandmark(name, id, src, srcLabel) {
        if (!src) { console.log(`[showLandmark] ${id} — no data (${srcLabel} is null)`); return; }
        const reg = src.find(r => r.name === name);
        if (!reg) { console.log(`[showLandmark] "${name}" not found in ${id}/${srcLabel} — regions: ${src.map(r=>r.name).join(', ')}`); return; }
        console.log(`[showLandmark] "${name}" id=${id} src=${srcLabel} — ${reg.path0.length} points:`);
        reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
        return reg.path0;
    }

    window.showAlignIHF = (name='IHF', id) => {
        const targetId = id ?? alignSubjectId;
        if (targetId === alignSubjectId && alignOverlay) {
            alignOverlay._saveRef();
            const reg = alignOverlay.regions.find(r => r.name === name);
            if (!reg) { console.log(`[showAlignIHF] "${name}" not found — regions: ${alignOverlay.regions.map(r=>r.name).join(', ')}`); return; }
            console.log(`[showAlignIHF] "${name}" subject=${alignSubjectId} src=LIVE — ${reg.path0.length} points:`);
            reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
            return reg.path0;
        }
        return _showLandmark(name, targetId, alignInMemory[targetId], `alignInMemory[${targetId}]`);
    };

    window.showMatchIHF = (name='IHF', id) => {
        const targetId = id ?? matchRefId;
        return _showLandmark(name, targetId, alignInMemory[targetId], `alignInMemory[${targetId}]`);
    };

    // ── Public API ───────────────────────────────────────────────────────────
    return { init, goStep, loadMeshByPath };
})();

window.addEventListener('DOMContentLoaded', () => app.init());
