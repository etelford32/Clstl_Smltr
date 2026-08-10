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
 * Pure, node-tested exports (tests/aqi-heatmap.mjs): HEAT_SPECIES,
 * buildHeatSamples, heatColor, heatAlpha. The class below is rendering only.
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
 * inside this range, and heatAlpha saturates at the ceiling. Backgrounds:
 * aggregate/no2 fade to clean-air values; CO₂ fades to the ~422 ppm
 * well-mixed ambient baseline (its "pollution" signal is the urban EXCESS
 * above that baseline, which is why its scale starts there).
 */
export const HEAT_SPECIES = Object.freeze({
    aggregate: Object.freeze({
        label: 'Aggregate (US AQI)', unit: 'AQI',
        scale: Object.freeze([0, 300]), background: 12,
        pick: row => Number.isFinite(row.aqi) ? row.aqi : null,
    }),
    co2: Object.freeze({
        label: 'CO₂', unit: 'ppm',
        scale: Object.freeze([422, 520]), background: 422,
        pick: row => Number.isFinite(row.co2) ? row.co2 : null,
    }),
    no2: Object.freeze({
        label: 'NO₂', unit: 'µg/m³',
        scale: Object.freeze([0, 150]), background: 2,
        pick: row => Number.isFinite(row.no2) ? row.no2 : null,
    }),
});

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
    if (key === 'aggregate') {
        for (const p of gridPoints) {
            const v = Number.isFinite(p.aqi) ? p.aqi : null;
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

// CO₂: cool teal at ambient → amber → deep red at heavily-enhanced urban
// plumes. NO₂: WHO-guideline-shaped (10 annual / 25 daily µg/m³ sit at the
// green→yellow knee). Both are this layer's own ramps; the aggregate view
// reuses the EPA stops shared by every other AQ surface.
const CO2_STOPS = [
    [422, 0.10, 0.65, 0.60], [440, 0.85, 0.80, 0.20],
    [470, 1.00, 0.49, 0.05], [500, 1.00, 0.15, 0.18], [520, 0.62, 0.25, 0.78],
];
const NO2_STOPS = [
    [5, 0.10, 0.88, 0.48], [25, 1.00, 0.86, 0.18],
    [60, 1.00, 0.49, 0.05], [120, 1.00, 0.15, 0.18], [150, 0.62, 0.25, 0.78],
];

/** Species value → [r, g, b] in 0–1. Aggregate = shared EPA stops. */
export function heatColor(species, value) {
    if (species === 'co2') return ramp(CO2_STOPS, value);
    if (species === 'no2') return ramp(NO2_STOPS, value);
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
        this.co2Available = null;       // null until the feed answers
        this.sampleCount = 0;
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
            this.co2Available = centers.co2Available !== false
                && centers.cities.some(c => Number.isFinite(c.co2));
            const grid = gridRes.status === 'fulfilled' ? gridRes.value : null;
            this.gridPoints = grid?.available ? (grid.frame?.points ?? []) : [];
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
        for (let i = 0; i < FIELD_W * FIELD_H; i++) {
            const v = field.data[i];
            const a = heatAlpha(v, floor, hi);
            if (a <= 0) continue;
            const [r, g, b] = heatColor(this.species, v);
            im.data[i * 4] = Math.round(r * 255);
            im.data[i * 4 + 1] = Math.round(g * 255);
            im.data[i * 4 + 2] = Math.round(b * 255);
            im.data[i * 4 + 3] = Math.round(a * 255);
        }
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
