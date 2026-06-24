/**
 * morph.js — Spherical Beier-Neely (SBN) morph for MatchMaker
 *
 * Ported from stereographic/sbn.js + stereographic/linalg.js.
 * All landmark coordinates use the azimuthal-equidistant (AE) projection:
 *   u = r_ae * cos(phi),  v = r_ae * sin(phi)
 *   where r_ae = acos(z) is the polar angle from the north pole.
 *
 * Note: sbn.js names its AE functions "stereographic" — a misnomer.
 * The projection here is AE (theta = r), not true stereographic (r = tan(theta/2)).
 * path0 in sulci.json stores AE coordinates {px, py}, so no conversion is needed.
 */

// ── Vector math ──────────────────────────────────────────────────────────────

function _norm3D(a) { return Math.sqrt(a[0]*a[0] + a[1]*a[1] + a[2]*a[2]); }
function _add3D(a, b) { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function _sub3D(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function _sca3D(a, t) { return [a[0]*t, a[1]*t, a[2]*t]; }
function _dot3D(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function _cross3D(a, b) {
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function _direction(p) {
    const n = _norm3D(p);
    return [p[0]/n, p[1]/n, p[2]/n];
}
function _clip(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

// ── AE ↔ sphere (matches sbn.js's "stereographic" functions) ─────────────────
// Note: sbn.js calls these "stereographic" but the projection is azimuthal-equidistant
// (theta = r, not r = tan(theta/2)). path0 in sulci.json is already in AE, so no
// conversion to true stereographic is ever needed.

export function ae2sphere(uv) {
    const b = Math.sqrt(uv[0]*uv[0] + uv[1]*uv[1]);
    if (b < 1e-10) return [0, 0, 1];
    const z = Math.cos(b);
    const f = Math.sqrt(1 - z*z);
    return [uv[0]*f/b, uv[1]*f/b, z];
}

export function sphere2ae(p) {
    const phi = Math.atan2(p[1], p[0]);
    const b   = Math.acos(_clip(p[2] / _norm3D(p), -1, 1));
    return [b*Math.cos(phi), b*Math.sin(phi)];
}

// ── Public helpers ───────────────────────────────────────────────────────────

/**
 * Parse rotation.txt content.
 * Accepts a 4×4 matrix (takes top-left 3×3) or a plain 3×3 matrix.
 *
 * @param {string} txt  whitespace-delimited numbers
 * @returns {number[]}  flat 9-element row-major rotation matrix
 */
export function parseRotMat(txt) {
    const nums = txt.trim().split(/\s+/).map(Number).filter(n => !isNaN(n));
    if (nums.length < 9) throw new Error('rotation.txt has fewer than 9 numbers');
    const stride = nums.length >= 16 ? 4 : 3;
    return [
        nums[0],          nums[1],          nums[2],
        nums[stride],     nums[stride+1],   nums[stride+2],
        nums[2*stride],   nums[2*stride+1], nums[2*stride+2],
    ];
}

/**
 * Apply v@R (row-vector convention, same as matchmesh2's Smov.dot(rot)) to sphere vertices.
 *
 * @param {Array<[number,number,number]>} vertices
 * @param {number[]} R9  flat 9-element row-major rotation matrix
 * @returns {Array<[number,number,number]>}
 */
export function rotateVertsVR(vertices, R9) {
    return vertices.map(([x, y, z]) => [
        x*R9[0] + y*R9[3] + z*R9[6],
        x*R9[1] + y*R9[4] + z*R9[7],
        x*R9[2] + y*R9[5] + z*R9[8],
    ]);
}

/**
 * Apply R × v (standard matrix-vector product) to sphere vertices.
 * R9 is stored row-major: R9[0..2] = first row, R9[3..5] = second row, etc.
 *
 * @param {Array<[number,number,number]>} vertices
 * @param {number[]} R9  flat 9-element row-major rotation matrix
 * @returns {Array<[number,number,number]>}
 */
export function applyRotation(vertices, R9) {
    return vertices.map(([x, y, z]) => [
        R9[0]*x + R9[1]*y + R9[2]*z,
        R9[3]*x + R9[4]*y + R9[5]*z,
        R9[6]*x + R9[7]*y + R9[8]*z,
    ]);
}

// ── Bezier flattening ────────────────────────────────────────────────────────

// Flatten one cubic Bezier into start-of-flat-segment points (paper.js criterion).
// Adds the start point of each flat sub-segment; caller must add the final endpoint.
// Matches PathFlattener in paper.js 0.11 with maxRecursion=256 (8 depth levels).
function _flatCubicBez(x0, y0, x1, y1, x2, y2, x3, y3, tolSq, depth, pts) {
    const ux = 3*x1 - 2*x0 - x3, uy = 3*y1 - 2*y0 - y3;
    const vx = 3*x2 - 2*x3 - x0, vy = 3*y2 - 2*y3 - y0;
    if (depth >= 8 || Math.max(ux*ux, vx*vx) + Math.max(uy*uy, vy*vy) <= tolSq) {
        const dx = x3-x0, dy = y3-y0;
        if (dx*dx + dy*dy > 0) pts.push([x0, y0]);
        return;
    }
    const m01x=(x0+x1)*0.5, m01y=(y0+y1)*0.5;
    const m12x=(x1+x2)*0.5, m12y=(y1+y2)*0.5;
    const m23x=(x2+x3)*0.5, m23y=(y2+y3)*0.5;
    const m012x=(m01x+m12x)*0.5, m012y=(m01y+m12y)*0.5;
    const m123x=(m12x+m23x)*0.5, m123y=(m12y+m23y)*0.5;
    const mx=(m012x+m123x)*0.5,   my=(m012y+m123y)*0.5;
    _flatCubicBez(x0,y0, m01x,m01y, m012x,m012y, mx,my, tolSq, depth+1, pts);
    _flatCubicBez(mx,my, m123x,m123y, m23x,m23y, x3,y3, tolSq, depth+1, pts);
}

/**
 * Convert sulci.json to SBN landmark lines, applying optional rotation (v@R) and
 * flattening Bezier curves using the Bezier handles (ix,iy,ox,oy) from path0.
 * Matches the original morph.js behavior: lineset + path.flatten(0.001).
 *
 * @param {Array} sulci  parsed sulci.json
 * @param {number[]|null} R9  flat 9-element rotation matrix (v@R convention) or null
 * @param {number} [tol=0.001]  Bezier flatness tolerance (matches paper.js default)
 * @returns {Array<{name:string, p:[number,number][]}>}
 */
export function sulciToSbnLinesVR(sulci, R9 = null, tol = 0.001) {
    if (!sulci || !sulci.length) return [];
    const tolSq = 16 * tol * tol;

    function rotPt(px, py) {
        if (!R9) return [px, py];
        const s = ae2sphere([px, py]);
        return sphere2ae([
            s[0]*R9[0] + s[1]*R9[3] + s[2]*R9[6],
            s[0]*R9[1] + s[1]*R9[4] + s[2]*R9[7],
            s[0]*R9[2] + s[1]*R9[5] + s[2]*R9[8],
        ]);
    }

    return sulci
        .filter(r => r.path0 && r.path0.length >= 2)
        .map(r => {
            const pts = [];
            const a0 = r.path0;
            for (let i = 0; i < a0.length - 1; i++) {
                const a = a0[i], b = a0[i + 1];
                const [P0x, P0y] = rotPt(a.px,        a.py       );
                const [P1x, P1y] = rotPt(a.px + a.ox,  a.py + a.oy);
                const [P2x, P2y] = rotPt(b.px + b.ix,  b.py + b.iy);
                const [P3x, P3y] = rotPt(b.px,         b.py       );
                // Zero-handle segments are straight lines; skip subdivision (ignoreStraight=true).
                const hasHandle = a.ox*a.ox + a.oy*a.oy > 1e-14 || b.ix*b.ix + b.iy*b.iy > 1e-14;
                if (!hasHandle) {
                    const dx=P3x-P0x, dy=P3y-P0y;
                    if (dx*dx + dy*dy > 0) pts.push([P0x, P0y]);
                } else {
                    _flatCubicBez(P0x,P0y, P1x,P1y, P2x,P2y, P3x,P3y, tolSq, 0, pts);
                }
            }
            // Add the final anchor point
            const last = a0[a0.length - 1];
            pts.push(rotPt(last.px, last.py));
            return { name: r.name, p: pts };
        });
}

/** Convenience alias: convert sulci.json to SBN lines without rotation. */
export const sulciToSbnLines = (sulci) => sulciToSbnLinesVR(sulci, null);

// ── SBN internals ────────────────────────────────────────────────────────────

const _D = 0.1;   // resample arc-length
const _A = 0.5;   // line-length influence on weights
const _B = 0.01;  // near-zero guard for weight denominator
const _C = 2;     // distance falloff exponent

function _resampleLine(line, nseg) {
    let tlength = 0;
    for (let i = 0; i < line.p.length - 1; i++) {
        tlength += _norm3D(_sub3D(ae2sphere(line.p[i]), ae2sphere(line.p[i+1])));
    }
    const slength = tlength / nseg;
    const spx = [];
    for (let i = 0; i <= nseg; i++) {
        const s = slength * i;
        let t = 0;
        for (let j = 0; j < line.p.length - 1; j++) {
            const p1 = ae2sphere(line.p[j]);
            const p2 = ae2sphere(line.p[j+1]);
            const d = _norm3D(_sub3D(p1, p2));
            if (t <= s && t + d >= s - 1e-6) {
                const g = (s - t) / d;
                const px = _direction(_add3D(_sca3D(p1, 1-g), _sca3D(p2, g)));
                spx.push(sphere2ae(px));
                break;
            }
            t += d;
        }
    }
    line.p = spx;
}

function _findByName(lines, name) {
    for (let j = 0; j < lines.length; j++) {
        if (lines[j].name === name) return j;
    }
    return -1;
}

// Deep-copy, pair by name, resample to equal segment counts.
function _pairAndResample(l1, l2) {
    l1 = l1.map(r => ({ name: r.name, p: r.p.map(pt => [...pt]) }));
    l2 = l2.map(r => ({ name: r.name, p: r.p.map(pt => [...pt]) }));

    const paired1 = [], paired2 = [];
    for (let i = 0; i < l1.length; i++) {
        const j = _findByName(l2, l1[i].name);
        if (j < 0) continue;
        let len1 = 0, len2 = 0;
        for (let k = 0; k < l1[i].p.length - 1; k++) {
            len1 += _norm3D(_sub3D(ae2sphere(l1[i].p[k]), ae2sphere(l1[i].p[k+1])));
        }
        for (let k = 0; k < l2[j].p.length - 1; k++) {
            len2 += _norm3D(_sub3D(ae2sphere(l2[j].p[k]), ae2sphere(l2[j].p[k+1])));
        }
        let nseg = Math.max(1, Math.min(
            Math.round(len1 / _D),
            Math.round(len2 / _D),
        ));
        nseg = Math.min(nseg, Math.min(l1[i].p.length - 1, l2[j].p.length - 1));
        _resampleLine(l1[i], nseg);
        _resampleLine(l2[j], nseg);
        paired1.push(l1[i]);
        paired2.push(l2[j]);
    }
    return { paired1, paired2 };
}

// Precompute per-segment geometry into line.pre[j].
function _prepareWeights(lines) {
    for (let i = 0; i < lines.length; i++) {
        lines[i].pre = [];
        for (let j = 0; j < lines[i].p.length - 1; j++) {
            const p = ae2sphere(lines[i].p[j]);
            const q = ae2sphere(lines[i].p[j+1]);
            let r = _cross3D(p, q);
            const rn = _norm3D(r);
            if (rn < 1e-10) {
                // Degenerate segment (p ≈ q or antipodal) — mark to skip; fa=0 zeroes its weight.
                lines[i].pre[j] = { skip: true };
                continue;
            }
            r = _sca3D(r, 1 / rn);
            const q1     = _cross3D(r, p);
            const length = Math.acos(_clip(_dot3D(p, q), -1, 1));
            const fa     = Math.pow(length, _A);
            lines[i].pre[j] = { p, q, r, q1, length, fa };
        }
    }
}

// Compute per-segment weights for vertex x against line set l1 (with precomputed data).
function _computeWeights(l1, x) {
    let totalSegs = 0;
    for (const line of l1) totalSegs += line.p.length - 1;
    const w = new Float32Array(totalSegs);
    const c = new Float32Array(2 * totalSegs);

    let k = 0;
    for (let i = 0; i < l1.length; i++) {
        for (let j = 0; j < l1[i].p.length - 1; j++) {
            const seg = l1[i].pre[j];
            if (seg.skip) { w[k] = 0; c[2*k] = 0; c[2*k+1] = 0; k++; continue; }
            const { p, q, r, q1, length, fa } = seg;
            const dp = _clip(_dot3D(p, x), -1, 1);
            const dq = _clip(_dot3D(q, x), -1, 1);
            const acosdp = Math.acos(dp);
            const acosdq = Math.acos(dq);
            c[2*k]   = Math.atan2(_dot3D(x, r), _dot3D(x, q1));
            c[2*k+1] = acosdp / length;
            // Guard: if x lies exactly on both endpoints (near-zero segment), use max weight
            if (acosdp === 0 && acosdq === 0) { w[k] = Math.pow(fa / _B, _C); k++; continue; }
            const t   = acosdp / (acosdp + acosdq);
            const tmp = _add3D(_sca3D(p, 1-t), _sca3D(q, t));
            const fb  = _B + 10 * Math.min(
                Math.min(acosdp, acosdq),
                Math.acos(Math.min(1, _dot3D(tmp, x))),
            );
            w[k] = Math.pow(fa / fb, _C);
            k++;
        }
    }
    return { w, c };
}

// Apply weights from l1 via the geometry of l2 to produce a morphed vertex.
function _applyWeights(l2, wc) {
    const { w, c } = wc;
    let tmp  = [0, 0, 0];
    let sumw = 0;
    let k    = 0;
    for (let i = 0; i < l2.length; i++) {
        for (let j = 0; j < l2[i].p.length - 1; j++) {
            const seg = l2[i].pre[j];
            if (seg.skip || w[k] === 0) { k++; continue; }
            const { p, r, q1, length } = seg;
            const a  = c[2*k];
            const b  = length * c[2*k+1];
            const xy = [b * Math.cos(a), b * Math.sin(a)];
            const x0 = ae2sphere(xy);
            const xg = _add3D(
                _add3D(_sca3D(q1, x0[0]), _sca3D(r, x0[1])),
                _sca3D(p, x0[2]),
            );
            tmp  = _add3D(tmp, _sca3D(xg, w[k]));
            sumw += w[k];
            k++;
        }
    }
    return _direction(_sca3D(tmp, 1 / sumw));
}

// ── Triangle intersection (ray from origin along p vs triangle a,b,c) ───────
// Returns {case:1, u, v} for a hit (point = (1-u-v)*a + u*b + v*c), else {case:0}.
// Direct port of intersectVectorTriangle from stereographic/intersect_vector_triangle.js.

const _EPS = 1e-10;

function _intersectVecTri(p, a, b, c) {
    const u  = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const v  = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const n  = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    if (Math.sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]) < _EPS) return { case: -1 };
    const a_ = n[0]*a[0]+n[1]*a[1]+n[2]*a[2];
    const b_ = n[0]*p[0]+n[1]*p[1]+n[2]*p[2];
    if (b_ > -_EPS && b_ < _EPS) return { case: 0 };
    const r  = a_ / b_;
    if (r < 0) return { case: 0 };
    const xx = [p[0]*r, p[1]*r, p[2]*r];
    const uu = u[0]*u[0]+u[1]*u[1]+u[2]*u[2];
    const uv = u[0]*v[0]+u[1]*v[1]+u[2]*v[2];
    const vv = v[0]*v[0]+v[1]*v[1]+v[2]*v[2];
    const w  = [xx[0]-a[0], xx[1]-a[1], xx[2]-a[2]];
    const wu = w[0]*u[0]+w[1]*u[1]+w[2]*u[2];
    const wv = w[0]*v[0]+w[1]*v[1]+w[2]*v[2];
    const D  = uv*uv - uu*vv;
    let ss = (uv*wv - vv*wu) / D;
    let tt = (uv*wu - uu*wv) / D;
    if (ss > -_EPS && ss < _EPS) ss = 0; if (1-ss > -_EPS && 1-ss < _EPS) ss = 1;
    if (tt > -_EPS && tt < _EPS) tt = 0; if (1-tt > -_EPS && 1-tt < _EPS) tt = 1;
    if (ss < 0 || tt < 0 || ss+tt > 1) return { case: 0 };
    return { case: 1, u: ss, v: tt };
}

// ── Retopology ───────────────────────────────────────────────────────────────

/**
 * Resample the mov native surface onto the ref topology using the morphed sphere
 * as the correspondence map.  Port of sbn.js:resampleMesh.
 *
 * Precondition: morphedVerts[i] ↔ movNativeVerts[i]  (same index = same anatomical point).
 * This holds when sphere and native mesh share vertex ordering, i.e. the sphere
 * was produced by meshparam (same topology, not homogeneous-resampled).
 *
 * Algorithm:
 *   For each ref sphere vertex p:
 *     1. Normalize p to unit sphere.
 *     2. Dot-product cull: only test triangles whose first vertex is within ~26° of p.
 *     3. Run ray-triangle intersection on surviving triangles.
 *     4. Use barycentric coordinates (u,v) to interpolate movNativeVerts.
 *     5. Fallback (full scan, then nearest-vertex) if cull misses.
 *
 * @param {number[][]} morphedFaces      triangles of the morphed mov sphere
 * @param {number[][]} morphedVerts      vertices of the morphed mov sphere (unit sphere)
 * @param {number[][]} movNativeVerts    vertices of the mov native surface (same indexing)
 * @param {number[][]} refSphereVerts    vertices of the ref sphere (to project into morphed sphere)
 * @returns {number[][]} remeshed vertices — mov surface in ref topology
 */
export function resampleMesh(morphedFaces, morphedVerts, movNativeVerts, refSphereVerts) {
    const result = [];
    let missed = 0;

    for (let i = 0; i < refSphereVerts.length; i++) {
        const raw = refSphereVerts[i];
        const len = Math.sqrt(raw[0]*raw[0] + raw[1]*raw[1] + raw[2]*raw[2]) || 1;
        const p = [raw[0]/len, raw[1]/len, raw[2]/len];

        // Pass 1: first-vertex dot-product cull (vertex within ~26° of p)
        let found = false;
        for (let t = 0; t < morphedFaces.length; t++) {
            const [ai, bi, ci] = morphedFaces[t];
            if (_dot3D(p, morphedVerts[ai]) <= 0.9) continue;
            const hit = _intersectVecTri(p, morphedVerts[ai], morphedVerts[bi], morphedVerts[ci]);
            if (hit.case !== 1) continue;
            const w = 1 - hit.u - hit.v;
            const na = movNativeVerts[ai], nb = movNativeVerts[bi], nc = movNativeVerts[ci];
            result.push([w*na[0]+hit.u*nb[0]+hit.v*nc[0], w*na[1]+hit.u*nb[1]+hit.v*nc[1], w*na[2]+hit.u*nb[2]+hit.v*nc[2]]);
            found = true;
            break;
        }
        if (found) continue;

        // Pass 2: full scan without cull (catches triangles near great-circle edges)
        for (let t = 0; t < morphedFaces.length; t++) {
            const [ai, bi, ci] = morphedFaces[t];
            const hit = _intersectVecTri(p, morphedVerts[ai], morphedVerts[bi], morphedVerts[ci]);
            if (hit.case !== 1) continue;
            const w = 1 - hit.u - hit.v;
            const na = movNativeVerts[ai], nb = movNativeVerts[bi], nc = movNativeVerts[ci];
            result.push([w*na[0]+hit.u*nb[0]+hit.v*nc[0], w*na[1]+hit.u*nb[1]+hit.v*nc[1], w*na[2]+hit.u*nb[2]+hit.v*nc[2]]);
            found = true;
            break;
        }
        if (found) continue;

        // Pass 3: nearest-vertex fallback
        let bestIdx = 0, bestDot = -Infinity;
        for (let j = 0; j < morphedVerts.length; j++) {
            const d = _dot3D(p, morphedVerts[j]);
            if (d > bestDot) { bestDot = d; bestIdx = j; }
        }
        result.push([...movNativeVerts[bestIdx]]);
        missed++;
    }

    if (missed > 0) console.warn(`resampleMesh: ${missed}/${refSphereVerts.length} vertices fell back to nearest-vertex`);
    return result;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run the Spherical Beier-Neely morph.
 * Returns a copy of vertices when no landmark pairs can be formed.
 *
 * @param {Array<{name:string, p:[number,number][]}>} l1  landmarks on moving sphere
 * @param {Array<{name:string, p:[number,number][]}>} l2  landmarks on reference sphere
 * @param {Array<[number,number,number]>} vertices  unit-sphere vertices of the moving mesh
 * @returns {Array<[number,number,number]>} morphed vertices (still on unit sphere)
 */
export function sbnMorph(l1, l2, vertices) {
    if (!l1.length || !l2.length) return vertices.map(v => [...v]);

    const { paired1, paired2 } = _pairAndResample(l1, l2);
    if (!paired1.length) return vertices.map(v => [...v]);

    _prepareWeights(paired1);
    _prepareWeights(paired2);

    return vertices.map(x => {
        const r = _applyWeights(paired2, _computeWeights(paired1, x));
        // Guard: degenerate landmark segments can produce NaN. Fall back to original.
        if (!isFinite(r[0]) || !isFinite(r[1]) || !isFinite(r[2])) return [...x];
        return r;
    });
}
