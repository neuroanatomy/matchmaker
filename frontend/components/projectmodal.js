/**
 * ProjectModal — prompts the user to create a MatchMaker project before the
 * first write operation (spherize / curvature).
 *
 * Usage:
 *   const modal = new ProjectModal(document.body, {
 *     refPath, movPath,
 *     onConfirm: ({ projectRoot, refId, movId }) => { ... },
 *     onCancel:  () => { ... },
 *   });
 *   // modal.destroy() removes it
 */
export class ProjectModal {
    constructor(container, { meshPath, onConfirm, onCancel }) {
        this._onConfirm = onConfirm;
        this._onCancel  = onCancel;

        const guessedId = meshPath ? _guessId(meshPath) : 'subject';
        const root      = _suggestRoot(meshPath, guessedId, null);

        this._overlay = _el('div', { className: 'pm-overlay' });
        this._overlay.setAttribute('role', 'dialog');
        this._overlay.setAttribute('aria-modal', 'true');
        this._overlay.setAttribute('aria-label', 'Create project');

        const box = _el('div', { className: 'pm-box' });

        const title = _el('h3', { className: 'pm-title' });
        title.textContent = 'Create project';
        box.appendChild(title);

        const desc = _el('p', { className: 'pm-desc' });
        desc.textContent = 'Choose where to save outputs. A project folder keeps raw data and derived results separate.';
        box.appendChild(desc);

        // Project folder
        box.appendChild(_label('Project folder'));
        const rootInput = _el('input', { className: 'pm-input', type: 'text', value: root });
        rootInput.setAttribute('aria-label', 'Project folder path');
        rootInput.placeholder = '/path/to/my-project';
        box.appendChild(rootInput);

        // Subject ID
        box.appendChild(_label('Subject ID  (guessed from path)'));
        const idInput = _el('input', { className: 'pm-input', type: 'text', value: guessedId });
        idInput.setAttribute('aria-label', 'Subject ID');
        box.appendChild(idInput);

        // Error line
        const errEl = _el('div', { className: 'pm-error' });
        errEl.style.display = 'none';
        box.appendChild(errEl);

        // Buttons
        const btnRow = _el('div', { className: 'pm-btns' });

        const cancelBtn = _el('button', { className: 'pm-btn pm-btn-cancel' });
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => { this.destroy(); onCancel?.(); };
        btnRow.appendChild(cancelBtn);

        const confirmBtn = _el('button', { className: 'pm-btn pm-btn-confirm' });
        confirmBtn.textContent = 'Create project';
        confirmBtn.onclick = () => {
            const pr = rootInput.value.trim();
            const id = idInput.value.trim();
            if (!pr) { _showErr(errEl, 'Project folder is required.'); return; }
            if (!id) { _showErr(errEl, 'Subject ID is required.'); return; }
            this.destroy();
            onConfirm?.({ projectRoot: pr, subjectId: id });
        };
        btnRow.appendChild(confirmBtn);

        box.appendChild(btnRow);
        this._overlay.appendChild(box);
        container.appendChild(this._overlay);

        setTimeout(() => confirmBtn.focus(), 0);

        this._overlay.addEventListener('click', e => {
            if (e.target === this._overlay) { this.destroy(); onCancel?.(); }
        });
    }

    destroy() {
        this._overlay?.remove();
        this._overlay = null;
    }
}

/**
 * AddSubjectModal — shown when a mesh is loaded from outside the active project
 * and the user triggers a write operation (spherize / curvature).
 *
 * Usage:
 *   new AddSubjectModal(document.body, {
 *     slot: 'ref' | 'mov',
 *     meshPath,
 *     projectRoot,
 *     onConfirm: ({ subjectId }) => { ... },
 *     onCancel:  () => { ... },
 *   });
 */
export class AddSubjectModal {
    constructor(container, { slot, meshPath, projectRoot, onConfirm, onCancel }) {
        const guessedId = _guessId(meshPath);
        const slotLabel = slot === 'ref' ? 'Ref' : 'Mov';

        this._overlay = _el('div', { className: 'pm-overlay' });
        this._overlay.setAttribute('role', 'dialog');
        this._overlay.setAttribute('aria-modal', 'true');
        this._overlay.setAttribute('aria-label', 'Add subject to project');

        const box = _el('div', { className: 'pm-box' });

        const title = _el('h3', { className: 'pm-title' });
        title.textContent = 'Add to project';
        box.appendChild(title);

        const desc = _el('p', { className: 'pm-desc' });
        desc.textContent = `This mesh is outside the active project. It will be copied in and its outputs saved there.`;
        box.appendChild(desc);

        const projectDesc = _el('p', { className: 'pm-desc' });
        projectDesc.textContent = `Project: ${projectRoot}`;
        projectDesc.style.fontFamily = 'monospace';
        projectDesc.style.fontSize = '0.85em';
        projectDesc.style.wordBreak = 'break-all';
        box.appendChild(projectDesc);

        box.appendChild(_label(`${slotLabel} subject ID  (guessed from path)`));
        const idInput = _el('input', { className: 'pm-input', type: 'text', value: guessedId });
        idInput.setAttribute('aria-label', `${slotLabel} subject ID`);
        box.appendChild(idInput);

        const errEl = _el('div', { className: 'pm-error' });
        errEl.style.display = 'none';
        box.appendChild(errEl);

        const btnRow = _el('div', { className: 'pm-btns' });

        const cancelBtn = _el('button', { className: 'pm-btn pm-btn-cancel' });
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = () => { this.destroy(); onCancel?.(); };
        btnRow.appendChild(cancelBtn);

        const confirmBtn = _el('button', { className: 'pm-btn pm-btn-confirm' });
        confirmBtn.textContent = 'Add to project';
        confirmBtn.onclick = () => {
            const id = idInput.value.trim();
            if (!id) { _showErr(errEl, 'Subject ID is required.'); return; }
            this.destroy();
            onConfirm?.({ subjectId: id });
        };
        btnRow.appendChild(confirmBtn);

        box.appendChild(btnRow);
        this._overlay.appendChild(box);
        container.appendChild(this._overlay);

        setTimeout(() => confirmBtn.focus(), 0);

        this._overlay.addEventListener('click', e => {
            if (e.target === this._overlay) { this.destroy(); onCancel?.(); }
        });
    }

    destroy() {
        this._overlay?.remove();
        this._overlay = null;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _el(tag, props = {}) {
    return Object.assign(document.createElement(tag), props);
}

function _label(text) {
    const el = _el('label', { className: 'pm-label' });
    el.textContent = text;
    return el;
}

function _showErr(el, msg) {
    el.textContent = msg;
    el.style.display = 'block';
}

const _GENERIC = new Set([
    'seg-pial-t2', 'seg-pial', 'seg-white', 'surfaces', 'surface',
    'external', 'data', 'landmarks', 'meshes', 'raw', 'derived',
]);

function _guessId(absPath) {
    if (!absPath) return 'subject';
    const parts = absPath.split('/').filter(Boolean);
    // Walk from the filename up, skip generic directory names
    for (let i = parts.length - 2; i >= 0; i--) {
        if (!_GENERIC.has(parts[i]) && parts[i].length > 0) return parts[i];
    }
    return parts[parts.length - 2] || 'subject';
}

function _suggestRoot(absPath, subjectId) {
    if (!absPath) return '';
    const parts = absPath.split('/');
    for (let i = parts.length - 1; i >= 1; i--) {
        if (parts[i] === 'data' || parts[i] === 'external') {
            return parts.slice(0, i).join('/') + '/projects/' + subjectId;
        }
    }
    return parts.slice(0, -3).join('/') + '/projects/' + subjectId;
}
