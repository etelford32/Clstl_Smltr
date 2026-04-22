/**
 * wind-pipeline-feed.js — Solar wind pipeline client (Supabase-backed)
 * ========================================================================
 * Primary source  :  /api/solar-wind/latest        (Vercel Edge → Supabase
 *                                                  ring buffer, 1-min pg_cron
 *                                                  writer hitting NOAA)
 * Belt & suspenders:  https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json
 *                    (browser-direct NOAA fetch, invoked ONLY when the
 *                     Supabase reader says the ring buffer is stale). On
 *                     success, the newest sample is POSTed back to
 *                     /api/solar-wind/ingest to repopulate the ring buffer
 *                     for every other visitor — any online user keeps the
 *                     buffer warm if the cron writer is paused.
 *
 * Dispatches 'wind-pipeline-update' on window each time fresh data arrives.
 *
 * Previous version (removed): every browser polled NOAA directly every 60 s,
 * which meant N visitors = N req/min to NOAA's WAF. That's what tripped the
 * earlier 403 host_not_allowed on the server side, and risks browser-IP
 * bans at scale. Now NOAA sees at most one request per cron tick (plus a
 * trickle of belt-and-suspenders fetches only when the cron is down).
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
 *   source        'supabase' | 'noaa-direct' | null  (provenance for the UI)
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

const SUPABASE_ENDPOINT = '/api/solar-wind/latest?series=1';
const INGEST_ENDPOINT   = '/api/solar-wind/ingest';
const NOAA_WIND_URL     = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';

const DEFAULT_INTERVAL  = 60_000;   // 60 s — matches NOAA 1-min product cadence
const SERIES_CAP        = 60;       // last 60 rows ≈ 1 hour for sparkline
const TREND_WINDOW      = 5;        // readings for slope calculation

// If the Supabase reader returns data older than this, trigger the
// browser-direct NOAA belt-and-suspenders path. 3 min gives pg_cron
// three chances to land a row (it runs every 60 s) before we bypass.
const STALE_BYPASS_MS   = 3 * 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────

const _fill = v => (v == null || Number(v) <= -9990 || Number(v) > 1e20) ? null : Number(v);
const _norm = v => Math.max(0, Math.min(1, (v - 250) / 650));

function _slope(vals) {
    const n = vals.length;
    if (n < 2) return 0;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    vals.forEach((y, x) => { sx += x; sy += y; sxy += x * y; sxx += x * x; });
    const denom = n * sxx - sx * sx;
    return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
}

function _alertLevel(speed, bz) {
    const s = speed ?? 400;
    const b = bz    ?? 0;
    if (s >= 800 || (s >= 600 && b < -15)) return 'EXTREME';
    if (s >= 600 || (s >= 400 && b < -10)) return 'HIGH';
    if (s >= 400 || b < -10)               return 'MODERATE';
    return 'QUIET';
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

    start() {
        this._poll();
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        return this;
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
    }

    refresh() { return this._poll(); }

    // ── Internal ──────────────────────────────────────────────────────────────

    async _poll() {
        // 1. Primary read: Supabase-backed edge endpoint.
        let supabasePayload = null;
        try {
            const res = await fetch(SUPABASE_ENDPOINT, {
                cache:  'no-store',
                signal: AbortSignal.timeout(10_000),
            });
            if (res.ok) {
                supabasePayload = await res.json();
            } else if (res.status !== 503) {
                // 503 just means the ring buffer is still cold-starting.
                // Any other code is a real error worth logging.
                console.debug('[wind-pipeline] supabase reader HTTP', res.status);
            }
        } catch (err) {
            console.debug('[wind-pipeline] supabase reader failed:', err.message);
        }

        const supaAgeMs = _payloadAgeMs(supabasePayload);
        const supaFresh = supaAgeMs != null && supaAgeMs < STALE_BYPASS_MS;

        if (supaFresh) {
            this._failStreak = 0;
            this._dispatchFromSupabase(supabasePayload);
            return;
        }

        // 2. Fallback: browser-direct NOAA fetch. Only reached when pg_cron
        //    hasn't landed a row in the last ~3 min — this is the belt-and-
        //    suspenders path. On success we dispatch + POST to ingest so the
        //    Supabase ring buffer recovers even if pg_cron itself is broken.
        try {
            const res = await fetch(NOAA_WIND_URL, {
                cache:  'no-store',
                signal: AbortSignal.timeout(15_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const raw = await res.json();
            if (!Array.isArray(raw) || raw.length === 0) throw new Error('empty NOAA response');
            this._failStreak = 0;
            const dispatched = this._dispatchFromNoaa(raw);
            if (dispatched) this._postIngest(dispatched);   // best-effort
        } catch (err) {
            this._failStreak++;
            console.debug('[wind-pipeline] NOAA fallback failed:', err.message);
            // If Supabase gave us *something* (just stale), serve that over
            // a hard 'offline' — stale real data beats no data.
            if (supabasePayload?.data?.current) {
                this._dispatchFromSupabase(supabasePayload, { forcedStale: true });
            } else {
                this._dispatchOffline(err.message);
            }
        }
    }

    /**
     * Parse the Supabase-backed /api/solar-wind/latest response and emit
     * a wind-pipeline-update event. Response shape is documented in
     * api/solar-wind/latest.js.
     */
    _dispatchFromSupabase(payload, { forcedStale = false } = {}) {
        const d = payload?.data;
        if (!d?.current || !d?.updated) {
            this._dispatchOffline('malformed supabase payload');
            return;
        }

        const c       = d.current;
        const updated = d.updated;
        const ageMin  = (Date.now() - Date.parse(updated)) / 60_000;

        const freshness = ageMin < 5 ? 'fresh' : ageMin < 20 ? 'stale' : 'expired';

        // Series ships already-normalised from the edge endpoint.
        const series = Array.isArray(d.series)
            ? d.series.slice(-SERIES_CAP).map(r => ({
                  timestamp:  r.timestamp,
                  speed_km_s: r.speed_km_s,
                  speed_norm: r.speed_norm ?? _norm(r.speed_km_s),
                  density_cc: r.density_cc,
                  bz_nT:      r.bz_nT,
              }))
            : [];

        const trend = d.trend ?? {
            slope_km_s_per_min: 0,
            direction:          'STEADY',
        };

        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:       forcedStale || freshness === 'expired' ? 'stale' : 'live',
                source:       'supabase',
                speed_km_s:   c.speed_km_s,
                speed_norm:   c.speed_norm ?? _norm(c.speed_km_s),
                density_cc:   c.density_cc,
                bz_nT:        c.bz_nT,
                alert_level:  c.alert_level ?? _alertLevel(c.speed_km_s, c.bz_nT),
                trend,
                series_count: series.length,
                series,
                age_min:      Math.round(ageMin * 10) / 10,
                freshness,
                updated,
            },
        }));
    }

    /**
     * Parse raw NOAA rtsw_wind_1m.json and emit wind-pipeline-update.
     * Returns the newest reading so the caller can forward it to the
     * Supabase ingest endpoint (write-through).
     */
    _dispatchFromNoaa(raw) {
        // Parse every row; prefer DSCOVR proton_* fields over ACE legacy fields.
        // Apply _fill independently before coalescing so fill sentinels don't
        // shadow valid readings via the ?? operator.
        const rows = raw
            .filter(r => r?.time_tag && r.active !== false)
            .map(r => {
                const spd = _fill(r.proton_speed) ?? _fill(r.speed);
                const den = _fill(r.proton_density) ?? _fill(r.density);
                // NOTE: rtsw_wind_1m.json is plasma-only — Bz lives in
                // rtsw_mag_1m.json (fetched separately by swpc-feed.js).
                // Keep the try here for NOAA versions that merge both.
                return {
                    timestamp:  new Date(String(r.time_tag).replace(' ', 'T') + 'Z'),
                    speed_km_s: spd,
                    density_cc: den,
                    bz_nT:      _fill(r.bz_gsm) ?? _fill(r.bz),
                    bt_nT:      _fill(r.bt),
                };
            })
            .filter(r => r.speed_km_s != null && r.speed_km_s > 0);

        if (rows.length === 0) {
            this._dispatchOffline('no valid readings in NOAA response');
            return null;
        }

        const latest = rows[rows.length - 1];
        const ageMin = (Date.now() - latest.timestamp.getTime()) / 60_000;
        const fresh  = ageMin < 5 ? 'fresh' : ageMin < 20 ? 'stale' : 'expired';

        const tw    = rows.slice(-TREND_WINDOW).map(r => r.speed_km_s);
        const slope = _slope(tw);
        const trend = {
            slope_km_s_per_min: Math.round(slope * 100) / 100,
            direction: slope >  2 ? 'RISING' : slope < -2 ? 'FALLING' : 'STEADY',
        };

        const series = rows.slice(-SERIES_CAP).map(r => ({
            timestamp:  r.timestamp.toISOString(),
            speed_km_s: r.speed_km_s,
            speed_norm: Math.round(_norm(r.speed_km_s) * 1000) / 1000,
            density_cc: r.density_cc,
            bz_nT:      r.bz_nT,
        }));

        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:       fresh === 'expired' ? 'stale' : 'live',
                source:       'noaa-direct',
                speed_km_s:   latest.speed_km_s,
                speed_norm:   _norm(latest.speed_km_s),
                density_cc:   latest.density_cc,
                bz_nT:        latest.bz_nT,
                alert_level:  _alertLevel(latest.speed_km_s, latest.bz_nT),
                trend,
                series_count: rows.length,
                series,
                age_min:      Math.round(ageMin * 10) / 10,
                freshness:    fresh,
                updated:      latest.timestamp.toISOString(),
            },
        }));

        return latest;
    }

    /**
     * Best-effort POST to /api/solar-wind/ingest with the newest NOAA row
     * we just successfully read. Silently swallows failures — this is a
     * cache-warming side-effect, not part of the user-visible flow.
     */
    async _postIngest(latest) {
        try {
            await fetch(INGEST_ENDPOINT, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    observed_at:   latest.timestamp.toISOString(),
                    speed_km_s:    latest.speed_km_s,
                    density_cc:    latest.density_cc,
                    bt_nt:         latest.bt_nT,
                    bz_nt:         latest.bz_nT,
                    source:        'noaa-swpc-browser',
                }),
                cache:  'no-store',
                signal: AbortSignal.timeout(5_000),
            });
        } catch {
            // write-through is best-effort; a single failed POST doesn't
            // affect the user flow (they already saw the NOAA data).
        }
    }

    _dispatchOffline(reason) {
        window.dispatchEvent(new CustomEvent('wind-pipeline-update', {
            detail: {
                status:      this._failStreak > 2 ? 'offline' : 'stale',
                source:      null,
                alert_level: null,
                trend:       null,
                error:       reason,
            },
        }));
    }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _payloadAgeMs(payload) {
    const updated = payload?.data?.updated;
    if (!updated) return null;
    const ms = Date.parse(updated);
    return Number.isFinite(ms) ? Date.now() - ms : null;
}

export default WindPipelineFeed;
