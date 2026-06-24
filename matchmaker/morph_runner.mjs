/**
 * morph_runner.mjs — CLI wrapper around morph.js for use as a subprocess.
 *
 * Called by match_pair.py (and pipeline.run_match in future).
 * Reads JSON from stdin:
 *   { vertices: [[x,y,z],...], faces: [[a,b,c],...],
 *     sulci_mov_path, sulci_ref_path,
 *     rot_ref_path?,   rot_mov_path? }
 * Writes JSON to stdout:
 *   { vertices: [[x,y,z],...] }
 *
 * Dual-rotation + Bezier-flattening convention (matches original morph.js):
 *   sulciToSbnLinesVR applies rotRef (v@R) to REF landmarks + Bezier flattening.
 *   sulciToSbnLinesVR applies rotMov (v@R) to MOV landmarks + Bezier flattening.
 *   rotateVertsVR applies rotRef (v@R) to REF sphere vertices.
 *   Output is already in rotRef frame — callers must NOT apply additional rotation.
 */
import { readFileSync } from 'fs';
import { parseRotMat, rotateVertsVR, sulciToSbnLinesVR, sbnMorph }
    from '../frontend/components/morph.js';

const input = JSON.parse(readFileSync('/dev/stdin', 'utf8'));

const sulciMov = JSON.parse(readFileSync(input.sulci_mov_path, 'utf8'));
const sulciRef = JSON.parse(readFileSync(input.sulci_ref_path, 'utf8'));

let R_ref = null, R_mov = null;
if (input.rot_ref_path) R_ref = parseRotMat(readFileSync(input.rot_ref_path, 'utf8'));
if (input.rot_mov_path) R_mov = parseRotMat(readFileSync(input.rot_mov_path, 'utf8'));

// sulciToSbnLinesVR handles rotation + Bezier flattening (matches original morph.js lineset + flatten).
const l1 = sulciToSbnLinesVR(sulciRef, R_ref);   // REF landmarks, rotated by rotRef
const l2 = sulciToSbnLinesVR(sulciMov, R_mov);   // MOV landmarks, rotated by rotMov

// Normalize to exact unit sphere (matches reference's direction() call).
// Mean-centering by the pipeline can shift norms to 0.994–1.006, causing
// dot(p,x) > 1 → acos(NaN) in weight computation.
const _n = (v) => { const r = Math.sqrt(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]); return [v[0]/r,v[1]/r,v[2]/r]; };
const unitVerts = input.vertices.map(_n);

// Rotate REF sphere vertices by rotRef (v@R).
const verts = R_ref ? rotateVertsVR(unitVerts, R_ref) : unitVerts;

// Output is already in rotRef frame — no post-rotation needed.
const morphed = sbnMorph(l1, l2, verts);
process.stdout.write(JSON.stringify({ vertices: morphed }));
