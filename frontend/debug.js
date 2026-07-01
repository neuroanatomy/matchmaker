/**
 * debug.js — manual-testing helpers for landmark inspection in the browser console.
 *
 * Only loaded and attached to `window` when the app is opened with `?debug=1`
 * in the URL (see the conditional import in app.js). Not part of the normal
 * app flow — these are for interactively inspecting sulci landmark data while
 * developing the Align/Match steps.
 */

function _showLandmark(name, id, src, srcLabel) {
    if (!src) { console.log(`[showLandmark] ${id} — no data (${srcLabel} is null)`); return; }
    const reg = src.find(r => r.name === name);
    if (!reg) { console.log(`[showLandmark] "${name}" not found in ${id}/${srcLabel} — regions: ${src.map(r=>r.name).join(', ')}`); return; }
    console.log(`[showLandmark] "${name}" id=${id} src=${srcLabel} — ${reg.path0.length} points:`);
    reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
    return reg.path0;
}

/**
 * Attach window.showAlignIHF / window.showMatchIHF. `state` getters give this
 * module live access to app.js's private closure state without exporting it.
 */
export function installDebugHelpers({ getAlignSubjectId, getAlignOverlay, getAlignInMemory, getMatchRefId }) {
    window.showAlignIHF = (name = 'IHF', id) => {
        const alignSubjectId = getAlignSubjectId();
        const alignOverlay   = getAlignOverlay();
        const targetId = id ?? alignSubjectId;
        if (targetId === alignSubjectId && alignOverlay) {
            alignOverlay._saveRef();
            const reg = alignOverlay.regions.find(r => r.name === name);
            if (!reg) { console.log(`[showAlignIHF] "${name}" not found — regions: ${alignOverlay.regions.map(r=>r.name).join(', ')}`); return; }
            console.log(`[showAlignIHF] "${name}" subject=${alignSubjectId} src=LIVE — ${reg.path0.length} points:`);
            reg.path0.forEach((p, i) => console.log(`  [${i}] px=${p.px.toFixed(4)}  py=${p.py.toFixed(4)}`));
            return reg.path0;
        }
        return _showLandmark(name, targetId, getAlignInMemory()[targetId], `alignInMemory[${targetId}]`);
    };

    window.showMatchIHF = (name = 'IHF', id) => {
        const targetId = id ?? getMatchRefId();
        return _showLandmark(name, targetId, getAlignInMemory()[targetId], `alignInMemory[${targetId}]`);
    };
}
