/**
 * sun-observed.js — the OBSERVED Sun on sun.html's photosphere sphere
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 1 of SUN_VISUALS_WORLD_CLASS_PLAN.md. Wraps the live SDO full-disk
 * image (HMI continuum in white light, AIA in the EUV modes, HMI LOS in the
 * magnetogram mode) onto the Earth-facing hemisphere of the photosphere
 * sphere. The far side stays procedural. The page's chip says which is which
 * at all times (§5 of the plan: the chip is never wrong).
 *
 * Two halves, deliberately split:
 *
 *   PURE (node-testable, no DOM / three / fetch — `tests/sun-observed.mjs`):
 *     solarEphemeris(date)          → { b0Deg, pDeg, lambdaDeg }  (Meeus ch. 25/29)
 *     heliographicToVec(lat, lon)   → scene unit vector (+z sub-Earth, +y north)
 *     projectDiskUV(p, geom)        → { u, v, zObs, visible }  disk→sphere mapping
 *     measureDisk(gray, w, h)       → { cx, cy, r } in normalised image coords
 *     DISK_FRACTION / diskFractionFor(channel) — geometric fallbacks per instrument
 *     freshnessFor(ageS)            → 'live' | 'stale' | 'expired'
 *     chipLabel(state)              → the provenance string the chip prints
 *     rotationDeRotate(...)         — the inverse of the AR-slot rotation
 *
 *   BROWSER (`SunObserved` class): fetch through the house proxy, measure the
 *   disk from the decoded frame, upload the texture, cross-fade frames, keep
 *   the last good frame on failure, and drive the uniforms + chip state.
 *
 * ── Geometry ─────────────────────────────────────────────────────────────
 * The sphere's object frame (sunFS comment, sun.html ~2864): +y is the solar
 * rotation axis, +z points at the sub-Earth observer, lon = atan(x, z). The
 * AR slots (`u_arSpots`, sun.html ~8346) are built from NOAA heliographic
 * (lat, lon) as (cos lat sin lon, sin lat, cos lat cos lon) and then ROTATED
 * about y by rotAng = u_time·0.014·u_rot·diffRot(lat). The observed disk is
 * projected in exactly that frame, de-rotated by the same rotAng, so the
 * image's sunspots and the shader's `u_arSpots` never separate whatever the
 * sim clock does. (Note, recorded for the plan: the marker Group rotates
 * with `solarRotAngle` at 0.004·2π/unit in the OPPOSITE sense — a pre-
 * existing discrepancy between markers and shader spots, not touched here.)
 *
 * The SDO browse frames are north-up (the pipeline applies CROTA2), so the
 * only orientation angle applied is B0 — the heliographic latitude of disk
 * centre (±7.25°). Earth's direction in the heliographic frame is
 * e = (0, sin B0, cos B0); rotating the fragment into the Earth-view frame
 * gives q = (x, y·cosB0 − z·sinB0, y·sinB0 + z·cosB0), and the image pixel
 * is (cx + q.x·r, cy − q.y·r) with (cx, cy, r) the disk's centre and radius
 * as fractions of the frame (y down). Texture v is 1 − that (three.js
 * flipY). P-angle is computed and exposed for provenance but NOT applied —
 * `pAngleApplied: false` in the state, on purpose.
 *
 * ── Disk radius ──────────────────────────────────────────────────────────
 * The two instruments have different plate scales, so the disk fills a
 * different fraction of the frame: HMI (0.504″/px) ≈ 0.465 of the frame
 * radius, AIA (0.6″/px) ≈ 0.390. Both drift ±1.7 % over the year with the
 * Earth–Sun distance. The Stage (`js/stage/stage.js:307`) uses 0.485 for
 * both, which is ~25 % too large for AIA. Here the disk is MEASURED from the
 * decoded frame (`measureDisk`: strongest outward luminance drop along eight
 * rays, median radius, centre from opposite pairs) and the per-instrument
 * constant is the fallback only when the measurement is implausible.
 *
 * ── Honesty ──────────────────────────────────────────────────────────────
 *  • Failure keeps the last good frame (chip → OBSERVED (stale N min)); with
 *    no frame at all the disk is procedural and the chip says MODEL · feed
 *    down. `u_obsOn` is never 1 with a null texture.
 *  • The synthetic EUV ramps in sunFS remain the far-side fill and the
 *    offline fallback — they are not dead code.
 *  • Nothing procedural changes the colour or shape of an observed pixel.
 */

const DEG = Math.PI / 180;

// ── Ephemeris (Meeus, Astronomical Algorithms, ch. 25 + 29) ────────────────

/** Julian Day for a Date (UTC). */
export function julianDayOf(date) {
    return date.getTime() / 86400000 + 2440587.5;
}

/**
 * Solar B0 (heliographic latitude of disk centre), P (position angle of the
 * rotation axis, +E of N) and the Sun's apparent ecliptic longitude, all in
 * degrees. Low-precision series (~0.01°), ample for a 1024-px disk.
 */
export function solarEphemeris(date = new Date()) {
    const jd = julianDayOf(date);
    const T  = (jd - 2451545.0) / 36525;
    const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
    const M  = (357.52911 + 35999.05029 * T - 0.0001537 * T * T) * DEG;
    const C  = (1.914602 - 0.004817 * T - 0.000014 * T * T) * Math.sin(M)
             + (0.019993 - 0.000101 * T) * Math.sin(2 * M)
             + 0.000289 * Math.sin(3 * M);
    const trueLon = L0 + C;
    const omega   = (125.04 - 1934.136 * T) * DEG;
    const lambda  = trueLon - 0.00569 - 0.00478 * Math.sin(omega);   // apparent
    const eps     = (23.4392911 - 0.0130042 * T) * DEG + 0.00256 * DEG * Math.cos(omega);
    const I = 7.25 * DEG;
    const K = (73.6667 + 1.3958333 * (jd - 2396758) / 36525) * DEG;
    const lam = ((lambda % 360) + 360) % 360 * DEG;
    const x = Math.atan(-Math.cos(lam) * Math.tan(eps));
    const y = Math.atan(-Math.cos(lam - K) * Math.tan(I));
    const b0 = Math.asin(Math.sin(lam - K) * Math.sin(I));
    return {
        b0Deg: b0 / DEG,
        pDeg: (x + y) / DEG,
        lambdaDeg: lam / DEG,
    };
}

// ── Frame conventions ──────────────────────────────────────────────────────

/** Scene unit vector for heliographic (lat, lon) degrees — the AR-slot basis. */
export function heliographicToVec(latDeg, lonDeg) {
    const lat = latDeg * DEG, lon = lonDeg * DEG;
    const cl = Math.cos(lat);
    return [cl * Math.sin(lon), Math.sin(lat), cl * Math.cos(lon)];
}

/** Snodgrass differential-rotation factor used by sunFS and the AR slots. */
export function diffRotFactor(latRad) {
    const s2 = Math.sin(latRad) ** 2;
    return 1.0 - 0.19 * s2 - 0.09 * s2 * s2;
}

/**
 * Inverse of the AR-slot rotation (sun.html ~8360): the slots rotate a
 * Carrington-fixed position by rotAng about +y as x = c·x0 − s·z0,
 * z = s·x0 + c·z0. Given a CURRENT fragment position, return where it was at
 * the observation epoch so the image can be sampled there.
 */
export function rotationDeRotate(p, rotAng) {
    const c = Math.cos(rotAng), s = Math.sin(rotAng);
    return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
}

/** rotAng for a fragment latitude at sim time t (mirrors the slot math). */
export function slotRotAngle(tSim, uRot, latRad) {
    return tSim * 0.014 * uRot * diffRotFactor(latRad);
}

/**
 * Disk→sphere mapping. `p` is the fragment's unit position at the OBSERVATION
 * epoch (already de-rotated); `geom` is { cx, cy, r, b0Rad } with cx/cy/r as
 * fractions of the image frame, y DOWN (image convention).
 * Returns texture-space (u, v) with v UP (three.js flipY), the Earth-view
 * depth zObs (>0 = facing the observer) and `visible`.
 */
export function projectDiskUV(p, geom) {
    const cb = Math.cos(geom.b0Rad || 0), sb = Math.sin(geom.b0Rad || 0);
    const qx = p[0];
    const qy = p[1] * cb - p[2] * sb;
    const qz = p[1] * sb + p[2] * cb;
    return {
        u: geom.cx + qx * geom.r,
        v: (1 - geom.cy) + qy * geom.r,
        zObs: qz,
        visible: qz > 0,
    };
}

/** Image-space pixel (x right, y down, in pixels) for a heliographic point. */
export function projectToPixel(latDeg, lonDeg, geom, width, height) {
    const p = heliographicToVec(latDeg, lonDeg);
    const { u, v, visible, zObs } = projectDiskUV(p, geom);
    return { x: u * width, y: (1 - v) * height, visible, zObs };
}

// ── Disk geometry ──────────────────────────────────────────────────────────

/** Disk radius as a fraction of the browse frame, per instrument (fallback). */
export const DISK_FRACTION = Object.freeze({
    hmi: 0.465,   // 0.504″/px → R☉ ≈ 1905 px of 4096
    aia: 0.390,   // 0.600″/px → R☉ ≈ 1600 px of 4096
});

export const CHANNELS = Object.freeze({
    white: { code: 'HMIIC', instrument: 'hmi', label: 'SDO/HMI continuum',      kind: 0 },
    mag:   { code: 'HMIB',  instrument: 'hmi', label: 'SDO/HMI LOS magnetogram', kind: 2 },
    94:    { code: '0094',  instrument: 'aia', label: 'SDO/AIA 94 Å',            kind: 1 },
    131:   { code: '0131',  instrument: 'aia', label: 'SDO/AIA 131 Å',           kind: 1 },
    171:   { code: '0171',  instrument: 'aia', label: 'SDO/AIA 171 Å',           kind: 1 },
    193:   { code: '0193',  instrument: 'aia', label: 'SDO/AIA 193 Å',           kind: 1 },
    211:   { code: '0211',  instrument: 'aia', label: 'SDO/AIA 211 Å',           kind: 1 },
    304:   { code: '0304',  instrument: 'aia', label: 'SDO/AIA 304 Å',           kind: 1 },
});

/** sun.html `u_viewMode` value → proxy channel. */
export const VIEW_MODE_CHANNEL = Object.freeze({
    0: 'white', 1: '304', 2: '171', 3: '193', 4: '211', 5: '131', 6: 'mag',
});

export function diskFractionFor(channel) {
    const c = CHANNELS[String(channel)];
    return DISK_FRACTION[c ? c.instrument : 'hmi'];
}

/**
 * Measure the solar disk in a decoded frame. `gray` is a Uint8/Float array of
 * luminance, row-major, `w`×`h`. Eight rays from the frame centre; on each,
 * the radius of the strongest outward luminance DROP beyond 0.25·min(w,h)
 * (the limb: HMI falls from ~40 % of centre to zero, AIA falls from the
 * limb-brightened rim to the faint corona). Centre = mean of the opposite-ray
 * pair midpoints, radius = median of the eight. Returns fractions of the
 * frame (x/w, y/h, r/min(w,h)), plus `ok` = the eight agree to within 4 %.
 */
export function measureDisk(gray, w, h) {
    const cx0 = (w - 1) / 2, cy0 = (h - 1) / 2;
    const rMax = Math.floor(Math.min(w, h) / 2) - 2;
    const rMin = Math.floor(Math.min(w, h) * 0.22);
    const dirs = [];
    for (let k = 0; k < 8; k++) dirs.push([Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);
    const hits = [];
    for (const [dx, dy] of dirs) {
        const prof = new Float32Array(rMax + 1);
        for (let r = 0; r <= rMax; r++) {
            const x = Math.round(cx0 + dx * r), y = Math.round(cy0 + dy * r);
            prof[r] = gray[y * w + x];
        }
        // 5-tap box smooth, then the strongest negative slope over a 4-px span.
        let best = -1, bestR = -1;
        for (let r = rMin; r < rMax - 4; r++) {
            const a = (prof[r - 2] + prof[r - 1] + prof[r]) / 3;
            const b = (prof[r + 2] + prof[r + 3] + prof[r + 4]) / 3;
            const drop = a - b;
            if (drop > best) { best = drop; bestR = r + 1.5; }
        }
        hits.push(bestR);
    }
    // Opposite rays k and k+4: (ra − rb)/2 is the offset's component along
    // d_k. Four directions 45° apart satisfy Σ d dᵀ = 2·I, so the summed
    // projections recover the offset with a factor 1/2 (not 1/4).
    let sx = 0, sy = 0;
    for (let k = 0; k < 4; k++) {
        const [dx, dy] = dirs[k];
        const along = (hits[k] - hits[k + 4]) / 2;
        sx += dx * along;
        sy += dy * along;
    }
    const cx = cx0 + sx / 2, cy = cy0 + sy / 2;
    // For an off-centre circle the chord through the frame centre along any
    // direction has half-length √(R² − h²) ≈ R − h²/2R, so the opposite-ray
    // PAIR MEANS agree to second order even when the individual hits do not
    // (a 9 px offset moves single hits by ±9 px but pair means by ~0.2 px).
    const pairMeans = [0, 1, 2, 3].map(k => (hits[k] + hits[k + 4]) / 2).sort((a, b) => a - b);
    const r = (pairMeans[1] + pairMeans[2]) / 2;
    const spread = (pairMeans[3] - pairMeans[0]) / r;
    return {
        cx: cx / w,
        cy: cy / h,
        r: r / Math.min(w, h),
        ok: Number.isFinite(r) && r > rMin && spread < 0.04,
        spread,
    };
}

/** Accept a measurement only when it is within 12 % of the instrument's expected fraction. */
export function resolveDiskGeometry(measured, channel) {
    const fallback = diskFractionFor(channel);
    if (measured && measured.ok && Math.abs(measured.r - fallback) / fallback < 0.12) {
        return { cx: measured.cx, cy: measured.cy, r: measured.r, source: 'measured' };
    }
    return { cx: 0.5, cy: 0.5, r: fallback, source: 'fallback' };
}

// ── Freshness + chip ───────────────────────────────────────────────────────

export const FRESH_WARN_S = 30 * 60;   // matches the pipeline-registry row
export const FRESH_CRIT_S = 90 * 60;

export function freshnessFor(ageS) {
    if (!Number.isFinite(ageS)) return 'unknown';
    if (ageS > FRESH_CRIT_S) return 'expired';
    if (ageS > FRESH_WARN_S) return 'stale';
    return 'live';
}

function fmtAge(s) {
    if (!Number.isFinite(s)) return '';
    if (s < 90) return `${Math.round(s)} s old`;
    if (s < 5400) return `${Math.round(s / 60)} min old`;
    return `${(s / 3600).toFixed(1)} h old`;
}

function fmtUtc(ms) {
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '';
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/**
 * The provenance line. `state`:
 *   mode        'observed' | 'model'
 *   channel     proxy channel key
 *   observedAt  ms epoch of the frame (null if unknown)
 *   nowMs       ms epoch "now" (injected — no ambient time)
 *   feedDown    boolean — last fetch failed
 *   reason      'feed-down' | 'user' | 'cutaway' | 'doppler' | null  (model mode)
 *   geometry    'measured' | 'fallback' | null
 */
export function chipLabel(state) {
    if (state.mode !== 'observed') {
        const why = state.reason === 'feed-down' ? ' · feed down'
                  : state.reason === 'cutaway'   ? ' · cutaway'
                  : state.reason === 'doppler'   ? ' · Doppler'
                  : state.reason === 'loading'   ? ' · loading frame'
                  : '';
        return `MODEL · procedural photosphere${why}`;
    }
    const ch = CHANNELS[String(state.channel)] || CHANNELS.white;
    const ageS = (state.observedAt != null && Number.isFinite(state.nowMs))
        ? (state.nowMs - state.observedAt) / 1000 : NaN;
    const fresh = freshnessFor(ageS);
    const head = fresh === 'live' || fresh === 'unknown' ? 'OBSERVED'
               : fresh === 'stale' ? 'OBSERVED (stale)' : 'OBSERVED (expired)';
    const parts = [head, ch.label];
    if (state.observedAt != null) parts.push(fmtUtc(state.observedAt));
    if (Number.isFinite(ageS)) parts.push(fmtAge(ageS));
    if (state.feedDown) parts.push('refresh failed');
    return parts.join(' · ');
}

/** Real-time rotation multiplier for `u_rot` (see sun.html: 0.014 rad per
 *  sim unit, 0.010 units per frame at 1×, ~60 fps): synodic 27.2753 d. */
export const REAL_TIME_ROT_MUL = (2 * Math.PI / (27.2753 * 86400)) / (0.014 * 0.6);

// ── Browser half ───────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {object} opts.THREE
 * @param {object} opts.uniforms      sun.html's shared uniforms (u_obs* must exist)
 * @param {string} [opts.base]        proxy base, default '/api/solar/aia'
 * @param {number} [opts.res]         1024 | 2048
 * @param {number} [opts.refreshMs]   re-fetch cadence (5 min = the globe's bucket)
 * @param {(state:object)=>void} [opts.onState]
 * @param {()=>number} [opts.now]     clock injection for tests
 * @param {Document} [opts.doc]
 */
export class SunObserved {
    constructor(opts) {
        this.THREE     = opts.THREE;
        this.uniforms  = opts.uniforms;
        this.base      = opts.base || '/api/solar/aia';
        this.res       = opts.res || 1024;
        this.refreshMs = opts.refreshMs || 5 * 60 * 1000;
        this.onState   = opts.onState || (() => {});
        this.now       = opts.now || (() => Date.now());
        this.doc       = opts.doc || (typeof document !== 'undefined' ? document : null);
        this.fadeMs    = opts.fadeMs ?? 1500;
        this.channel   = 'white';
        this.enabled   = false;
        this.frames    = new Map();       // channel → { tex, observedAt, geom, fetchedAt }
        this.state = {
            mode: 'model', reason: null, channel: 'white', observedAt: null,
            feedDown: false, geometry: null, pAngleApplied: false, b0Deg: 0, pDeg: 0,
            lastError: null, loads: 0,
        };
        this._timer = null;
        this._fade  = { active: false, t0: 0 };
        this._inflight = null;
        this._gen = 0;
    }

    /** Switch on/off. Off ⇒ u_obsOn = 0 and the chip says MODEL · <reason>. */
    setEnabled(on, reason = 'user') {
        this.enabled = !!on;
        if (!this.enabled) {
            this.uniforms.u_obsOn.value = 0.0;
            this._emit({ mode: 'model', reason });
            return;
        }
        this._apply(this.channel);
        this.refresh();
    }

    /** Proxy channel key ('white' | 'mag' | '171' …). */
    setChannel(channel) {
        const ch = String(channel);
        if (!CHANNELS[ch]) return;
        this.channel = ch;
        if (this.enabled) { this._apply(ch); this.refresh(); }
    }

    start() {
        if (this._timer) return this;
        this._timer = setInterval(() => this.refresh(), this.refreshMs);
        return this;
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** Per-frame: advance the cross-fade. */
    tick() {
        if (!this._fade.active) return;
        const f = Math.min(1, (this.now() - this._fade.t0) / this.fadeMs);
        this.uniforms.u_obsFade.value = f;
        if (f >= 1) this._fade.active = false;
    }

    /** Fetch the current channel's frame (skips while the tab is hidden). */
    async refresh(force = false) {
        if (!this.enabled) return null;
        if (!force && this.doc && this.doc.visibilityState === 'hidden') return null;
        const ch = this.channel;
        const bucket = Math.floor(this.now() / this.refreshMs);
        const prev = this.frames.get(ch);
        if (!force && prev && prev.bucket === bucket) { this._apply(ch); return prev; }
        const url = `${this.base}?channel=${encodeURIComponent(ch)}&res=${this.res}&b=${bucket}`;
        const gen = ++this._gen;
        try {
            const res = await fetch(url, { cache: 'default' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const observedAt = parseObservedAt(res.headers.get('X-SDO-Observed-At'))
                            ?? parseObservedAt(res.headers.get('Last-Modified'))
                            ?? parseObservedAt(res.headers.get('Date'));
            const blob = await res.blob();
            const img  = await decodeImage(blob);
            if (gen !== this._gen && this.channel !== ch) { return null; }
            const measured = measureImageDisk(img);
            const geom = resolveDiskGeometry(measured, ch);
            const tex = new this.THREE.Texture(img);
            tex.colorSpace = this.THREE.SRGBColorSpace;
            tex.minFilter = this.THREE.LinearMipmapLinearFilter;
            tex.magFilter = this.THREE.LinearFilter;
            tex.anisotropy = 4;
            tex.needsUpdate = true;
            const frame = { tex, observedAt, geom, bucket, fetchedAt: this.now(), url };
            const old = this.frames.get(ch);
            this.frames.set(ch, frame);
            this.state.loads++;
            this.state.feedDown = false;
            this.state.lastError = null;
            this._apply(ch, old);
            return frame;
        } catch (e) {
            this.state.lastError = String(e && e.message || e);
            this.state.feedDown = true;
            // Keep the last good frame if there is one; otherwise the disk is
            // procedural and the chip must say so.
            if (this.frames.get(ch)) this._apply(ch);
            else { this.uniforms.u_obsOn.value = 0.0; this._emit({ mode: 'model', reason: 'feed-down', channel: ch }); }
            return null;
        }
    }

    _apply(ch, previousFrame = null) {
        const f = this.frames.get(ch);
        const u = this.uniforms;
        if (!f) {
            u.u_obsOn.value = 0.0;
            this._emit({ mode: 'model', reason: this.state.feedDown ? 'feed-down' : 'loading', channel: ch });
            return;
        }
        const eph = solarEphemeris(new Date(f.observedAt ?? this.now()));
        u.u_obsTex.value  = f.tex;
        u.u_obsPrev.value = previousFrame ? previousFrame.tex : f.tex;
        u.u_obsFade.value = previousFrame ? 0.0 : 1.0;
        this._fade = previousFrame ? { active: true, t0: this.now() } : { active: false, t0: 0 };
        u.u_obsGeom.value.set(f.geom.cx, 1 - f.geom.cy, f.geom.r, 0);
        u.u_obsB0.value   = eph.b0Deg * DEG;
        u.u_obsKind.value = CHANNELS[ch].kind;
        u.u_obsOn.value   = 1.0;
        this._emit({
            mode: 'observed', reason: null, channel: ch, observedAt: f.observedAt,
            geometry: f.geom.source, b0Deg: eph.b0Deg, pDeg: eph.pDeg, pAngleApplied: false,
        });
        // Dispose the frame the cross-fade no longer needs, after it ends.
        if (previousFrame && previousFrame.tex && previousFrame.tex !== f.tex) {
            setTimeout(() => { try { previousFrame.tex.dispose(); } catch (_) {} }, this.fadeMs + 200);
        }
    }

    _emit(patch) {
        Object.assign(this.state, patch);
        this.state.nowMs = this.now();
        this.state.label = chipLabel(this.state);
        try { this.onState(this.state); } catch (_) {}
    }

    /** Current provenance state (read-only snapshot for tests + the chip). */
    getState() { this.state.nowMs = this.now(); this.state.label = chipLabel(this.state); return { ...this.state }; }
}

function parseObservedAt(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
}

async function decodeImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.decoding = 'async';
        await new Promise((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error('decode failed')); img.src = url; });
        return img;
    } finally {
        // The texture holds the decoded bitmap; the object URL can go.
        setTimeout(() => URL.revokeObjectURL(url), 0);
    }
}

/** Downsample to 256² and run measureDisk. Returns null if the canvas is unavailable. */
export function measureImageDisk(img, size = 256) {
    try {
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, size, size);
        const d = x.getImageData(0, 0, size, size).data;
        const gray = new Float32Array(size * size);
        for (let i = 0, j = 0; i < d.length; i += 4, j++) gray[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        return measureDisk(gray, size, size);
    } catch (_) {
        return null;
    }
}
