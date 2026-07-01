import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

const LOADER = new PLYLoader();

// ── Sphere→native mesh projection helpers (port of intersect_vector_triangle.js) ──

const _EPS = 1e-10;

// Ray from origin along p intersecting triangle (a,b,c).
// Returns {case:1, u, v} for a hit (point = (1-u-v)*a + u*b + v*c), else {case:0}.
// Direct port of intersectVectorTriangle from stereographic/intersect_vector_triangle.js.
function _intersectVecTri(p, a, b, c) {
    const u  = [b[0]-a[0], b[1]-a[1], b[2]-a[2]];
    const v  = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const n  = [u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]];
    if (Math.sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]) < _EPS) return { case: -1 };
    const a_ = n[0]*a[0]+n[1]*a[1]+n[2]*a[2];           // dot(n, vertex-a) = dot(n, a)
    const b_ = n[0]*p[0]+n[1]*p[1]+n[2]*p[2];           // dot(n, dir)
    if (b_ > -_EPS && b_ < _EPS) return { case: 0 };
    const r  = a_ / b_;                                  // r = dot(n,a)/dot(n,p): ray-plane t
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

function _dot3(p, a) { return p[0]*a[0]+p[1]*a[1]+p[2]*a[2]; }

const STEREO_VERT = `
uniform float zoom;
uniform float aspectRatio;
varying vec3 vcolor;
void main() {
    vcolor = color;
    vec4 p = viewMatrix * vec4(position, 0.0);
    p /= length(p);
    float invPI = 0.3183098861837907;
    float a = atan(p.y, p.x);
    float b = zoom * acos(clamp(p.z, -1.0, 1.0)) * invPI;
    gl_Position = vec4(b * cos(a) / aspectRatio, b * sin(a), 0.1, 1.0);
}`;

const STEREO_FRAG = `
varying vec3 vcolor;
void main() {
    gl_FragColor = vec4(vcolor, 1.0);
}`;

/** Fetch a URL and return its ArrayBuffer. */
async function fetchBuffer(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.arrayBuffer();
}

/**
 * Apply per-vertex scalar coloring to a geometry (in-place).
 * Normalises values by clipping at median ± 2σ then maps to a
 * dark-blue (deep sulci) → light-gray (gyri) ramp.
 */
function _applyScalarColors(geo, scalars) {
    const n = geo.attributes.position.count;
    if (n !== scalars.length) {
        console.warn(`Scalar count ${scalars.length} ≠ vertex count ${n} — vertex colors skipped`);
        return;
    }

    // Clip at median ± 2σ
    const arr = Float64Array.from(scalars);
    const sorted = arr.slice().sort();
    const med = sorted[Math.floor(sorted.length / 2)];
    let variance = 0;
    for (let i = 0; i < arr.length; i++) variance += (arr[i] - med) ** 2;
    const std = Math.sqrt(variance / arr.length);
    const lo = med - 2 * std, hi = med + 2 * std, range = (hi - lo) || 1;

    const cLo = new THREE.Color(0x1e3a5f); // deep sulci — dark blue
    const cHi = new THREE.Color(0xe8e8e8); // gyri — light gray
    const buf = new Float32Array(n * 3);
    const tmp = new THREE.Color();
    for (let i = 0; i < n; i++) {
        const t = Math.max(0, Math.min(1, (arr[i] - lo) / range));
        tmp.copy(cLo).lerp(cHi, t);
        buf[i * 3] = tmp.r; buf[i * 3 + 1] = tmp.g; buf[i * 3 + 2] = tmp.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(buf, 3));
}

/** Parse PLY bytes and return a centred, normalised BufferGeometry. */
function parsePly(buffer) {
    const geo = LOADER.parse(buffer);
    geo.center();
    geo.computeVertexNormals();
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const maxDim = Math.max(
        box.max.x - box.min.x,
        box.max.y - box.min.y,
        box.max.z - box.min.z,
    );
    geo.scale(2 / maxDim, 2 / maxDim, 2 / maxDim);
    return geo;
}

export class Viewer3D {
    constructor(container) {
        this.container = container;
        this.scene = new THREE.Scene();
        this._meshes = new Map(); // id → THREE.Object3D
        this._edgesOn = false;
        this._initRenderer();
        this._initControls();
        this._animate();
        window.addEventListener('resize', () => this._onResize());
    }

    // ── Setup ────────────────────────────────────────────────────────────────

    _initRenderer() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setSize(w, h);
        this.renderer.setClearColor(0x1a1a2e);
        this.container.appendChild(this.renderer.domElement);

        this.camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 1000);
        this.camera.position.set(0, 0, 3);
    }

    _initControls() {
        this.controls = new TrackballControls(this.camera, this.renderer.domElement);
        this.controls.rotateSpeed = 3.0;
        this.controls.zoomSpeed = 1.5;
        this.controls.panSpeed = 0.8;
    }

    _animate() {
        requestAnimationFrame(() => this._animate());
        this.controls.update();
        if (this._edgesOn) this._syncTrajectoryEdges();
        this.renderer.render(this.scene, this.camera);
    }

    _onResize() {
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(w, h);
        this.controls.handleResize();
        if (this._stereoUniforms) {
            this._stereoUniforms.aspectRatio.value = w / h;
        }
    }

    // ── Named mesh management ────────────────────────────────────────────────

    _addObject(id, obj) {
        this._removeObject(id);
        this._meshes.set(id, obj);
        this.scene.add(obj);
        if (this._edgesOn && !id.startsWith('__edges_')) {
            this._maybeCreateEdgesFor(id, obj);
        }
    }

    _removeObject(id) {
        if (!id.startsWith('__edges_')) {
            const edgesObj = this._meshes.get('__edges_' + id);
            if (edgesObj) {
                this.scene.remove(edgesObj);
                edgesObj.traverse(o => {
                    o.geometry?.dispose();
                    [].concat(o.material || []).forEach(m => m.dispose());
                });
                this._meshes.delete('__edges_' + id);
            }
        }
        const obj = this._meshes.get(id);
        if (!obj) return;
        this.scene.remove(obj);
        obj.traverse(o => {
            o.geometry?.dispose();
            if (o.material) {
                [].concat(o.material).forEach(m => m.dispose());
            }
        });
        this._meshes.delete(id);
    }

    // Compute unique edge vertex-index pairs from a BufferGeometry.
    // Returns a Uint32Array [a0, b0, a1, b1, …] with one pair per edge.
    _extractEdgePairs(geo) {
        const idx = geo.index;
        const nTris = idx ? idx.count / 3 : geo.attributes.position.count / 3;
        const seen = new Set();
        const pairs = [];
        for (let f = 0; f < nTris; f++) {
            const a = idx ? idx.getX(f*3)   : f*3;
            const b = idx ? idx.getX(f*3+1) : f*3+1;
            const c = idx ? idx.getX(f*3+2) : f*3+2;
            for (const [u, v] of [[a,b],[b,c],[c,a]]) {
                const key = u < v ? `${u},${v}` : `${v},${u}`;
                if (!seen.has(key)) { seen.add(key); pairs.push(u, v); }
            }
        }
        return new Uint32Array(pairs);
    }

    _maybeCreateEdgesFor(id, obj) {
        // Only create edges for plain Mesh objects; skip LineSegments, Groups (lights, landmarks), and blend (shares topology with ref)
        if (!(obj instanceof THREE.Mesh)) return;
        if (id === 'blend') return;
        const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5 });
        if (id === 'trajectory') {
            // Trajectory animates vertex positions in-place each frame; precompute edge pairs
            // and sync positions every animate tick instead of rebuilding EdgesGeometry.
            const pairs = this._extractEdgePairs(obj.geometry);
            const nEdges = pairs.length / 2;
            const posArr = new Float32Array(nEdges * 6);
            const src = obj.geometry.attributes.position.array;
            for (let i = 0; i < nEdges; i++) {
                const a = pairs[i*2], b = pairs[i*2+1];
                posArr[i*6]   = src[a*3];   posArr[i*6+1] = src[a*3+1]; posArr[i*6+2] = src[a*3+2];
                posArr[i*6+3] = src[b*3];   posArr[i*6+4] = src[b*3+1]; posArr[i*6+5] = src[b*3+2];
            }
            const edgesGeo = new THREE.BufferGeometry();
            edgesGeo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
            const lines = new THREE.LineSegments(edgesGeo, mat);
            lines.userData.edgePairs  = pairs;
            lines.userData.srcGeoAttr = obj.geometry.attributes.position;
            this._meshes.set('__edges_trajectory', lines);
            this.scene.add(lines);
        } else {
            const edgesGeo = new THREE.EdgesGeometry(obj.geometry);
            const lines = new THREE.LineSegments(edgesGeo, mat);
            this._meshes.set('__edges_' + id, lines);
            this.scene.add(lines);
        }
    }

    // Called every animate tick to keep trajectory edge positions in sync with animated vertices.
    _syncTrajectoryEdges() {
        const lines = this._meshes.get('__edges_trajectory');
        if (!lines?.userData.edgePairs) return;
        const { edgePairs, srcGeoAttr } = lines.userData;
        const src = srcGeoAttr.array;
        const dst = lines.geometry.attributes.position.array;
        const nEdges = edgePairs.length / 2;
        for (let i = 0; i < nEdges; i++) {
            const a = edgePairs[i*2], b = edgePairs[i*2+1];
            dst[i*6]   = src[a*3];   dst[i*6+1] = src[a*3+1]; dst[i*6+2] = src[a*3+2];
            dst[i*6+3] = src[b*3];   dst[i*6+4] = src[b*3+1]; dst[i*6+5] = src[b*3+2];
        }
        lines.geometry.attributes.position.needsUpdate = true;
    }

    clearAll() {
        for (const id of [...this._meshes.keys()]) this._removeObject(id);
        this._hidePlaceholder();
        this._matchLights = false;
        this._blendRef = null; this._blendMorph = null; this._blendGeo = null;
    }

    // ── Single mesh (Step 1, simple load) ────────────────────────────────────

    async loadMesh(url, { preserveOrientation = false } = {}) {
        this.clearAll();
        this._showPlaceholder('Loading…');
        try {
            const geo = parsePly(await fetchBuffer(url));
            const mesh = new THREE.Mesh(geo,
                new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }));
            this._addObject('main', mesh);
            this._hidePlaceholder();
            if (!preserveOrientation) this.controls.reset();
        } catch (err) {
            this._showPlaceholder(`Failed to load:\n${err.message}`);
            throw err;
        }
    }

    /** Load a PLY and color its vertices by a scalar array (e.g. sulcal depth). */
    async loadMeshColored(url, scalars, { preserveOrientation = false } = {}) {
        this.clearAll();
        this._showPlaceholder('Loading…');
        try {
            const geo = parsePly(await fetchBuffer(url));
            _applyScalarColors(geo, scalars);
            const mesh = new THREE.Mesh(geo,
                new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
            this._addObject('main', mesh);
            this._hidePlaceholder();
            if (!preserveOrientation) this.controls.reset();
        } catch (err) {
            this._showPlaceholder(`Failed to load:\n${err.message}`);
            throw err;
        }
    }

    // ── Pair (ref + mov) ─────────────────────────────────────────────────────

    async loadRef(url) {
        this._removeObject('trajectory');  // pair mode and trajectory mode are exclusive
        this._removeObject('main');        // pair mode and single-mesh mode are exclusive
        this._showPlaceholder('Loading ref…');
        const geo = parsePly(await fetchBuffer(url));
        const mesh = new THREE.Mesh(geo,
            new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }));
        this._addObject('ref', mesh);
        this._hidePlaceholder();
        this.controls.reset();
    }

    async loadMov(url) {
        this._removeObject('trajectory');
        this._removeObject('main');        // pair mode and single-mesh mode are exclusive
        this._showPlaceholder('Loading mov…');
        const geo = parsePly(await fetchBuffer(url));
        const edges = new THREE.EdgesGeometry(geo);
        const lines = new THREE.LineSegments(edges,
            new THREE.LineBasicMaterial({ color: 0xf4a261, transparent: true, opacity: 0.85 }));
        this._addObject('mov', lines);
        this._hidePlaceholder();
    }

    // ── Trajectory support ───────────────────────────────────────────────────

    /**
     * Install a pre-built geometry (from TrajectoryPlayer) as the trajectory
     * mesh. Clears ref/mov first — trajectory and pair modes are exclusive.
     * Returns the Mesh so TrajectoryPlayer can update positions directly.
     */
    setTrajectoryGeometry(geometry) {
        this._removeObject('ref');
        this._removeObject('mov');
        const mesh = new THREE.Mesh(geometry,
            new THREE.MeshNormalMaterial({ side: THREE.DoubleSide }));
        this._addObject('trajectory', mesh);
        this._hidePlaceholder();
        this.controls.reset();
        return mesh;
    }

    // ── Stereographic projection mode ───────────────────────────────────────

    async loadMeshStereo(url, scalars = null) {
        this.clearAll();
        this._showPlaceholder('Loading…');
        try {
            const geo = parsePly(await fetchBuffer(url));
            if (scalars && scalars.length === geo.attributes.position.count) {
                _applyScalarColors(geo, scalars);
            } else {
                const n = geo.attributes.position.count;
                const buf = new Float32Array(n * 3).fill(0.6);
                geo.setAttribute('color', new THREE.BufferAttribute(buf, 3));
            }
            const w = this.container.clientWidth;
            const h = this.container.clientHeight;
            this._stereoUniforms = {
                zoom: { value: 1.0 },
                aspectRatio: { value: w / h },
            };
            const mat = new THREE.ShaderMaterial({
                uniforms: this._stereoUniforms,
                vertexShader: STEREO_VERT,
                fragmentShader: STEREO_FRAG,
                vertexColors: true,
                side: THREE.DoubleSide,
            });
            this._addObject('stereo', new THREE.Mesh(geo, mat));
            this._hidePlaceholder();
            this.camera.position.set(0, 0, 1);
            this.controls.noPan = true;
            this.controls.noZoom = true;
            this.controls.reset();
        } catch (err) {
            this._showPlaceholder(`Failed to load:\n${err.message}`);
            throw err;
        }
    }

    disableStereoMode() {
        this._removeObject('stereo');
        this._stereoUniforms = null;
        this.controls.noPan = false;
        this.controls.noZoom = false;
        this.camera.position.set(0, 0, 3);
        this.controls.reset();
    }

    getStereoZoom() { return this._stereoUniforms?.zoom.value ?? 1.0; }
    setStereoZoom(z) { if (this._stereoUniforms) this._stereoUniforms.zoom.value = z; }

    // ── Wireframe toggle ────────────────────────────────────────────────────

    setWireframe(on) {
        const obj = this._meshes.get('main');
        if (obj instanceof THREE.Mesh) obj.material.wireframe = on;
    }

    // ── Edges overlay toggle ─────────────────────────────────────────────────

    setEdges(on) {
        this._edgesOn = on;
        // Remove all existing edge overlays
        for (const id of [...this._meshes.keys()]) {
            if (!id.startsWith('__edges_')) continue;
            const obj = this._meshes.get(id);
            this.scene.remove(obj);
            obj.traverse(o => {
                o.geometry?.dispose();
                [].concat(o.material || []).forEach(m => m.dispose());
            });
            this._meshes.delete(id);
        }
        if (!on) return;
        // Rebuild edges for all currently loaded eligible meshes
        for (const [id, obj] of this._meshes) {
            if (id.startsWith('__edges_')) continue;
            this._maybeCreateEdgesFor(id, obj);
        }
    }

    // ── Landmark projection onto native mesh (align 3D view) ────────────────

    // Returns the pre-transformed vertex positions of the 'main' mesh as [[x,y,z],…],
    // in Three.js scene coordinates (already centered + scaled by parsePly).
    getMainMeshVertexArray() {
        const obj = this._meshes.get('main');
        if (!(obj instanceof THREE.Mesh)) return null;
        const pos = obj.geometry.attributes.position;
        const arr = [];
        for (let i = 0; i < pos.count; i++) arr.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
        return arr;
    }

    // Project landmark paths from sphere space onto the native mesh surface.
    //
    // regions3d   : [{name, color, points:[{x,y,z}]}] — unit-sphere vectors in ref frame
    //               (from StereographicOverlay.getRegions3DSampled())
    // sphRawF32   : Float32Array of raw sphere vertex coords (StereoView._rawVerts)
    // sphNBase    : number of sphere vertices (StereoView._nBase)
    // sphTris     : array of [a,b,c] index triples (StereoView._tris)
    // nativeVerts : [[x,y,z],…] from getMainMeshVertexArray() — same index ordering as sphere
    //
    // Algorithm mirrors labels2lines() in stereographic/stereo.js:
    //   for each path point (unit-sphere vector), find the containing sphere triangle via
    //   dot-product filter + intersectVectorTriangle, then interpolate native vertices
    //   using the same barycentric (u,v) weights.
    setLandmarkLinesOnMesh(regions3d, sphRawF32, sphNBase, sphTris, nativeVerts) {
        this._removeObject('landmarks');
        if (!regions3d?.length || !sphRawF32 || !nativeVerts?.length) return;

        // Enable polygon offset so landmark lines always render on top of faces
        const mainMesh = this._meshes.get('main');
        if (mainMesh instanceof THREE.Mesh) {
            mainMesh.material.polygonOffset = true;
            mainMesh.material.polygonOffsetFactor = 1;
            mainMesh.material.polygonOffsetUnits  = 1;
            mainMesh.material.needsUpdate = true;
        }

        // Normalise sphere vertices to unit sphere (matching StereoView._buildFrame)
        const sv = [];
        for (let i = 0; i < sphNBase; i++) {
            const x = sphRawF32[i*3], y = sphRawF32[i*3+1], z = sphRawF32[i*3+2];
            const len = Math.sqrt(x*x+y*y+z*z) || 1;
            sv.push([x/len, y/len, z/len]);
        }

        const group = new THREE.Group();

        for (const reg of regions3d) {
            if (!reg.points?.length) continue;
            const vectors = [];

            for (const p of reg.points) {
                const pa = [p.x, p.y, p.z];
                for (const tri of sphTris) {
                    const [ai, bi, ci] = tri;
                    // Same cull as labels2lines: dot product with first vertex > 0.9
                    if (_dot3(pa, sv[ai]) <= 0.9) continue;
                    const c = _intersectVecTri(pa, sv[ai], sv[bi], sv[ci]);
                    if (c.case !== 1) continue;
                    const w = 1 - c.u - c.v;
                    const na = nativeVerts[ai], nb = nativeVerts[bi], nc = nativeVerts[ci];
                    vectors.push(new THREE.Vector3(
                        w*na[0] + c.u*nb[0] + c.v*nc[0],
                        w*na[1] + c.u*nb[1] + c.v*nc[1],
                        w*na[2] + c.u*nb[2] + c.v*nc[2],
                    ));
                    break;
                }
            }

            if (vectors.length < 2) continue;
            const curve   = new THREE.CatmullRomCurve3(vectors);
            const tubeSeg = Math.max(vectors.length * 4, 100);
            const radius  = 0.015;
            const geo     = new THREE.TubeGeometry(curve, tubeSeg, radius, 6, false);
            const mat     = new THREE.MeshBasicMaterial({ color: new THREE.Color(reg.color) });
            group.add(new THREE.Mesh(geo, mat));
        }

        if (group.children.length > 0) this._addObject('landmarks', group);
    }

    // ── Match step overlay (ref solid + morph/match semi-transparent) ───────

    _ensureLights() {
        if (this._matchLights) return;
        this._matchLights = true;
        const amb = new THREE.AmbientLight(0xffffff, 0.5);
        const dir = new THREE.DirectionalLight(0xffffff, 0.9);
        dir.position.set(1, 2, 3);
        const grp = new THREE.Group();
        grp.add(amb, dir);
        this._addObject('__lights', grp);
    }

    async loadRefForMatch(url, { preserveOrientation = false } = {}) {
        this._removeObject('main');
        this._removeObject('match');
        this._showPlaceholder('Loading…');
        try {
            const geo = parsePly(await fetchBuffer(url));
            const mat = new THREE.MeshLambertMaterial({ color: 0x8899aa, side: THREE.DoubleSide });
            this._removeObject('ref');
            this._addObject('ref', new THREE.Mesh(geo, mat));
            this._ensureLights();
            this._hidePlaceholder();
            if (!preserveOrientation) this.controls.reset();
        } catch (err) {
            this._showPlaceholder(`Failed to load:\n${err.message}`);
            throw err;
        }
    }

    loadMatchFromData(vertices, faces, { color = 0xff8844, opacity = 0.6 } = {}) {
        this._removeObject('main');
        const n = vertices.length;
        const posArr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            posArr[i*3] = vertices[i][0]; posArr[i*3+1] = vertices[i][1]; posArr[i*3+2] = vertices[i][2];
        }
        const idxArr = new Uint32Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            idxArr[i*3] = faces[i][0]; idxArr[i*3+1] = faces[i][1]; idxArr[i*3+2] = faces[i][2];
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
        geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
        geo.center();
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        const box = geo.boundingBox;
        const maxDim = Math.max(
            box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z,
        ) || 1;
        geo.scale(2 / maxDim, 2 / maxDim, 2 / maxDim);
        const mat = new THREE.MeshLambertMaterial({
            color, transparent: opacity < 1, opacity, side: THREE.DoubleSide,
        });
        this._removeObject('match');
        this._addObject('match', new THREE.Mesh(geo, mat));
        this._ensureLights();
    }

    async loadMatchFromUrl(url, { color = 0xff8844, opacity = 0.6, preserveOrientation = true } = {}) {
        const geo = parsePly(await fetchBuffer(url));
        const mat = new THREE.MeshLambertMaterial({
            color, transparent: opacity < 1, opacity, side: THREE.DoubleSide,
        });
        this._removeObject('match');
        this._addObject('match', new THREE.Mesh(geo, mat));
        this._ensureLights();
        if (!preserveOrientation) this.controls.reset();
    }

    setMatchOpacity(opacity) {
        const obj = this._meshes.get('match');
        if (obj instanceof THREE.Mesh) {
            obj.material.opacity = opacity;
            obj.material.transparent = opacity < 1;
            obj.material.needsUpdate = true;
        }
    }

    showSlot(id, visible) {
        const obj = this._meshes.get(id);
        if (obj) obj.visible = visible;
    }

    // ── Ref ↔ Mov blend mesh (morph retopology visualization) ───────────────

    /**
     * Build a blend mesh that can be smoothly interpolated between two vertex
     * sets sharing the same face connectivity (ref native ↔ mov in ref topology).
     * Starts at t=0 (ref shape).  Call setBlendT(t) to morph.
     *
     * @param {number[][]} refVerts   ref native surface vertices [[x,y,z],…]
     * @param {number[][]} morphVerts mov native surface vertices in ref topology
     * @param {number[][]} faces      shared face connectivity [[a,b,c],…]
     */
    loadBlendMesh(refVerts, morphVerts, faces) {
        this._removeObject('blend');
        this._blendRef = null; this._blendMorph = null; this._blendGeo = null;

        const n = refVerts.length;

        // Normalize by ref bounding box (same scale factor as parsePly)
        let minX=Infinity, maxX=-Infinity, minY=Infinity, maxY=-Infinity,
            minZ=Infinity, maxZ=-Infinity;
        for (const [x, y, z] of refVerts) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }
        const scale = 2 / Math.max(maxX-minX, maxY-minY, maxZ-minZ, 1e-6);

        const rF32 = new Float32Array(n * 3);
        const mF32 = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            rF32[i*3]   = refVerts[i][0]  * scale;
            rF32[i*3+1] = refVerts[i][1]  * scale;
            rF32[i*3+2] = refVerts[i][2]  * scale;
            mF32[i*3]   = morphVerts[i][0] * scale;
            mF32[i*3+1] = morphVerts[i][1] * scale;
            mF32[i*3+2] = morphVerts[i][2] * scale;
        }

        const idxArr = new Uint32Array(faces.length * 3);
        for (let i = 0; i < faces.length; i++) {
            idxArr[i*3] = faces[i][0]; idxArr[i*3+1] = faces[i][1]; idxArr[i*3+2] = faces[i][2];
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(rF32.slice(), 3));
        geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
        geo.computeVertexNormals();

        const mat = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
        this._addObject('blend', new THREE.Mesh(geo, mat));
        this._blendRef  = rF32;
        this._blendMorph = mF32;
        this._blendGeo  = geo;
        this._hidePlaceholder();
        this.controls.reset();
    }

    /**
     * Interpolate the blend mesh between ref (t=0) and morphed-mov (t=1).
     * @param {number} t  value in [0, 1]
     */
    setBlendT(t) {
        if (!this._blendRef || !this._blendGeo) return;
        const pos = this._blendGeo.attributes.position.array;
        const r = this._blendRef, m = this._blendMorph;
        for (let i = 0; i < pos.length; i++) pos[i] = (1 - t) * r[i] + t * m[i];
        this._blendGeo.attributes.position.needsUpdate = true;
        this._blendGeo.computeVertexNormals();
    }

    // ── Placeholder overlay ──────────────────────────────────────────────────

    _showPlaceholder(msg) {
        let el = this.container.querySelector('.viewer-placeholder');
        if (!el) {
            el = Object.assign(document.createElement('div'),
                { className: 'viewer-placeholder' });
            this.container.appendChild(el);
        }
        el.textContent = msg;
        el.style.display = 'flex';
    }

    _hidePlaceholder() {
        const el = this.container.querySelector('.viewer-placeholder');
        if (el) el.style.display = 'none';
    }
}
