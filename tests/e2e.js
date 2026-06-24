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
const MESH_REL_PATH = 'data/external/F02_P0/seg-pial-t2/e2.ply';
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

// Click a slot tab ('ref' or 'mov') in the Load panel.
async function clickSlotTab(page, slot) {
    await page.evaluate((slot) => {
        const btn = [...document.querySelectorAll('.slot-tab')]
            .find(b => b.textContent.toLowerCase().includes(slot));
        if (!btn) throw new Error(`Slot tab for "${slot}" not found`);
        btn.click();
    }, slot);
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
        path.join(PROJECT_ROOT, 'data/external/F02_P0/seg-pial-t2')
    )}`);
    const entries = await res.json();
    const names = entries.map(e => e.name);
    assert.ok(names.includes('e2.ply'), `e2.ply not found in listing, got: ${names}`);
});

test('/api/mesh serves e2.ply with correct PLY header', async () => {
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

test('e2.ply loads and renders non-background pixels', async () => {
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

    // Wait for companions to arrive (sphere companion makes "e2.sphere.ply" appear in panel)
    await page.waitForFunction(() => {
        const items = [...document.querySelectorAll('.sph-item')];
        return items.some(el => el.textContent.includes('e2.sphere.ply'));
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

// ── Load step tests (TC-L01 through TC-L07) ──────────────────────────────────
//
// These tests are sequential and share page state. They start from a known
// state: step 1 active, both slots empty (achieved by reloading the page
// before TC-L01 and relying on sequential ordering thereafter).
//
// Camera default position: [0, 0, 3] (set in Viewer3D._initRenderer).

test('TC-L01: loading Ref shows native mesh in single-mesh mode', async () => {
    // Start clean at step 1
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 300));

    // Ref tab should be active by default; load F02_P0
    await clickPill(page, 'F02_P0');
    await waitForStatus(page, 'REF loaded');
    await new Promise(r => setTimeout(r, 500));

    // Viewer must be in single-mesh mode only
    const meshState = await page.evaluate(() => ({
        hasMain: window._viewer._meshes.has('main'),
        hasRef:  window._viewer._meshes.has('ref'),
        hasMov:  window._viewer._meshes.has('mov'),
    }));
    assert.ok(meshState.hasMain, 'Viewer should use single-mesh slot "main"');
    assert.ok(!meshState.hasRef, 'Pair-mode "ref" slot should be absent');
    assert.ok(!meshState.hasMov, 'Pair-mode "mov" slot should be absent');

    // Panel must show active native mesh item
    const activeText = await page.$eval('.sph-item-active', el => el.textContent.trim())
        .catch(() => '');
    assert.ok(activeText.includes('e2.ply'), `Active mesh item should be e2.ply, got "${activeText}"`);

    // Mesh must be visible
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show non-background pixels after load, got ${nonBg}/25`);
});

test('TC-L02: loading Mov slot shows only Mov in single-mesh mode (no pair overlay)', async () => {
    // Precondition: Ref loaded (TC-L01). Switch to Mov tab and load F06_P4.
    await clickSlotTab(page, 'mov');
    await new Promise(r => setTimeout(r, 200));

    await clickPill(page, 'F06_P4');
    await waitForStatus(page, 'MOV loaded');
    await new Promise(r => setTimeout(r, 500));

    const meshState = await page.evaluate(() => ({
        hasMain: window._viewer._meshes.has('main'),
        hasRef:  window._viewer._meshes.has('ref'),
        hasMov:  window._viewer._meshes.has('mov'),
    }));
    assert.ok(meshState.hasMain, 'Viewer should use single-mesh slot after loading Mov');
    assert.ok(!meshState.hasRef,  'Pair-mode "ref" slot must be absent');
    assert.ok(!meshState.hasMov,  'Pair-mode "mov" slot must be absent');

    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show Mov mesh, got ${nonBg}/25`);
});

test('TC-L03: switching slot tabs updates the viewer', async () => {
    // Precondition: both Ref (F02_P0) and Mov (F06_P4) loaded. Currently on Mov.

    // Switch to Ref
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 800));

    let hasMain = await page.evaluate(() => window._viewer._meshes.has('main'));
    assert.ok(hasMain, 'Viewer should have main mesh after switching to Ref tab');

    let activeTab = await page.$eval('.slot-tab.active', el => el.textContent.trim());
    assert.ok(activeTab.toLowerCase().includes('ref'), `Ref tab should be active, got "${activeTab}"`);

    let nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show Ref mesh after tab switch, got ${nonBg}/25`);

    // Switch back to Mov
    await clickSlotTab(page, 'mov');
    await new Promise(r => setTimeout(r, 800));

    activeTab = await page.$eval('.slot-tab.active', el => el.textContent.trim());
    assert.ok(activeTab.toLowerCase().includes('mov'), `Mov tab should be active, got "${activeTab}"`);

    nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Viewer should show Mov mesh after switching back, got ${nonBg}/25`);
});

test('TC-L04: tab switch preserves camera; geometry-type change resets it', async () => {
    // Start on Ref tab
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 800));

    // Set a known non-default camera position
    await page.evaluate(() => {
        window._viewer.camera.position.set(0, 0, 5);
        window._viewer.controls.update();
    });

    // Switch to Mov tab (preserveOrientation: true → camera must NOT reset)
    await clickSlotTab(page, 'mov');
    await new Promise(r => setTimeout(r, 800));

    // Switch back to Ref (preserveOrientation: true → camera must NOT reset)
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 800));

    const camZ = await page.evaluate(() => window._viewer.camera.position.z);
    assert.ok(Math.abs(camZ - 5) < 0.5,
        `Camera z should be ~5 after tab switch (preserved), got ${camZ.toFixed(3)}`);

    // Now click a DIFFERENT geometry (sphere) — camera MUST reset to ~[0,0,3]
    const hasSphere = await page.evaluate(() =>
        [...document.querySelectorAll('.sph-item.sph-clickable')]
            .some(el => el.textContent.includes('e2.sphere.ply')));

    if (hasSphere) {
        await page.evaluate(() => {
            const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
                .find(el => el.textContent.includes('e2.sphere.ply'));
            el?.click();
        });
        await new Promise(r => setTimeout(r, 1200));

        const camZAfter = await page.evaluate(() => window._viewer.camera.position.z);
        assert.ok(Math.abs(camZAfter - 3) < 0.5,
            `Camera z should reset to ~3 on geometry change, got ${camZAfter.toFixed(3)}`);
    }
});

test('TC-L05: texture toggle preserves camera orientation', async () => {
    // Start on Ref tab with native mesh (camera already at default after TC-L04 geometry switch)
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 500));

    // Ensure native mesh is shown (click it if sphere is currently active)
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('e2.ply') && !el.textContent.includes('sphere'));
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
    // Start on Ref tab with native mesh active
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 500));

    // Click native mesh to ensure it's active
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('e2.ply') && !el.textContent.includes('sphere'));
        el?.click();
    });
    await new Promise(r => setTimeout(r, 800));

    // Set a non-default camera position
    await page.evaluate(() => {
        window._viewer.camera.position.set(0, 0, 6);
        window._viewer.controls.update();
    });

    // Click the native mesh AGAIN — should be a no-op
    await page.evaluate(() => {
        const el = [...document.querySelectorAll('.sph-item.sph-clickable')]
            .find(el => el.textContent.includes('e2.ply') && !el.textContent.includes('sphere'));
        el?.click();
    });
    await new Promise(r => setTimeout(r, 400));

    const camZ = await page.evaluate(() => window._viewer.camera.position.z);
    assert.ok(Math.abs(camZ - 6) < 0.5,
        `Camera should not reset when clicking already-active geometry, got z=${camZ.toFixed(3)}`);
});

test('TC-L07: reloading a slot resets its companion state and resets the camera', async () => {
    // Precondition: Ref loaded as F02_P0 with sphere companion visible
    await clickSlotTab(page, 'ref');
    await new Promise(r => setTimeout(r, 400));

    const hasSphere = await page.evaluate(() =>
        [...document.querySelectorAll('.sph-item')]
            .some(el => el.textContent.includes('e2.sphere.ply')));
    assert.ok(hasSphere, 'F02_P0 should have sphere companion in panel before reload');

    // Set non-default camera
    await page.evaluate(() => {
        window._viewer.camera.position.set(3, 3, 3);
        window._viewer.controls.update();
    });

    // Reload Ref with F10_P8
    await clickPill(page, 'F10_P8');
    await waitForStatus(page, 'REF loaded');
    await new Promise(r => setTimeout(r, 800));

    // Camera must have reset (fresh load)
    const camZ = await page.evaluate(() => window._viewer.camera.position.z);
    assert.ok(Math.abs(camZ - 3) < 0.5,
        `Camera z should reset to ~3 on slot reload, got ${camZ.toFixed(3)}`);

    // Viewer still in single-mesh mode
    const meshState = await page.evaluate(() => ({
        hasMain: window._viewer._meshes.has('main'),
        hasRef:  window._viewer._meshes.has('ref'),
    }));
    assert.ok(meshState.hasMain, 'Viewer should be in single-mesh mode after reload');
    assert.ok(!meshState.hasRef,  'Pair-mode ref slot should be absent after reload');

    // New mesh visible
    const nonBg = await countNonBgPixelsMain(page);
    assert.ok(nonBg > 0, `Reloaded mesh should be visible, got ${nonBg}/25`);
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

// ── Match step tests (M-01 through M-04) ─────────────────────────────────────
//
// Sequential; M-01 reloads to get a clean state with only Ref loaded.
// M-04 then loads Mov and re-navigates to step 4.

const F02_ABS = path.join(PROJECT_ROOT, 'data/external/F02_P0/seg-pial-t2/e2.ply');
const F06_ABS = path.join(PROJECT_ROOT, 'data/external/F06_P4/seg-pial-t2/e2.ply');

test('M-01: step 4 panel renders after loading Ref only', async () => {
    // Start clean: only Ref loaded
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 300));

    await clickPill(page, 'F02_P0');
    await waitForStatus(page, 'REF loaded');
    await new Promise(r => setTimeout(r, 500));

    // Navigate to step 4
    await page.click('[data-step="4"]');
    await new Promise(r => setTimeout(r, 300));

    // Panel must contain the morph button (no JS error crash)
    const hasBtn = await page.$('#btn-run-morph').then(el => !!el);
    assert.ok(hasBtn, 'Step 4 panel should render #btn-run-morph without error');

    const hasMatchBtn = await page.$('#btn-run-match').then(el => !!el);
    assert.ok(hasMatchBtn, 'Step 4 panel should render #btn-run-match');
});

test('M-02: inputs checklist shows ✓ for ref, ✗ for mov and landmarks', async () => {
    // Precondition: step 4, only Ref (F02_P0) loaded
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

test('M-03: Run Morph button is disabled when Mov not loaded', async () => {
    // Precondition: step 4, only Ref loaded
    const disabled = await page.$eval('#btn-run-morph', btn => btn.disabled);
    assert.ok(disabled, 'Run Morph should be disabled when Mov is not loaded');
});

test('M-04: Run Morph enabled after loading both meshes with landmarks', async () => {
    // Load Mov (F06_P4 has sulci.json, so sulciMov will be auto-discovered)
    await page.click('[data-step="1"]');
    await new Promise(r => setTimeout(r, 200));
    await clickSlotTab(page, 'mov');
    await new Promise(r => setTimeout(r, 200));
    await clickPill(page, 'F06_P4');
    await waitForStatus(page, 'MOV loaded');
    await new Promise(r => setTimeout(r, 500));

    // Navigate to step 4 to re-render the panel
    await page.click('[data-step="4"]');
    await new Promise(r => setTimeout(r, 300));

    // Run Morph should now be enabled (both sulciRef + sulciMov are set)
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

    // Viewer should show non-background pixels (overlay mode loaded)
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

    // View mode toolbar should have Morph and Overlay buttons enabled
    const viewBtns = await page.evaluate(() => {
        const btns = [...document.querySelectorAll('.view-row .view-btn')];
        return btns.map(b => ({ label: b.textContent.trim(), disabled: b.disabled }));
    });
    const morphBtn = viewBtns.find(b => b.label === 'Morph');
    const overlayBtn = viewBtns.find(b => b.label === 'Overlay');
    assert.ok(morphBtn && !morphBtn.disabled, 'Morph view button should be enabled after morph');
    assert.ok(overlayBtn && !overlayBtn.disabled, 'Overlay view button should be enabled after morph');

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
