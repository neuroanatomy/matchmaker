import { el, setStatus } from '../dom-helpers.js';
import { state } from '../state.js';
import { meshUrl, apiGet, pollJob, getTrajectories, startTrajectory, deleteTrajectory } from '../api.js';
import { TrajectoryPlayer } from '../components/trajectory.js';
import { renderStep } from '../app.js';

const TRAJ_DEMO_RELS = [0, 2, 4, 6, 8].map(n => `trajectoryviewer/${n}.ply`);

// ── Step 5 — Trajectory ──────────────────────────────────────────────────

export async function loadExistingTrajectories() {
    if (!state.projectRoot) { state.existingTrajectories = []; return; }
    try { state.existingTrajectories = await getTrajectories(state.projectRoot); }
    catch { state.existingTrajectories = []; }
}

export function renderTrajectoryPanel(container) {
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
            loadBtn.onclick = () => loadTrajectoryFromDisk(t);
            row.appendChild(loadBtn);

            const delBtn = el('button', { className: 'roster-del-btn' });
            delBtn.textContent = '✕';
            delBtn.setAttribute('aria-label', `Delete trajectory ${t.name}`);
            delBtn.onclick = () => confirmDeleteTrajectory(t, row, sec);
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
            runBtn.onclick = () => runTrajectory();
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
        demoBtn.onclick = () => loadTrajectoryDemo();
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

export async function loadTrajectoryFromDisk(traj) {
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
            state.player.onSeek(t => updateScrubber(t));
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

export async function runTrajectory() {
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
        await loadExistingTrajectories();
        const traj = state.existingTrajectories.find(t => t.dir === out_dir);
        if (traj) await loadTrajectoryFromDisk(traj);
        else renderStep(state.currentStep);
    } catch (e) {
        setStatus(`Trajectory error: ${e.message}`);
        renderStep(state.currentStep);
    }
}

export function confirmDeleteTrajectory(traj, rowEl, secEl) {
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
            renderTrajectoryPanel(document.getElementById('rpanel-content'));
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

export async function loadTrajectoryDemo() {
    setStatus('Loading trajectory demo…');
    const urls = TRAJ_DEMO_RELS.map(rel => meshUrl(state.dataRoot + '/' + rel));
    try {
        if (!state.player) {
            state.player = new TrajectoryPlayer(state.viewer);
            state.player.onSeek(t => updateScrubber(t));
        }
        window._player = state.player;
        await state.player.load(urls);
        state.loadedTrajDir = null;
        setStatus(`Trajectory loaded — ${state.player.frameCount} frames`);
        renderTrajectoryPanel(document.getElementById('rpanel-content'));
    } catch (e) {
        setStatus(`Trajectory error: ${e.message}`);
    }
}

// ── Trajectory helpers ───────────────────────────────────────────────────
export function updateScrubber(t) {
    const scrubber = document.getElementById('rp-traj-scrubber');
    if (scrubber) scrubber.value = Math.round(t * 1000);
    const timeEl = document.getElementById('rp-traj-time');
    if (timeEl) timeEl.textContent = t.toFixed(2);
    const playBtn = document.getElementById('rp-traj-play');
    if (playBtn && state.player) playBtn.textContent = state.player.isPlaying ? '⏸' : '▶';
}
