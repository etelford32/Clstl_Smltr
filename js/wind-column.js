/**
 * wind-column.js — vertical wind-profile columns for the EarthView stack
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The geometry half is PURE and THREE-free (`columnGrid`, `columnSegments`,
 * `tangentBasis`), so `node tests/wind-column.mjs` can pin the vector math
 * without a GL context. Only `WindColumns` touches THREE.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The four particle layers answer "where is the air going at THIS level"
 * beautifully, and answer "how does the wind change with height" not at all.
 * Stacked on nearly-coincident shells they overlap into one field of streaks
 * — the reading that made the globe look like white spaghetti — and even
 * once the exaggeration ramp (js/atmo-scale.js) fans them apart, each layer
 * is still a separate sheet the eye has to mentally register against the
 * others.
 *
 * A column ties them together: one mast from the surface shell up through
 * every enabled level, with a downwind arrow planted at each. Veering,
 * backing and speed shear become one shape you read at a glance, which is
 * the thing a forecaster actually wants off a vertical profile and the thing
 * four independent streak fields cannot show.
 *
 * WHAT IT DOES NOT DO
 * ───────────────────
 * It computes no wind. Every vector comes from the sampler the caller hands
 * in — the SAME per-level bilinear lookups the particle trails advect
 * against — so a column and the streaks around it can never disagree. A
 * level with no upstream data contributes no arrow (never a zero-length one,
 * which would read as "calm" rather than "no data").
 *
 * WHEN IT DRAWS
 * ─────────────
 * Only once the camera is close enough that the stack has visibly fanned AND
 * at least two levels are enabled. From orbit the levels are nearly
 * coincident, so a mast would be a dot and 96 of them would be the same
 * clutter this is meant to cure. Gated by the caller.
 */

const DEG = Math.PI / 180;

/**
 * Local east / north unit vectors at (lat, lon), in the page's canonical
 * frame:  x = cosφ·cosλ,  y = sinφ,  z = −cosφ·sinλ
 *
 * east  = ∂p/∂λ normalised = (−sinλ, 0, −cosλ)
 * north = ∂p/∂φ normalised = (−sinφ·cosλ, cosφ, sinφ·sinλ)
 *
 * Both are exact unit vectors for every φ except the poles, where east is
 * still well-defined by this formula (the singularity is in the ∂p/∂λ
 * MAGNITUDE, which we normalise away) — so callers do not need a polar
 * special case, only the ±80° spawn clamp the trails already use.
 */
export function tangentBasis(lat, lon) {
    const phi = lat * DEG, lam = lon * DEG;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const sl = Math.sin(lam), cl = Math.cos(lam);
    return {
        up:    [cp * cl, sp, -cp * sl],
        east:  [-sl, 0, -cl],
        north: [-sp * cl, cp, sp * sl],
    };
}

/**
 * A camera-focused lattice of column sites, re-centred on the sub-camera
 * point so the visible cap is populated and the far hemisphere costs
 * nothing. Same shape as the wind-arrow grid in earth.html and for the same
 * reason: spacing tightens with zoom so the read goes synoptic → regional
 * without ever drawing more than `maxSites` masts.
 *
 * Sites are snapped to a fixed lat/lon lattice (not to the camera point) so
 * they stay put as the camera nudges around — an un-snapped grid shimmers.
 *
 * @param {{focusLat:number, focusLon:number, zoom01:number,
 *          maxSites?:number, latLimit?:number}} o
 */
export function columnGrid(o) {
    const zoom01   = Math.max(0, Math.min(1, o.zoom01 ?? 0));
    const maxSites = o.maxSites ?? 96;
    const latLimit = o.latLimit ?? 78;

    // Spacing: 18° when the fan-out first becomes legible, tightening to 4°
    // pressed right up against the deck.
    const step = 18 - 14 * zoom01;
    // Angular half-extent of the populated cap. Shrinks with zoom so the
    // site budget concentrates where the user is actually looking.
    const extent = 46 - 33 * zoom01;

    const keyLat = Math.round(o.focusLat / step) * step;
    const keyLon = Math.round(o.focusLon / step) * step;

    const sites = [];
    const latLo = Math.max(-latLimit, keyLat - extent);
    const latHi = Math.min(latLimit, keyLat + extent);
    for (let lat = latLo; lat <= latHi + 1e-9; lat += step) {
        // Converging meridians: widen the longitude step by 1/cos(lat) so
        // high-latitude rows don't collapse into a dense arc. Capped so the
        // polar rows stay a sane handful of sites rather than two.
        const lonStep = Math.min(step / Math.max(0.18, Math.cos(lat * DEG)), 90);
        for (let d = -extent; d <= extent + 1e-9; d += lonStep) {
            let lon = keyLon + d;
            if (lon > 180) lon -= 360;
            if (lon < -180) lon += 360;
            sites.push({ lat, lon });
            if (sites.length >= maxSites) return { step, extent, sites };
        }
    }
    return { step, extent, sites };
}

/**
 * Vertices for one column. Emits LINE SEGMENT pairs (every 2 vertices = one
 * segment) into `out.pos` / `out.col`, appending from `out.n` vertices.
 *
 * `levels` must be sorted low → high and carry, per level:
 *   radius   shell radius this level is currently drawn at (from atmo-scale)
 *   u, v     wind components, normalised to [-1,1] by that level's ceiling
 *   speed01  normalised speed, for arrow length
 *   color    [r,g,b] this level's identity colour
 *   hasData  false ⇒ mast still passes through, but NO arrow is planted
 *
 * @returns {number} vertices written
 */
export function columnSegments(lat, lon, levels, out, opts = {}) {
    const mastAlpha = opts.mastAlpha ?? 0.30;
    const arrowLen  = opts.arrowLen  ?? 0.055;   // radians of arc at full speed
    const headFrac  = opts.headFrac  ?? 0.34;
    const strength  = opts.strength  ?? 1;
    const { up, east, north } = tangentBasis(lat, lon);

    const pos = out.pos, col = out.col;
    let n = out.n;
    const push = (p, c) => {
        pos[n * 3] = p[0]; pos[n * 3 + 1] = p[1]; pos[n * 3 + 2] = p[2];
        col[n * 3] = c[0]; col[n * 3 + 1] = c[1]; col[n * 3 + 2] = c[2];
        n++;
    };
    const at = (r, e, no) => [
        up[0] * r + east[0] * e + north[0] * no,
        up[1] * r + east[1] * e + north[1] * no,
        up[2] * r + east[2] * e + north[2] * no,
    ];

    // ── The mast: one segment per gap between consecutive levels ────────────
    // Drawn dim. It is a reference line, not data — the DATA is the arrows,
    // and a bright mast competes with them for attention at exactly the
    // moment the user is trying to compare arrow directions.
    for (let i = 0; i < levels.length - 1; i++) {
        const a = levels[i], b = levels[i + 1];
        // Tint each mast section toward the level it rises to, so the mast
        // itself carries the altitude gradient.
        const c = [
            b.color[0] * mastAlpha * strength,
            b.color[1] * mastAlpha * strength,
            b.color[2] * mastAlpha * strength,
        ];
        push(at(a.radius, 0, 0), c);
        push(at(b.radius, 0, 0), c);
    }

    // ── One downwind arrow per level ────────────────────────────────────────
    for (const lv of levels) {
        if (!lv.hasData) continue;              // no data ⇒ no glyph, not a calm
        const spd = Math.max(0, Math.min(1, lv.speed01 ?? Math.hypot(lv.u, lv.v)));
        const mag = Math.hypot(lv.u, lv.v);
        if (!(mag > 1e-4)) continue;            // genuinely calm: no direction to draw
        const ex = lv.u / mag, nx = lv.v / mag; // unit downwind in (east, north)

        // Arrow length carries speed as well as colour. Two channels for one
        // quantity is redundant on purpose: colour alone is unreliable for
        // readers with colour-vision deficiency, and length survives the
        // additive-blend saturation that flattens colour in dense fields.
        const L = arrowLen * (0.30 + 0.70 * spd);
        const c = [lv.color[0] * strength, lv.color[1] * strength, lv.color[2] * strength];

        const tail = [0, 0];
        const head = [ex * L, nx * L];
        push(at(lv.radius, tail[0], tail[1]), c);
        push(at(lv.radius, head[0], head[1]), c);

        // Chevron head — two barbs swept back 30° from the shaft.
        const hl = L * headFrac;
        const cs = Math.cos(2.618), sn = Math.sin(2.618);   // 150°
        for (const s of [1, -1]) {
            const bx = ex * cs - s * nx * sn;
            const bn = ex * s * sn + nx * cs;
            push(at(lv.radius, head[0], head[1]), c);
            push(at(lv.radius, head[0] + bx * hl, head[1] + bn * hl), c);
        }
    }

    const written = n - out.n;
    out.n = n;
    return written;
}

/** Vertices one column can emit, worst case: masts + shaft + 2 barbs each. */
export function maxVerticesPerColumn(levelCount) {
    return (levelCount - 1) * 2 + levelCount * 6;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THREE wrapper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @param {object} THREE            the three module (injected so the pure
 *                                  half above stays importable in node)
 * @param {object} parent           Object3D to attach to (the rotating earth)
 * @param {object} opts
 *   maxSites      site budget (default 96)
 *   levelCount    how many levels a column can carry (default 4)
 *   renderOrder   draw order
 */
export class WindColumns {
    constructor(THREE, parent, opts = {}) {
        this.THREE      = THREE;
        this.maxSites   = opts.maxSites ?? 96;
        this.levelCount = opts.levelCount ?? 4;
        this.visible    = false;

        const vertCount = this.maxSites * maxVerticesPerColumn(this.levelCount);
        this._pos = new Float32Array(vertCount * 3);
        this._col = new Float32Array(vertCount * 3);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._col, 3));
        geo.attributes.position.setUsage(THREE.DynamicDrawUsage);
        geo.attributes.color.setUsage(THREE.DynamicDrawUsage);

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.mesh = new THREE.LineSegments(geo, mat);
        // Same reason as the trail meshes: vertices are rewritten every frame
        // and the shells ride the exaggeration ramp, so a cached bounding
        // sphere from frame 1 would cull the layer once it fans out.
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = opts.renderOrder ?? 3.4;
        this.mesh.visible = false;
        parent.add(this.mesh);
    }

    setVisible(v) { this.visible = v; this.mesh.visible = v; }

    /**
     * Rebuild. `levelsAt(lat, lon)` returns this site's level array in the
     * shape columnSegments expects, or null to skip the site entirely.
     */
    update({ focusLat, focusLon, zoom01, strength, levelsAt }) {
        if (!this.visible) return;
        const { sites } = columnGrid({ focusLat, focusLon, zoom01, maxSites: this.maxSites });

        const out = { pos: this._pos, col: this._col, n: 0 };
        const cap = this.maxSites * maxVerticesPerColumn(this.levelCount);
        for (const s of sites) {
            const levels = levelsAt(s.lat, s.lon);
            if (!levels || levels.length < 2) continue;
            if (out.n + maxVerticesPerColumn(levels.length) > cap) break;
            columnSegments(s.lat, s.lon, levels, out, { strength });
        }

        // Zero the tail so last frame's columns don't keep glowing. Additive
        // blending renders a zeroed vertex invisible, so this is the whole
        // cleanup — no draw-range juggling.
        this._col.fill(0, out.n * 3);
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.color.needsUpdate    = true;
    }
}
