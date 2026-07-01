/**
 * StereoView — WebGL azimuthal-equidistant flat-disc view.
 *
 * Same CPU-projection + GPU-rasterize approach as UPSView/index_webgl.html:
 *   CPU: rotate vertices, project to 2D, fix seam triangles
 *   GPU: rasterise with per-pixel interpolated jet/sulc colouring
 *
 * Canvas fills #viewer-container absolutely. When Paper.js overlay is in
 * draw/select mode its canvas captures pointer events; when rotate mode
 * sets pointerEvents:'none' on Paper.js this canvas receives drags.
 */
export class StereoView {
    constructor(container) {
        this.container = container;
        this._rawVerts  = null;
        this._sulcNorm  = null;
        this._tris      = null;
        this._nBase     = 0;
        this._R              = [[1,0,0],[0,1,0],[0,0,1]];
        this._zoom           = 1.0;
        this._wireframe      = false;
        this._gl             = null;
        this._prog           = null;
        this._loc            = null;
        this._bufs           = null;
        this._onWinMove      = null;
        this._onWinUp        = null;
        this._onRotationChange = null;
        this._canvas    = this._initCanvas();
        this._initGL();
        this._initDrag();
        this._initZoom();
        this._onResize = () => this.resize();
        window.addEventListener('resize', this._onResize);
    }

    // ── Canvas ───────────────────────────────────────────────────────────────

    _initCanvas() {
        const { clientWidth: w, clientHeight: h } = this.container;
        const canvas = document.createElement('canvas');
        canvas.width  = w;
        canvas.height = h;
        Object.assign(canvas.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%',
            cursor: 'grab', background: '#0d0d1f',
        });
        this.container.appendChild(canvas);
        return canvas;
    }

    // ── WebGL ────────────────────────────────────────────────────────────────

    _initGL() {
        const gl = this._canvas.getContext('webgl', { preserveDrawingBuffer: true });
        if (!gl) { console.error('StereoView: WebGL unavailable'); return; }
        gl.getExtension('OES_element_index_uint');
        this._gl = gl;

        // Aspect-ratio-corrected vertex shader: disc of radius π fills height
        const VS = `
attribute vec2 a_pos2d;
attribute float a_sulc;
attribute float a_z;
uniform float u_aspect;
uniform float u_zoom;
varying float v_sulc;
varying float v_z;
void main() {
    v_sulc = a_sulc;
    v_z    = a_z;
    gl_Position = vec4(a_pos2d.x * u_zoom / (3.14159265 * u_aspect),
                       a_pos2d.y * u_zoom /  3.14159265, 0.0, 1.0);
}`;
        const FS = `
precision mediump float;
varying float v_sulc;
varying float v_z;
void main() {
    if (v_z < -0.9) discard;
    vec3 cLo = vec3(0.118, 0.227, 0.373);
    vec3 cHi = vec3(0.910, 0.910, 0.910);
    gl_FragColor = vec4(mix(cLo, cHi, v_sulc), 1.0);
}`;

        const compile = (type, src) => {
            const s = gl.createShader(type);
            gl.shaderSource(s, src);
            gl.compileShader(s);
            if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
                console.error('StereoView shader:', gl.getShaderInfoLog(s));
            return s;
        };
        const prog = gl.createProgram();
        gl.attachShader(prog, compile(gl.VERTEX_SHADER,   VS));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
        gl.linkProgram(prog);
        gl.useProgram(prog);
        this._prog = prog;

        this._loc = {
            pos2d:  gl.getAttribLocation(prog,  'a_pos2d'),
            sulc:   gl.getAttribLocation(prog,  'a_sulc'),
            z:      gl.getAttribLocation(prog,  'a_z'),
            aspect: gl.getUniformLocation(prog, 'u_aspect'),
            zoom:   gl.getUniformLocation(prog, 'u_zoom'),
        };
        this._bufs = {
            pos:  gl.createBuffer(),
            sulc: gl.createBuffer(),
            z:    gl.createBuffer(),
            idx:  gl.createBuffer(),
        };

        const { clientWidth: w, clientHeight: h } = this.container;
        gl.clearColor(0.051, 0.051, 0.122, 1);
        gl.viewport(0, 0, w, h);
        gl.uniform1f(this._loc.aspect, w / h);
        gl.uniform1f(this._loc.zoom,   this._zoom);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    // ── Mouse drag (fires only when Paper.js overlay has pointerEvents:none) ──

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
            this._onRotationChange?.();
        };
        this._onWinUp = () => { dragging = false; c.style.cursor = 'grab'; };

        window.addEventListener('mousemove', this._onWinMove);
        window.addEventListener('mouseup',   this._onWinUp);
        c.addEventListener('mouseleave', this._onWinUp);
    }

    _initZoom() {
        this._canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this._zoom *= 1 - e.deltaY / 300;
            if (this._zoom < 0.1) this._zoom = 0.1;
            if (this._zoom > 10)  this._zoom = 10;
            this._render();
        }, { passive: false });
    }

    _applyDrag(dx, dy) {
        const s = 0.005;
        const ax = dy * s, ay = dx * s;
        const cx = Math.cos(ax), sx = Math.sin(ax);
        const cy = Math.cos(ay), sy = Math.sin(ay);
        const Rx = [[1,0,0],[0,cx,-sx],[0,sx,cx]];
        const Ry = [[cy,0,sy],[0,1,0],[-sy,0,cy]];
        this._R = _matMul3(_matMul3(Ry, Rx), this._R);
    }

    // ── CPU projection ───────────────────────────────────────────────────────

    _buildFrame() {
        const R = this._R, n = this._nBase, raw = this._rawVerts;
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
            rArr[i]  = Math.acos(Math.max(-1, Math.min(1,  rz)));  // north pole at center
            zArr[i]  = rz;
        }

        const pos2d = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
            pos2d[i*2]   = rArr[i] * Math.cos(azArr[i]);
            pos2d[i*2+1] = rArr[i] * Math.sin(azArr[i]);
        }

        const extraPos = [], extraSulc = [], extraZ = [];
        let nextIdx = n;
        const indices = new Uint32Array(this._tris.length * 3);
        let idxCount = 0;
        const TWO_PI = 2 * Math.PI;

        for (const tri of this._tris) {
            const [a, b, c] = tri;
            if (zArr[a] < -0.9 && zArr[b] < -0.9 && zArr[c] < -0.9) continue;

            const a0 = azArr[a], a1 = azArr[b], a2 = azArr[c];
            if (Math.max(a0, a1, a2) - Math.min(a0, a1, a2) <= Math.PI) {
                indices[idxCount++] = a;
                indices[idxCount++] = b;
                indices[idxCount++] = c;
            } else {
                const vi = [a, b, c], azs = [a0, a1, a2];
                const fixed = azs.map(az => az < 0 ? az + TWO_PI : az);
                for (let j = 0; j < 3; j++) {
                    const v = vi[j];
                    extraPos.push(rArr[v]*Math.cos(fixed[j]), rArr[v]*Math.sin(fixed[j]));
                    extraSulc.push(this._sulcNorm[v]);
                    extraZ.push(zArr[v]);
                    indices[idxCount++] = nextIdx++;
                }
            }
        }

        const total = n + extraSulc.length;
        const finalPos  = new Float32Array(total * 2);
        const finalSulc = new Float32Array(total);
        const finalZ    = new Float32Array(total);
        finalPos.set(pos2d);
        finalSulc.set(this._sulcNorm);
        finalZ.set(zArr);
        for (let i = 0; i < extraSulc.length; i++) {
            finalPos[(n+i)*2]   = extraPos[i*2];
            finalPos[(n+i)*2+1] = extraPos[i*2+1];
            finalSulc[n+i] = extraSulc[i];
            finalZ[n+i]    = extraZ[i];
        }

        return { pos: finalPos, sulc: finalSulc, z: finalZ,
                 idx: indices.subarray(0, idxCount), idxCount };
    }

    // ── Draw ─────────────────────────────────────────────────────────────────

    _render() {
        const gl = this._gl;
        if (!gl || !this._rawVerts) return;
        const { pos, sulc, z, idx, idxCount } = this._buildFrame();
        const L = this._loc, B = this._bufs;

        gl.bindBuffer(gl.ARRAY_BUFFER, B.pos);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(L.pos2d);
        gl.vertexAttribPointer(L.pos2d, 2, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, B.sulc);
        gl.bufferData(gl.ARRAY_BUFFER, sulc, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(L.sulc);
        gl.vertexAttribPointer(L.sulc, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ARRAY_BUFFER, B.z);
        gl.bufferData(gl.ARRAY_BUFFER, z, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(L.z);
        gl.vertexAttribPointer(L.z, 1, gl.FLOAT, false, 0, 0);

        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, B.idx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);

        gl.uniform1f(this._loc.zoom, this._zoom);
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (this._wireframe) {
            // Convert triangle indices → line pairs [a,b, b,c, c,a] per triangle
            const lineIdx = new Uint32Array(idxCount * 2);
            let li = 0;
            for (let i = 0; i < idxCount; i += 3) {
                lineIdx[li++] = idx[i];   lineIdx[li++] = idx[i+1];
                lineIdx[li++] = idx[i+1]; lineIdx[li++] = idx[i+2];
                lineIdx[li++] = idx[i+2]; lineIdx[li++] = idx[i];
            }
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, lineIdx.subarray(0, li), gl.DYNAMIC_DRAW);
            gl.drawElements(gl.LINES, li, gl.UNSIGNED_INT, 0);
        } else {
            gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.DYNAMIC_DRAW);
            gl.drawElements(gl.TRIANGLES, idxCount, gl.UNSIGNED_INT, 0);
        }
    }

    // ── Public API ───────────────────────────────────────────────────────────

    resize() {
        const { clientWidth: w, clientHeight: h } = this.container;
        this._canvas.width  = w;
        this._canvas.height = h;
        if (this._gl) {
            this._gl.viewport(0, 0, w, h);
            this._gl.uniform1f(this._loc.aspect, w / h);
        }
        this._render();
    }

    getR()    { return this._R; }
    getZoom() { return this._zoom; }

    // ZYX intrinsic Euler angles in degrees: {alpha=Rz(twist), beta=Ry(tilt↕), gamma=Rx(spin↔)}
    getEulerZYX() {
        return matrixToEulerZYX(this._R);
    }

    setEulerZYX(alpha, beta, gamma) {
        this._R = eulerZYXToMatrix(alpha, beta, gamma);
        this._render();
        this._onRotationChange?.();
    }

    onRotationChange(fn) { this._onRotationChange = fn; }

    setWireframe(on) {
        this._wireframe = on;
        this._render();
    }

    async load(spherePath, sulcValues, rotation3x3 = null) {
        const { API } = (await import('../api.js'));
        const res = await fetch(`${API}/api/mesh_raw?path=${encodeURIComponent(spherePath)}`);
        if (!res.ok) throw new Error(`mesh_raw ${res.status}`);
        const { vertices, faces } = await res.json();

        const n = vertices.length;
        const raw = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            raw[i*3] = vertices[i][0]; raw[i*3+1] = vertices[i][1]; raw[i*3+2] = vertices[i][2];
        }
        this._rawVerts = raw;
        this._tris     = faces;
        this._nBase    = n;

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

    destroy() {
        if (this._onResize)  window.removeEventListener('resize',    this._onResize);
        if (this._onWinMove) window.removeEventListener('mousemove', this._onWinMove);
        if (this._onWinUp)   window.removeEventListener('mouseup',   this._onWinUp);
        if (this._canvas && this._canvas.parentNode)
            this._canvas.parentNode.removeChild(this._canvas);
    }
}

export function _matMul3(A, B) {
    const C = [[0,0,0],[0,0,0],[0,0,0]];
    for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++)
            for (let k = 0; k < 3; k++)
                C[i][j] += A[i][k] * B[k][j];
    return C;
}

// ZYX intrinsic Euler angles (degrees) ↔ 3×3 rotation matrix.
// Pure functions so they can be unit-tested directly (see tests/rotation-unit.js)
// instead of the test hand-copying this math, which let a real bug slip past
// the test suite (docs/29.code-improvement-plan.md, F8).
export function matrixToEulerZYX(R) {
    const beta  = Math.asin(Math.max(-1, Math.min(1, -R[2][0])));
    const cb    = Math.cos(beta);
    let alpha, gamma;
    if (cb > 1e-6) {
        alpha = Math.atan2(R[1][0], R[0][0]);
        gamma = Math.atan2(R[2][1], R[2][2]);
    } else {
        // Gimbal lock: fold all rotation into alpha
        alpha = Math.atan2(-R[0][1], R[1][1]);
        gamma = 0;
    }
    const toDeg = v => Math.round(v * 180 / Math.PI);
    return { alpha: toDeg(alpha), beta: toDeg(beta), gamma: toDeg(gamma) };
}

export function eulerZYXToMatrix(alpha, beta, gamma) {
    const toRad = d => d * Math.PI / 180;
    const a = toRad(alpha), b = toRad(beta), g = toRad(gamma);
    const ca = Math.cos(a), sa = Math.sin(a);
    const cb = Math.cos(b), sb = Math.sin(b);
    const cg = Math.cos(g), sg = Math.sin(g);
    // R = Rz(a) · Ry(b) · Rx(g)
    return [
        [ ca*cb,  ca*sb*sg - sa*cg,  ca*sb*cg + sa*sg ],
        [ sa*cb,  sa*sb*sg + ca*cg,  sa*sb*cg - ca*sg ],
        [ -sb,    cb*sg,             cb*cg            ],
    ];
}
