import { API } from '../api.js';

/**
 * Universal Polar Stereographic flat map — WebGL implementation.
 *
 * CPU builds the projected geometry each frame (handles seam properly),
 * GPU rasterises with per-pixel jet coloring and smooth sulcal-depth
 * interpolation across triangles.
 *
 * Public API (same as the old SVG version):
 *   new UPSView(container)
 *   ups.load(spherePath, sulcValues, rotation3x3)
 *   ups.setRotation(matrix3x3)
 *   ups.destroy()
 *
 * this._svg is the canvas element (aliased for compatibility with app.js).
 */
export class UPSView {
    constructor(container) {
        this.container = container;
        this._rawVerts  = null;   // Float32Array(n*3) — centered sphere positions
        this._sulcNorm  = null;   // Float32Array(n)   — normalized to [0,1]
        this._tris      = null;   // [[i,j,k], ...]
        this._nBase     = 0;
        this._R         = [[1,0,0],[0,1,0],[0,0,1]];  // current 3×3 rotation
        this._gl        = null;
        this._prog      = null;
        this._loc       = null;
        this._bufs      = null;
        this._canvas    = this._initCanvas();
        this._svg       = this._canvas;  // compatibility alias used by app.js
        this._initGL();
        this._initDrag();
    }

    // ── Canvas & WebGL setup ─────────────────────────────────────────────────

    _initCanvas() {
        const canvas = document.createElement('canvas');
        canvas.width  = 500;
        canvas.height = 500;
        Object.assign(canvas.style, {
            width: '100%',
            aspectRatio: '1 / 1',
            display: 'block',
            cursor: 'grab',
        });
        this.container.appendChild(canvas);
        return canvas;
    }

    _initGL() {
        const gl = this._canvas.getContext('webgl', { preserveDrawingBuffer: true });
        if (!gl) { console.error('UPS: WebGL not available'); return; }
        gl.getExtension('OES_element_index_uint');  // 32-bit indices
        this._gl = gl;

        const VS = `
attribute vec2 a_pos2d;
attribute float a_sulc;
attribute float a_z;
varying float v_sulc;
varying float v_z;
void main() {
    v_sulc = a_sulc;
    v_z    = a_z;
    gl_Position = vec4(a_pos2d / 3.14159265, 0.0, 1.0);
}`;
        const FS = `
precision mediump float;
varying float v_sulc;
varying float v_z;
vec3 jet(float t) {
    float r, g, b;
    if (t < 0.25)      { r = 0.0;            g = 4.0*t;           b = 1.0; }
    else if (t < 0.5)  { r = 0.0;            g = 1.0;             b = 1.0 - 4.0*(t-0.25); }
    else if (t < 0.75) { r = 4.0*(t-0.5);   g = 1.0;             b = 0.0; }
    else               { r = 1.0;            g = 1.0 - 4.0*(t-0.75); b = 0.0; }
    return vec3(r, g, b);
}
void main() {
    if (v_z > 0.9) discard;
    float br = 0.2 + 0.8 * v_sulc;
    gl_FragColor = vec4(jet(v_sulc) * br, 1.0);
}`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                console.error('UPS shader:', gl.getShaderInfoLog(s));
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        gl.useProgram(prog);
        this._prog = prog;

        this._loc = {
            pos2d: gl.getAttribLocation(prog, 'a_pos2d'),
            sulc:  gl.getAttribLocation(prog, 'a_sulc'),
            z:     gl.getAttribLocation(prog, 'a_z'),
        };
        this._bufs = {
            pos:  gl.createBuffer(),
            sulc: gl.createBuffer(),
            z:    gl.createBuffer(),
            idx:  gl.createBuffer(),
        };

        gl.clearColor(0.051, 0.051, 0.122, 1);   // ≈ #0d0d1f
        gl.viewport(0, 0, 500, 500);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // ── Mouse drag ───────────────────────────────────────────────────────────

    _initDrag() {
        let dragging = false, lastX = 0, lastY = 0;
        const c = this._canvas;
        c.addEventListener('mousedown', e => {
            dragging = true;
            lastX = e.clientX; lastY = e.clientY;
            c.style.cursor = 'grabbing';
        });
        this._onWinMove = e => {
            if (!dragging) return;
            this._applyDrag(e.clientX - lastX, e.clientY - lastY);
            lastX = e.clientX; lastY = e.clientY;
            this._render();
        };
        this._onWinUp = () => { dragging = false; c.style.cursor = 'grab'; };
        window.addEventListener('mousemove', this._onWinMove);
        window.addEventListener('mouseup',   this._onWinUp);
        c.addEventListener('mouseleave', this._onWinUp);
    }

    _applyDrag(dx, dy) {
        const s = 0.005;  // radians per pixel
        const ax = dy * s, ay = dx * s;
        const cx = Math.cos(ax), sx = Math.sin(ax);
        const cy = Math.cos(ay), sy = Math.sin(ay);
        const Rx = [[1,0,0],[0,cx,-sx],[0,sx,cx]];
        const Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]];
        this._R = _matMul3(_matMul3(Ry, Rx), this._R);
    }

    // ── CPU projection (buildFrame equivalent) ───────────────────────────────

    _buildFrame() {
        const R = this._R;
        const n = this._nBase;
        const raw = this._rawVerts;

        const azArr = new Float32Array(n);
        const rArr  = new Float32Array(n);
        const zArr  = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            const ox = raw[i*3], oy = raw[i*3+1], oz = raw[i*3+2];
            let rx = R[0][0]*ox + R[0][1]*oy + R[0][2]*oz;
            let ry = R[1][0]*ox + R[1][1]*oy + R[1][2]*oz;
            let rz = R[2][0]*ox + R[2][1]*oy + R[2][2]*oz;
            const len = Math.sqrt(rx*rx + ry*ry + rz*rz);
            rx /= len; ry /= len; rz /= len;
            azArr[i] = Math.atan2(ry, rx);
            rArr[i]  = Math.acos(Math.max(-1, Math.min(1, -rz)));
            zArr[i]  = rz;
        }

        // Base 2D positions
        const pos2d = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
            pos2d[i*2]   = rArr[i] * Math.cos(azArr[i]);
            pos2d[i*2+1] = rArr[i] * Math.sin(azArr[i]);
        }

        // Build index buffer; seam triangles get duplicated vertices
        const extraPos  = [];
        const extraSulc = [];
        const extraZ    = [];
        let nextIdx = n;

        const indices = new Uint32Array(this._tris.length * 3);
        let idxCount = 0;
        const TWO_PI = 2 * Math.PI;

        for (const tri of this._tris) {
            const [a, b, c] = tri;
            if (zArr[a] > 0.9 && zArr[b] > 0.9 && zArr[c] > 0.9) continue;

            const a0 = azArr[a], a1 = azArr[b], a2 = azArr[c];
            const mn = Math.min(a0, a1, a2);
            const mx = Math.max(a0, a1, a2);

            if (mx - mn <= Math.PI) {
                indices[idxCount++] = a;
                indices[idxCount++] = b;
                indices[idxCount++] = c;
            } else {
                // Seam: shift negative azimuths by +2π so all are on the same side
                const vi  = [a, b, c];
                const azs = [a0, a1, a2];
                const fixed = azs.map(az => az < 0 ? az + TWO_PI : az);
                for (let j = 0; j < 3; j++) {
                    const v = vi[j];
                    extraPos.push(rArr[v] * Math.cos(fixed[j]), rArr[v] * Math.sin(fixed[j]));
                    extraSulc.push(this._sulcNorm[v]);
                    extraZ.push(zArr[v]);
                    indices[idxCount++] = nextIdx++;
                }
            }
        }

        // Merge base + extra
        const total = n + extraSulc.length;
        const finalPos  = new Float32Array(total * 2);
        const finalSulc = new Float32Array(total);
        const finalZ    = new Float32Array(total);
        finalPos.set(pos2d);
        finalSulc.set(this._sulcNorm);
        finalZ.set(zArr);
        for (let i = 0; i < extraSulc.length; i++) {
            finalPos[(n + i)*2]   = extraPos[i*2];
            finalPos[(n + i)*2+1] = extraPos[i*2+1];
            finalSulc[n + i] = extraSulc[i];
            finalZ[n + i]    = extraZ[i];
        }

        return { pos: finalPos, sulc: finalSulc, z: finalZ,
                 idx: indices.subarray(0, idxCount), idxCount };
    }

    // ── WebGL draw call ──────────────────────────────────────────────────────

    _render() {
        if (!this._gl || !this._rawVerts) return;
        const gl = this._gl;
        const { pos, sulc, z, idx, idxCount } = this._buildFrame();
        const { pos2d, sulc: lSulc, z: lZ } = this._loc;
        const bufs = this._bufs;

        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.pos);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(pos2d);
        gl.vertexAttribPointer(pos2d, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.sulc);
        gl.bufferData(gl.ARRAY_BUFFER, sulc, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(lSulc);
        gl.vertexAttribPointer(lSulc, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, bufs.z);
        gl.bufferData(gl.ARRAY_BUFFER, z, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(lZ);
        gl.vertexAttribPointer(lZ, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufs.idx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);

        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_INT, 0);
    }

    // ── Public API ───────────────────────────────────────────────────────────

    async load(spherePath, sulcValues, rotation3x3 = null) {
        const url = `${API}/api/mesh_raw?path=${encodeURIComponent(spherePath)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`mesh_raw ${res.status}`);
        const { vertices, faces } = await res.json();

        // Pack vertices into flat Float32Array (centering done server-side)
        const n = vertices.length;
        const raw = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            raw[i*3] = vertices[i][0];
            raw[i*3+1] = vertices[i][1];
            raw[i*3+2] = vertices[i][2];
        }
        this._rawVerts = raw;
        this._tris     = faces;
        this._nBase    = n;

        // Normalize sulcal depth values to [0,1]
        if (sulcValues && sulcValues.length === n) {
            let mn = Infinity, mx = -Infinity;
            for (let i = 0; i < n; i++) {
                if (sulcValues[i] < mn) mn = sulcValues[i];
                if (sulcValues[i] > mx) mx = sulcValues[i];
            }
            const range = mx - mn || 1;
            const s = new Float32Array(n);
            for (let i = 0; i < n; i++) s[i] = (sulcValues[i] - mn) / range;
            this._sulcNorm = s;
        } else {
            this._sulcNorm = new Float32Array(n).fill(0.5);
        }

        if (rotation3x3) this._R = rotation3x3;
        this._render();
    }

    setRotation(matrix3x3) {
        this._R = matrix3x3;
        this._render();
    }

    destroy() {
        if (this._onWinMove) window.removeEventListener('mousemove', this._onWinMove);
        if (this._onWinUp)   window.removeEventListener('mouseup',   this._onWinUp);
        if (this._canvas && this._canvas.parentNode)
            this._canvas.parentNode.removeChild(this._canvas);
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _matMul3(A, B) {
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}
