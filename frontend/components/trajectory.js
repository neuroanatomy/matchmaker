import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

const LOADER = new PLYLoader();

/**
 * Tent weight: linear falloff from frame j, zero beyond ±1 frame.
 * Matches the original trajectoryviewer interpolation.
 */
function tentWeight(j, t) {
    let w = t - (j - 1);
    if (w > 1) w = 2 - w;
    if (w < 0) w = 0;
    return w;
}

/**
 * TrajectoryPlayer — loads a sequence of same-topology PLY files and
 * interpolates between them.
 *
 * Usage:
 *   const player = new TrajectoryPlayer(viewer);
 *   await player.load([url0, url1, url2, ...]);
 *   player.seek(0.5);  // t ∈ [0, 1]
 *   player.play();
 *   player.pause();
 */
export class TrajectoryPlayer {
    #viewer;
    #frames = [];      // Float32Array[] — one per PLY file
    #geometry = null;  // shared BufferGeometry whose positions get mutated
    #mesh = null;      // THREE.Mesh owned by the viewer
    #t = 0;            // current normalised time [0, 1]
    #playing = false;
    #rafId = null;
    #speed = 4.0;      // full-cycle seconds; increase for slower playback
    #lastTs = null;
    #onSeek = null;    // callback(t) called after each seek

    constructor(viewer) {
        this.#viewer = viewer;
    }

    get frameCount() { return this.#frames.length; }
    get t() { return this.#t; }
    get isLoaded() { return this.#frames.length > 0; }
    get isPlaying() { return this.#playing; }
    get speed() { return this.#speed; }
    set speed(s) { this.#speed = s; }

    /** Register a callback invoked each time seek() is called. */
    onSeek(fn) { this.#onSeek = fn; }

    /**
     * Load PLY URLs. All files must share the same vertex count and face
     * topology. Replaces any previously loaded trajectory.
     */
    async load(urls) {
        if (!urls?.length) throw new Error('TrajectoryPlayer.load: empty URL list');

        // Fetch and parse all frames concurrently
        const geometries = await Promise.all(urls.map(async url => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
            return LOADER.parse(await res.arrayBuffer());
        }));

        // Validate all frames have the same vertex count
        const n = geometries[0].attributes.position.count;
        for (let i = 1; i < geometries.length; i++) {
            if (geometries[i].attributes.position.count !== n) {
                throw new Error(
                    `Frame ${i} has ${geometries[i].attributes.position.count} vertices; ` +
                    `expected ${n}`
                );
            }
        }

        // Extract position arrays (copies, so we don't hold references to parsed geometries)
        const rawFrames = geometries.map(g =>
            new Float32Array(g.attributes.position.array)
        );

        // Compute global bounding box across all frames for consistent normalisation
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (const arr of rawFrames) {
            for (let i = 0; i < arr.length; i += 3) {
                if (arr[i]   < min[0]) min[0] = arr[i];
                if (arr[i+1] < min[1]) min[1] = arr[i+1];
                if (arr[i+2] < min[2]) min[2] = arr[i+2];
                if (arr[i]   > max[0]) max[0] = arr[i];
                if (arr[i+1] > max[1]) max[1] = arr[i+1];
                if (arr[i+2] > max[2]) max[2] = arr[i+2];
            }
        }
        const cx = (min[0] + max[0]) / 2;
        const cy = (min[1] + max[1]) / 2;
        const cz = (min[2] + max[2]) / 2;
        const size = Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) || 1;
        const scale = 2 / size;

        for (const arr of rawFrames) {
            for (let i = 0; i < arr.length; i += 3) {
                arr[i]   = (arr[i]   - cx) * scale;
                arr[i+1] = (arr[i+1] - cy) * scale;
                arr[i+2] = (arr[i+2] - cz) * scale;
            }
        }
        this.#frames = rawFrames;

        // Build a shared geometry from the first frame; positions will be
        // mutated in-place by seek().
        const geo = geometries[0];
        geo.center();
        geo.computeVertexNormals();
        // Apply our own normalisation to the shared geometry's positions
        const pos = geo.attributes.position.array;
        for (let i = 0; i < pos.length; i++) pos[i] = rawFrames[0][i];
        geo.attributes.position.needsUpdate = true;
        geo.computeBoundingBox();

        // Dispose old geometry when reloading
        this.#geometry?.dispose();
        this.#geometry = geo;
        this.#t = 0;

        // Hand the geometry to the viewer (it creates and owns the Mesh)
        this.#mesh = this.#viewer.setTrajectoryGeometry(geo);
    }

    /**
     * Seek to normalised time t ∈ [0, 1].
     * Interpolates vertex positions between the two nearest frames.
     */
    seek(t) {
        if (!this.#frames.length) return;
        this.#t = Math.max(0, Math.min(1, t));

        const nFrames = this.#frames.length;
        const fi = this.#t * (nFrames - 1); // floating-point frame index

        const pos = this.#geometry.attributes.position.array;

        // Reset to zero
        pos.fill(0);

        // Accumulate weighted frame contributions (tent interpolation)
        for (let j = 0; j < nFrames; j++) {
            const w = tentWeight(j, fi);
            if (w === 0) continue;
            const frame = this.#frames[j];
            for (let i = 0; i < pos.length; i++) {
                pos[i] += w * frame[i];
            }
        }

        this.#geometry.attributes.position.needsUpdate = true;
        this.#geometry.computeVertexNormals();

        this.#onSeek?.(this.#t);
    }

    play(speed = this.#speed) {
        if (this.#playing) return;
        this.#speed = speed;
        this.#playing = true;
        this.#lastTs = null;
        requestAnimationFrame(ts => this.#tick(ts));
    }

    pause() {
        this.#playing = false;
        if (this.#rafId) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    }

    dispose() {
        this.pause();
        this.#geometry?.dispose();
        this.#frames = [];
    }

    // ── Private ───────────────────────────────────────────────────────────────

    #tick(ts) {
        if (!this.#playing) return;
        this.#rafId = requestAnimationFrame(t => this.#tick(t));
        if (this.#lastTs === null) { this.#lastTs = ts; return; }

        const dt = (ts - this.#lastTs) / 1000; // seconds
        this.#lastTs = ts;

        // Ping-pong loop
        let t = this.#t + dt / this.#speed;
        if (t > 1) t = 2 - t;
        if (t < 0) t = -t;
        this.seek(t);
    }
}
