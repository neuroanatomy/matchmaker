/**
 * morph-unit.js — unit tests for frontend/components/morph.js
 *
 * Pure Node.js — no browser, no server required.
 * Run: node --test morph-unit.js  (or: npm run test:morph)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ae2sphere,
    sphere2ae,
    sulciToSbnLines,
    parseRotMat,
    applyRotation,
    sbnMorph,
    resampleMesh,
} from '../frontend/components/morph.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TOL = 1e-6;

function assertClose(a, b, tol = TOL, msg = '') {
    assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b} ± ${tol}`);
}

function assertVecClose(a, b, tol = TOL, label = '') {
    for (let i = 0; i < b.length; i++) {
        assertClose(a[i], b[i], tol, `${label}[${i}]`);
    }
}

// 12-vertex icosphere on the unit sphere
const PHI = (1 + Math.sqrt(5)) / 2;
function _ico() {
    const raw = [
        [-1, PHI, 0], [1, PHI, 0], [-1, -PHI, 0], [1, -PHI, 0],
        [0, -1, PHI], [0,  1, PHI], [0, -1, -PHI], [0,  1, -PHI],
        [PHI, 0, -1], [PHI, 0,  1], [-PHI, 0, -1], [-PHI, 0,  1],
    ];
    return raw.map(([x, y, z]) => {
        const n = Math.sqrt(x*x + y*y + z*z);
        return [x/n, y/n, z/n];
    });
}

// Simple landmark pair: a short arc from north pole toward the equator.
// AE coordinates: north pole = [0,0], equator along x = [π/2, 0]
const LINE_NORTH_TO_EQ = [
    { name: 'arc', p: [[0, 0], [Math.PI/2, 0]] },
];

// ── ae2sphere / sphere2ae ─────────────────────────────────────────────────────
// Note: morph.js uses AE (azimuthal-equidistant) throughout. sbn.js misleadingly
// calls this projection "stereographic", but no true stereographic conversion is
// needed since path0 in sulci.json is already stored in AE coordinates.

test('ae2sphere: north pole [0,0] maps to [0,0,1]', () => {
    assertVecClose(ae2sphere([0, 0]), [0, 0, 1]);
});

test('ae2sphere: equator along x [π/2,0] maps to unit sphere on equator', () => {
    const p = ae2sphere([Math.PI / 2, 0]);
    assertClose(p[0], 1, TOL, 'x');
    assertClose(p[1], 0, TOL, 'y');
    assertClose(p[2], 0, TOL, 'z');
});

test('ae2sphere: output is always on the unit sphere', () => {
    const samples = [[0, 0], [1, 0], [0, 1], [Math.PI/4, Math.PI/4], [Math.PI/2, 0]];
    for (const uv of samples) {
        const p = ae2sphere(uv);
        const n = Math.sqrt(p[0]*p[0] + p[1]*p[1] + p[2]*p[2]);
        assertClose(n, 1, TOL, `norm for ae2sphere([${uv}])`);
    }
});

test('sphere2ae → ae2sphere round-trip is identity', () => {
    for (const v of _ico()) {
        const uv  = sphere2ae(v);
        const p   = ae2sphere(uv);
        assertVecClose(p, v, 1e-6, `round-trip for [${v}]`);
    }
});

test('ae2sphere → sphere2ae round-trip is identity for in-range AE coords', () => {
    const coords = [[0, 0], [0.5, 0], [0, 0.5], [1, 1], [Math.PI/3, Math.PI/6]];
    for (const uv of coords) {
        const p   = ae2sphere(uv);
        const uv2 = sphere2ae(p);
        assertVecClose(uv2, uv, 1e-6, `round-trip for [${uv}]`);
    }
});

// ── stereographic.js delegation guard (fixes F7) ──────────────────────────────
// stereographic.js's _stereoToSphere/_sphereToStereo now delegate to ae2sphere/
// sphere2ae. These are the pre-refactor formulas (golden reference, computed
// inline so this test doesn't just re-check morph.js against itself) — if a
// future edit to ae2sphere/sphere2ae drifts from the original {x,y}/{x,y,z}
// math that stereographic.js relied on, this test catches it.

function _goldenStereoToSphere({ x, y }) {
    const b = x*x + y*y;
    if (b < 1e-10) return { x: 0, y: 0, z: 1 };
    const cosR = Math.cos(Math.sqrt(b));
    const sinR = Math.sqrt(Math.max(0, 1 - cosR*cosR));
    const f = sinR / Math.sqrt(b);
    return { x: x*f, y: y*f, z: cosR };
}

function _goldenSphereToStereo(p) {
    const len = Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z);
    if (len < 1e-10) return { x: 0, y: 0 };
    const pz = Math.max(-1, Math.min(1, p.z / len));
    const b = Math.acos(pz), a = Math.atan2(p.y, p.x);
    return { x: b*Math.cos(a), y: b*Math.sin(a) };
}

test('ae2sphere matches golden _stereoToSphere for sample AE points', () => {
    const samples = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 0, y: 0.5 }, { x: 1, y: 1 }, { x: Math.PI/3, y: Math.PI/6 }];
    for (const { x, y } of samples) {
        const golden = _goldenStereoToSphere({ x, y });
        const [px, py, pz] = ae2sphere([x, y]);
        assertClose(px, golden.x, TOL, `x for [${x},${y}]`);
        assertClose(py, golden.y, TOL, `y for [${x},${y}]`);
        assertClose(pz, golden.z, TOL, `z for [${x},${y}]`);
    }
});

test('sphere2ae matches golden _sphereToStereo for sample sphere points', () => {
    for (const v of _ico()) {
        const golden = _goldenSphereToStereo({ x: v[0], y: v[1], z: v[2] });
        const [x, y] = sphere2ae(v);
        assertClose(x, golden.x, TOL, `x for [${v}]`);
        assertClose(y, golden.y, TOL, `y for [${v}]`);
    }
});

// ── sulciToSbnLines ──────────────────────────────────────────────────────────

test('sulciToSbnLines: empty input returns []', () => {
    assert.deepEqual(sulciToSbnLines([]), []);
    assert.deepEqual(sulciToSbnLines(null), []);
});

test('sulciToSbnLines: skips regions with fewer than 2 path0 points', () => {
    const sulci = [
        { name: 'short', path0: [{ px: 0, py: 0 }] },
        { name: 'ok',    path0: [{ px: 1, py: 0 }, { px: 0, py: 1 }] },
    ];
    const result = sulciToSbnLines(sulci);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'ok');
});

test('sulciToSbnLines: converts path0 {px,py} to [px,py] pairs', () => {
    const sulci = [{
        name: 'IHF',
        path0: [
            { px: -1.84, py: -1.31 },
            { px: -0.5,  py:  0.2  },
        ],
        selected: false,
    }];
    const result = sulciToSbnLines(sulci);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, 'IHF');
    assertVecClose(result[0].p[0], [-1.84, -1.31]);
    assertVecClose(result[0].p[1], [-0.5,   0.2]);
});

// ── parseRotMat ──────────────────────────────────────────────────────────────

test('parseRotMat: 4×4 identity matrix returns flat identity 3×3', () => {
    const txt = '1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1';
    const R = parseRotMat(txt);
    assert.deepEqual(R, [1, 0, 0,  0, 1, 0,  0, 0, 1]);
});

test('parseRotMat: 3×3 input also works', () => {
    const txt = '1 0 0\n0 1 0\n0 0 1';
    const R = parseRotMat(txt);
    assert.deepEqual(R, [1, 0, 0,  0, 1, 0,  0, 0, 1]);
});

test('parseRotMat: extracts top-left 3×3 from 4×4', () => {
    // rotation.txt from F02_P0 (first row)
    const txt = [
        '-0.285 0.954 -0.096 0',
        '-0.682 -0.131 0.720 0',
        '0.674 0.271 0.687 0',
        '0 0 0 1',
    ].join('\n');
    const R = parseRotMat(txt);
    assert.equal(R.length, 9);
    assertClose(R[0], -0.285, 1e-3, 'R[0]');
    assertClose(R[3], -0.682, 1e-3, 'R[3]');
    assertClose(R[8],  0.687, 1e-3, 'R[8]');
});

// ── applyRotation ────────────────────────────────────────────────────────────

test('applyRotation: identity matrix returns input unchanged', () => {
    const verts = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const I = [1, 0, 0,  0, 1, 0,  0, 0, 1];
    const result = applyRotation(verts, I);
    for (let i = 0; i < verts.length; i++) {
        assertVecClose(result[i], verts[i], TOL, `vertex ${i}`);
    }
});

test('applyRotation: Rz(90°) maps [1,0,0]→[0,1,0] and [0,1,0]→[-1,0,0]', () => {
    // Rz(90°): x→y, y→-x, z→z
    const Rz90 = [0, -1, 0,   1, 0, 0,   0, 0, 1];
    const verts = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const result = applyRotation(verts, Rz90);
    assertVecClose(result[0], [ 0, 1, 0], TOL, 'x→y');
    assertVecClose(result[1], [-1, 0, 0], TOL, 'y→-x');
    assertVecClose(result[2], [ 0, 0, 1], TOL, 'z→z');
});

test('applyRotation: preserves vector norms', () => {
    const Rz90 = [0, -1, 0,   1, 0, 0,   0, 0, 1];
    const verts = _ico();
    const result = applyRotation(verts, Rz90);
    for (const v of result) {
        const n = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        assertClose(n, 1, TOL, 'norm');
    }
});

// ── sbnMorph ─────────────────────────────────────────────────────────────────

test('sbnMorph: empty l1 returns copy of input', () => {
    const verts = [[1, 0, 0], [0, 1, 0]];
    const result = sbnMorph([], [], verts);
    assert.equal(result.length, 2);
    assertVecClose(result[0], [1, 0, 0]);
    assertVecClose(result[1], [0, 1, 0]);
});

test('sbnMorph: no matching landmark names returns copy of input', () => {
    const l1 = [{ name: 'A', p: [[0, 0], [Math.PI/4, 0]] }];
    const l2 = [{ name: 'B', p: [[0, 0], [Math.PI/4, 0]] }];
    const verts = [[1, 0, 0], [0, 1, 0]];
    const result = sbnMorph(l1, l2, verts);
    assertVecClose(result[0], [1, 0, 0]);
    assertVecClose(result[1], [0, 1, 0]);
});

test('sbnMorph: identity landmarks (l1 === l2) preserves vertex positions', () => {
    const l = LINE_NORTH_TO_EQ;
    const verts = _ico();
    const result = sbnMorph(l, l, verts);
    assert.equal(result.length, verts.length);
    for (let i = 0; i < verts.length; i++) {
        assertVecClose(result[i], verts[i], 1e-4, `vertex ${i}`);
    }
});

test('sbnMorph: output vertices stay on the unit sphere', () => {
    // Use two non-identical lines to produce an actual deformation
    const l1 = [{ name: 'arc', p: [[0, 0], [Math.PI/3, 0]] }];
    const l2 = [{ name: 'arc', p: [[0, 0], [Math.PI/4, Math.PI/8]] }];
    const verts = _ico();
    const result = sbnMorph(l1, l2, verts);
    assert.equal(result.length, verts.length);
    for (const v of result) {
        const n = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
        assertClose(n, 1, 1e-4, 'output vertex norm');
    }
});

// ── resampleMesh ─────────────────────────────────────────────────────────────

// Icosphere faces (20 triangles of the 12-vertex icosphere)
const ICO_FACES = [
    [0,11,5],[0,5,1],[0,1,7],[0,7,10],[0,10,11],
    [1,5,9],[5,11,4],[11,10,2],[10,7,6],[7,1,8],
    [3,9,4],[3,4,2],[3,2,6],[3,6,8],[3,8,9],
    [4,9,5],[2,4,11],[6,2,10],[8,6,7],[9,8,1],
];

test('resampleMesh: identity (sphere = native, morphed = original) returns same vertices', () => {
    const sphere = _ico();
    const native = sphere.map(v => v.map(x => x * 10)); // native is 10× larger
    // morphedVerts === sphere (no morph applied)
    // refSphereVerts === sphere (same mesh)
    // For each ref vertex, resampleMesh should find its own triangle and return native[i]
    const remeshed = resampleMesh(ICO_FACES, sphere, native, sphere);
    assert.equal(remeshed.length, sphere.length, 'output length matches ref sphere vertex count');
    for (let i = 0; i < sphere.length; i++) {
        // Each ref vertex lands on itself → native vertex should be native[i]
        const got = remeshed[i];
        assertVecClose(got, native[i], 1e-4, `vertex ${i}`);
    }
});

test('resampleMesh: shifted morph maps each ref vertex to shifted native position', () => {
    // All morphed sphere vertices are the same as the ref sphere (no deformation).
    // movNativeVerts are shifted by [1,0,0].
    const sphere = _ico();
    const shift = [1, 0, 0];
    const shiftedNative = sphere.map(([x, y, z]) => [x + shift[0], y + shift[1], z + shift[2]]);
    const remeshed = resampleMesh(ICO_FACES, sphere, shiftedNative, sphere);
    assert.equal(remeshed.length, sphere.length);
    for (let i = 0; i < sphere.length; i++) {
        assertVecClose(remeshed[i], shiftedNative[i], 1e-3, `vertex ${i} shifted`);
    }
});

test('resampleMesh: output count equals refSphereVerts count (can differ from morphed)', () => {
    // Use a subset of the icosphere as ref (only vertices 0-5)
    const sphere = _ico();
    const native = sphere.map(v => [v[0]*5, v[1]*5, v[2]*5]);
    const refSubset = sphere.slice(0, 6);  // 6 ref vertices
    const remeshed = resampleMesh(ICO_FACES, sphere, native, refSubset);
    assert.equal(remeshed.length, 6, 'output has one entry per ref vertex');
});
