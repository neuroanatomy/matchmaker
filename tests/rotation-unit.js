/**
 * rotation-unit.js — unit tests for the Euler decompose/recompose math
 * used by StereoView.getEulerZYX() and StereoView.setEulerZYX().
 *
 * Pure Node.js — no browser, no server required.
 * Run: node --test rotation-unit.js  (or: npm run test:unit)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    _matMul3,
    eulerZYXToMatrix as _eulerToMatrix,
    matrixToEulerZYX as _matrixToEuler,
} from '../frontend/components/stereoview.js';

// ── Imported from stereoview.js (real implementation, not a copy) ────────────
//
// Previously this file hand-copied the formulas below to test them "in
// isolation," since StereoView.getEulerZYX()/setEulerZYX() were private
// methods with no exported pure functions. That meant a regression in the
// real math would not be caught here — only a bug in the copy would be.
// stereoview.js now exports eulerZYXToMatrix/matrixToEulerZYX/_matMul3 as
// pure functions that the class methods delegate to (docs/29 Phase 0b, F8).

// ── Helpers ───────────────────────────────────────────────────────────────────

const TOL = 1e-9;
const DEG_TOL = 1; // rounding to integer degrees can shift by ±1°

function assertClose(a, b, tol = TOL, msg = '') {
    assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b} ± ${tol}`);
}

function assertMatrixClose(actual, expected, tol = TOL, label = '') {
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            assertClose(actual[i][j], expected[i][j], tol,
                `${label} R[${i}][${j}]`);
}

function assertEulerClose(actual, expected, tol = DEG_TOL, label = '') {
    assertClose(actual.alpha, expected.alpha, tol, `${label} alpha`);
    assertClose(actual.beta,  expected.beta,  tol, `${label} beta`);
    assertClose(actual.gamma, expected.gamma, tol, `${label} gamma`);
}

// ── Matrix construction tests ─────────────────────────────────────────────────

test('identity angles produce identity matrix', () => {
    const R = _eulerToMatrix(0, 0, 0);
    assertMatrixClose(R, [[1,0,0],[0,1,0],[0,0,1]], TOL, 'identity');
});

test('twist=90 produces Rz(90°): x→y, y→-x, z→z', () => {
    const R = _eulerToMatrix(90, 0, 0);
    assertMatrixClose(R, [
        [ 0, -1, 0],
        [ 1,  0, 0],
        [ 0,  0, 1],
    ], TOL, 'Rz90');
});

test('twist=180 produces Rz(180°): x→-x, y→-y, z→z', () => {
    const R = _eulerToMatrix(180, 0, 0);
    assertMatrixClose(R, [
        [-1,  0, 0],
        [ 0, -1, 0],
        [ 0,  0, 1],
    ], TOL, 'Rz180');
});

test('tilt↕=90 produces Ry(90°): z→x, x→-z, y→y', () => {
    const R = _eulerToMatrix(0, 90, 0);
    assertMatrixClose(R, [
        [ 0, 0, 1],
        [ 0, 1, 0],
        [-1, 0, 0],
    ], TOL, 'Ry90');
});

test('spin↔=90 produces Rx(90°): y→z, z→-y, x→x', () => {
    const R = _eulerToMatrix(0, 0, 90);
    assertMatrixClose(R, [
        [1,  0, 0],
        [0,  0,-1],
        [0,  1, 0],
    ], TOL, 'Rx90');
});

test('each axis rotation is orthogonal (R·Rᵀ = I)', () => {
    for (const [a, b, g] of [[90,0,0],[0,45,0],[0,0,-60],[30,45,-90]]) {
        const R = _eulerToMatrix(a, b, g);
        const Rt = [[0,0,0],[0,0,0],[0,0,0]];
        for (let i=0;i<3;i++) for (let j=0;j<3;j++) Rt[i][j] = R[j][i];
        const RRt = _matMul3(R, Rt);
        assertMatrixClose(RRt, [[1,0,0],[0,1,0],[0,0,1]], 1e-10,
            `orthogonality (${a},${b},${g})`);
    }
});

// ── Round-trip tests ──────────────────────────────────────────────────────────

test('round-trip (0, 0, 0)', () => {
    const R = _eulerToMatrix(0, 0, 0);
    assertEulerClose(_matrixToEuler(R), { alpha:0, beta:0, gamma:0 }, DEG_TOL, '(0,0,0)');
});

test('round-trip (45, 30, -60)', () => {
    const R = _eulerToMatrix(45, 30, -60);
    assertEulerClose(_matrixToEuler(R), { alpha:45, beta:30, gamma:-60 }, DEG_TOL, '(45,30,-60)');
});

test('round-trip (180, 0, 0) — maximum twist', () => {
    const R = _eulerToMatrix(180, 0, 0);
    const e = _matrixToEuler(R);
    // atan2 can return +180 or -180 for the same rotation; accept both
    assert.ok(Math.abs(Math.abs(e.alpha) - 180) <= DEG_TOL,
        `alpha should be ±180, got ${e.alpha}`);
    assertClose(e.beta,  0, DEG_TOL, 'beta');
    assertClose(e.gamma, 0, DEG_TOL, 'gamma');
});

test('round-trip (-90, 0, 0) — negative twist', () => {
    const R = _eulerToMatrix(-90, 0, 0);
    assertEulerClose(_matrixToEuler(R), { alpha:-90, beta:0, gamma:0 }, DEG_TOL, '(-90,0,0)');
});

test('round-trip (0, 0, -45) — negative spin', () => {
    const R = _eulerToMatrix(0, 0, -45);
    assertEulerClose(_matrixToEuler(R), { alpha:0, beta:0, gamma:-45 }, DEG_TOL, '(0,0,-45)');
});

test('round-trip (120, -30, 75)', () => {
    const R = _eulerToMatrix(120, -30, 75);
    assertEulerClose(_matrixToEuler(R), { alpha:120, beta:-30, gamma:75 }, DEG_TOL, '(120,-30,75)');
});

test('round-trip near gimbal lock (0, 89, 0)', () => {
    const R = _eulerToMatrix(0, 89, 0);
    const e = _matrixToEuler(R);
    assertClose(e.beta, 89, DEG_TOL, 'beta near-gimbal');
    assert.ok(isFinite(e.alpha) && isFinite(e.gamma), 'alpha and gamma should be finite');
});

// ── Gimbal-lock edge case ─────────────────────────────────────────────────────

test('gimbal lock (0, 90, 0) returns finite values without throwing', () => {
    const R = _eulerToMatrix(0, 90, 0);
    const e = _matrixToEuler(R);
    assert.ok(isFinite(e.alpha), `alpha finite, got ${e.alpha}`);
    assert.ok(isFinite(e.beta),  `beta finite, got ${e.beta}`);
    assert.ok(isFinite(e.gamma), `gamma finite, got ${e.gamma}`);
    assertClose(e.beta, 90, DEG_TOL, 'beta at gimbal lock');
});

test('gimbal lock (45, 90, 30): all DOF collapse, no throw', () => {
    assert.doesNotThrow(() => {
        const R = _eulerToMatrix(45, 90, 30);
        const e = _matrixToEuler(R);
        assert.ok(isFinite(e.alpha) && isFinite(e.beta) && isFinite(e.gamma));
        assertClose(e.beta, 90, DEG_TOL, 'beta at gimbal lock');
    });
});

// ── matMul3 sanity ────────────────────────────────────────────────────────────

test('matMul3: identity × A = A', () => {
    const I = [[1,0,0],[0,1,0],[0,0,1]];
    const A = [[1,2,3],[4,5,6],[7,8,9]];
    assertMatrixClose(_matMul3(I, A), A, TOL, 'I×A');
});

test('matMul3: Rz(90)·Rz(90) = Rz(180)', () => {
    const Rz90  = _eulerToMatrix(90,  0, 0);
    const Rz180 = _eulerToMatrix(180, 0, 0);
    assertMatrixClose(_matMul3(Rz90, Rz90), Rz180, TOL, 'Rz90²=Rz180');
});
