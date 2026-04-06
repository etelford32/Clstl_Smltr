/**
 * WeatherFeed — Real-time global weather data pipeline
 *
 * Data source:  Open-Meteo (https://open-meteo.com) — free, no API key,
 *               backed by NOAA GFS + ECMWF forecasts.
 *
 * Output:  Two Float32 RGBA DataTexture buffers at TEX_W × TEX_H resolution:
 *
 *   weatherBuffer  (RGBA)
 *     R = temperature   — normalised [0,1] spanning -60 … +50 °C
 *     G = pressure      — normalised [0,1] spanning  850 … 1060 hPa
 *     B = humidity      — normalised [0,1] spanning    0 … 100 %
 *     A = wind speed    — normalised [0,1] spanning    0 … MAX_WIND m/s
 *
 *   windBuffer  (RGBA)
 *     R = U component (eastward)   — signed [-1,1] in MAX_WIND units
 *     G = V component (northward)  — signed [-1,1] in MAX_WIND units
 *     B = wind speed normalised    — [0,1]
 *     A = 1.0
 *
 * Fires: CustomEvent 'weather-update' on document
 *   detail: { weatherBuffer, windBuffer, meta, texW, texH }
 *
 * Replace / augment _fetchGrid() to integrate additional sources:
 *   - NOAA NOMADS GRIB2 tiles (high resolution, requires server-side parsing)
 *   - Copernicus ERA5 Climate Data Store (historical + NRT)
 *   - OpenWeatherMap (requires API key, point-based)
 *   - Custom WebSocket stream for ultra-low-latency updates
 */

const OPEN_METEO   = 'https://api.open-meteo.com/v1/forecast';
// Grid size must stay under ~700 points for Open-Meteo URL length limit.
// 72×36 = 2592 points → 40KB URL → rejected → "GFS unavailable".
// 36×18 = 648 points → ~10KB URL → proven reliable.
// Bilinear interpolation upscales to 360×180 output texture (1°/px).
const GRID_W       = 36;                // longitude grid points (10° spacing)
const GRID_H       = 18;                // latitude  grid points (10° spacing)
export const TEX_W = 360;               // output texture width  (1°/pixel)
export const TEX_H = 180;               // output texture height (1°/pixel)
const MAX_WIND_MS  = 60;                // m/s — normalisation ceiling
const REFRESH_MS   = 10 * 60 * 1000;   // re-fetch every 10 minutes

// ─────────────────────────────────────────────────────────────────────────────
export class WeatherFeed {
    constructor() {
        this._timer      = null;
        this._weatherBuf = new Float32Array(TEX_W * TEX_H * 4);
        this._windBuf    = new Float32Array(TEX_W * TEX_H * 4);
        // cloudBuf: R=cloud_low, G=cloud_mid, B=cloud_high, A=precipitation_rate
        this._cloudBuf   = new Float32Array(TEX_W * TEX_H * 4);
        this._meta       = {
            loaded:    false,
            source:    'procedural',
            fetchTime: null,
            tempMin:   null, tempMax:  null, tempMean: null,
            presMin:   null, presMax:  null,
            windMax:   null,
            cloudMax:  null,
        };

        // Build coarse grid lat/lon arrays (row-major: lat varies slowest)
        this._gridLats = [];
        this._gridLons = [];
        for (let j = 0; j < GRID_H; j++) {
            for (let i = 0; i < GRID_W; i++) {
                this._gridLats.push(-85 + j * 10);    // -85 … +85
                this._gridLons.push(-175 + i * 10);   // -175 … +175
            }
        }

        // Start with procedural data so the shader has something immediately
        this._buildProcedural();
    }

    // ── Public API ───────────────────────────────────────────────────────────
    start()  { this._fetchAndProcess(); this._timer = setInterval(() => this._fetchAndProcess(), REFRESH_MS); }
    stop()   { clearInterval(this._timer); }
    refresh(){ this._fetchAndProcess(); }

    get weatherBuffer() { return this._weatherBuf; }
    get windBuffer()    { return this._windBuf; }
    get cloudBuffer()   { return this._cloudBuf; }
    get meta()          { return this._meta; }

    // ── localStorage cache for instant startup ─────────────────────────────
    _cacheKey = 'ppx_weather_cache';

    _saveToCache(rows) {
        try {
            const data = { rows, timestamp: Date.now() };
            localStorage.setItem(this._cacheKey, JSON.stringify(data));
        } catch { /* storage full or unavailable — ignore */ }
    }

    _loadFromCache() {
        try {
            const raw = localStorage.getItem(this._cacheKey);
            if (!raw) return null;
            const data = JSON.parse(raw);
            // Accept cache up to 2 hours old
            if (Date.now() - data.timestamp > 2 * 60 * 60 * 1000) return null;
            return data.rows;
        } catch { return null; }
    }

    // ── Fetch → process ──────────────────────────────────────────────────────
    async _fetchAndProcess() {
        this._dispatch('weather-status', { status: 'fetching' });

        // Serve cached data instantly on first load (while fetch runs in background)
        if (!this._meta.loaded) {
            const cached = this._loadFromCache();
            if (cached && cached.length > 0) {
                this._processRows(cached);
                this._meta.source    = 'Open-Meteo / GFS (cached)';
                this._meta.fetchTime = new Date();
                this._meta.loaded    = true;
                this._dispatch('weather-update', {
                    weatherBuffer: this._weatherBuf, windBuffer: this._windBuf,
                    cloudBuffer: this._cloudBuf, meta: this._meta,
                    texW: TEX_W, texH: TEX_H,
                });
                console.info('[WeatherFeed] Served cached data while fetching fresh');
            }
        }

        try {
            const rows = await this._fetchGrid();
            if (rows && rows.length > 0) {
                this._processRows(rows);
                this._saveToCache(rows);
                this._meta.source    = 'Open-Meteo / GFS';
                this._meta.fetchTime = new Date();
                this._meta.loaded    = true;
            } else {
                throw new Error('Empty response');
            }
        } catch (err) {
            console.warn('[WeatherFeed] Falling back to procedural data:', err.message);
            if (!this._meta.loaded) {
                // Only use procedural if we have nothing else
                this._buildProcedural();
            }
            this._meta.source    = this._meta.loaded
                ? `${this._meta.source} (refresh failed)`
                : 'procedural (GFS unavailable)';
            this._meta.fetchTime = new Date();
        }
        this._dispatch('weather-update', {
            weatherBuffer: this._weatherBuf,
            windBuffer:    this._windBuf,
            cloudBuffer:   this._cloudBuf,
            meta:          this._meta,
            texW:          TEX_W,
            texH:          TEX_H,
        });
    }

    // ── Open-Meteo grid fetch ─────────────────────────────────────────────────
    // Sends ONE HTTP request with all 648 lat/lon pairs as comma-separated lists.
    // Returns array of per-location objects (same order as _gridLats/_gridLons).
    async _fetchGrid() {
        const params = new URLSearchParams();
        params.set('latitude',        this._gridLats.join(','));
        params.set('longitude',       this._gridLons.join(','));
        params.set('current',         [
            'temperature_2m',
            'relative_humidity_2m',
            'surface_pressure',
            'wind_speed_10m',
            'wind_direction_10m',
            'cloud_cover_low',
            'cloud_cover_mid',
            'cloud_cover_high',
            'precipitation',
            'cape',
        ].join(','));
        params.set('wind_speed_unit', 'ms');
        params.set('timezone',        'UTC');

        const res = await fetch(`${OPEN_METEO}?${params}`, {
            signal: AbortSignal.timeout(20000),   // 20 s timeout
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = await res.json();
        // Open-Meteo returns { error: true, reason: "…" } on bad requests
        if (body && !Array.isArray(body) && body.error) {
            throw new Error(`Open-Meteo: ${body.reason ?? body.error}`);
        }
        // Multi-location → array; single location → wrap in array
        return Array.isArray(body) ? body : [body];
    }

    // ── Parse location array → coarse grid → interpolated textures ───────────
    _processRows(rows) {
        const N    = GRID_W * GRID_H;
        const DEG  = Math.PI / 180;
        const temp = new Float32Array(N).fill(NaN);
        const hum  = new Float32Array(N).fill(NaN);
        const pres = new Float32Array(N).fill(NaN);
        const wspd = new Float32Array(N).fill(NaN);
        const wdir = new Float32Array(N).fill(NaN);
        const clLow  = new Float32Array(N).fill(0);
        const clMid  = new Float32Array(N).fill(0);
        const clHigh = new Float32Array(N).fill(0);
        const precip = new Float32Array(N).fill(0);

        rows.forEach((loc, idx) => {
            if (idx >= N) return;
            const c = loc.current ?? {};
            temp[idx]   = c.temperature_2m        ?? NaN;
            hum[idx]    = c.relative_humidity_2m  ?? 50;
            pres[idx]   = c.surface_pressure       ?? 1013;
            wspd[idx]   = c.wind_speed_10m         ?? 0;
            wdir[idx]   = c.wind_direction_10m     ?? 0;
            clLow[idx]  = c.cloud_cover_low        ?? 0;
            clMid[idx]  = c.cloud_cover_mid        ?? 0;
            clHigh[idx] = c.cloud_cover_high       ?? 0;
            precip[idx] = c.precipitation          ?? 0;
        });

        // Fill any NaN gaps (missing ocean cells, polar regions, etc.)
        [temp, hum, pres, wspd, wdir].forEach(a => this._fillNaN(a, GRID_W, GRID_H));

        // Decompose wind speed+direction into U/V on the coarse grid BEFORE
        // interpolation.  Bilinear interpolation of angles is wrong because
        // degrees wrap at 360°→0° (e.g. avg of 350° and 10° gives 180° not 0°).
        // Interpolating the Cartesian components avoids this entirely.
        const windUCoarse = new Float32Array(N);
        const windVCoarse = new Float32Array(N);
        for (let k = 0; k < N; k++) {
            const dir = wdir[k] * DEG;
            // Meteorological convention: FROM direction → negate for velocity
            windUCoarse[k] = -wspd[k] * Math.sin(dir);  // eastward  m/s
            windVCoarse[k] = -wspd[k] * Math.cos(dir);  // northward m/s
        }

        // Compute global stats for the analysis panel
        const vt = Array.from(temp).filter(isFinite);
        const vp = Array.from(pres).filter(isFinite);
        const vw = Array.from(wspd).filter(isFinite);
        this._meta.tempMin  = Math.min(...vt);
        this._meta.tempMax  = Math.max(...vt);
        this._meta.tempMean = vt.reduce((a, b) => a + b, 0) / vt.length;
        this._meta.presMin  = Math.min(...vp);
        this._meta.presMax  = Math.max(...vp);
        this._meta.windMax  = Math.max(...vw);
        this._meta.cloudMax = Math.max(...Array.from(clLow), ...Array.from(clMid), ...Array.from(clHigh));

        this._interpolateToTextures(temp, hum, pres, wspd, windUCoarse, windVCoarse);
        this._interpolateCloudTexture(clLow, clMid, clHigh, precip);
    }

    // ── Bilinear interpolation: inW×inH → outW×outH ──────────────────────────
    // wrapX: when true, longitude (x axis) wraps so column 0 is adjacent to
    //        column inW-1 (periodic boundary).  This eliminates the 10° seam
    //        at the antimeridian where -175° meets +175°.
    _bilinear(src, inW, inH, outW, outH, wrapX = false) {
        const dst = new Float32Array(outW * outH);
        for (let j = 0; j < outH; j++) {
            const fy = (j / (outH - 1)) * (inH - 1);
            const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, inH - 1);
            const ty = fy - y0;
            for (let i = 0; i < outW; i++) {
                const fx = (i / (outW - 1)) * (inW - 1);
                const x0 = Math.floor(fx);
                const x1 = wrapX ? (x0 + 1) % inW : Math.min(x0 + 1, inW - 1);
                const tx = fx - x0;
                dst[j * outW + i] =
                    (1-tx)*(1-ty)*src[y0*inW+x0] + tx*(1-ty)*src[y0*inW+x1] +
                    (1-tx)*   ty *src[y1*inW+x0] + tx*   ty *src[y1*inW+x1];
            }
        }
        return dst;
    }

    // ── NaN-gap fill (nearest valid neighbour) ────────────────────────────────
    _fillNaN(arr, W, H) {
        for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
                if (isFinite(arr[j * W + i])) continue;
                outer: for (let r = 1; r <= Math.max(W, H); r++) {
                    for (let dj = -r; dj <= r; dj++) {
                        for (let di = -r; di <= r; di++) {
                            const ni = ((i + di) % W + W) % W;
                            const nj = Math.max(0, Math.min(H-1, j + dj));
                            const v  = arr[nj * W + ni];
                            if (isFinite(v)) { arr[j * W + i] = v; break outer; }
                        }
                    }
                }
            }
        }
    }

    // ── Write interpolated data into Float32 texture buffers ──────────────────
    // Wind U/V are now pre-decomposed on the coarse grid and interpolated
    // as Cartesian components (no angle-wrapping artifacts).
    _interpolateToTextures(rawTemp, rawHum, rawPres, rawWSpd, rawWindU, rawWindV) {
        const temp  = this._bilinear(rawTemp,  GRID_W, GRID_H, TEX_W, TEX_H, true);
        const hum   = this._bilinear(rawHum,   GRID_W, GRID_H, TEX_W, TEX_H, true);
        const pres  = this._bilinear(rawPres,  GRID_W, GRID_H, TEX_W, TEX_H, true);
        const wspd  = this._bilinear(rawWSpd,  GRID_W, GRID_H, TEX_W, TEX_H, true);
        const windU = this._bilinear(rawWindU, GRID_W, GRID_H, TEX_W, TEX_H, true);
        const windV = this._bilinear(rawWindV, GRID_W, GRID_H, TEX_W, TEX_H, true);

        for (let k = 0; k < TEX_W * TEX_H; k++) {
            const t4 = k * 4;

            // weatherBuffer — normalised scalars for colour overlays
            this._weatherBuf[t4+0] = Math.max(0, Math.min(1, (temp[k] + 60) / 110)); // -60…+50 °C
            this._weatherBuf[t4+1] = Math.max(0, Math.min(1, (pres[k] - 850) / 210));// 850…1060 hPa
            this._weatherBuf[t4+2] = Math.max(0, Math.min(1,  hum[k] / 100));
            this._weatherBuf[t4+3] = Math.max(0, Math.min(1,  wspd[k] / MAX_WIND_MS));

            // windBuffer — signed U,V for particle advection (already in m/s)
            this._windBuf[t4+0] = windU[k] / MAX_WIND_MS;   // [-1, 1]
            this._windBuf[t4+1] = windV[k] / MAX_WIND_MS;   // [-1, 1]
            this._windBuf[t4+2] = wspd[k]  / MAX_WIND_MS;   // [0, 1]
            this._windBuf[t4+3] = 1.0;
        }
    }

    // ── Pack cloud-layer fractions + precipitation into cloudBuf ─────────────
    // After bilinear interpolation, apply a box-blur smoothing pass to reduce
    // visible 10° grid-cell blockiness in the cloud fraction data.
    _interpolateCloudTexture(rawLow, rawMid, rawHigh, rawPrecip) {
        const low    = this._bilinear(rawLow,    GRID_W, GRID_H, TEX_W, TEX_H, true);
        const mid    = this._bilinear(rawMid,    GRID_W, GRID_H, TEX_W, TEX_H, true);
        const high   = this._bilinear(rawHigh,   GRID_W, GRID_H, TEX_W, TEX_H, true);
        const precip = this._bilinear(rawPrecip, GRID_W, GRID_H, TEX_W, TEX_H, true);

        // Smooth cloud fractions to soften grid-cell boundaries.
        // Two passes of 5×5 box blur is equivalent to ~10×10 Gaussian and
        // eliminates the visible 10°-spaced block edges.
        const sLow    = this._boxBlur(this._boxBlur(low,    TEX_W, TEX_H, 2), TEX_W, TEX_H, 2);
        const sMid    = this._boxBlur(this._boxBlur(mid,    TEX_W, TEX_H, 2), TEX_W, TEX_H, 2);
        const sHigh   = this._boxBlur(this._boxBlur(high,   TEX_W, TEX_H, 2), TEX_W, TEX_H, 2);
        const sPrecip = this._boxBlur(precip, TEX_W, TEX_H, 2);  // single pass for precip

        for (let k = 0; k < TEX_W * TEX_H; k++) {
            const t4 = k * 4;
            this._cloudBuf[t4+0] = Math.max(0, Math.min(1, sLow[k]    / 100));
            this._cloudBuf[t4+1] = Math.max(0, Math.min(1, sMid[k]    / 100));
            this._cloudBuf[t4+2] = Math.max(0, Math.min(1, sHigh[k]   / 100));
            this._cloudBuf[t4+3] = Math.max(0, Math.min(1, sPrecip[k] / 10));  // cap 10 mm/hr
        }
    }

    // ── Separable box blur (radius R → kernel width 2R+1) ───────────────────
    // Wraps longitude (x axis); clamps latitude (y axis).
    _boxBlur(src, W, H, R) {
        const tmp = new Float32Array(W * H);
        const dst = new Float32Array(W * H);
        const diam = 2 * R + 1;

        // Horizontal pass (wrap longitude)
        for (let j = 0; j < H; j++) {
            let sum = 0;
            // Seed with first window
            for (let dx = -R; dx <= R; dx++) {
                sum += src[j * W + ((dx % W) + W) % W];
            }
            tmp[j * W + 0] = sum / diam;
            for (let i = 1; i < W; i++) {
                sum += src[j * W + ((i + R) % W)] - src[j * W + (((i - R - 1) % W) + W) % W];
                tmp[j * W + i] = sum / diam;
            }
        }

        // Vertical pass (clamp latitude)
        for (let i = 0; i < W; i++) {
            let sum = 0;
            for (let dy = -R; dy <= R; dy++) {
                sum += tmp[Math.max(0, Math.min(H - 1, dy)) * W + i];
            }
            dst[0 * W + i] = sum / diam;
            for (let j = 1; j < H; j++) {
                sum += tmp[Math.min(H - 1, j + R) * W + i] - tmp[Math.max(0, j - R - 1) * W + i];
                dst[j * W + i] = sum / diam;
            }
        }

        return dst;
    }

    // ── Procedural fallback: physically motivated zonal circulation ───────────
    // Reproduces major features: Hadley cell, Ferrel cell, polar cell,
    // trade winds, mid-latitude westerlies, Intertropical Convergence Zone.
    _buildProcedural() {
        const TWO_PI = Math.PI * 2;
        for (let j = 0; j < TEX_H; j++) {
            for (let i = 0; i < TEX_W; i++) {
                const k   = j * TEX_W + i;
                const lat = (j / (TEX_H - 1) - 0.5) * Math.PI;   // -π/2 … +π/2
                const lon = (i / (TEX_W - 1) - 0.5) * TWO_PI;    // -π … +π
                const t4  = k * 4;

                // Temperature: equatorial maximum, polar minimum, Rossby wave perturbation
                const tBase = Math.cos(lat * 1.05) * 0.5 + 0.5;
                const wave  = 0.18 * Math.sin(lon * 3.0 + lat * 1.5)
                            + 0.10 * Math.sin(lon * 5.0 - lat * 2.5)
                            + 0.06 * Math.sin(lon * 7.0 + lat * 0.8);
                const tNorm = Math.max(0, Math.min(1, tBase + wave));

                // Pressure: subtropical highs (±30°), equatorial low, polar lows
                const pNorm = 0.5 + 0.30 * Math.cos(lat * 3.0)
                                  + 0.10 * Math.sin(lon * 4.0 + lat);

                // Humidity: ITCZ near equator, dry subtropics, moist storm tracks
                const hNorm = Math.max(0, Math.cos(lat * 1.8) * 0.8
                            + 0.20 * Math.abs(Math.sin(lat * 3.0 + lon * 2.0)));

                // Zonal wind: trade winds (E) in tropics, westerlies in mid-lat,
                //             polar easterlies. Meridional: gentle Hadley circulation.
                // sin(3φ) has zeros at ±0, ±60, ±90° and max at ±30° — matches Ferrel
                const windU = -Math.sin(lat * 3.0) * 0.65;  // eastward normalised [-1,1]
                const windV =  Math.sin(lon * 2.0 + lat * 0.8) * 0.12 * Math.cos(lat);
                const spd   = Math.min(1, Math.sqrt(windU * windU + windV * windV) * 1.4);

                this._weatherBuf[t4+0] = tNorm;
                this._weatherBuf[t4+1] = Math.max(0, Math.min(1, pNorm));
                this._weatherBuf[t4+2] = Math.max(0, Math.min(1, hNorm));
                this._weatherBuf[t4+3] = spd;

                this._windBuf[t4+0] = windU;
                this._windBuf[t4+1] = windV;
                this._windBuf[t4+2] = spd;
                this._windBuf[t4+3] = 1.0;

                // Procedural cloud layers: low cloud in ITCZ + mid-lat storms,
                // high cirrus in subtropics and polar front
                const itcz    = Math.max(0, 1.0 - Math.abs(lat) * 3.8); // near equator
                const midLat  = Math.max(0, Math.abs(lat) - 0.5) * 1.2; // >30°
                const cLow    = Math.max(0, Math.min(1, itcz * 0.9 + midLat * 0.55 * (1 - pNorm)));
                const cMid    = Math.max(0, Math.min(1, midLat * 0.5 + (1 - pNorm) * 0.3));
                const cHigh   = Math.max(0, Math.min(1, 0.25 + 0.35 * Math.abs(Math.sin(lat * 2))));
                this._cloudBuf[t4+0] = cLow;
                this._cloudBuf[t4+1] = cMid;
                this._cloudBuf[t4+2] = cHigh;
                this._cloudBuf[t4+3] = cLow * 0.4;  // precip proportional to low cloud
            }
        }
    }

    // ── Event helpers ─────────────────────────────────────────────────────────
    _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
