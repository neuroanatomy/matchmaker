import { el, setStatus } from '../dom-helpers.js';
import { state } from '../state.js';
import { FileBrowser } from '../components/filebrowser.js';
import { ProjectModal, AddSubjectModal } from '../components/projectmodal.js';
import { apiGet, createProject, addSubject, getProject, deleteSubject } from '../api.js';
import { renderStep, _viewMesh as viewMesh, _toggleTexture as toggleTexture, _refreshViewer as refreshViewer } from '../app.js';

// ── Quick-load datasets ──────────────────────────────────────────────────
const DATASETS = [
    { label: 'F02_P0', rel: 'data/external/project/data/raw/meshes/F02_P0/mesh.ply' },
    { label: 'F06_P4', rel: 'data/external/project/data/raw/meshes/F06_P4/mesh.ply' },
    { label: 'F10_P8', rel: 'data/external/project/data/raw/meshes/F10_P8/mesh.ply' },
];

// ── Step 1 — Load meshes ─────────────────────────────────────────────────
export function renderLoadPanel(container) {
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
            rmBtn.onclick = e => { e.stopPropagation(); confirmRemoveSubject(id, row); };
            row.appendChild(rmBtn);

            row.onclick = async () => {
                state.activeSubjectId = id;
                if (state.viewedSubjectId !== id) {
                    state.viewedSubjectId = id;
                    if (!state.viewState[id]) state.viewState[id] = { meshType: 'native', texType: null };
                    else if (!state.viewState[id].meshType) state.viewState[id].meshType = 'native';
                    await refreshViewer({ preserveOrientation: true });
                }
                renderLoadPanel(container);
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
        nativeEl.onclick = () => viewMesh(id, 'native');
        viewSec.appendChild(nativeEl);

        if (s.sphere) {
            const sphereEl = el('div', { className: 'sph-item sph-clickable' });
            const sphereOn = isView && vs.meshType === 'sphere';
            sphereEl.classList.toggle('sph-item-active', sphereOn);
            sphereEl.textContent = (sphereOn ? '▶ ' : '  ') + s.sphere.split('/').pop();
            sphereEl.onclick = () => viewMesh(id, 'sphere');
            viewSec.appendChild(sphereEl);
        }

        if (s.sulc || s.curv) {
            viewSec.appendChild(el('div', { className: 'sph-divider' }));
            if (s.sulc) {
                const sulcEl = el('div', { className: 'sph-item sph-clickable' });
                const on = vs.texType === 'sulc';
                sulcEl.classList.toggle('sph-tex-active', on);
                sulcEl.textContent = (on ? '☑ ' : '☐ ') + 'sulcal depth';
                sulcEl.onclick = () => toggleTexture(id, 'sulc');
                viewSec.appendChild(sulcEl);
            }
            if (s.curv) {
                const curvEl = el('div', { className: 'sph-item sph-clickable' });
                const on = vs.texType === 'curv';
                curvEl.classList.toggle('sph-tex-active', on);
                curvEl.textContent = (on ? '☑ ' : '☐ ') + 'curvature';
                curvEl.onclick = () => toggleTexture(id, 'curv');
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
        btn.onclick = () => loadSubject(state.dataRoot + '/' + ds.rel);
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

    addBtn.onclick = () => addMeshFromBrowser(addBtn.dataset.path);
    container.appendChild(addBtn);
}

export async function confirmRemoveSubject(id, rowEl) {
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

export async function loadSubject(absPath) {
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
            id = guessSubjectId(absPath);
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

        await refreshViewer({ preserveOrientation: false });

        const found = [];
        if (comp.sphere)       found.push('sphere');
        if (comp.sulc)         found.push('sulcal depth');
        if (comp.curv)         found.push('curvature');
        if (comp.sulci_json)   found.push('landmarks');
        if (comp.rotation_txt) found.push('rotation');
        setStatus(`${name} loaded${found.length ? ' — ' + found.join(', ') + ' available' : ''}`);

        if (state.currentStep === 1) {
            const c = document.getElementById('rpanel-content');
            if (c) renderLoadPanel(c);
        } else {
            renderStep(state.currentStep);
        }
    } catch (e) {
        setStatus(`Load error: ${e.message}`);
    }
}

export async function loadProjectFile(projectJsonPath) {
    const root = projectJsonPath.replace(/\/project\.json$/, '');
    setStatus('Loading project…');
    try {
        const proj = await getProject(root);
        state.projectRoot = root;
        const ids = proj.subjects || [];
        if (ids.length === 0) { setStatus('Project has no subjects'); return; }
        for (const subjectId of ids) {
            await loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
        }
        setStatus(`Project loaded — ${ids.length} subject${ids.length > 1 ? 's' : ''}`);
    } catch (e) {
        setStatus(`Project load error: ${e.message}`);
    }
}

export async function addMeshFromBrowser(path) {
    if (!path) return;

    // project.json selected — load entire project
    if (path.endsWith('/project.json')) {
        await loadProjectFile(path);
        return;
    }

    // Path already inside a project structure — just load it
    const projMatch = path.match(/^(.+)\/data\/raw\/meshes\/([^/]+)\/mesh\.ply$/);
    if (projMatch) {
        await loadSubject(path);
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
                        await loadSubject(`${root}/data/raw/meshes/${subjectId}/mesh.ply`);
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
                        await loadSubject(`${state.projectRoot}/data/raw/meshes/${subjectId}/mesh.ply`);
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

export function guessSubjectId(absPath) {
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

export function annotationsDir(id) {
    return `${state.projectRoot}/data/derived/annotations/${id}`;
}

// ── Public shortcut used by E2E tests ────────────────────────────────────
export async function loadMeshByPath(absPath) {
    await loadSubject(absPath);
}
