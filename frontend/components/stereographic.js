/**
 * Paper.js canvas overlay for stereographic landmark drawing.
 * Sits on top of the StereoView WebGL canvas.
 *
 * Coordinate systems:
 *   screen  — CSS pixel coords relative to the container element
 *   stereo  — equidistant polar (x, y in radians)
 *   sphere  — unit 3-vector {x,y,z}
 *   ref     — sphere in the reference orientation (stored in sulci.json path0)
 *
 * The rotation matrix R = stereoView.getR() maps ref→rotated (same R used by
 * StereoView.buildFrame). So:
 *   rotated→ref: p_ref = R^T * p_rotated
 *   ref→rotated: p_rot = R   * p_ref
 */
export class StereographicOverlay {
    constructor(container, stereoView) {
        this.container  = container;
        this._stereoView = stereoView;
        this.regions    = [];
        this.region     = null;
        this.tool       = 'draw';
        this._handle    = null;
        this._mouseDown = false;
        this._canvas    = null;
        this._paper     = null;
        this._lastR     = null;
        this._clipToRegion = new WeakMap();
        this._init();
        this.setTool('rotate');
    }

    // ── Setup ────────────────────────────────────────────────────────────────

    _init() {
        const { clientWidth: w, clientHeight: h } = this.container;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        Object.assign(canvas.style, {
            position: 'absolute', top: '0', left: '0',
            width: '100%', height: '100%', pointerEvents: 'auto',
        });
        this.container.appendChild(canvas);
        this._canvas = canvas;

        this._paper = new window.paper.PaperScope();
        this._paper.setup(canvas);
        this._paper.settings.handleSize = 8;

        this._lastZoom = 1.0;
        this._paper.view.onFrame = () => {
            const rStr = JSON.stringify(this._stereoView.getR());
            const zoom = this._stereoView._zoom;
            if (rStr !== this._lastR || zoom !== this._lastZoom) {
                this._lastR    = rStr;
                this._lastZoom = zoom;
                this._refreshPaths();
            }
        };

        this._onWinResize = () => this.resize();
        window.addEventListener('resize', this._onWinResize);

        canvas.addEventListener('mousedown',  e => this._onDown(e));
        canvas.addEventListener('mousemove',  e => this._onMove(e));
        canvas.addEventListener('mouseup',    () => this._onUp());
        canvas.addEventListener('mouseleave', () => { if (this._mouseDown) this._onUp(); });
        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            this._stereoView._zoom *= 1 - e.deltaY / 300;
            if (this._stereoView._zoom < 0.1) this._stereoView._zoom = 0.1;
            if (this._stereoView._zoom > 10)  this._stereoView._zoom = 10;
            this._stereoView._render();
        }, { passive: false });
    }

    // ── Tool selection ───────────────────────────────────────────────────────

    setTool(tool) {
        this.tool = tool;
        this._canvas.style.pointerEvents = (tool === 'rotate') ? 'none' : 'auto';
    }

    // ── Coordinate transforms ────────────────────────────────────────────────

    _screenToStereo(px, py) {
        const h = this.container.clientHeight, w = this.container.clientWidth;
        const z = this._stereoView._zoom;
        return { x: (2*px - w) / (h*z) * Math.PI, y: (h - 2*py) / (h*z) * Math.PI };
    }

    _stereoToScreen({ x, y }) {
        const h = this.container.clientHeight, w = this.container.clientWidth;
        const z = this._stereoView._zoom;
        return { x: w/2 + z*x*h/(2*Math.PI), y: h/2 - z*y*h/(2*Math.PI) };
    }

    _stereoToSphere({ x, y }) {
        const b = x*x + y*y;
        if (b < 1e-10) return { x: 0, y: 0, z: 1 };
        const cosR = Math.cos(Math.sqrt(b));
        const sinR = Math.sqrt(Math.max(0, 1 - cosR*cosR));
        const f = sinR / Math.sqrt(b);
        return { x: x*f, y: y*f, z: cosR };
    }

    _sphereToStereo(p) {
        const len = Math.sqrt(p.x*p.x + p.y*p.y + p.z*p.z);
        if (len < 1e-10) return { x: 0, y: 0 };
        const pz = Math.max(-1, Math.min(1, p.z / len));
        const b = Math.acos(pz), a = Math.atan2(p.y, p.x);
        return { x: b*Math.cos(a), y: b*Math.sin(a) };
    }

    // p_rotated → p_ref: apply R^T  (R = StereoView._R maps ref→rotated)
    _rotated2ref(p) {
        const R = this._stereoView.getR();
        return {
            x: R[0][0]*p.x + R[1][0]*p.y + R[2][0]*p.z,
            y: R[0][1]*p.x + R[1][1]*p.y + R[2][1]*p.z,
            z: R[0][2]*p.x + R[1][2]*p.y + R[2][2]*p.z,
        };
    }

    // p_ref → p_rotated: apply R
    _ref2rotated(p) {
        const R = this._stereoView.getR();
        return {
            x: R[0][0]*p.x + R[0][1]*p.y + R[0][2]*p.z,
            y: R[1][0]*p.x + R[1][1]*p.y + R[1][2]*p.z,
            z: R[2][0]*p.x + R[2][1]*p.y + R[2][2]*p.z,
        };
    }

    // screen → reference stereo (stored in sulci.json path0)
    _inverse(px, py) {
        return this._sphereToStereo(this._rotated2ref(this._stereoToSphere(this._screenToStereo(px, py))));
    }

    // reference stereo → screen
    _direct(rx, ry) {
        return this._stereoToScreen(this._sphereToStereo(this._ref2rotated(this._stereoToSphere({ x: rx, y: ry }))));
    }

    // ── Mouse handlers ───────────────────────────────────────────────────────

    _pos(e) {
        const rect = this._canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    _onDown(e) {
        this._mouseDown = true;
        const { x, y } = this._pos(e);
        const P = this._paper;
        const point = new P.Point(x, y);
        this._handle = null;

        if (this.tool === 'draw') {
            if (this.region) { this.region.path.selected = false; this._setSelected(this.region, false); }
            const color = this._nextColor();
            const path = new P.Path({ segments: [point], strokeColor: color, strokeWidth: 2 });
            const reg = { uid: Date.now(), name: `sulcus_${this.regions.length + 1}`, color, path, path0: [], _clips: [] };
            this.regions.push(reg);
            this.region = reg;
            this._setSelected(reg, true);
        } else {
            // Exclude handles for addpoint so fullySelected handle-dots don't intercept stroke clicks.
            // Test the selected region first so it takes precedence over nearby unselected ones.
            const hitOptions = { tolerance: 8, stroke: true, segments: true, handles: false };
            const _closest = hits => {
                if (!hits?.length) return null;
                let best = null, bestD = Infinity;
                for (const h of hits) {
                    const p = h.type === 'segment'    ? h.segment.point
                            : h.type === 'handle-in'  ? h.segment.point.add(h.segment.handleIn)
                            : h.type === 'handle-out' ? h.segment.point.add(h.segment.handleOut)
                            : h.location?.point;
                    if (!p) continue;
                    const d = Math.hypot(p.x - point.x, p.y - point.y);
                    if (d < bestD) { bestD = d; best = h; }
                }
                return best;
            };
            // Paper.js hitTestAll does not reliably return handle hits, so for the
            // selected region we scan anchors and handle endpoints directly.
            let selectedHit = null;
            if (this.region) {
                if (this.tool === 'addpoint') {
                    selectedHit = this.region.path.hitTest(point, { tolerance: 8, stroke: true });
                } else {
                    let bestD = Infinity;
                    for (const seg of this.region.path.segments) {
                        const a = seg.point;
                        const dA = Math.hypot(a.x - point.x, a.y - point.y);
                        if (dA <= 8 && dA < bestD) {
                            bestD = dA; selectedHit = { type: 'segment', segment: seg, item: this.region.path };
                        }
                        if (seg.handleIn.x !== 0 || seg.handleIn.y !== 0) {
                            const hi = a.add(seg.handleIn);
                            const dI = Math.hypot(hi.x - point.x, hi.y - point.y);
                            if (dI <= 8 && dI < bestD) {
                                bestD = dI; selectedHit = { type: 'handle-in', segment: seg, item: this.region.path };
                            }
                        }
                        if (seg.handleOut.x !== 0 || seg.handleOut.y !== 0) {
                            const ho = a.add(seg.handleOut);
                            const dO = Math.hypot(ho.x - point.x, ho.y - point.y);
                            if (dO <= 8 && dO < bestD) {
                                bestD = dO; selectedHit = { type: 'handle-out', segment: seg, item: this.region.path };
                            }
                        }
                    }
                }
            }
            const hit = selectedHit ?? _closest(P.project.hitTestAll(point, hitOptions));


            if (hit) {
                const reg = selectedHit ? this.region
                    : (this.regions.find(r => r.path === hit.item) ?? this._clipToRegion.get(hit.item));
                if (reg) {
                    if (this.region && this.region !== reg) {
                        this.region.path.selected = false;
                        this._setSelected(this.region, false);
                    }
                    this.region = reg;
                    this._setSelected(reg, true);
                    // fullySelected is set AFTER hit-type handling — setting it early
                    // bumps path._version and invalidates hit.location (CurveLocation
                    // resets _time to null when version mismatches, causing divide to fail).
                    if (hit.type === 'handle-in') {
                        this._handle = { obj: hit.segment.handleIn, lastPt: point };
                    } else if (hit.type === 'handle-out') {
                        this._handle = { obj: hit.segment.handleOut, lastPt: point };
                    } else if (hit.type === 'segment') {
                        if (this.tool === 'select') {
                            this._handle = { obj: hit.segment.point, lastPt: point };
                        } else if (this.tool === 'delpoint') {
                            hit.segment.remove();
                            this._saveRef();
                            this._refreshPaths();
                            if (this.onChange) this.onChange();
                        }
                    } else if (hit.type === 'stroke' && this.tool === 'addpoint') {
                        const loc = (hit.item === reg.path)
                            ? hit.location
                            : reg.path.getNearestLocation(point);
                        if (loc) {
                            const t = loc.time, idx = loc.index;
                            if (t > 1e-6 && t < 1 - 1e-6) {
                                const P = this._paper;
                                const curve = reg.path.curves[idx];
                                const s1 = curve._segment1, s2 = curve._segment2;
                                // Read control points directly from segments to avoid Paper.js CurveLocation invalidation
                                const p0x = s1.point.x, p0y = s1.point.y;
                                const p1x = p0x + s1.handleOut.x, p1y = p0y + s1.handleOut.y;
                                const p3x = s2.point.x, p3y = s2.point.y;
                                const p2x = p3x + s2.handleIn.x, p2y = p3y + s2.handleIn.y;
                                const u = 1 - t;
                                // de Casteljau subdivision
                                const q0x = u*p0x + t*p1x, q0y = u*p0y + t*p1y;
                                const q1x = u*p1x + t*p2x, q1y = u*p1y + t*p2y;
                                const q2x = u*p2x + t*p3x, q2y = u*p2y + t*p3y;
                                const r0x = u*q0x + t*q1x, r0y = u*q0y + t*q1y;
                                const r1x = u*q1x + t*q2x, r1y = u*q1y + t*q2y;
                                const mx  = u*r0x  + t*r1x,  my  = u*r0y  + t*r1y;
                                // Update handles of the two surrounding segments
                                s1.handleOut.set(q0x - p0x, q0y - p0y);
                                s2.handleIn.set( q2x - p3x, q2y - p3y);
                                // Insert new segment between s1 and s2
                                reg.path.insert(s1._index + 1, new P.Segment(
                                    new P.Point(mx, my),
                                    new P.Point(r0x - mx, r0y - my),
                                    new P.Point(r1x - mx, r1y - my)
                                ));
                                this._saveRef();
                                this._refreshPaths();
                                if (this.onChange) this.onChange();
                            }
                        }
                    }
                    reg.path.fullySelected = true;
                }
            } else if (this.region) {
                this.region.path.selected = false;
                this._setSelected(this.region, false);
                this.region = null;
            }
        }
    }

    _onMove(e) {
        if (!this._mouseDown) return;
        const { x, y } = this._pos(e);
        const point = new this._paper.Point(x, y);
        if (this._handle) {
            const dx = point.x - this._handle.lastPt.x;
            const dy = point.y - this._handle.lastPt.y;
            this._handle.obj.x += dx; this._handle.obj.y += dy;
            this._handle.lastPt = point;
            this._updateDecoration(this.region);
        } else if (this.tool === 'draw' && this.region) {
            this.region.path.add(point);
            this._updateDecoration(this.region);
        }
    }

    _onUp() {
        if (!this._mouseDown) return;
        this._mouseDown = false;
        if (this._handle) {
            this._handle = null;
            this._saveRef();
            this._refreshPaths();
            if (this.region) this.region.path.fullySelected = true;
            if (this.onChange) this.onChange();
        }
        if (this.tool === 'draw' && this.region) {
            this.region.path.simplify(8);
            this._saveRef();
            this._refreshPaths();
            this.region.path.fullySelected = true;
            if (this.onChange) this.onChange();
        }
    }

    // ── Reference coordinate store / refresh ─────────────────────────────────

    _saveRef() {
        for (const reg of this.regions) {
            reg.path0 = [];
            for (const seg of reg.path.segments) {
                const px = seg.point.x, py = seg.point.y;
                const ref   = this._inverse(px, py);
                const hiAbs = this._inverse(px + seg.handleIn.x,  py + seg.handleIn.y);
                const hoAbs = this._inverse(px + seg.handleOut.x, py + seg.handleOut.y);
                reg.path0.push({
                    px: ref.x,  py: ref.y,
                    ix: hiAbs.x - ref.x, iy: hiAbs.y - ref.y,
                    ox: hoAbs.x - ref.x, oy: hoAbs.y - ref.y,
                });
            }
        }
    }

    _refreshPaths() {
        for (const reg of this.regions) {
            if (!reg.path0?.length) continue;
            const segs = reg.path.segments;
            if (segs.length !== reg.path0.length) continue;
            for (let i = 0; i < reg.path0.length; i++) {
                const pt = reg.path0[i];
                const sp = this._direct(pt.px, pt.py);
                segs[i].point.x = sp.x; segs[i].point.y = sp.y;
                if (pt.ix !== 0 || pt.iy !== 0) {
                    const hi = this._direct(pt.px + pt.ix, pt.py + pt.iy);
                    segs[i].handleIn.x = hi.x - sp.x; segs[i].handleIn.y = hi.y - sp.y;
                }
                if (pt.ox !== 0 || pt.oy !== 0) {
                    const ho = this._direct(pt.px + pt.ox, pt.py + pt.oy);
                    segs[i].handleOut.x = ho.x - sp.x; segs[i].handleOut.y = ho.y - sp.y;
                }
            }
            this._rebuildClipPaths(reg);
            this._setSelected(reg, reg === this.region);
            this._updateDecoration(reg);
        }
    }

    // ── Clipped display paths ────────────────────────────────────────────────

    // Rebuilds reg._clips: dense polylines sampled from the screen-space bezier.
    // Sampling the bezier in screen space (rather than reference space) ensures
    // clips look identical to the bezier path, eliminating selected/unselected
    // shape mismatch. Segments that pass through the south-pole discard zone
    // (rz < -0.9) or jump across the disc (wrap-around) are broken into separate
    // sub-paths.
    _rebuildClipPaths(reg) {
        if (reg._clips) {
            for (const cp of reg._clips) { this._clipToRegion.delete(cp); cp.remove(); }
        }
        reg._clips = [];
        const pathSegs = reg.path.segments;
        if (!pathSegs?.length || pathSegs.length < 2) return;

        const P = this._paper;
        const color = reg.color ?? (reg.path.strokeColor?.toCSS?.() ?? '#ff6b6b');
        const sw    = reg.path.strokeWidth || 2;
        const { clientWidth: w, clientHeight: h } = this.container;
        const jumpSq = (Math.min(w, h) * 0.4) ** 2;
        const STEPS  = 20;

        // Sample screen-space bezier; convert each point to rotated sphere coords
        // for the south-pole visibility check.
        const pts = [];
        for (let i = 0; i < pathSegs.length - 1; i++) {
            const s0 = pathSegs[i], s1 = pathSegs[i + 1];
            const p0x = s0.point.x,                  p0y = s0.point.y;
            const p1x = p0x + s0.handleOut.x,        p1y = p0y + s0.handleOut.y;
            const p2x = s1.point.x + s1.handleIn.x,  p2y = s1.point.y + s1.handleIn.y;
            const p3x = s1.point.x,                  p3y = s1.point.y;
            const n = (i === pathSegs.length - 2) ? STEPS + 1 : STEPS;
            for (let j = 0; j < n; j++) {
                const t = j / STEPS, mt = 1 - t;
                const sx = mt*mt*mt*p0x + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*p3x;
                const sy = mt*mt*mt*p0y + 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t*p3y;
                const sph = this._stereoToSphere(this._screenToStereo(sx, sy));
                pts.push({ x: sx, y: sy, ok: sph.z > -0.9, rz: sph.z });
            }
        }

        // Stitch into sub-paths, breaking at unsafe points or screen jumps.
        // Track the pixel length of each clip as it is completed; the last value
        // is the length of the terminal clip and gates arrowhead visibility.
        let cur = [];
        const _finishClip = () => {
            if (cur.length < 2) { cur = []; return; }
            reg._clips.push(this._makeClipPath(P, cur, color, sw));
            cur = [];
        };
        for (const p of pts) {
            if (!p.ok) { _finishClip(); continue; }
            if (cur.length > 0) {
                const prev = cur[cur.length - 1];
                const dx = p.x - prev.x, dy = p.y - prev.y;
                if (dx*dx + dy*dy > jumpSq) _finishClip();
            }
            cur.push(p);
        }
        _finishClip();

        for (const cp of reg._clips) this._clipToRegion.set(cp, reg);

        // Arrowhead is shown when BOTH hold:
        //   1. the curve's actual endpoint (t=1 of last segment) is in the safe zone (rz > -0.9)
        //   2. the endpoint is sufficiently away from the disc edge (rz > ARROWHEAD_RZ) —
        //      the disc mesh degrades near the edge so arrowheads there look orphaned even
        //      when technically within the rendered area; -0.8 ≈ 80% of disc radius
        const ARROWHEAD_RZ   = -0.8;
        const lastPt = pts.length > 0 ? pts[pts.length - 1] : null;
        reg._endpointSafe = lastPt !== null && lastPt.ok &&
                            lastPt.rz > ARROWHEAD_RZ;
    }

    _makeClipPath(P, pts, color, sw) {
        return new P.Path({
            segments:    pts.map(p => new P.Point(p.x, p.y)),
            strokeColor: color,
            strokeWidth: sw,
        });
    }

    // Show bezier path (with handles) when selected; show clipped polylines when not.
    _setSelected(reg, isSelected) {
        if (!reg) return;
        reg.path.opacity = isSelected ? 1.0 : 0.01;
        for (const cp of (reg._clips || [])) cp.visible = !isSelected;
    }

    _updateDecoration(reg) {
        if (!reg) return;
        const P = this._paper;
        const segs = reg.path.segments;
        const color = reg.path.strokeColor;

        // When clips are showing (unselected), anchor decorations to clip endpoints
        // so the arrowhead/label tracks the visible polyline, not the bezier anchors.
        const clipsActive = (reg !== this.region) && reg._clips?.length > 0;

        // ── Arrowhead ────────────────────────────────────────────────────────
        // When clips are active, only draw the arrowhead if the curve's actual
        // endpoint (t=1 of last bezier segment) is in the safe zone. If the end
        // is clipped away, the last visible clip terminates mid-curve and an
        // arrowhead there would look orphaned / floating.
        //
        // For `prev` we walk backwards through the clip (or bezier segments)
        // to find a point ≥ 8 px from tip — this avoids a near-zero direction
        // vector when the terminal bezier sub-segment is only a few screen pixels
        // long (e.g. RS_R whose last two anchors are <3 px apart at default zoom).
        const _findPrev = (pts, tipIdx) => {
            const t = pts[tipIdx].point;
            for (let i = tipIdx - 1; i >= 0; i--) {
                const p = pts[i].point;
                if ((p.x-t.x)**2 + (p.y-t.y)**2 >= 64) return p;
            }
            return null;
        };
        let tip = null, prev = null;
        if (clipsActive && reg._endpointSafe !== false) {
            const cs = reg._clips[reg._clips.length - 1].segments;
            if (cs.length >= 2) {
                tip  = cs[cs.length - 1].point;
                prev = _findPrev(cs, cs.length - 1);
            }
        } else if (reg === this.region && segs.length >= 2) {
            tip  = segs[segs.length - 1].point;
            prev = _findPrev(segs, segs.length - 1);
        }

        if (tip && prev) {
            const bx = prev.x - tip.x, by = prev.y - tip.y;
            const bl = Math.sqrt(bx*bx + by*by);
            if (bl > 0.5) {
                const ux = bx/bl * 10, uy = by/bl * 10;
                const px = -uy, py = ux;
                const w1x = tip.x + ux - px, w1y = tip.y + uy - py;
                const w2x = tip.x + ux + px, w2y = tip.y + uy + py;
                if (reg._arrow?.segments?.length === 3) {
                    // update in-place — no allocation
                    reg._arrow.segments[0].point.x = w1x; reg._arrow.segments[0].point.y = w1y;
                    reg._arrow.segments[1].point.x = tip.x; reg._arrow.segments[1].point.y = tip.y;
                    reg._arrow.segments[2].point.x = w2x; reg._arrow.segments[2].point.y = w2y;
                } else {
                    if (reg._arrow) { reg._arrow.remove(); reg._arrow = null; }
                    const arrow = new P.Path([
                        new P.Point(w1x, w1y),
                        new P.Point(tip.x, tip.y),
                        new P.Point(w2x, w2y),
                    ]);
                    arrow.strokeColor = color;
                    arrow.strokeWidth = reg.path.strokeWidth;
                    arrow.guide = true;
                    reg._arrow = arrow;
                }
            }
        } else if (reg._arrow) {
            reg._arrow.remove(); reg._arrow = null;
        }

        // ── Label ─────────────────────────────────────────────────────────────
        let midPt = null;
        if (clipsActive) {
            const mc = reg._clips[Math.floor(reg._clips.length / 2)];
            const cs = mc.segments;
            if (cs.length > 0) midPt = cs[Math.floor(cs.length / 2)].point;
        }
        if (!midPt && segs.length >= 1) midPt = segs[Math.floor(segs.length / 2)].point;

        if (midPt) {
            if (reg._label) {
                reg._label.point.x = midPt.x + 5;
                reg._label.point.y = midPt.y - 5;
            } else {
                reg._label = new P.PointText({
                    point:      new P.Point(midPt.x + 5, midPt.y - 5),
                    content:    reg.name,
                    fillColor:  'white',
                    fontSize:   12,
                    fontFamily: 'sans-serif',
                    guide:      true,
                });
            }
        } else if (reg._label) {
            reg._label.remove(); reg._label = null;
        }
    }

    // ── Public region management ─────────────────────────────────────────────

    selectRegion(reg) {
        if (this.region === reg) return;
        const prev = this.region;
        this.region = reg;
        if (prev) { this._setSelected(prev, false); this._updateDecoration(prev); }
        if (reg)  { this._setSelected(reg,  true);  this._updateDecoration(reg);  }
    }

    addRegion(name = null) {
        const color = this._nextColor();
        const reg = {
            uid: Date.now(),
            name: name || `sulcus_${this.regions.length + 1}`,
            color,
            path: new this._paper.Path({ strokeColor: color, strokeWidth: 2 }),
            path0: [],
            _clips: [],
        };
        this.regions.push(reg);
        this.region = reg;
        this._setSelected(reg, true);
        this.setTool('draw');
        return reg;
    }

    deleteRegion(reg) {
        if (reg._clips) {
            for (const cp of reg._clips) { this._clipToRegion.delete(cp); cp.remove(); }
            reg._clips = [];
        }
        if (reg._arrow) { reg._arrow.remove(); reg._arrow = null; }
        if (reg._label) { reg._label.remove(); reg._label = null; }
        reg.path.remove();
        const i = this.regions.indexOf(reg);
        if (i >= 0) this.regions.splice(i, 1);
        if (this.region === reg) this.region = null;
    }

    renameRegion(reg, name) {
        reg.name = name;
        if (reg._label) reg._label.content = name;
    }

    // ── sulci.json I/O ───────────────────────────────────────────────────────

    toJSON() {
        this._saveRef();
        return this.regions.map(r => {
            const wasFully = r.path.fullySelected;
            r.path.selected = false;
            const json = { uid: r.uid, name: r.name, path: r.path.exportJSON(), path0: r.path0 };
            if (wasFully) r.path.fullySelected = true;
            return json;
        });
    }

    fromJSON(data) {
        for (const r of this.regions) {
            if (r._arrow) r._arrow.remove();
            if (r._label) r._label.remove();
            r.path.remove();
        }
        this.regions = []; this.region = null;
        const P = this._paper;
        for (const item of data) {
            const path = new P.Path();
            path.importJSON(item.path);
            path.selected = false;
            const color = path.strokeColor?.toCSS?.() ?? this._nextColor();
            if (!path.strokeColor) path.strokeColor = new P.Color(color);
            path.strokeWidth = path.strokeWidth || 2;
            this.regions.push({ uid: item.uid, name: item.name, color, path, path0: item.path0 || [], _clips: [] });
        }
        this._refreshPaths();
    }

    // ── 3D landmark export ───────────────────────────────────────────────────

    // Returns [{name, color, points:[{x,y,z}]}] where points are densely sampled
    // along each bezier segment (stepsPerSeg samples per curve segment) and converted
    // to unit-sphere vectors in the reference frame — same space as the sphere PLY.
    getRegions3DSampled(stepsPerSeg = 10) {
        return this.regions.map(reg => {
            const color = reg.path.strokeColor?.toCSS?.() ?? '#ff6b6b';
            const segs  = reg.path0;
            const pts   = [];
            if (!segs?.length) return { name: reg.name, color, points: pts };
            if (segs.length === 1) {
                pts.push(this._stereoToSphere({ x: segs[0].px, y: segs[0].py }));
                return { name: reg.name, color, points: pts };
            }
            for (let i = 0; i < segs.length - 1; i++) {
                const s0 = segs[i], s1 = segs[i + 1];
                // Cubic bezier control points in ref-stereo space:
                //   P0 = anchor[i], P1 = anchor[i] + handle-out, P2 = anchor[i+1] + handle-in, P3 = anchor[i+1]
                const p0x = s0.px,          p0y = s0.py;
                const p1x = s0.px + s0.ox,  p1y = s0.py + s0.oy;
                const p2x = s1.px + s1.ix,  p2y = s1.py + s1.iy;
                const p3x = s1.px,          p3y = s1.py;
                // Include endpoint only on the last segment
                const n = (i === segs.length - 2) ? stepsPerSeg + 1 : stepsPerSeg;
                for (let j = 0; j < n; j++) {
                    const t = j / stepsPerSeg, mt = 1 - t;
                    const x = mt*mt*mt*p0x + 3*mt*mt*t*p1x + 3*mt*t*t*p2x + t*t*t*p3x;
                    const y = mt*mt*mt*p0y + 3*mt*mt*t*p1y + 3*mt*t*t*p2y + t*t*t*p3y;
                    pts.push(this._stereoToSphere({ x, y }));
                }
            }
            return { name: reg.name, color, points: pts };
        });
    }

    // ── rotation.txt export ──────────────────────────────────────────────────

    getCameraRotationText() {
        // R = stereoView._R maps ref→rotated. rotation.txt stores R_cam = R^T
        // (rows of R^T = columns of R): same format as original stereo.js saveRotation().
        const R = this._stereoView.getR();
        // R^T[row][col] = R[col][row]
        const rows = [];
        for (let row = 0; row < 4; row++) {
            const vals = [];
            for (let col = 0; col < 4; col++) {
                if (row < 3 && col < 3) vals.push(R[col][row].toFixed(16));
                else vals.push(row === col ? '1.0000000000000000' : '0.0000000000000000');
            }
            rows.push(vals.join(' '));
        }
        return rows.join('\n') + '\n';
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    _nextColor() {
        const colors = ['#ff6b6b','#4ecdc4','#45b7d1','#f9ca24','#a29bfe','#fd79a8'];
        return colors[this.regions.length % colors.length];
    }

    resize() {
        const { clientWidth: w, clientHeight: h } = this.container;
        this._canvas.width = w; this._canvas.height = h;
        this._paper.view.viewSize = new this._paper.Size(w, h);
        this._refreshPaths();
    }

    destroy() {
        if (this._onWinResize) window.removeEventListener('resize', this._onWinResize);
        this._paper.view.onFrame = null;
        this._canvas.remove();
    }
}
