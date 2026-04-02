/**
 * wind-pipeline-feed.js — Solar wind pipeline client (direct NOAA browser fetch)
 * ========================================================================
 * Fetches NOAA DSCOVR/ACE real-time 1-minute wind data DIRECTLY from the
 * browser.  The previous design polled a Vercel edge function
 * (/api/solar-wind/wind-speed) which NOAA's WAF permanently blocks with 403
 * host_not_allowed for any server-side fetch.  This version skips the edge
 * function and hits NOAA directly — CORS is enabled on all services.swpc.noaa.gov
 * endpoints so browser-side fetches are fine.
 *
 * Dispatches 'wind-pipeline-update' on window each time fresh data arrives.
 *
 * USAGE
 * ─────
 *   import WindPipelineFeed from './js/wind-pipeline-feed.js';
 *   new WindPipelineFeed().start();
 *   window.addEventListener('wind-pipeline-update', e => console.log(e.detail));
 *
 * EVENT DETAIL  (wind-pipeline-update)
 * ─────────────────────────────────────
 *   status        'live' | 'stale' | 'offline'
 *   speed_km_s    float   e.g. 487.3
 *   speed_norm    float   0–1
 *   density_cc    float   protons/cm³
 *   bz_nT         float   IMF Bz in nT (negative = southward)
 *   alert_level   string  'QUIET' | 'MODERATE' | 'HIGH' | 'EXTREME'
 *   trend         object  { slope_km_s_per_min: float, direction: 'RISING'|'STEADY'|'FALLING' }
 *   series_count  int     number of valid data points in the NOAA 1-hour window
 *   series        array   last 60 readings  [{ timestamp, speed_km_s, speed_norm, density_cc, bz_nT }]
 *   age_min       float   minutes since last ingest
 *   freshness     string  'fresh' | 'stale' | 'expired' | 'missing'
 *   updated       string  ISO timestamp of last reading
 */

// NOAA SWPC DSCOVR/ACE real-time 1-minute wind (CORS-enabled; browser-only)
const NOAA_WIND_URL    = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const DEFAULT_INTERVAL = 60_000;   // 60 s — matches NOAA 1-min product cadence
const SERIES_CAP       = 60;       // last 60 rows ≈ 1 hour for sparkline
const TREND_WINDOW     = 5;        // readings for slope calculation

// ── Helpers ───────────────────────────────────────────────────────────────────

/** NOAA fill sentinel: values ≤ −9990 or > 1e20 are missing. */
const _fill = v => (v == null || Number(v) <= -9990 || Number(v) > 1e20) ? null : Number(v);

/** Normalize speed to 0–1 over 250–900 km/s. */
const _norm = v => Math.max(0, Math.min(1, (v - 250) / 650));

/** OLS slope over an array of numbers (returns km/s per sample). */
function _slope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const denom = n * sxx - sx * sx;
    return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

// ── Class ─────────────────────────────────────────────────────────────────────

export class WindPipelineFeed {
    /**
     * @param {object} opts
     * @param {number} [opts.pollInterval]  ms between polls (default 60 000)
     */
    constructor({ pollInterval = DEFAULT_INTERVAL } = {}) {
        this.pollInterval = pollInterval;
        this._timer       = null;
        this._failStreak  = 0;
    }

    /** Start polling immediately and on the configured interval. */
    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    /** Stop polling. */
    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    /** Trigger an out-of-band refresh. */
    refresh() { return this._poll(); }

    // ── Internal ──────────────────────────────────────────────────────────────

    async _poll() {
        try {
            const res = await fetch(NOAA_WIND_URL, {
                cache:  'no-store',
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.json();
            if (!Array.isArray(raw) || raw.length === 0) throw new Error('empty response');
            this._failStreak = 0;
            this._dispatch(raw);
        } catch (err) {
            this._failStreak++;
            console.debug('[wind-pipeline] poll failed:', err.message);
            this._dispatchOffline(err.message);
        }
    }

    _dispatch(raw) {
        // ── DIAGNOSTIC: dump raw NOAA structure on first dispatch ──────────
        if (!this._diagnosed) {
            this._diagnosed = true;
            const last = raw[raw.length - 1];
            console.group('%c[WIND PIPELINE DIAGNOSTIC] Raw NOAA rtsw_wind_1m.json', 'color:#00ccff;font-weight:bold');
            console.log('Total rows:', raw.length);
            console.log('Last row keys:', Object.keys(last ?? {}));
            console.log('Last row:', JSON.parse(JSON.stringify(last)));
            console.groupEnd();
        }

        // Parse every row; prefer DSCOVR proton_* fields over ACE legacy fields.
        // Apply noaaFill to each field independently before coalescing, so fill
        // values (-99999) don't shadow valid proton_* readings via the ?? operator.
        const rows = raw
            .filter(r => r?.time_tag)
            .map(r => {
                const spd = _fill(r.proton_speed) ?? _fill(r.speed);
                const den = _fill(r.proton_density) ?? _fill(r.density);
                return {
                    timestamp:  new Date(String(r.time_tag).replace(' ', 'T') + 'Z'),
                    speed_km_s: spd,
                    density_cc: den,
                    bz_nT:      _fill(r.bz_gsm) ?? _fill(r.bz),
                    bt_nT:      _fill(r.bt),
                };
            })
            // Only keep rows that have a valid, positive wind speed
            .filter(r => r.speed_km_s != null && r.speed_km_s > 0);

        if (rows.length === 0) {
            this._dispatchOffline('no valid readings in NOAA response');
            return;
        }

        // Most-recent valid reading
        const latest  = rows[rows.length - 1];
        const ageMin  = (Date.now() - latest.timestamp.getTime()) / 60_000;
        const fresh   = ageMin < 5 ? 'fresh' : ageMin < 20 ? 'stale' : 'expired';

        // Trend slope over last TREND_WINDOW valid readings (km/s per sample minute)
        const tw    = rows.slice(-TREND_WINDOW).map(r => r.speed_km_s);
        const slope = _slope(tw);
        const trend = {
            slope_km_s_per_min: Math.round(slope * 100) / 100,
            direction: slope >  2 ? 'RISING' : slope < -2 ? 'FALLING' : 'STEADY',
        };

        // Series for sparkline (last SERIES_CAP readings ≈ 1 hour)
        const series = rows.slice(-SERIES_CAP).map(r => ({
            timestamp:  r.timestamp.toISOString(),
            speed_km_s: r.speed_km_s,
            speed_norm: Math.round(_norm(r.speed_km_s) * 1000) / 1000,
            density_cc: r.density_cc,
            bz_nT:      r.bz_nT,
        }));

        // Alert classification
        const spd   = latest.speed_km_s;
        const bz    = latest.bz_nT ?? 0;
        const alert =
            spd >= 800 || (spd >= 600 && bz < -15) ? 'EXTREME' :
            spd >= 600 || (spd >= 400 && bz < -10) ? 'HIGH'    :
            spd >= 400 || bz < -10                  ? 'MODERATE': 'QUIET';

        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:       fresh === 'expired' ? 'stale' : 'live',
                speed_km_s:   spd,
                speed_norm:   _norm(spd),
                density_cc:   latest.density_cc,
                bz_nT:        latest.bz_nT,
                alert_level:  alert,
                trend,
                series_count: rows.length,
                series,
                age_min:      Math.round(ageMin * 10) / 10,
                freshness:    fresh,
                updated:      latest.timestamp.toISOString(),
            },
        }));
    }

    _dispatchOffline(reason) {
        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:      this._failStreak > 2 ? 'offline' : 'stale',
                alert_level: null,
                trend:       null,
                error:       reason,
            },
        }));
    }
}

export default WindPipelineFeed;
