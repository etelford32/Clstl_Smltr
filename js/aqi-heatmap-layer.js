/**
 * aqi-heatmap-layer.js — continuous pollution-density heatmap draped on the
 * EarthView globe, with per-species views.
 *
 * Where the numeric AQI layer shows DISCRETE timestamped CAMS cells and the
 * pollution-centers layer shows DISCRETE city rings, this layer renders the
 * CONTINUOUS density field between them: live samples (batched CAMS city
 * feed + sparse global grid) are interpolated by the pollution kernel's IDW
 * (js/pollution-model.js — the same math the Pollution Lab uses, so the two
 * surfaces can never disagree about what the field between samples looks
 * like) and drawn as a gradient texture on a sphere shell.
 *
 * Species — tracked separately AND in aggregate:
 *   aggregate — US AQI (EPA composite; the shared airQualityMetricColor
 *               stops color it, so every AQ surface agrees on "unhealthy")
 *   co2       — CO₂ (ppm), CAMS greenhouse-gas field. City samples only;
 *               the feed marks availability (`co2Available`) and this layer
 *               reports honestly when the upstream doesn't serve it.
 *   no2       — NO₂ (µg/m³), CAMS. NOTE: this is nitrogen DIOXIDE — CAMS /
 *               Open-Meteo publish no nitrate-aerosol (NO₃⁻) field; NO₂ is
 *               the tracked nitrogen species and the UI must not relabel it.
 *
 * Two density controls (the section's sliders drive these):
 *   setSpread(km)    — IDW influence radius: how far a source's plume
 *                      gradient extends before fading to background.
 *   setFloor(pct)    — density floor: values below the floor go transparent,
 *                      so raising it isolates the dense cores.
 *
 * Shader note: the fragment shader inverts the page's geo convention
 * EXACTLY (js/geo/coords.js latLonToNormal: x = cosφ·cosλ, y = sinφ,
 * z = −cosφ·sinλ ⇒ φ = asin(y), λ = atan2(−z, x)). Any other mapping draws
 * the field rotated off the continents.
 *
 * SUPPORT — the drape covers the whole planet but is built from roughly 145
 * scattered samples. Opacity is multiplied by supportFade(), which is driven
 * by the per-cell distance-to-nearest-sample that js/pollution-model.js's
 * idwGrid now carries. Where the field is observed it is solid; where it is
 * interpolated it thins; beyond the influence radius it draws nothing. This
 * is a TRUTHFULNESS control, not a style knob — do not "fix" a dim ocean by
 * removing it. `supportedPct` in the status payload reports the share of the
 * globe within SUPPORT_FULL_KM of a real sample (~18% at the default spread).
 *
 * Pure, node-tested exports (tests/aqi-heatmap.mjs): HEAT_SPECIES,
 * buildHeatSamples, heatColor, heatAlpha, supportFade. The class below is
 * rendering only.
 *
 * This layer fetches /api/air-quality/centers itself even though the
 * pollution-centers layer may also have it open — the route is CDN-cached
 * 15 min, so the duplicate browser GET costs one cache hit and keeps the
 * two layers fully decoupled (either works without the other enabled).
 */

import { idwGrid, sampleGrid } from './pollution-model.js';
import { airQualityMetricColor } from './air-quality-frame.js';

const CENTERS_URL = '/api/air-quality/centers';
const GRID_URL = '/api/air-quality/grid?detail=global';
const REFRESH_MS = 15 * 60 * 1000;
const FIELD_W = 144, FIELD_H = 72;      // 2.5° IDW field
const TEX_W = 720, TEX_H = 360;         // smoothed gradient texture
const REBUILD_DEBOUNCE_MS = 150;        // slider drags coalesce

/**
 * Species registry. `scale` is [transparent-floor-min, saturated-ceiling] in
 * the species' native unit — the density-floor slider picks its cutoff
 * inside this range, and heatAlpha saturates at the ceiling. Backgrounds
 * fade remote cells to clean-air values; the well-mixed greenhouse gases
 * (CO₂, CH₄) anchor their scales at the ambient baseline instead of zero —
 * their pollution signal is the urban EXCESS, and a zero-based scale would
 * paint the whole planet.
 *
 * `pick` reads a city row from /api/air-quality/centers; `gridPick`, where
 * present, reads a sparse-grid point from /api/air-quality/grid (the grid
 * frame only carries aqi/pm25/pm10/aod, so gas species are city-only and an
 * all-null species yields zero samples — the honest "unavailable" signal).
 */
const num = v => (Number.isFinite(v) ? v : null);
export const HEAT_SPECIES = Object.freeze({
    aggregate: Object.freeze({
        label: 'Aggregate (US AQI)', unit: 'AQI',
        scale: Object.freeze([0, 300]), background: 12,
        pick: row => num(row.aqi), gridPick: p => num(p.aqi),
    }),
    // ── Particulates & aerosol ────────────────────────────────────────────
    pm25: Object.freeze({
        label: 'PM2.5', unit: 'µg/m³',
        scale: Object.freeze([0, 150]), background: 3,
        pick: row => num(row.pm25), gridPick: p => num(p.pm25),
    }),
    pm10: Object.freeze({
        label: 'PM10', unit: 'µg/m³',
        scale: Object.freeze([0, 250]), background: 6,
        pick: row => num(row.pm10), gridPick: p => num(p.pm10),
    }),
    dust: Object.freeze({
        label: 'Dust', unit: 'µg/m³',
        scale: Object.freeze([0, 300]), background: 0,
        pick: row => num(row.dust),
    }),
    aod: Object.freeze({
        label: 'AOD 550 nm', unit: '',
        scale: Object.freeze([0, 1.5]), background: 0.03,
        pick: row => num(row.aod), gridPick: p => num(p.aod),
    }),
    // ── Gases ─────────────────────────────────────────────────────────────
    o3: Object.freeze({
        label: 'O₃', unit: 'µg/m³',
        scale: Object.freeze([0, 240]), background: 40,   // real ambient background
        pick: row => num(row.ozone),
    }),
    no2: Object.freeze({
        label: 'NO₂', unit: 'µg/m³',
        scale: Object.freeze([0, 150]), background: 2,
        pick: row => num(row.no2),
    }),
    so2: Object.freeze({
        label: 'SO₂', unit: 'µg/m³',
        scale: Object.freeze([0, 200]), background: 1,
        pick: row => num(row.so2),
    }),
    co: Object.freeze({
        label: 'CO', unit: 'µg/m³',
        scale: Object.freeze([0, 4000]), background: 100,
        pick: row => num(row.co),
    }),
    co2: Object.freeze({
        label: 'CO₂', unit: 'ppm',
        scale: Object.freeze([422, 520]), background: 422,
        pick: row => num(row.co2),
    }),
    ch4: Object.freeze({
        label: 'CH₄', unit: 'µg/m³',
        scale: Object.freeze([1250, 1700]), background: 1250,  // ≈1.9 ppm ambient
        pick: row => num(row.ch4),
    }),
});

/** Per-species sample availability for the current feed data — the page
 *  uses this to gray options instead of letting them error on selection. */
export function availableSpecies(cities = [], gridPoints = []) {
    const out = {};
    for (const key of Object.keys(HEAT_SPECIES)) {
        out[key] = buildHeatSamples(cities, gridPoints, key).length > 0;
    }
    return out;
}

/**
 * Extract IDW samples for one species from the two feeds. The sparse global
 * grid frame only carries aggregate-adjacent fields (aqi/pm/aod), so the
 * CO₂/NO₂ views are city-sample-only by construction — fewer samples, wider
 * spread does more work, and an empty result means "species unavailable".
 */
export function buildHeatSamples(cities = [], gridPoints = [], species = 'aggregate') {
    const key = HEAT_SPECIES[species] ? species : 'aggregate';
    const spec = HEAT_SPECIES[key];
    const out = [];
    for (const c of cities) {
        const v = spec.pick(c);
        if (v != null && Number.isFinite(c.lat) && Number.isFinite(c.lon)) {
            out.push({ lat: c.lat, lon: c.lon, value: v });
        }
    }
    if (spec.gridPick) {
        for (const p of gridPoints) {
            const v = spec.gridPick(p);
            if (v != null && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
                out.push({ lat: p.lat, lon: p.lon, value: v });
            }
        }
    }
    return out;
}

/** Piecewise-linear color ramp helper: stops = [[value, r, g, b], …]. */
function ramp(stops, v) {
    if (!Number.isFinite(v)) return [0.34, 0.39, 0.46];
    if (v <= stops[0][0]) return [stops[0][1], stops[0][2], stops[0][3]];
    for (let i = 1; i < stops.length; i++) {
        if (v <= stops[i][0]) {
            const [v0, r0, g0, b0] = stops[i - 1];
            const [v1, r1, g1, b1] = stops[i];
            const t = (v - v0) / (v1 - v0);
            return [r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t];
        }
    }
    const last = stops[stops.length - 1];
    return [last[1], last[2], last[3]];
}

// Gas ramps are WHO-guideline-shaped where a guideline exists (the
// green→yellow knee sits at it) and all end "beyond red" in purple, the
// same convention as the EPA stops. The greenhouse gases anchor at their
// ambient baselines. Aggregate + the particulate metrics the rest of the
// site already colors (PM2.5/PM10/AOD) reuse the SHARED EPA stops via
// airQualityMetricColor so no two surfaces can disagree.
const GAS_STOPS = Object.freeze({
    co2: [
        [422, 0.10, 0.65, 0.60], [440, 0.85, 0.80, 0.20],
        [470, 1.00, 0.49, 0.05], [500, 1.00, 0.15, 0.18], [520, 0.62, 0.25, 0.78],
    ],
    no2: [
        [5, 0.10, 0.88, 0.48], [25, 1.00, 0.86, 0.18],
        [60, 1.00, 0.49, 0.05], [120, 1.00, 0.15, 0.18], [150, 0.62, 0.25, 0.78],
    ],
    // WHO 8-h O₃ guideline 100 µg/m³ at the yellow knee.
    o3: [
        [50, 0.10, 0.88, 0.48], [100, 1.00, 0.86, 0.18],
        [150, 1.00, 0.49, 0.05], [200, 1.00, 0.15, 0.18], [240, 0.62, 0.25, 0.78],
    ],
    // WHO 24-h SO₂ guideline 40 µg/m³ at the yellow knee.
    so2: [
        [10, 0.10, 0.88, 0.48], [40, 1.00, 0.86, 0.18],
        [90, 1.00, 0.49, 0.05], [150, 1.00, 0.15, 0.18], [200, 0.62, 0.25, 0.78],
    ],
    // WHO 24-h CO guideline 4 mg/m³ = 4000 µg/m³ at the red end.
    co: [
        [300, 0.10, 0.88, 0.48], [1000, 1.00, 0.86, 0.18],
        [2000, 1.00, 0.49, 0.05], [3000, 1.00, 0.15, 0.18], [4000, 0.62, 0.25, 0.78],
    ],
    ch4: [
        [1250, 0.10, 0.65, 0.60], [1350, 0.85, 0.80, 0.20],
        [1450, 1.00, 0.49, 0.05], [1580, 1.00, 0.15, 0.18], [1700, 0.62, 0.25, 0.78],
    ],
    // Dust has no WHO line of its own; ramp shaped to Saharan-event scales.
    dust: [
        [20, 0.55, 0.48, 0.25], [80, 0.85, 0.68, 0.25],
        [160, 0.95, 0.52, 0.12], [240, 0.90, 0.30, 0.10], [300, 0.62, 0.25, 0.78],
    ],
});

/** Species value → [r, g, b] in 0–1. Shared EPA stops wherever they exist. */
export function heatColor(species, value) {
    if (GAS_STOPS[species]) return ramp(GAS_STOPS[species], value);
    if (species === 'pm25' || species === 'pm10' || species === 'aod') {
        return airQualityMetricColor(species, value);
    }
    return airQualityMetricColor('aqi', value);
}

/**
 * Density → opacity. Zero at/below the floor, saturating toward the species
 * ceiling with a soft exponent so the gradient reads as a plume, not a
 * poster edge. floor/ceil are in the species' native unit.
 */
export function heatAlpha(value, floor, ceil) {
    if (!Number.isFinite(value) || value <= floor || ceil <= floor) return 0;
    const t = Math.min(1, (value - floor) / (ceil - floor));
    return Math.pow(t, 0.65);
}

/** Within this distance of a real sample, the field is drawn at full strength. */
export const SUPPORT_FULL_KM = 600;
/** Beyond this, nothing is drawn — there is no observation to justify it. */
export const SUPPORT_NONE_KM = 2200;

/**
 * Opacity multiplier from SUPPORT — how far the cell is from a real sample.
 *
 * The drape is interpolated from ~145 scattered points across the whole
 * planet. Painted at uniform opacity, a cell sitting on Delhi and a cell in
 * the middle of the Pacific 1,800 km from anything look equally authoritative.
 * Fading with distance makes the sampling visible in the picture itself:
 * where the field is confident it is solid, and where it is a guess it thins
 * out. Cells with no sample in range (Infinity) draw nothing at all.
 *
 * Pure and node-gated — this is a truthfulness control, not a style knob.
 */
export function supportFade(nearestKm) {
    if (nearestKm == null) return 1;                  // no support data: unchanged
    if (!Number.isFinite(nearestKm)) return 0;        // nothing in range
    if (nearestKm <= SUPPORT_FULL_KM) return 1;
    if (nearestKm >= SUPPORT_NONE_KM) return 0;
    // LINEAR on purpose: opacity is proportional to remaining support, which
    // is the mapping a reader can actually invert by eye. An eased curve
    // (1 − t²) was tried first and is the wrong instrument here — it holds
    // ~0.98 out to 850 km, so the sampling stays invisible exactly where the
    // interpolation starts doing the work.
    const t = (nearestKm - SUPPORT_FULL_KM) / (SUPPORT_NONE_KM - SUPPORT_FULL_KM);
    return 1 - t;
}

export class AqiHeatmapLayer {
    /**
     * @param {object} THREE    three.js namespace (page-supplied)
     * @param {object} parent   scene node to attach to (earthMesh)
     * @param {object} [opts]
     * @param {number}   [opts.radius]    shell radius (globe radii)
     * @param {Function} [opts.onStatus]  (state, detail) → void
     */
    constructor(THREE, parent, { radius = 1.0038, onStatus } = {}) {
        this._T = THREE;
        this._onStatus = onStatus ?? (() => {});
        this.species = 'aggregate';
        this.spreadKm = 2000;
        this.floorPct = 20;             // % of the species scale
        this.cities = [];
        this.gridPoints = [];
        this.available = null;          // per-species map, null until the feed answers
        this.co2Available = null;       // back-compat alias
        this.sampleCount = 0;
        this.supportedPct = null;       // % of cells near a real sample
        this._timer = null;
        this._rebuildTimer = null;
        this._inflight = null;
        this._field = null;             // exposed for the browser gate

        this._canvas = document.createElement('canvas');
        this._canvas.width = TEX_W;
        this._canvas.height = TEX_H;
        this._ctx = this._canvas.getContext('2d');
        this._cellCanvas = document.createElement('canvas');
        this._cellCanvas.width = FIELD_W;
        this._cellCanvas.height = FIELD_H;
        this._cellCtx = this._cellCanvas.getContext('2d');

        this._tex = new THREE.CanvasTexture(this._canvas);
        this._tex.colorSpace = THREE.SRGBColorSpace;

        this._mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: THREE.FrontSide,
            uniforms: {
                u_tex: { value: this._tex },
                u_opacity: { value: 0.72 },
            },
            vertexShader: `
                varying vec3 vN;
                void main() {
                    vN = normalize(position);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            // Inverts js/geo/coords.js latLonToNormal exactly — see header.
            fragmentShader: `
                uniform sampler2D u_tex;
                uniform float u_opacity;
                varying vec3 vN;
                const float PI = 3.14159265358979;
                void main() {
                    vec3 n = normalize(vN);
                    float lat = asin(clamp(n.y, -1.0, 1.0));
                    float lon = atan(-n.z, n.x);
                    vec2 uv = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
                    vec4 c = texture2D(u_tex, uv);
                    if (c.a < 0.004) discard;
                    gl_FragColor = vec4(c.rgb, c.a * u_opacity);
                }`,
        });

        this._mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), this._mat);
        this._mesh.renderOrder = 2;     // above NASA obs drapes (1), below cloud (3)
        this.group = new THREE.Group();
        this.group.name = 'aqi-heatmap';
        this.group.visible = false;
        this.group.add(this._mesh);
        parent.add(this.group);
    }

    get visible() { return this.group.visible; }

    setEnabled(enabled) {
        this.group.visible = !!enabled;
        if (enabled) {
            this._refresh();
            if (!this._timer) this._timer = setInterval(() => this._refresh(), REFRESH_MS);
        } else {
            clearInterval(this._timer);
            this._timer = null;
            this._onStatus('idle', { label: 'off' });
        }
    }

    setSpecies(species) {
        if (!HEAT_SPECIES[species]) return;
        this.species = species;
        this._scheduleRebuild();
    }

    /** Slider 1 — IDW influence radius, km (gradient spread). */
    setSpread(km) {
        this.spreadKm = Math.max(300, Math.min(5000, Number(km) || 2000));
        this._scheduleRebuild();
    }

    /** Slider 2 — density floor, % of the species scale (isolates cores). */
    setFloor(pct) {
        this.floorPct = Math.max(0, Math.min(80, Number(pct) || 0));
        this._scheduleRebuild();
    }

    async _refresh() {
        if (this._inflight) return;
        this._onStatus('fetching', {});
        this._inflight = (async () => {
            const [centersRes, gridRes] = await Promise.allSettled([
                fetch(CENTERS_URL, { signal: AbortSignal.timeout(15_000) })
                    .then(r => r.ok ? r.json() : Promise.reject(new Error(`centers HTTP ${r.status}`))),
                fetch(GRID_URL, { signal: AbortSignal.timeout(15_000) })
                    .then(r => r.ok ? r.json() : Promise.reject(new Error(`grid HTTP ${r.status}`))),
            ]);
            const centers = centersRes.status === 'fulfilled' ? centersRes.value : null;
            if (!centers || centers.freshness !== 'live' || !centers.cities?.length) {
                throw new Error(centers?.error
                    ?? centersRes.reason?.message ?? 'city feed is stale');
            }
            this.cities = centers.cities;
            const grid = gridRes.status === 'fulfilled' ? gridRes.value : null;
            this.gridPoints = grid?.available ? (grid.frame?.points ?? []) : [];
            // Sample-presence is the one availability truth: it already
            // reflects the feed's retry-ladder (a rung that dropped CO₂/CH₄
            // leaves those fields null in every row).
            this.available = availableSpecies(this.cities, this.gridPoints);
            this.co2Available = this.available.co2;      // back-compat alias
            this._rebuild();
        })().catch(err => {
            this._onStatus('error', { error: err?.message ?? 'fetch failed' });
        }).finally(() => { this._inflight = null; });
        await this._inflight;
    }

    _scheduleRebuild() {
        clearTimeout(this._rebuildTimer);
        this._rebuildTimer = setTimeout(() => this._rebuild(), REBUILD_DEBOUNCE_MS);
    }

    _rebuild() {
        if (!this.cities.length) return;
        const spec = HEAT_SPECIES[this.species];
        const samples = buildHeatSamples(this.cities, this.gridPoints, this.species);
        this.sampleCount = samples.length;
        if (!samples.length) {
            // Species genuinely unserved (CO₂ without the CAMS field) —
            // clear the drape and say so instead of drawing stale colors.
            this._ctx.clearRect(0, 0, TEX_W, TEX_H);
            this._tex.needsUpdate = true;
            this._field = null;
            this._onStatus('error', {
                error: `${spec.label} not available from the feed`,
                species: this.species,
            });
            return;
        }

        const field = idwGrid(samples, FIELD_W, FIELD_H, {
            maxDistKm: this.spreadKm,
            background: spec.background,
        });
        this._field = field;

        const [lo, hi] = spec.scale;
        const floor = lo + (this.floorPct / 100) * (hi - lo);
        const im = this._cellCtx.createImageData(FIELD_W, FIELD_H);
        let supported = 0;
        for (let i = 0; i < FIELD_W * FIELD_H; i++) {
            const v = field.data[i];
            const a = heatAlpha(v, floor, hi) * supportFade(field.nearestKm?.[i]);
            if (field.nearestKm?.[i] <= SUPPORT_FULL_KM) supported++;
            if (a <= 0) continue;
            const [r, g, b] = heatColor(this.species, v);
            im.data[i * 4] = Math.round(r * 255);
            im.data[i * 4 + 1] = Math.round(g * 255);
            im.data[i * 4 + 2] = Math.round(b * 255);
            im.data[i * 4 + 3] = Math.round(a * 255);
        }
        this.supportedPct = Math.round(100 * supported / (FIELD_W * FIELD_H));
        this._cellCtx.putImageData(im, 0, 0);
        this._ctx.clearRect(0, 0, TEX_W, TEX_H);
        this._ctx.imageSmoothingEnabled = true;
        this._ctx.imageSmoothingQuality = 'high';
        this._ctx.drawImage(this._cellCanvas, 0, 0, TEX_W, TEX_H);
        this._tex.needsUpdate = true;

        this._onStatus('loaded', {
            species: this.species,
            label: spec.label,
            unit: spec.unit,
            count: samples.length,
            spreadKm: this.spreadKm,
            floorPct: this.floorPct,
            // Share of the globe within SUPPORT_FULL_KM of a real sample.
            // The drape covers the planet; this says how much of it is
            // actually observed rather than interpolated.
            supportedPct: this.supportedPct,
            available: this.available,
            co2Available: this.co2Available,
        });
    }

    /** Field probe for tests / console: species value at (lat, lon). */
    valueAt(lat, lon) {
        return this._field ? sampleGrid(this._field, lat, lon) : null;
    }

    dispose() {
        clearInterval(this._timer);
        clearTimeout(this._rebuildTimer);
        this._mesh.geometry.dispose();
        this._mat.dispose();
        this._tex.dispose();
        this.group.parent?.remove(this.group);
    }
}

export default AqiHeatmapLayer;
