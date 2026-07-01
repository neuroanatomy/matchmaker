import { el, setStatus } from './dom-helpers.js';
import { state } from './state.js';
import { Viewer3D } from './components/viewer3d.js';

import { checkHealth, getConfig } from './api.js';
import { loadMeshByPath, renderLoadPanel } from './steps/load.js';
import { renderPreprocessPanel, refreshViewer } from './steps/preprocess.js';
import { renderAlignPanel } from './steps/align.js';
import { renderMatchPanel, refreshMatchViewer, loadExistingMatches } from './steps/match.js';
import { renderTrajectoryPanel, loadExistingTrajectories } from './steps/trajectory.js';

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
            refreshMatchViewer();
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
            loadExistingMatches().then(() => renderMatchPanel(rpanel));
        } else if (n === 5) {
            h2.textContent = 'Trajectory';
            Promise.all([loadExistingTrajectories(), loadExistingMatches()])
                .then(() => renderTrajectoryPanel(rpanel));
        } else {
            const labels = ['', 'Load', 'Preprocess', 'Align', 'Match', 'View'];
            h2.textContent = labels[n] || `Step ${n}`;
            rpanel.innerHTML = `<p class="coming-soon">Coming in a future phase.</p>`;
        }
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
