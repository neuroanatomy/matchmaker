import { Viewer3D } from './components/viewer3d.js';
import { FileBrowser } from './components/filebrowser.js';
import { TrajectoryPlayer } from './components/trajectory.js';
import { StereographicOverlay } from './components/stereographic.js';
import { StereoView } from './components/stereoview.js';

import { meshUrl, checkHealth, getConfig, apiGet, apiPost, apiPut, pollJob } from './api.js';
import { resampleMesh, parseRotMat, rotateVertsVR } from './components/morph.js';

window.app = (() => {
    let viewer = null;
    let player = null;
    let dataRoot = '';     // absolute path to MATCHMAKER_ROOT
    let activeSlot = 'ref';  // 'ref' | 'mov'
    let loadedRef = null;
    let loadedMov = null;
    let sphereRef = null;   // path to ref sphere PLY (set after spherize)
    let sphereMov = null;   // path to mov sphere PLY
    let sulcRef   = null;   // path to ref sulc.txt.gz
    let sulcMov   = null;   // path to mov sulc.txt.gz
    let curvRef   = null;   // path to ref curv.txt.gz
    let curvMov   = null;   // path to mov curv.txt.gz
    let sulciRef  = null;   // path to ref sulci.json (landmark curves)
    let sulciMov  = null;   // path to mov sulci.json
    let rotRef    = null;   // path to ref rotation.txt
    let rotMov    = null;   // path to mov rotation.txt

    // ── Match step state ─────────────────────────────────────────────────────
    let matchOutDir      = null;  // auto-derived or user-edited output directory
    let morphResult      = null;  // {morph_sphere_path} set after morph completes
    let matchResult      = null;  // {matched_ply, matched_sphere} set after match
    let matchK           = 100;
    let matchNsteps      = 1;
    let matchWSmooth     = 1.0;
    let matchWDeform     = 10.0;
    let matchWProject    = 1.0;
    let matchViewMode    = 'morph'; // 'morph' | 'match'
    let matchViewOpacity = 0.6;
    let morphSphereData  = null;   // {vertices, faces} from sbnMorph (in-memory)
    let morphSurface     = null;   // {refVerts, morphVerts, faces} after retopology
    let matchSurface     = null;   // {refVerts, matchVerts, faces} after match retopology
    let morphInterpT     = 0;      // blend slider value 0=ref, 1=mov

    // ── Align step state ──────────────────────────────────────────────────────
    let alignStereoView = null; // StereoView instance (WebGL flat disc)
    let alignOverlay    = null; // StereographicOverlay instance

    let alignSlot             = 'ref'; // which slot is currently shown in align
    let alignViewMode         = 'flat'; // 'flat' | '3d'
    let alignWireframe        = false;
    let alignHas3DOrientation = false; // true after first 3D load; orbit is then preserved on re-entry
    let alignInMemoryRef      = null;  // unsaved overlay JSON for ref (survives slot switches)
    let alignInMemoryMov      = null;  // unsaved overlay JSON for mov

    // ── Display state (independent of file existence) ─────────────────────────
    // meshType: null | 'native' | 'sphere'
    // texType:  null | 'sulc' | 'curv'
    const viewState = {
        ref: { meshType: null, texType: null },
        mov: { meshType: null, texType: null },
    };
    let viewedSlot  = null;  // 'ref' | 'mov' — whose mesh is in the viewer
    let currentStep = 1;     // tracks active step so re-renders go to the right panel

    // ── Quick-load datasets ──────────────────────────────────────────────────
    const DATASETS = [
        { label: 'F02_P0', rel: 'data/external/F02_P0/seg-pial-t2/e2.ply' },
        { label: 'F06_P4', rel: 'data/external/F06_P4/seg-pial-t2/e2.ply' },
        { label: 'F10_P8', rel: 'data/external/F10_P8/seg-pial-t2/e2.ply' },
    ];

    const TRAJ_DEMO_RELS = [0, 2, 4, 6, 8].map(n => `trajectoryviewer/${n}.ply`);

    // ── Init ─────────────────────────────────────────────────────────────────
    async function init() {
        viewer = new Viewer3D(document.getElementById('viewer-container'));
        window._viewer = viewer; // for E2E pixel sampling

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
        // Leaving step 3: save overlay state then tear down
        if (prev === 3 && n !== 3) {
            if (alignOverlay) {
                // Persist edits so _runMorph and re-entry to step 3 can use them
                if (alignSlot === 'ref') alignInMemoryRef = alignOverlay.toJSON();
                else                     alignInMemoryMov = alignOverlay.toJSON();
                alignOverlay.destroy();
                alignOverlay = null;
            }
            if (alignStereoView) { alignStereoView.destroy(); alignStereoView = null; }
            if (alignViewMode === '3d') viewer.clearAll();
            alignViewMode         = 'flat';
            alignWireframe        = false;
            alignHas3DOrientation = false;
        }
        // Leaving step 4: clear match overlay from viewer
        if (prev === 4 && n !== 4) {
            viewer.clearAll();
        }
        currentStep = n;
        _activateStep(n);
        renderStep(n);
        // Entering step 4: populate viewer
        if (n === 4 && prev !== 4) {
            _refreshMatchViewer();
        }
        // Returning to step 1 or 2 after step 4: restore last single-mesh view
        if (prev === 4 && (n === 1 || n === 2) && viewedSlot && viewState[viewedSlot].meshType) {
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

        // Hide trajectory statusbar row unless on step 5
        _showTrajectoryBar(n === 5 && player?.isLoaded);

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
            _renderMatchPanel(rpanel);
        } else if (n === 5) {
            h2.textContent = 'Trajectory';
            _renderTrajectoryPanel(rpanel);
        } else {
            const labels = ['', 'Load', 'Preprocess', 'Align', 'Match', 'View'];
            h2.textContent = labels[n] || `Step ${n}`;
            rpanel.innerHTML = `<p class="coming-soon">Coming in a future phase.</p>`;
        }
    }

    // ── Step 1 — Load meshes ─────────────────────────────────────────────────
    function _renderLoadPanel(container) {
        container.innerHTML = '';

        // Tab row
        const tabs = _el('div', { className: 'slot-tabs' });
        ['ref', 'mov'].forEach(slot => {
            const btn = _el('button', { className: `slot-tab${slot === activeSlot ? ' active' : ''}` });
            btn.textContent = slot === 'ref' ? 'Ref (surface)' : 'Mov (moving)';
            btn.onclick = async () => {
                activeSlot = slot;
                const slotLoaded = slot === 'ref' ? loadedRef : loadedMov;
                if (slotLoaded && viewedSlot !== slot) {
                    viewedSlot = slot;
                    if (!viewState[slot].meshType) viewState[slot].meshType = 'native';
                    await _refreshViewer({ preserveOrientation: true });
                }
                _renderLoadPanel(container);
            };
            tabs.appendChild(btn);
        });
        container.appendChild(tabs);

        // Status line
        const loaded = activeSlot === 'ref' ? loadedRef : loadedMov;
        const statusEl = _el('div', { className: 'slot-status' });
        statusEl.textContent = loaded
            ? `✓ ${loaded.split('/').pop()}`
            : `No ${activeSlot} loaded`;
        container.appendChild(statusEl);

        // ── View controls: mesh selector + texture toggles ────────────────────
        if (loaded) {
            const slot   = activeSlot;
            const vs     = viewState[slot];
            const isView = viewedSlot === slot;
            const sphere = slot === 'ref' ? sphereRef : sphereMov;
            const sulc   = slot === 'ref' ? sulcRef   : sulcMov;
            const curv   = slot === 'ref' ? curvRef   : curvMov;

            const viewSec = _el('div', { className: 'view-section' });

            // Mesh options (radio)
            const nativeEl = _el('div', { className: 'sph-item sph-clickable' });
            const nativeOn = isView && vs.meshType === 'native';
            nativeEl.classList.toggle('sph-item-active', nativeOn);
            nativeEl.textContent = (nativeOn ? '▶ ' : '  ') + loaded.split('/').pop();
            nativeEl.onclick = () => _viewMesh(slot, 'native');
            viewSec.appendChild(nativeEl);

            if (sphere) {
                const sphereEl = _el('div', { className: 'sph-item sph-clickable' });
                const sphereOn = isView && vs.meshType === 'sphere';
                sphereEl.classList.toggle('sph-item-active', sphereOn);
                sphereEl.textContent = (sphereOn ? '▶ ' : '  ') + sphere.split('/').pop();
                sphereEl.onclick = () => _viewMesh(slot, 'sphere');
                viewSec.appendChild(sphereEl);
            }

            // Texture options (checkbox, mutually exclusive)
            if (sulc || curv) {
                viewSec.appendChild(_el('div', { className: 'sph-divider' }));
                if (sulc) {
                    const el = _el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'sulc';
                    el.classList.toggle('sph-tex-active', on);
                    el.textContent = (on ? '☑ ' : '☐ ') + 'sulcal depth';
                    el.onclick = () => _toggleTexture(slot, 'sulc');
                    viewSec.appendChild(el);
                }
                if (curv) {
                    const el = _el('div', { className: 'sph-item sph-clickable' });
                    const on = vs.texType === 'curv';
                    el.classList.toggle('sph-tex-active', on);
                    el.textContent = (on ? '☑ ' : '☐ ') + 'curvature';
                    el.onclick = () => _toggleTexture(slot, 'curv');
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
            btn.onclick = () => _loadSlot(dataRoot + '/' + ds.rel);
            pills.appendChild(btn);
        });
        container.appendChild(pills);

        const sep = _el('div', { className: 'sep-label' });
        sep.textContent = '— or browse —';
        container.appendChild(sep);

        // File browser
        const fbContainer = _el('div', { className: 'fb-container' });
        container.appendChild(fbContainer);

        const fb = new FileBrowser(fbContainer, {
            filter: name => name.endsWith('.ply') || name.endsWith('.ply.gz'),
            onSelect: path => {
                loadBtn.disabled = false;
                loadBtn.dataset.path = path;
            },
        });
        fb.navigate(dataRoot || null);

        // Load button
        const loadBtn = _el('button', { className: 'load-btn' });
        loadBtn.textContent = `Load as ${activeSlot.toUpperCase()}`;
        loadBtn.disabled = true;
        loadBtn.onclick = () => _loadSlot(loadBtn.dataset.path);
        container.appendChild(loadBtn);
    }

    async function _loadSlot(absPath) {
        if (!absPath) return;
        const slot = activeSlot;
        const name = absPath.split('/').pop();
        _setStatus(`Loading ${name}…`);
        try {
            // Clear stale companion state for this slot
            if (slot === 'ref') { loadedRef = null; sphereRef = null; sulcRef = null; curvRef = null; sulciRef = null; rotRef = null; viewState.ref = { meshType: null, texType: null }; alignInMemoryRef = null; }
            else                { loadedMov = null; sphereMov = null; sulcMov = null; curvMov = null; sulciMov = null; rotMov = null; viewState.mov = { meshType: null, texType: null }; alignInMemoryMov = null; }
            matchOutDir = null; morphResult = null; matchResult = null; morphSphereData = null; matchViewMode = 'morph'; morphSurface = null; matchSurface = null; morphInterpT = 0;
            if (viewedSlot === slot) viewedSlot = null;

            if (slot === 'ref') loadedRef = absPath;
            else                loadedMov = absPath;

            // Auto-discover pre-existing companion files
            const companions = await apiGet('/api/companions', { path: absPath }).catch(() => null);
            if (companions) {
                if (slot === 'ref') {
                    if (companions.sphere)       sphereRef = companions.sphere;
                    if (companions.sulc)         sulcRef   = companions.sulc;
                    if (companions.curv)         curvRef   = companions.curv;
                    if (companions.sulci_json)   sulciRef  = companions.sulci_json;
                    if (companions.rotation_txt) rotRef    = companions.rotation_txt;
                } else {
                    if (companions.sphere)       sphereMov = companions.sphere;
                    if (companions.sulc)         sulcMov   = companions.sulc;
                    if (companions.curv)         curvMov   = companions.curv;
                    if (companions.sulci_json)   sulciMov  = companions.sulci_json;
                    if (companions.rotation_txt) rotMov    = companions.rotation_txt;
                }
            }

            // Show the native mesh immediately — camera resets (fresh load)
            viewState[slot].meshType = 'native';
            viewedSlot = slot;
            await _refreshViewer();

            const found = [companions?.sphere && 'sphere', companions?.sulc && 'sulcal depth', companions?.curv && 'curvature']
                .filter(Boolean);
            const hint = found.length ? ` — ${found.join(', ')} available` : '';
            _setStatus(`${slot.toUpperCase()} loaded: ${name}${hint}`);
            _renderLoadPanel(document.getElementById('rpanel-content'));
        } catch (e) {
            _setStatus(`Error: ${e.message}`);
        }
    }

    // ── Public shortcut used by E2E tests ────────────────────────────────────
    async function loadMeshByPath(absPath) {
        activeSlot = 'ref';
        await _loadSlot(absPath);
    }

    // ── Step 2 — Preprocess ──────────────────────────────────────────────────
    function _renderPreprocessPanel(container) {
        container.innerHTML = '';

        const rows = [
            { label: 'Ref', path: loadedRef, sphere: sphereRef, curv: curvRef, sulc: sulcRef, slot: 'ref' },
            { label: 'Mov', path: loadedMov, sphere: sphereMov, curv: curvMov, sulc: sulcMov, slot: 'mov' },
        ];

        rows.forEach(({ label, path, sphere, curv, sulc, slot }) => {
            const section = _el('div', { className: 'sph-section' });

            // Header: label + filename
            const hdr = _el('div', { className: 'pre-header' });
            const lbl = _el('span', { className: 'sph-label' });
            lbl.textContent = label;
            hdr.appendChild(lbl);
            const fname = _el('span', { className: 'pre-filename' });
            fname.textContent = path ? '  ' + path.split('/').pop() : '  — not loaded —';
            hdr.appendChild(fname);
            section.appendChild(hdr);

            // Checklist
            section.appendChild(_preItem('Sphere',       !!sphere));
            section.appendChild(_preItem('Curvature',    !!curv));
            section.appendChild(_preItem('Sulcal depth', !!sulc));

            // Action buttons (only for what's missing)
            if (path) {
                if (!sphere) {
                    const bar = _el('div', { className: 'progress-bar-wrap' });
                    const fill = _el('div', { className: 'progress-bar' });
                    bar.appendChild(fill); bar.style.display = 'none';
                    section.appendChild(bar);
                    const btn = _el('button', { className: 'load-btn' });
                    btn.textContent = `Spherize ${label}`;
                    btn.onclick = () => _spherize(slot, path, fill, btn);
                    section.appendChild(btn);
                }
                if (!curv || !sulc) {
                    const bar = _el('div', { className: 'progress-bar-wrap' });
                    const fill = _el('div', { className: 'progress-bar' });
                    bar.appendChild(fill); bar.style.display = 'none';
                    section.appendChild(bar);
                    const btn = _el('button', { className: 'load-btn' });
                    btn.textContent = 'Compute maps';
                    btn.onclick = () => _computeCurvature(slot, path, fill, btn);
                    section.appendChild(btn);
                }
            }

            container.appendChild(section);
            container.appendChild(_el('div', { className: 'sph-divider' }));
        });
    }

    function _preItem(label, done) {
        const el = _el('div', { className: `pre-check ${done ? 'pre-done' : 'pre-missing'}` });
        el.textContent = (done ? '✓ ' : '✗ ') + label;
        return el;
    }

    async function _viewMesh(slot, meshType) {
        if (viewedSlot === slot && viewState[slot].meshType === meshType) return;
        viewedSlot = slot;
        viewState[slot].meshType = meshType;
        await _refreshViewer();
        renderStep(currentStep);
    }

    async function _toggleTexture(slot, texType) {
        viewState[slot].texType = viewState[slot].texType === texType ? null : texType;
        if (viewedSlot === slot) await _refreshViewer({ preserveOrientation: true });
        renderStep(currentStep);
    }

    async function _refreshViewer({ preserveOrientation = false } = {}) {
        if (!viewedSlot || !viewState[viewedSlot].meshType) return;
        const slot = viewedSlot;
        const meshPath = viewState[slot].meshType === 'sphere'
            ? (slot === 'ref' ? sphereRef : sphereMov)
            : (slot === 'ref' ? loadedRef : loadedMov);
        if (!meshPath) return;

        const texType = viewState[slot].texType;
        if (texType === 'sulc' || texType === 'curv') {
            const scalarPath = texType === 'sulc'
                ? (slot === 'ref' ? sulcRef : sulcMov)
                : (slot === 'ref' ? curvRef : curvMov);
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

    async function _spherize(slot, path, fillEl, btn) {
        btn.disabled = true;
        fillEl.parentElement.style.display = 'block';
        _setStatus(`Spherizing ${path.split('/').pop()}…`);
        try {
            const { job_id } = await apiPost('/api/spherize', { path });
            const result = await pollJob(job_id, {
                onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
            });
            if (slot === 'ref') sphereRef = result.sphere_path;
            else               sphereMov = result.sphere_path;
            _setStatus(`Sphere ready: ${result.sphere_path.split('/').pop()}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Spherize error: ${e.message}`);
            btn.disabled = false;
        }
    }

    async function _computeCurvature(slot, path, fillEl, btn) {
        btn.disabled = true;
        fillEl.parentElement.style.display = 'block';
        _setStatus(`Computing maps for ${path.split('/').pop()}…`);
        try {
            const { job_id } = await apiPost('/api/curvature', { path });
            const result = await pollJob(job_id, {
                onProgress: p => { fillEl.style.width = `${Math.round(p * 100)}%`; },
            });
            if (slot === 'ref') { curvRef = result.curv_path; sulcRef = result.sulc_path; }
            else                { curvMov = result.curv_path; sulcMov = result.sulc_path; }
            _setStatus(`Maps ready: ${result.sulc_path.split('/').pop()}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Maps error: ${e.message}`);
            btn.disabled = false;
        }
    }

    // ── Step 3 — Align (stereographic landmark drawing) ─────────────────────

    async function _activateAlign(slot) {
        const prevSlot = alignSlot;   // capture before updating
        alignSlot             = slot;
        alignHas3DOrientation = false; // new slot → fresh 3D camera on first entry
        if (currentStep !== 3) return;

        // No-op if this slot is already fully set up
        if (slot === prevSlot && alignOverlay && alignStereoView) return;

        // Save current overlay state before destroying — preserves unsaved edits
        if (alignOverlay) {
            if (prevSlot === 'ref') alignInMemoryRef = alignOverlay.toJSON();
            else                    alignInMemoryMov = alignOverlay.toJSON();
            alignOverlay.destroy();
            alignOverlay = null;
        }
        if (alignStereoView) { alignStereoView.destroy(); alignStereoView = null; }

        const sphere = slot === 'ref' ? sphereRef : sphereMov;
        const sulc   = slot === 'ref' ? sulcRef   : sulcMov;

        if (!sphere) {
            _setStatus(`No sphere for ${slot.toUpperCase()} — run Preprocess first`);
            renderStep(currentStep);
            return;
        }

        const rotPath = slot === 'ref' ? rotRef : rotMov;
        let initR = null;  // 3×3 rotation matrix for StereoView (R = R_cam^T)
        if (rotPath) {
            const resp = await apiGet('/api/file', { path: rotPath }).catch(() => null);
            if (resp?.content) {
                try {
                    const R9 = parseRotMat(resp.content);   // flat row-major R_cam
                    initR = [                                // StereoView uses R_cam^T
                        [R9[0], R9[3], R9[6]],
                        [R9[1], R9[4], R9[7]],
                        [R9[2], R9[5], R9[8]],
                    ];
                } catch { /* malformed rotation.txt */ }
            }
        }
        if (currentStep !== 3) return;

        _setStatus(`Loading sphere…`);
        try {
            const scalars = sulc ? await apiGet('/api/scalar', { path: sulc }) : null;
            if (currentStep !== 3) return;

            // Create WebGL stereo view (replaces Three.js loadMeshStereo)
            const container = document.getElementById('viewer-container');
            alignStereoView = new StereoView(container);
            window._alignStereoView = alignStereoView; // exposed for E2E tests
            await alignStereoView.load(sphere, scalars, initR);
            if (currentStep !== 3) { alignStereoView.destroy(); alignStereoView = null; return; }

            // Keep rotation sliders in sync when user drags the disc
            alignStereoView.onRotationChange(() => {
                const { alpha, beta, gamma } = alignStereoView.getEulerZYX();
                const update = (id, val) => {
                    const el = document.getElementById(id);
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

            // Paper.js landmark overlay on top of StereoView canvas
            alignOverlay = new StereographicOverlay(container, alignStereoView);

            // Keep alignInMemoryRef/Mov always fresh after every edit gesture
            alignOverlay.onChange = () => {
                if (alignSlot === 'ref') alignInMemoryRef = alignOverlay.toJSON();
                else                     alignInMemoryMov = alignOverlay.toJSON();
            };

            // Restore from in-memory state (unsaved edits) if available,
            // otherwise fall back to the last saved sulci.json on disk.
            const inMem     = slot === 'ref' ? alignInMemoryRef : alignInMemoryMov;
            const sulciPath = slot === 'ref' ? sulciRef : sulciMov;
            if (inMem) {
                alignOverlay.fromJSON(inMem);
                _setStatus(`Stereo view ready — ${alignOverlay.regions.length} landmarks restored`);
            } else if (sulciPath) {
                try {
                    const data = await apiGet('/api/file', { path: sulciPath });
                    alignOverlay.fromJSON(data);
                    _setStatus(`Loaded ${sulciPath.split('/').pop()} — ${alignOverlay.regions.length} landmarks`);
                } catch { /* no prior sulci.json — start fresh */ }
            }

            if (!inMem && !sulciPath) _setStatus(`Stereo view ready — draw landmarks`);
        } catch (e) {
            _setStatus(`Align error: ${e.message}`);
            return;
        }

        if (currentStep !== 3) return;

        // Re-render the panel controls after async setup is complete
        if (currentStep === 3) renderStep(currentStep);
    }

    async function _switchViewMode(mode) {
        if (alignViewMode === mode || !alignOverlay) return;
        alignViewMode = mode;
        renderStep(currentStep);
        if (mode === '3d') {
            alignStereoView._canvas.style.display = 'none';
            alignOverlay._canvas.style.display    = 'none';
            const native = alignSlot === 'ref' ? loadedRef : loadedMov;
            const sulc   = alignSlot === 'ref' ? sulcRef   : sulcMov;
            const curv   = alignSlot === 'ref' ? curvRef   : curvMov;
            const scalar = sulc || curv;
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
                // Project landmarks from sphere space onto the native mesh surface
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

        // Slot tabs
        const tabs = _el('div', { className: 'slot-tabs' });
        ['ref', 'mov'].forEach(slot => {
            const btn = _el('button', { className: `slot-tab${slot === alignSlot ? ' active' : ''}` });
            btn.textContent = slot === 'ref' ? 'Ref' : 'Mov';
            btn.onclick = () => _activateAlign(slot);
            tabs.appendChild(btn);
        });
        container.appendChild(tabs);

        const sphere = alignSlot === 'ref' ? sphereRef : sphereMov;

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
        // Rotate mode (separate, toggles pointer-events)
        const rotBtn = _el('button', {
            className: `tool-btn rotate${currentTool === 'rotate' ? ' active' : ''}`,
        });
        rotBtn.textContent = '↻';
        rotBtn.title    = editDisabled ? 'Not available in 3D mode' : 'Rotate sphere (hold to orbit, then switch back to draw)';
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

        // ── View mode row (Flat / 3D / Wireframe) ────────────────────────────
        const viewRow = _el('div', { className: 'view-row' });
        viewRow.setAttribute('role', 'group');
        viewRow.setAttribute('aria-label', 'View controls');

        const viewLabel = _el('span', { className: 'view-row-label' });
        viewLabel.textContent = 'VIEW';
        viewRow.appendChild(viewLabel);

        const flatBtn = _el('button', { className: `view-btn${alignViewMode === 'flat' ? ' active' : ''}` });
        flatBtn.textContent = 'Flat';
        flatBtn.title = 'Flat disc — stereographic projection (default, for drawing)';
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
        wireBtn.title = 'Toggle wireframe — see landmarks behind mesh folds';
        wireBtn.setAttribute('aria-pressed', String(alignWireframe));
        wireBtn.setAttribute('aria-label', 'Wireframe rendering');
        if (!alignOverlay) { wireBtn.disabled = true; wireBtn.tabIndex = -1; }
        wireBtn.onclick = () => _toggleWireframe();
        viewRow.appendChild(wireBtn);

        container.appendChild(viewRow);

        // ── Rotation sliders (Flat mode only) ────────────────────────────────
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
                    valSpan.setAttribute('aria-valuenow', slider.value);  // keep span in sync
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

        // Load / Save sulci.json
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

        // If overlay not yet activated (first render of step 3), activate now
        if (!alignOverlay && sphere) {
            setTimeout(() => _activateAlign(alignSlot), 0);
        }
    }

    async function _loadSulciJSON() {
        if (!alignOverlay) return;
        const sulciPath = alignSlot === 'ref' ? sulciRef : sulciMov;
        if (!sulciPath) {
            _setStatus('No sulci.json found alongside the sphere file');
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
        if (!alignOverlay) return;
        const sphere = alignSlot === 'ref' ? sphereRef : sphereMov;
        if (!sphere) return;
        const dir = sphere.substring(0, sphere.lastIndexOf('/'));
        const savePath = `${dir}/sulci.json`;
        try {
            const json = alignOverlay.toJSON();
            await apiPut('/api/file', { path: savePath, content: JSON.stringify(json, null, 2) });
            if (alignSlot === 'ref') sulciRef = savePath;
            else                     sulciMov = savePath;
            _setStatus(`Saved ${savePath.split('/').pop()}`);
        } catch (e) {
            _setStatus(`Save sulci error: ${e.message}`);
        }
    }

    async function _saveRotationTxt() {
        if (!alignOverlay) return;
        const sphere = alignSlot === 'ref' ? sphereRef : sphereMov;
        if (!sphere) return;
        const dir = sphere.substring(0, sphere.lastIndexOf('/'));
        const savePath = `${dir}/rotation.txt`;
        try {
            const txt = alignOverlay.getCameraRotationText();
            await apiPut('/api/file', { path: savePath, content: txt });
            if (alignSlot === 'ref') rotRef = savePath;
            else                     rotMov = savePath;
            _setStatus(`Saved ${savePath.split('/').pop()}`);
        } catch (e) {
            _setStatus(`Save rotation error: ${e.message}`);
        }
    }

    // ── Step 4 — Match ───────────────────────────────────────────────────────

    function _renderMatchPanel(container) {
        container.innerHTML = '';

        // Auto-derive output dir from current state
        if (!matchOutDir && loadedMov && loadedRef) {
            const movDir  = loadedMov.substring(0, loadedMov.lastIndexOf('/'));
            const refStem = loadedRef.split('/').pop().replace(/\.ply$/, '');
            matchOutDir = `${movDir}/match_${refStem}`;
        }

        // ── Inputs checklist ─────────────────────────────────────────────────
        const inputsSection = _el('div', { className: 'sph-section' });
        const inputsHdr = _el('div', { className: 'sph-label' });
        inputsHdr.textContent = 'Inputs';
        inputsSection.appendChild(inputsHdr);

        const refName = loadedRef ? loadedRef.split('/').slice(-2).join('/') : null;
        const movName = loadedMov ? loadedMov.split('/').slice(-2).join('/') : null;
        inputsSection.appendChild(_preItem(refName ? `Ref: ${refName}` : 'Ref: not loaded', !!loadedRef));
        inputsSection.appendChild(_preItem(movName ? `Mov: ${movName}` : 'Mov: not loaded', !!loadedMov));

        const bothSpheres = !!(sphereRef && sphereMov);
        const sphereLabel = !sphereRef && !sphereMov ? 'Spheres: neither computed'
                          : !sphereRef               ? 'Spheres: ref missing'
                          : !sphereMov               ? 'Spheres: mov missing'
                          : 'Spheres computed';
        inputsSection.appendChild(_preItem(sphereLabel, bothSpheres));

        const bothLandmarks = !!(sulciRef && sulciMov);
        const lmkLabel = `Landmarks: ref ${sulciRef ? '✓' : '✗'} · mov ${sulciMov ? '✓' : '✗'}`;
        inputsSection.appendChild(_preItem(lmkLabel, bothLandmarks));

        if (rotRef || rotMov) {
            const bothRot  = !!(rotRef && rotMov);
            const rotLabel = !rotRef ? 'Rotations: ref missing'
                           : !rotMov ? 'Rotations: mov missing'
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
            { id: 'morph',   label: 'Morph',   ok: !!morphSurface,   title: 'Ref → Mov retopology blend' },
            { id: 'match',   label: 'Match',   ok: !!matchResult,    title: 'Matched surface' },
        ];
        VIEW_MODES.forEach(({ id, label, ok, title }) => {
            const b = _el('button', { className: `view-btn${matchViewMode === id ? ' active' : ''}` });
            b.textContent = label;
            b.title       = title;
            b.disabled    = !ok;
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

        // Blend slider — interpolates ref ↔ mov in both morph and match modes
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

        const canMorph = !!(loadedRef && loadedMov && sphereRef && sphereMov && sulciRef && sulciMov);
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

        const backBtn = _el('button', { className: 'load-btn' });
        backBtn.textContent = '← Back to Align';
        backBtn.style.background = 'var(--text-dim, #555)';
        backBtn.setAttribute('aria-label', 'Go back to Align step');
        backBtn.onclick = () => goStep(3);
        morphSection.appendChild(backBtn);
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

        // k eigenvectors slider
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

        // nsteps segmented control
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

        // Advanced accordion (weight sliders)
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

            const continueBtn = _el('button', { className: 'load-btn' });
            continueBtn.textContent = '→ Continue to View';
            continueBtn.style.background = 'var(--accent2)';
            continueBtn.setAttribute('aria-label', 'Continue to trajectory view');
            continueBtn.onclick = () => goStep(5);
            matchSection.appendChild(continueBtn);
        }

        container.appendChild(matchSection);
    }

    async function _refreshMatchViewer({ preserveOrientation = false } = {}) {
        if (!loadedRef) return;

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
        // match mode — blend mesh: ref shape → matched moving brain shape (same as morph mode).
        // matchSurface.matchVerts = surf.0.ply (MOV brain in REF topology from matchmesh2),
        // so both vertex sets share refFaces and the blend is geometrically meaningful.
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
            // Prefer in-memory overlay (unsaved edits), fall back to last saved file on disk
            const sulciMovData = alignInMemoryMov ?? await apiGet('/api/file', { path: sulciMov });
            const sulciRefData = alignInMemoryRef ?? await apiGet('/api/file', { path: sulciRef });
            console.log('[runMorph] mov:', alignInMemoryMov ? `in-memory (${alignInMemoryMov.length} regions)` : `disk (${sulciMov})`);
            console.log('[runMorph] ref:', alignInMemoryRef ? `in-memory (${alignInMemoryRef.length} regions)` : `disk (${sulciRef})`);
            fillEl.style.width = '15%';

            if (!matchOutDir) {
                const movDir  = loadedMov.substring(0, loadedMov.lastIndexOf('/'));
                const refStem = loadedRef.split('/').pop().replace(/\.ply(\.gz)?$/, '');
                matchOutDir = `${movDir}/match_${refStem}`;
            }

            const body = {
                ref_sphere: sphereRef,
                sulci_ref:  sulciRefData,
                sulci_mov:  sulciMovData,
                out_dir:    matchOutDir,
            };
            if (rotRef) body.rot_ref_path = rotRef;
            if (rotMov) body.rot_mov_path = rotMov;

            const { job_id } = await apiPost('/api/morph', body);
            fillEl.style.width = '25%';

            const result = await pollJob(job_id, {
                onProgress: p => { fillEl.style.width = `${Math.round(25 + p * 50)}%`; },
            });
            fillEl.style.width = '75%';

            // Load results for blend display (visualization only — retopology in browser)
            const [morphSphRaw, movSphRaw, movNat, refNat, refSphRaw] = await Promise.all([
                apiGet('/api/mesh_raw', { path: result.morph_sphere_path }),
                apiGet('/api/mesh_raw', { path: sphereMov }),
                apiGet('/api/mesh_raw', { path: loadedMov }),
                apiGet('/api/mesh_raw', { path: loadedRef }),
                apiGet('/api/mesh_raw', { path: sphereRef }),
            ]);

            // Rotate mov sphere into canonical frame for retopology query.
            // Normalise to unit sphere first (matches reference direction() call) — /api/mesh_raw
            // mean-centres but does not normalise, which would shift triangle positions slightly.
            let R_mov = null;
            if (rotMov) {
                const rotMovData = await apiGet('/api/file', { path: rotMov });
                const rotMovTxt = typeof rotMovData === 'string' ? rotMovData : (rotMovData?.content ?? '');
                if (rotMovTxt) R_mov = parseRotMat(rotMovTxt);
            }
            const _unitVec = ([x, y, z]) => { const r = Math.sqrt(x*x+y*y+z*z)||1; return [x/r, y/r, z/r]; };
            const movSphUnit = movSphRaw.vertices.map(_unitVec);
            const movSphForNN = R_mov ? rotateVertsVR(movSphUnit, R_mov) : movSphUnit;
            const remeshed = resampleMesh(
                movSphRaw.faces,         // MOV sphere topology
                movSphForNN,             // MOV sphere in canonical frame
                movNat.vertices,         // MOV native brain
                morphSphRaw.vertices,    // warped REF sphere in canonical frame (from API)
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
            // matchmesh2 naming: "ref" = brain to project onto = UI's mov (F10_P8)
            //                    "mov" = sphere to deform      = UI's ref (F02_P0)
            const body = {
                ref_ply:      loadedMov,    // matchmesh2 "ref" = UI's mov
                ref_sphere:   sphereMov,
                mov_ply:      loadedRef,    // matchmesh2 "mov" = UI's ref
                mov_sphere:   sphereRef,
                morph_sphere: morphResult.morph_sphere_path,
                out_dir:      matchOutDir,
                k:            matchK,
                nsteps:       matchNsteps,
                w_smooth:     matchWSmooth,
                w_deform:     matchWDeform,
                w_project:    matchWProject,
            };
            if (rotMov) body.ref_rot = rotMov;  // rotation for matchmesh2's "ref" (UI's mov)
            if (rotRef) body.mov_rot = rotRef;  // rotation for matchmesh2's "mov" (UI's ref)

            const { job_id } = await apiPost('/api/match', body);
            const result = await pollJob(job_id);
            matchResult   = result;
            matchViewMode = 'match';
            barWrap.style.display = 'none';

            // surf.0.ply = F10_P8 brain already projected onto F02_P0 topology by matchmesh2.
            // Load directly — matchmesh2 handles the retopology in the correct rotated frame.
            const matchedNatRaw = await apiGet('/api/mesh_raw', { path: result.matched_ply });
            const refVerts = morphSurface ? morphSurface.refVerts
                : (await apiGet('/api/mesh_raw', { path: loadedRef })).vertices;
            const refFaces = morphSurface ? morphSurface.faces : matchedNatRaw.faces;
            matchSurface = { refVerts, matchVerts: matchedNatRaw.vertices, faces: refFaces };

            await _refreshMatchViewer({ preserveOrientation: true });
            _setStatus(`Match done — ${result.matched_ply.split('/').pop()}`);
            renderStep(currentStep);
        } catch (e) {
            _setStatus(`Match error: ${e.message}`);
            btn.disabled = false;
            barWrap.style.display = 'none';
        }
    }

    // ── Step 5 — Trajectory player ───────────────────────────────────────────
    function _renderTrajectoryPanel(container) {
        container.innerHTML = '';

        if (!player) {
            player = new TrajectoryPlayer(viewer);
            player.onSeek(t => _updateScrubber(t));
            window._player = player;
        }

        // Demo load button
        const demoBtn = _el('button', { className: 'load-btn' });
        demoBtn.textContent = 'Load demo trajectory';
        demoBtn.onclick = () => _loadTrajectoryDemo();
        container.appendChild(demoBtn);

        if (player.isLoaded) {
            const info = _el('div', { className: 'traj-info' });
            info.textContent = `${player.frameCount} frames loaded`;
            container.appendChild(info);

            // Speed control
            const speedRow = _el('div', { className: 'traj-row' });
            speedRow.innerHTML = '<label>Speed</label>';
            const speedInput = _el('input');
            speedInput.type = 'range';
            speedInput.min = '1';
            speedInput.max = '12';
            speedInput.step = '0.5';
            speedInput.value = '4';
            speedInput.className = 'traj-speed';
            speedInput.oninput = () => {
                player.speed = parseFloat(speedInput.value);
            };
            speedRow.appendChild(speedInput);
            container.appendChild(speedRow);
        }
    }

    async function _loadTrajectoryDemo() {
        _setStatus('Loading trajectory demo…');
        const urls = TRAJ_DEMO_RELS.map(rel => meshUrl(dataRoot + '/' + rel));
        try {
            if (!player) {
                player = new TrajectoryPlayer(viewer);
                player.onSeek(t => _updateScrubber(t));
            }
            window._player = player;  // always expose, even if player pre-existed
            await player.load(urls);
            _setStatus(`Trajectory loaded — ${player.frameCount} frames`);
            _showTrajectoryBar(true);
            // Re-render panel to show controls
            _renderTrajectoryPanel(document.getElementById('rpanel-content'));
        } catch (e) {
            _setStatus(`Trajectory error: ${e.message}`);
        }
    }

    // ── Trajectory status bar ────────────────────────────────────────────────
    function _showTrajectoryBar(show) {
        document.getElementById('traj-bar').style.display = show ? 'flex' : 'none';
        document.getElementById('statusbar').style.display = show ? 'none' : 'flex';
    }

    function _updateScrubber(t) {
        const scrubber = document.getElementById('traj-scrubber');
        if (scrubber) scrubber.value = Math.round(t * 1000);
        const timeEl = document.getElementById('traj-time');
        if (timeEl) timeEl.textContent = t.toFixed(2);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────
    function _el(tag, props = {}) {
        return Object.assign(document.createElement(tag), props);
    }

    function _setStatus(msg) {
        document.getElementById('status-msg').textContent = msg;
    }

    // ── Public API ───────────────────────────────────────────────────────────
    function _showLandmark(name, slot, src, srcLabel) {
        if (!src) { console.log(`[showLandmark] ${slot} — no data (${srcLabel} is null)`); return; }
        const reg = src.find(r => r.name === name);
        if (!reg) { console.log(`[showLandmark] "${name}" not found in ${slot}/${srcLabel} — regions: ${src.map(r=>r.name).join(', ')}`); return; }
        console.log(`[showLandmark] "${name}" slot=${slot} src=${srcLabel} — ${reg.path0.length} points:`);
        reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
        return reg.path0;
    }

    // showAlignIHF()              — live overlay (current slot)
    // showAlignIHF('IHF', 'mov') — the OTHER slot (from its in-memory snapshot)
    window.showAlignIHF = (name='IHF', slot) => {
        const target = slot ?? alignSlot;
        if (target === alignSlot) {
            // Read directly from the live overlay, without calling toJSON() (no side effects)
            if (!alignOverlay) { console.log('[showAlignIHF] no overlay — are you in Align step?'); return; }
            alignOverlay._saveRef();  // flush path0 without deselecting
            const reg = alignOverlay.regions.find(r => r.name === name);
            if (!reg) { console.log(`[showAlignIHF] "${name}" not found — regions: ${alignOverlay.regions.map(r=>r.name).join(', ')}`); return; }
            console.log(`[showAlignIHF] "${name}" slot=${alignSlot} src=LIVE — ${reg.path0.length} points:`);
            reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
            return reg.path0;
        }
        // Non-active slot: read from its in-memory snapshot
        const src = target === 'mov' ? alignInMemoryMov : alignInMemoryRef;
        return _showLandmark(name, target, src, `alignInMemory${target==='mov'?'Mov':'Ref'}`);
    };

    // showMatchIHF()              — what _runMorph uses for ref
    // showMatchIHF('IHF', 'mov') — what _runMorph uses for mov
    window.showMatchIHF = (name='IHF', slot='ref') => {
        const src = slot === 'mov' ? alignInMemoryMov : alignInMemoryRef;
        return _showLandmark(name, slot, src, `alignInMemory${slot==='mov'?'Mov':'Ref'}`);
    };

    return { init, goStep, loadMeshByPath };
})();

window.addEventListener('DOMContentLoaded', () => app.init());
