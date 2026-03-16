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
const GRID_W       = 36;                // longitude grid points (10° spacing)
const GRID_H       = 18;                // latitude  grid points (10° spacing)
export const TEX_W = 360;               // output texture width  (1°/pixel)
export const TEX_H = 180;               // output texture height (1°/pixel)
const MAX_WIND_MS  = 60;                // m/s — normalisation ceiling
const REFRESH_MS   = 30 * 60 * 1000;   // re-fetch every 30 minutes

// ─────────────────────────────────────────────────────────────────────────────
export class WeatherFeed {
    constructor() {
        this._timer      = null;
        this._weatherBuf = new Float32Array(TEX_W * TEX_H * 4);
        this._windBuf    = new Float32Array(TEX_W * TEX_H * 4);
        this._meta       = {
            loaded:    false,
            source:    'procedural',
            fetchTime: null,
            tempMin:   null, tempMax:  null, tempMean: null,
            presMin:   null, presMax:  null,
            windMax:   null,
        };

        // Build coarse grid lat/lon arrays (row-major: lat varies slowest)
        this._gridLats = [];
        this._gridLons = [];
        for (let j = 0; j < GRID_H; j++) {
            for (let i = 0; i < GRID_W; i++) {
                this._gridLats.push(-85 + j * 10);   // -85 … +85
                this._gridLons.push(-175 + i * 10);  // -175 … +175
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
    get meta()          { return this._meta; }

    // ── Fetch → process ──────────────────────────────────────────────────────
    async _fetchAndProcess() {
        this._dispatch('weather-status', { status: 'fetching' });
        try {
            const rows = await this._fetchGrid();
            if (rows && rows.length > 0) {
                this._processRows(rows);
                this._meta.source    = 'Open-Meteo / GFS';
                this._meta.fetchTime = new Date();
                this._meta.loaded    = true;
            } else {
                throw new Error('Empty response');
            }
        } catch (err) {
            console.warn('[WeatherFeed] Falling back to procedural data:', err.message);
            this._buildProcedural();
            this._meta.source    = 'procedural (GFS unavailable)';
            this._meta.fetchTime = new Date();
        }
        this._dispatch('weather-update', {
            weatherBuffer: this._weatherBuf,
            windBuffer:    this._windBuf,
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
        ].join(','));
        params.set('wind_speed_unit', 'ms');
        params.set('timezone',        'UTC');

        const res = await fetch(`${OPEN_METEO}?${params}`, {
            signal: AbortSignal.timeout(20000),   // 20 s timeout
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const body = await res.json();
        // Open-Meteo returns array for multi-location, object for single location
        return Array.isArray(body) ? body : [body];
    }

    // ── Parse location array → coarse grid → interpolated textures ───────────
    _processRows(rows) {
        const N    = GRID_W * GRID_H;
        const temp = new Float32Array(N).fill(NaN);
        const hum  = new Float32Array(N).fill(NaN);
        const pres = new Float32Array(N).fill(NaN);
        const wspd = new Float32Array(N).fill(NaN);
        const wdir = new Float32Array(N).fill(NaN);

        rows.forEach((loc, idx) => {
            if (idx >= N) return;
            const c = loc.current ?? {};
            temp[idx] = c.temperature_2m        ?? NaN;
            hum[idx]  = c.relative_humidity_2m  ?? 50;
            pres[idx] = c.surface_pressure       ?? 1013;
            wspd[idx] = c.wind_speed_10m         ?? 0;
            wdir[idx] = c.wind_direction_10m     ?? 0;
        });

        // Fill any NaN gaps (missing ocean cells, polar regions, etc.)
        [temp, hum, pres, wspd, wdir].forEach(a => this._fillNaN(a, GRID_W, GRID_H));

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

        this._interpolateToTextures(temp, hum, pres, wspd, wdir);
    }

    // ── Bilinear interpolation: inW×inH → outW×outH ──────────────────────────
    _bilinear(src, inW, inH, outW, outH) {
        const dst = new Float32Array(outW * outH);
        for (let j = 0; j < outH; j++) {
            const fy = (j / (outH - 1)) * (inH - 1);
            const y0 = Math.floor(fy), y1 = Math.min(y0 + 1, inH - 1);
            const ty = fy - y0;
            for (let i = 0; i < outW; i++) {
                const fx = (i / (outW - 1)) * (inW - 1);
                const x0 = Math.floor(fx), x1 = Math.min(x0 + 1, inW - 1);
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
    _interpolateToTextures(rawTemp, rawHum, rawPres, rawWSpd, rawWDir) {
        const DEG  = Math.PI / 180;
        const temp = this._bilinear(rawTemp, GRID_W, GRID_H, TEX_W, TEX_H);
        const hum  = this._bilinear(rawHum,  GRID_W, GRID_H, TEX_W, TEX_H);
        const pres = this._bilinear(rawPres, GRID_W, GRID_H, TEX_W, TEX_H);
        const wspd = this._bilinear(rawWSpd, GRID_W, GRID_H, TEX_W, TEX_H);
        const wdir = this._bilinear(rawWDir, GRID_W, GRID_H, TEX_W, TEX_H);

        for (let k = 0; k < TEX_W * TEX_H; k++) {
            const t4  = k * 4;
            const dir = wdir[k] * DEG;
            // Meteorological convention: FROM direction → negate for velocity
            const windU = -wspd[k] * Math.sin(dir);  // eastward  m/s
            const windV = -wspd[k] * Math.cos(dir);  // northward m/s

            // weatherBuffer — normalised scalars for colour overlays
            this._weatherBuf[t4+0] = Math.max(0, Math.min(1, (temp[k] + 60) / 110)); // -60…+50 °C
            this._weatherBuf[t4+1] = Math.max(0, Math.min(1, (pres[k] - 850) / 210));// 850…1060 hPa
            this._weatherBuf[t4+2] = Math.max(0, Math.min(1,  hum[k] / 100));
            this._weatherBuf[t4+3] = Math.max(0, Math.min(1,  wspd[k] / MAX_WIND_MS));

            // windBuffer — signed U,V for particle advection
            this._windBuf[t4+0] = windU / MAX_WIND_MS;   // [-1, 1]
            this._windBuf[t4+1] = windV / MAX_WIND_MS;   // [-1, 1]
            this._windBuf[t4+2] = wspd[k] / MAX_WIND_MS; // [0, 1]
            this._windBuf[t4+3] = 1.0;
        }
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
            }
        }
    }

    // ── Event helpers ─────────────────────────────────────────────────────────
    _dispatch(type, detail) {
        document.dispatchEvent(new CustomEvent(type, { detail }));
    }
}
