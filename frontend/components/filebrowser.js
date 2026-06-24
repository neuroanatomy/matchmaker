import { apiGet } from '../api.js';

/**
 * FileBrowser — navigable file picker backed by /api/files.
 *
 * Usage:
 *   const fb = new FileBrowser(containerEl, {
 *       filter: name => name.endsWith('.ply') || name.endsWith('.ply.gz'),
 *       onSelect: path => console.log(path),
 *   });
 *   fb.navigate(null);  // start at data root
 */
export class FileBrowser {
    #container;
    #filter;
    #onSelect;
    #currentDir = null;
    #selectedPath = null;

    constructor(container, { filter = () => true, onSelect = () => {} } = {}) {
        this.#container = container;
        this.#filter = filter;
        this.#onSelect = onSelect;
    }

    get selectedPath() { return this.#selectedPath; }

    setSelected(path) {
        this.#selectedPath = path;
        this.#container.querySelectorAll('.fb-entry').forEach(r =>
            r.classList.toggle('selected', r.dataset.path === path)
        );
    }

    async navigate(dir) {
        this.#currentDir = dir;
        this.#container.innerHTML = '<div class="fb-loading">Loading…</div>';

        let entries;
        try {
            entries = await apiGet('/api/files', dir ? { dir } : {});
        } catch {
            this.#container.innerHTML = '<div class="fb-error">Cannot reach server.</div>';
            return;
        }

        this.#container.innerHTML = '';

        // Back button + breadcrumb when not at filesystem root
        if (dir && dir !== '/') {
            const back = document.createElement('button');
            back.className = 'fb-back-btn';
            back.textContent = '← Back';
            back.onclick = () => {
                const parts = dir.split('/').filter(Boolean);
                const parent = parts.length > 1 ? '/' + parts.slice(0, -1).join('/') : '/';
                this.navigate(parent);
            };
            this.#container.appendChild(back);
        }

        if (dir) {
            const bc = document.createElement('div');
            bc.className = 'fb-breadcrumb';
            bc.textContent = dir === '/' ? '/' : dir.split('/').slice(-2).join('/');
            this.#container.appendChild(bc);
        }

        const selPath = this.#selectedPath;
        entries.forEach(e => {
            if (!e.is_dir && !this.#filter(e.name)) return;

            const row = document.createElement('div');
            row.className = 'fb-entry';
            row.dataset.path = e.path;
            if (e.path === selPath) row.classList.add('selected');

            const icon = e.is_dir ? '📁' : '🔷';
            row.innerHTML = `<span class="icon">${icon}</span><span class="name">${e.name}</span>`;

            if (e.is_dir) {
                row.onclick = () => this.navigate(e.path);
            } else {
                row.onclick = () => {
                    this.#selectedPath = e.path;
                    this.#container.querySelectorAll('.fb-entry')
                        .forEach(r => r.classList.toggle('selected', r.dataset.path === e.path));
                    this.#onSelect(e.path);
                };
            }
            this.#container.appendChild(row);
        });
    }
}
