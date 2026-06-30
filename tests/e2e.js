/**
 * e2e.js — end-to-end tests for Match Maker
 *
 * Starts the local Flask server, opens the app in a headless browser,
 * loads a test mesh, and verifies it renders correctly.
 *
 * Run from the tests/ directory:
 *   npm test
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const PORT = 5099;
const BASE_URL = `http://localhost:${PORT}`;

// Path to the test mesh (relative to project root)
const MESH_REL_PATH = 'data/external/project/data/raw/meshes/F02_P0/mesh.ply';
const MESH_ABS_PATH = path.join(PROJECT_ROOT, MESH_REL_PATH);

// Background colour of the 3D viewer (#1a1a2e)
const BG = { r: 26, g: 26, b: 46 };
const BG_TOLERANCE = 15; // allow small rounding differences

let server, browser, page;

// ── Helpers ──────────────────────────────────────────────────────────────────

function startServer() {
    return new Promise((resolve, reject) => {
        // Resolve the Python binary directly so kill() reaches the Flask process.
        const pythonBin = execFileSync(
            'conda', ['run', '-n', 'py310', 'which', 'python']
        ).toString().trim();

        const env = {
            ...process.env,
            MATCHMAKER_PORT: String(PORT),
            MATCHMAKER_ROOT: PROJECT_ROOT,
        };
        const proc = spawn(pythonBin, ['-m', 'matchmaker'], {
            cwd: PROJECT_ROOT,
            env,
            stdio: 'pipe',
        });
        proc.unref(); // don't keep the Node event loop alive for this process
        proc.stderr.on('data', d => process.stderr.write(d));

        // Poll until /health responds
        const start = Date.now();
        const poll = setInterval(async () => {
            try {
                const res = await fetch(`${BASE_URL}/health`);
                if (res.ok) { clearInterval(poll); resolve(proc); }
            } catch { /* not ready yet */ }
            if (Date.now() - start > 15_000) {
                clearInterval(poll);
                reject(new Error('Server did not start within 15 s'));
            }
        }, 300);
    });
}

function isBackground(r, g, b) {
    return Math.abs(r - BG.r) < BG_TOLERANCE &&
           Math.abs(g - BG.g) < BG_TOLERANCE &&
           Math.abs(b - BG.b) < BG_TOLERANCE;
}

// Sample a 5×5 pixel grid from the main Three.js viewer canvas.
async function countNonBgPixelsMain(page) {
    return page.evaluate((bg, tol) => {
        const canvas = document.querySelector('#viewer-container canvas');
        if (!canvas) return -1;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return -1;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(4);
        let count = 0;
        for (let xi = 0; xi < 5; xi++) {
            for (let yi = 0; yi < 5; yi++) {
                const x = Math.round(w * (0.25 + xi * 0.1));
                const y = Math.round(h * (0.25 + yi * 0.1));
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                const isBg = Math.abs(pixels[0] - bg.r) < tol &&
                             Math.abs(pixels[1] - bg.g) < tol &&
                             Math.abs(pixels[2] - bg.b) < tol;
                if (!isBg) count++;
            }
        }
        return count;
    }, BG, BG_TOLERANCE);
}

// Click a subject roster row by subject ID.
async function clickSubjectRow(page, subjectId) {
    await page.evaluate((id) => {
        const row = document.querySelector(`[data-subject-id="${id}"]`);
        if (!row) throw new Error(`Subject row for "${id}" not found`);
        row.click();
    }, subjectId);
}

// Click a quick-load pill by label.
async function clickPill(page, label) {
    await page.evaluate((label) => {
        const btn = [...document.querySelectorAll('.pill-btn')]
            .find(b => b.textContent.trim() === label);
        if (!btn) throw new Error(`Quick-load pill "${label}" not found`);
        btn.click();
    }, label);
}

// Wait for the status bar to contain a string (case-insensitive).
async function waitForStatus(page, substring, timeout = 15_000) {
    await page.waitForFunction(
        (sub) => document.getElementById('status-msg')?.textContent
                         .toLowerCase().includes(sub.toLowerCase()),
        { timeout },
        substring,
    );
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
    server = await startServer();
    browser = await puppeteer.launch({
        executablePath: '/Applications/_Comm/Chromium.app/Contents/MacOS/Chromium',
        headless: true,
        args: ['--no-sandbox', '--disable-web-security'],
    });
    page = await browser.newPage();
    page.on('console', m => {
        if (m.type() === 'error') process.stderr.write(`[browser] ${m.text()}\n`);
    });
    await page.goto(BASE_URL, { waitUntil: 'networkidle0' });
});

after(async () => {
    await browser?.close();
    server?.kill();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('health endpoint returns ok', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.version, 'version field should be present');
});

test('connection badge shows connected', async () => {
    // The status dot should gain the "connected" class within the polling interval
    await page.waitForSelector('#status-dot.connected', { timeout: 5000 });
});

test('/api/files lists the test mesh', async () => {
    const res = await fetch(`${BASE_URL}/api/files?dir=${encodeURIComponent(
        path.join(PROJECT_ROOT, 'data/external/project/data/raw/meshes/F02_P0')
    )}`);
    const entries = await res.json();
    const names = entries.map(e => e.name);
    assert.ok(names.includes('mesh.ply'), `mesh.ply not found in listing, got: ${names}`);
});

test('/api/mesh serves mesh.ply with correct PLY header', async () => {
    const url = `${BASE_URL}/api/mesh?path=${encodeURIComponent(MESH_ABS_PATH)}`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    const buf = await res.arrayBuffer();
    const header = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
    assert.equal(header, 'ply\n', 'Response should start with PLY magic bytes');
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Sample a 5×5 pixel grid from the StereoView WebGL canvas and count non-bg pixels.
async function countNonBgPixelsStereo(page) {
    return page.evaluate((bg, tol) => {
        const sv = window._alignStereoView;
        if (!sv) return -1;
        const canvas = sv._canvas;
        if (!canvas) return -1;
        const gl = canvas.getContext('webgl');
        if (!gl) return -1;
        const w = canvas.width, h = canvas.height;
        const pixels = new Uint8Array(4);
        let count = 0;
        for (let xi = 0; xi < 5; xi++) {
            for (let yi = 0; yi < 5; yi++) {
                const x = Math.round(w * (0.25 + xi * 0.1));
                // WebGL Y=0 is bottom; sample the upper half of the disc
                const y = Math.round(h * (0.25 + yi * 0.1));
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                const isBg = Math.abs(pixels[0] - bg.r) < tol &&
                             Math.abs(pixels[1] - bg.g) < tol &&
                             Math.abs(pixels[2] - bg.b) < tol;
                if (!isBg) count++;
            }
        }
        return count;
    }, BG, BG_TOLERANCE);
}

test('mesh.ply loads and renders non-background pixels', async () => {
    // Trigger mesh load via the public JS API
    await page.evaluate(async (absPath) => {
        await window.app.loadMeshByPath(absPath);
    }, MESH_ABS_PATH);

    // Give the renderer a moment to paint
    await new Promise(r => setTimeout(r, 800));

    // Sample a grid of points in the canvas centre and count non-background pixels
    const nonBgCount = await page.evaluate((bg, tol) => {
        const canvas = document.querySelector('#viewer-container canvas');
        if (!canvas) return -1;
        const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
        if (!gl) return -1;

        const w = canvas.width;
        const h = canvas.height;
        const pixels = new Uint8Array(4);
        let nonBg = 0;

        // Sample a 5×5 grid in the central 50% of the canvas
        for (let xi = 0; xi < 5; xi++) {
            for (let yi = 0; yi < 5; yi++) {
                const x = Math.round(w * (0.25 + xi * 0.1));
                // WebGL readPixels Y=0 is at the bottom
                const y = Math.round(h * (0.25 + yi * 0.1));
                gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                const isBg = Math.abs(pixels[0] - bg.r) < tol &&
                             Math.abs(pixels[1] - bg.g) < tol &&
                             Math.abs(pixels[2] - bg.b) < tol;
                if (!isBg) nonBg++;
            }
        }
        return nonBg;
    }, BG, BG_TOLERANCE);

    assert.ok(nonBgCount > 0,
        `Expected non-background pixels in canvas centre, got ${nonBgCount}/25`);
});

// ── Align step — rotation slider tests ───────────────────────────────────────
//
// These tests share sequential state:
//   1. Quick-load F02_P0 (step 1)  →  companions auto-discovered (sphere, sulc, rotation.txt)
//   2. Navigate to step 3           →  StereoView created, sliders rendered
//   3. Interact with sliders / drag →  verify render + sync

test('Align: rotation sliders appear after F02_P0 quick-load + step 3', async () => {
    // Navigate to step 1 first so we start clean
    await page.click('[data-step="1"]');

    // Click the "F02_P0" quick-load pill
    const pills = await page.$$('.pill-btn');
    const f02btn = await (async () => {
        for (const btn of pills) {
            const txt = await btn.evaluate(el => el.textContent.trim());
            if (txt === 'F02_P0') return btn;
        }
        return null;
    })();
    assert.ok(f02btn, 'F02_P0 quick-load button should be present');
    await f02btn.click();

    // Wait for companions to arrive (sphere companion makes "sphere.ply" appear in panel)
    await page.waitForFunction(() => {
        const items = [...document.querySelectorAll('.sph-item')];
        return items.some(el => el.textContent.includes('sphere.ply'));
    }, { timeout: 10_000 });

    // Navigate to step 3
    await page.click('[data-step="3"]');

    // Wait for StereoView to load and sliders to render
    await page.waitForSelector('#rot-twist', { timeout: 20_000 });
    await page.waitForSelector('#rot-tiltv', { timeout: 5_000 });
    await page.waitForSelector('#rot-tilth', { timeout: 5_000 });

    const sliderCount = await page.$$eval(
        '#rot-twist, #rot-tiltv, #rot-tilth', els => els.length);
    assert.equal(sliderCount, 3, 'All three rotation sliders should be in the DOM');
});

test('Align: slider values are valid integers in their expected ranges', async () => {
    const values = await page.evaluate(() => ({
        twist: parseInt(document.getElementById('rot-twist')?.value),
        tiltv: parseInt(document.getElementById('rot-tiltv')?.value),
        tilth: parseInt(document.getElementById('rot-tilth')?.value),
    }));

    assert.ok(!isNaN(values.twist), `Twist value should be a number, got "${values.twist}"`);
    assert.ok(!isNaN(values.tiltv), `Tilt↕ value should be a number, got "${values.tiltv}"`);
    assert.ok(!isNaN(values.tilth), `Spin↔ value should be a number, got "${values.tilth}"`);

    assert.ok(values.twist >= -180 && values.twist <= 180,
        `Twist ${values.twist} out of range [-180, 180]`);
    assert.ok(values.tiltv >= -90  && values.tiltv <= 90,
        `Tilt↕ ${values.tiltv} out of range [-90, 90]`);
    assert.ok(values.tilth >= -180 && values.tilth <= 180,
        `Spin↔ ${values.tilth} out of range [-180, 180]`);
});

test('Align: moving Twist slider to 90° re-renders disc (non-bg pixels present)', async () => {
    // Set Twist to 90° and fire the input event
    await page.evaluate(() => {
        const el = document.getElementById('rot-twist');
        if (!el) throw new Error('rot-twist not found');
        el.value = '90';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Allow the WebGL re-render to flush
    await new Promise(r => setTimeout(r, 300));

    const nonBg = await countNonBgPixelsStereo(page);
    assert.ok(nonBg > 0,
        `After Twist=90° re-render, expected non-background pixels, got ${nonBg}/25`);
});

test('Align: programmatic applyDrag updates Tilt↕ and Spin↔ slider values', async () => {
    // Read baseline slider values
    const before = await page.evaluate(() => ({
        tiltv: parseInt(document.getElementById('rot-tiltv')?.value ?? '0'),
        tilth: parseInt(document.getElementById('rot-tilth')?.value ?? '0'),
    }));

    // Reset StereoView to identity so the drag result is predictable
    await page.evaluate(() => {
        const sv = window._alignStereoView;
        if (!sv) throw new Error('_alignStereoView not found');
        sv.setEulerZYX(0, 0, 0);
    });

    // Apply a sizeable horizontal drag (Δx=200, Δy=0) which rotates only Ry (Tilt↕/beta)
    await page.evaluate(() => {
        const sv = window._alignStereoView;
        sv._applyDrag(200, 0);
        sv._render();
        sv._onRotationChange?.();
    });

    await new Promise(r => setTimeout(r, 100));

    const after = await page.evaluate(() => ({
        tiltv: parseInt(document.getElementById('rot-tiltv')?.value ?? '0'),
        tilth: parseInt(document.getElementById('rot-tilth')?.value ?? '0'),
    }));

    // A horizontal drag of 200px at scale=0.005 → Ry(1 rad ≈ 57°)
    // Decomposed from identity: alpha≈0, beta≈57°, gamma≈0
    // So tiltv should be non-zero after the drag
    assert.ok(Math.abs(after.tiltv) > 5,
        `Tilt↕ slider should reflect horizontal drag (Ry rotation), got ${after.tiltv}°`);
    assert.ok(Math.abs(after.tilth) < 5,
        `Spin↔ slider should stay near 0 for pure horizontal drag, got ${after.tilth}°`);
});

// ── Load step tests (TC-L01 through TC-L09) ───────────────────────────────────
//
// These tests are sequential and share page state. TC-L01 starts from a clean
// state (page reload). Subsequent tests build on the loaded roster.
//
// Subject roster model: subjects appear as .subject-row[data-subject-id] elements.
// Camera default position: [0, 0, 3] (set in Viewer3D._initRenderer).

test('TC-L01: loading a mesh adds it to the subject roster', async () => {
    // Start clean at step 1
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 300));

    await clickPill(page, 'F02_P0');
    await waitForStatus(page, 'mesh.ply loaded');
    await new Promise(r => setTimeout(r, 500));

    // Subject row must appear in roster
    const rowExists = await page.$('[data-subject-id="F02_P0"]').then(el => !!el);
    assert.ok(rowExists, '.subject-row for F02_P0 should appear after load');

    // The loaded row should be marked active
    const isActive = await page.$eval('[data-subject-id="F02_P0"]',
        el => el.classList.contains('active'));
    assert.ok(isActive, 'F02_P0 row should be active after load');

    // Mesh must be visible
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show non-background pixels after load, got ${nonBg}/25`);
});

test('TC-L02: loading a second mesh appends it to the roster', async () => {
    // Precondition: F02_P0 loaded (TC-L01)
    await clickPill(page, 'F06_P4');
    await waitForStatus(page, 'mesh.ply loaded');
    await new Promise(r => setTimeout(r, 500));

    // Both roster rows must exist
    const rowCount = await page.$$eval('.subject-row', rows => rows.length);
    assert.ok(rowCount >= 2, `Roster should have at least 2 rows, got ${rowCount}`);

    const f06Exists = await page.$('[data-subject-id="F06_P4"]').then(el => !!el);
    assert.ok(f06Exists, 'F06_P4 row should appear in roster after load');

    // F06_P4 is now the active/viewed subject
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show F06_P4 mesh, got ${nonBg}/25`);
});

test('TC-L03: clicking a subject row switches the active subject and updates the viewer', async () => {
    // Precondition: F02_P0 and F06_P4 loaded; F06_P4 currently viewed

    // Switch to F02_P0
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 800));

    let isActive = await page.$eval('[data-subject-id="F02_P0"]',
        el => el.classList.contains('active'));
    assert.ok(isActive, 'F02_P0 row should be active after click');

    let nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show F02_P0 mesh after row click, got ${nonBg}/25`);

    // Switch to F06_P4
    await clickSubjectRow(page, 'F06_P4');
    await new Promise(r => setTimeout(r, 800));

    isActive = await page.$eval('[data-subject-id="F06_P4"]',
        el => el.classList.contains('active'));
    assert.ok(isActive, 'F06_P4 row should be active after click');

    nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show F06_P4 mesh after row click, got ${nonBg}/25`);
});

test('TC-L04: subject row click preserves camera; geometry-type change resets it', async () => {
    // Start on F02_P0
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 800));

    // Set a known non-default camera position
    await page.evaluate(() => {
        window._viewer.camera.position.set(0, 0, 5);
        window._viewer.controls.update();
    });

    // Switch to F06_P4 (preserveOrientation: true → camera must NOT reset)
    await clickSubjectRow(page, 'F06_P4');
    await new Promise(r => setTimeout(r, 800));

    // Switch back to F02_P0 (preserveOrientation: true → camera must NOT reset)
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 800));

    const camZ = await page.evaluate(() => window._viewer.camera.position.z);
    assert.ok(Math.abs(camZ - 5) < 0.5,
        `Camera z should be ~5 after subject row switch (preserved), got ${camZ.toFixed(3)}`);

    // Now click a DIFFERENT geometry (sphere) — camera MUST reset to ~[0,0,3]
    const hasSphere = await page.evaluate(() =>
        [...document.querySelectorAll('.sph-item.sph-clickable')]
            .some(el => el.textContent.includes('sphere.ply')));

    if (hasSphere) {
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
                .find(el => el.textContent.includes('sphere.ply'));
            el?.click();
        });
        await new Promise(r => setTimeout(r, 1200));

        const camZAfter = await page.evaluate(() => window._viewer.camera.position.z);
        assert.ok(Math.abs(camZAfter - 3) < 0.5,
            `Camera z should reset to ~3 on geometry change, got ${camZAfter.toFixed(3)}`);
    }
});

test('TC-L05: texture toggle preserves camera orientation', async () => {
    // Start on F02_P0 with native mesh (camera already at default after TC-L04 geometry switch)
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 500));

    // Ensure native mesh is shown (click it if sphere is currently active)
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('mesh.ply') && !el.textContent.includes('sphere'));
        el?.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Set a non-default camera position
    await page.evaluate(() => {
        window._viewer.camera.position.set(1, 2, 4);
        window._viewer.controls.update();
    });

    // Toggle sulcal depth if available
    const hasSulc = await page.evaluate(() =>
        [...document.querySelectorAll('.sph-item.sph-clickable')]
            .some(el => el.textContent.includes('sulcal depth')));

    if (hasSulc) {
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
                .find(el => el.textContent.includes('sulcal depth'));
            el?.click();
        });
        await new Promise(r => setTimeout(r, 1200));

        const cam = await page.evaluate(() => {
            const p = window._viewer.camera.position;
            return { x: p.x, y: p.y, z: p.z };
        });
        const dist = Math.sqrt((cam.x-1)**2 + (cam.y-2)**2 + (cam.z-4)**2);
        assert.ok(dist < 0.5,
            `Camera should be preserved on texture toggle, moved ${dist.toFixed(3)} from [1,2,4]`);

        // Toggle off — camera still preserved
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
                .find(el => el.textContent.includes('sulcal depth'));
            el?.click();
        });
        await new Promise(r => setTimeout(r, 1200));

        const cam2 = await page.evaluate(() => {
            const p = window._viewer.camera.position;
            return { x: p.x, y: p.y, z: p.z };
        });
        const dist2 = Math.sqrt((cam2.x-1)**2 + (cam2.y-2)**2 + (cam2.z-4)**2);
        assert.ok(dist2 < 0.5,
            `Camera should be preserved on texture toggle-off, moved ${dist2.toFixed(3)} from [1,2,4]`);
    }
});

test('TC-L06: clicking already-active geometry type does not reload or reset camera', async () => {
    // Start on F02_P0 with native mesh active
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 500));

    // Click native mesh to ensure it's active
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('mesh.ply') && !el.textContent.includes('sphere'));
        el?.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Set a non-default camera position
    await page.evaluate(() => {
        window._viewer.camera.position.set(0, 0, 6);
        window._viewer.controls.update();
    });

    // Click the native mesh AGAIN — should be a no-op (same geometry type)
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('mesh.ply') && !el.textContent.includes('sphere'));
        el?.click();
    });
    await new Promise(r => setTimeout(r, 400));

    const camZ = await page.evaluate(() => window._viewer.camera.position.z);
    assert.ok(Math.abs(camZ - 6) < 0.5,
        `Camera should not reset when clicking already-active geometry, got z=${camZ.toFixed(3)}`);
});

test('TC-L07: loading a new subject resets companion state and camera', async () => {
    // Precondition: F02_P0 and F06_P4 loaded; F02_P0 currently active/viewed

    // Ensure F02_P0 is viewed so sphere companion is visible in panel
    await clickSubjectRow(page, 'F02_P0');
    await new Promise(r => setTimeout(r, 400));

    const hasSphere = await page.evaluate(() =>
        [...document.querySelectorAll('.sph-item')]
            .some(el => el.textContent.includes('sphere.ply')));
    assert.ok(hasSphere, 'F02_P0 should have sphere companion in panel before new load');

    // Set a non-default camera position (distinguishable from default [0,0,3])
    await page.evaluate(() => {
        window._viewer.camera.position.set(5, 2, 1);
        window._viewer.controls.update();
    });

    // Load F10_P8 — new subject; camera must reset
    await clickPill(page, 'F10_P8');
    await waitForStatus(page, 'mesh.ply loaded');
    await new Promise(r => setTimeout(r, 800));

    // Camera must have reset to default ~[0,0,3]
    const camPos = await page.evaluate(() => ({
        x: window._viewer.camera.position.x,
        y: window._viewer.camera.position.y,
        z: window._viewer.camera.position.z,
    }));
    assert.ok(Math.abs(camPos.z - 3) < 0.5,
        `Camera z should reset to ~3 on new subject load, got ${camPos.z.toFixed(3)}`);
    assert.ok(Math.abs(camPos.x) < 1,
        `Camera x should reset to ~0 on new subject load, got ${camPos.x.toFixed(3)}`);

    // F10_P8 row must appear in roster
    const f10Exists = await page.$('[data-subject-id="F10_P8"]').then(el => !!el);
    assert.ok(f10Exists, 'F10_P8 row should appear in roster after load');

    // New mesh visible
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Reloaded mesh should be visible, got ${nonBg}/25`);
});

test('TC-L08: loading three subjects shows three roster rows', async () => {
    // Start clean
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 300));

    for (const label of ['F02_P0', 'F06_P4', 'F10_P8']) {
        await clickPill(page, label);
        await waitForStatus(page, 'mesh.ply loaded');
        await new Promise(r => setTimeout(r, 400));
    }

    const rowCount = await page.$$eval('.subject-row', rows => rows.length);
    assert.equal(rowCount, 3, `Expected 3 roster rows, got ${rowCount}`);

    for (const id of ['F02_P0', 'F06_P4', 'F10_P8']) {
        const exists = await page.$(`[data-subject-id="${id}"]`).then(el => !!el);
        assert.ok(exists, `Row for ${id} should be present in roster`);
    }
});

test('TC-L09: remove button shows confirmation; cancel keeps the row', async () => {
    // Precondition: 3 rows from TC-L08

    // Click the × button on F02_P0's row
    await page.evaluate(() => {
        const row = document.querySelector('[data-subject-id="F02_P0"]');
        if (!row) throw new Error('F02_P0 row not found');
        const btn = row.querySelector('.remove-btn');
        if (!btn) throw new Error('.remove-btn not found in F02_P0 row');
        btn.click();
    });
    await new Promise(r => setTimeout(r, 200));

    // Confirmation dialog must appear inside the row
    const hasConfirm = await page.evaluate(() =>
        !!document.querySelector('[data-subject-id="F02_P0"] .remove-confirm'));
    assert.ok(hasConfirm, 'Removal confirmation should appear after clicking ×');

    // Click Cancel
    await page.evaluate(() => {
        const btn = document.querySelector('[data-subject-id="F02_P0"] .remove-confirm-no');
        if (!btn) throw new Error('.remove-confirm-no not found');
        btn.click();
    });
    await new Promise(r => setTimeout(r, 200));

    // Dialog gone, row still present
    const confirmGone = await page.evaluate(() =>
        !document.querySelector('[data-subject-id="F02_P0"] .remove-confirm'));
    assert.ok(confirmGone, 'Confirmation dialog should disappear after Cancel');

    const rowStillPresent = await page.$('[data-subject-id="F02_P0"]').then(el => !!el);
    assert.ok(rowStillPresent, 'F02_P0 row should still be present after Cancel');

    const rowCount = await page.$$eval('.subject-row', rows => rows.length);
    assert.equal(rowCount, 3, `Roster should still have 3 rows after cancel, got ${rowCount}`);
});

// ── Match step tests (M-01 through M-07) ─────────────────────────────────────
//
// Sequential; M-01 reloads to get a clean state with only one subject loaded.
// M-04 then loads the second subject and navigates to step 4.

const F02_ABS = path.join(PROJECT_ROOT, 'data/external/project/data/raw/meshes/F02_P0/mesh.ply');
const F06_ABS = path.join(PROJECT_ROOT, 'data/external/project/data/raw/meshes/F06_P4/mesh.ply');

test('M-01: step 4 panel renders after loading one subject', async () => {
    // Start clean: only F02_P0 loaded
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 300));

    await clickPill(page, 'F02_P0');
    await waitForStatus(page, 'mesh.ply loaded');
    await new Promise(r => setTimeout(r, 500));

    // Navigate to step 4
    await page.click('[data-step="4"]');
    await new Promise(r => setTimeout(r, 300));

    // Panel must contain the morph button (no JS error crash)
    const hasBtn = await page.$('#btn-run-morph').then(el => !!el);
    assert.ok(hasBtn, 'Step 4 panel should render #btn-run-morph without error');

    const hasMatchBtn = await page.$('#btn-run-match').then(el => !!el);
    assert.ok(hasMatchBtn, 'Step 4 panel should render #btn-run-match');

    // Ref/Mov subject pickers must be present
    const hasRefPicker = await page.$('#match-ref-select').then(el => !!el);
    assert.ok(hasRefPicker, '#match-ref-select should be present in step 4 panel');

    const hasMovPicker = await page.$('#match-mov-select').then(el => !!el);
    assert.ok(hasMovPicker, '#match-mov-select should be present in step 4 panel');
});

test('M-02: inputs checklist shows ✓ for ref, ✗ for mov and landmarks', async () => {
    // Precondition: step 4, only F02_P0 loaded (matchRefId=F02_P0, matchMovId=null)
    const checks = await page.evaluate(() => {
        const done    = [...document.querySelectorAll('#rpanel-content .pre-check.pre-done')]
                            .map(el => el.textContent.trim());
        const missing = [...document.querySelectorAll('#rpanel-content .pre-check.pre-missing')]
                            .map(el => el.textContent.trim());
        return { done, missing };
    });

    assert.ok(checks.done.some(t => t.includes('Ref')),
        `Ref should be ✓, done items: ${JSON.stringify(checks.done)}`);
    assert.ok(checks.missing.some(t => t.includes('Mov')),
        `Mov should be ✗, missing items: ${JSON.stringify(checks.missing)}`);
});

test('M-03: Run Morph button is disabled when Mov not selected', async () => {
    // Precondition: step 4, only one subject loaded → matchMovId is null
    const disabled = await page.$eval('#btn-run-morph', btn => btn.disabled);
    assert.ok(disabled, 'Run Morph should be disabled when Mov is not selected');
});

test('M-04: Run Morph enabled after loading both meshes with landmarks', async () => {
    // Load F06_P4 — roster model, no slot tab needed
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 200));
    await clickPill(page, 'F06_P4');
    await waitForStatus(page, 'mesh.ply loaded');
    await new Promise(r => setTimeout(r, 500));

    // Navigate to step 4 to re-render the panel
    // matchRefId auto-set to F02_P0, matchMovId auto-set to F06_P4
    await page.click('[data-step="4"]');
    await new Promise(r => setTimeout(r, 300));

    // Run Morph should now be enabled (both subjects have spheres + sulci)
    const disabled = await page.$eval('#btn-run-morph', btn => btn.disabled);
    assert.ok(!disabled, 'Run Morph should be enabled when both meshes + landmarks are loaded');
});

test('M-05: Run Morph completes, fills progress bar, and renders in viewer', async () => {
    // Precondition: step 4, F02_P0 (Ref) + F06_P4 (Mov) loaded with landmarks (from M-04)
    // Click Run Morph
    await page.click('#btn-run-morph');

    // Wait for morph to complete (status says "Morph done")
    await waitForStatus(page, 'Morph done', 30_000);
    await new Promise(r => setTimeout(r, 800));

    // Progress bar should have filled (parent visible, fill at 100%)
    const barState = await page.evaluate(() => {
        const wrap = document.getElementById('morph-progress');
        const fill = wrap?.querySelector('.progress-bar');
        return {
            wrapVisible: wrap?.style.display !== 'none',
            fillWidth:   fill?.style.width,
        };
    });
    assert.ok(barState.wrapVisible, 'Morph progress bar wrapper should be visible after run');
    assert.equal(barState.fillWidth, '100%', `Progress fill should be 100%, got ${barState.fillWidth}`);

    // ✓ result line should appear
    const hasDone = await page.evaluate(() =>
        [...document.querySelectorAll('.pre-check.pre-done')]
            .some(el => el.textContent.includes('morph.sphere.ply')));
    assert.ok(hasDone, '✓ morph.sphere.ply saved line should appear after morph');

    // Viewer should show non-background pixels (morph surface loaded)
    await new Promise(r => setTimeout(r, 500));
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show mesh after morph, got ${nonBg}/25`);
});

test('M-06: After morph, Run Match is enabled and k/nsteps controls present', async () => {
    // Precondition: morph completed (from M-05)
    const matchBtnDisabled = await page.$eval('#btn-run-match', btn => btn.disabled);
    assert.ok(!matchBtnDisabled, 'Run Match should be enabled after morph completes');

    const hasKSlider = await page.$('#match-k').then(el => !!el);
    assert.ok(hasKSlider, '#match-k slider should be present in match panel');

    // View mode toolbar should have Morph button enabled (retopology blend available)
    const viewBtns = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('.view-row .view-btn')];
        return btns.map(b => ({ label: b.textContent.trim(), disabled: b.disabled }));
    });
    const morphBtn = viewBtns.find(b => b.label === 'Morph');
    const matchViewBtn = viewBtns.find(b => b.label === 'Match');
    assert.ok(morphBtn && !morphBtn.disabled, 'Morph view button should be enabled after morph');
    assert.ok(matchViewBtn && matchViewBtn.disabled,
        'Match view button should be disabled until match runs');

    // Blend slider (#morph-blend) should be present after retopology
    const hasBlendSlider = await page.$('#morph-blend').then(el => !!el);
    assert.ok(hasBlendSlider, '#morph-blend slider should appear after morph completes');
});

test('M-07: Continue to View button absent before Match completes', async () => {
    // Precondition: morph done but Match not yet run (from M-06)
    // "Continue to View" button should NOT exist yet
    const hasContinue = await page.evaluate(() =>
        [...document.querySelectorAll('button')]
            .some(b => b.textContent.includes('Continue to View')));
    assert.ok(!hasContinue, '"Continue to View" should not appear before Match completes');

    // Run Match button should still be enabled
    const matchBtnDisabled = await page.$eval('#btn-run-match', btn => btn.disabled);
    assert.ok(!matchBtnDisabled, 'Run Match button should still be enabled');
});

// ── Match roster tests (M-08 through M-11) ───────────────────────────────────

test('M-08: Match panel always renders #btn-run-match regardless of roster', async () => {
    await page.evaluate(() => window.app.goStep(4));
    await new Promise(r => setTimeout(r, 800));

    const panelEl = await page.$('#btn-run-match');
    assert.ok(panelEl, 'Match panel should always render #btn-run-match');
});

test('M-09: Match roster renders rows when match directories exist on disk', async () => {
    // Seed a completed match directory via the server's file system
    const matchDir = path.join(
        PROJECT_ROOT,
        'data/external/project/data/derived/matches/F06_P4_as_F02_P0'
    );
    const fs = await import('node:fs/promises');
    await fs.mkdir(matchDir, { recursive: true });
    await fs.writeFile(path.join(matchDir, 'morph.sphere.ply'), 'PLY');
    await fs.writeFile(path.join(matchDir, 'surf.0.ply'), 'PLY');

    // Re-navigate to step 4 to trigger _loadExistingMatches
    await page.evaluate(() => window.app.goStep(1));
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => window.app.goStep(4));
    await new Promise(r => setTimeout(r, 1200));

    const rosterRows = await page.$$('.match-roster-row');
    assert.ok(rosterRows.length >= 1, 'At least one roster row should render');

    const nameText = await rosterRows[0].$eval('.match-roster-name', el => el.textContent);
    assert.ok(nameText.includes('→'), `Roster name should contain → separator, got: ${nameText}`);

    const loadBtn = await rosterRows[0].$('.roster-load-btn');
    assert.ok(loadBtn, 'Roster row should have a Load button');

    const delBtn = await rosterRows[0].$('.roster-del-btn');
    assert.ok(delBtn, 'Roster row should have a Delete (✕) button');

    // Cleanup
    await fs.rm(matchDir, { recursive: true, force: true });
});

test('M-10: Clicking Load on roster row populates ref/mov selectors', async () => {
    // Seed a completed match directory
    const matchDir = path.join(
        PROJECT_ROOT,
        'data/external/project/data/derived/matches/F06_P4_as_F02_P0'
    );
    const fs = await import('node:fs/promises');
    await fs.mkdir(matchDir, { recursive: true });
    // surf.0.ply must be a valid PLY to load via /api/mesh_raw — use a minimal one
    const minimalPly = [
        'ply', 'format ascii 1.0',
        'element vertex 3', 'property float x', 'property float y', 'property float z',
        'element face 1', 'property list uchar int vertex_indices',
        'end_header',
        '1 0 0', '0 1 0', '0 0 1',
        '3 0 1 2',
    ].join('\n');
    await fs.writeFile(path.join(matchDir, 'morph.sphere.ply'), minimalPly);
    await fs.writeFile(path.join(matchDir, 'surf.0.ply'), minimalPly);

    await page.evaluate(() => window.app.goStep(1));
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => window.app.goStep(4));
    await new Promise(r => setTimeout(r, 1200));

    const rosterRows = await page.$$('.match-roster-row');
    assert.ok(rosterRows.length >= 1, 'Roster row should be present');

    const loadBtn = await rosterRows[0].$('.roster-load-btn:not([disabled])');
    assert.ok(loadBtn, 'Load button should be enabled for a complete match');

    await loadBtn.click();
    await new Promise(r => setTimeout(r, 1500));

    const refVal = await page.$eval('#match-ref-select', el => el.value);
    assert.ok(refVal !== '', `Ref picker should be populated after load, got: "${refVal}"`);

    // Cleanup
    await fs.rm(matchDir, { recursive: true, force: true });
});

test('M-11: Delete ✕ shows confirmation; Cancel keeps the row', async () => {
    // Seed a match directory
    const matchDir = path.join(
        PROJECT_ROOT,
        'data/external/project/data/derived/matches/F06_P4_as_F02_P0'
    );
    const fs = await import('node:fs/promises');
    await fs.mkdir(matchDir, { recursive: true });
    await fs.writeFile(path.join(matchDir, 'morph.sphere.ply'), 'PLY');

    await page.evaluate(() => window.app.goStep(1));
    await new Promise(r => setTimeout(r, 200));
    await page.evaluate(() => window.app.goStep(4));
    await new Promise(r => setTimeout(r, 1200));

    const rosterRows = await page.$$('.match-roster-row');
    assert.ok(rosterRows.length >= 1, 'Roster row should be present before delete test');

    const delBtn = await rosterRows[0].$('.roster-del-btn');
    await delBtn.click();
    await new Promise(r => setTimeout(r, 300));

    const confirmEl = await page.$('.remove-confirm');
    assert.ok(confirmEl, 'Delete confirmation should appear after clicking ✕');

    const cancelBtn = await page.$('.remove-confirm-no');
    await cancelBtn.click();
    await new Promise(r => setTimeout(r, 300));

    const confirmElAfter = await page.$('.remove-confirm');
    assert.ok(!confirmElAfter, 'Confirmation should disappear after Cancel');

    const rowsAfter = await page.$$('.match-roster-row');
    assert.ok(rowsAfter.length > 0, 'Row should still be present after Cancel');

    // Cleanup
    await fs.rm(matchDir, { recursive: true, force: true });
});
