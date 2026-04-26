/**
 * upper-atmosphere-live-feed.js — solar-wind heartbeat for the page
 * ═══════════════════════════════════════════════════════════════════════════
 * Polls /api/solar-wind/latest at a steady cadence and dispatches the
 * `swpc-update` CustomEvent the upper-atmosphere page already listens
 * for (see UpperAtmosphereUI._bindSwpcEventBus). That keeps the wiring
 * in one direction: producer → window event → existing consumer hooks.
 *
 * The page can also subscribe directly via onTick() to update a UI
 * tile that confirms data is arriving (age, alert level, freshness).
 *
 * Backoff:
 *   • success         → next tick at INTERVAL_OK (60 s)
 *   • soft error      → next tick at INTERVAL_OK (60 s) — endpoint may
 *                       be momentarily empty (cache_empty / 503)
 *   • hard error      → exponential backoff capped at INTERVAL_MAX (5 m)
 */

const ENDPOINT       = '/api/solar-wind/latest';
const INTERVAL_OK    = 60_000;
const INTERVAL_MIN   = 30_000;
const INTERVAL_MAX   = 300_000;
const FETCH_TIMEOUT  = 8_000;

export class SolarWindLiveFeed {
    constructor({ onTick } = {}) {
        this.onTick = typeof onTick === 'function' ? onTick : null;
        this._running    = false;
        this._timer      = null;
        this._failStreak = 0;
        this._lastTick   = null;
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._tick();
    }

    stop() {
        this._running = false;
        if (this._timer) clearTimeout(this._timer);
        this._timer = null;
    }

    /** Most recent successful payload, or null. */
    last() { return this._lastTick; }

    async _tick() {
        if (!this._running) return;

        let payload = null;
        let ok = false;
        const startedAt = performance.now();

        try {
            const ctl = new AbortController();
            const to = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
            const res = await fetch(ENDPOINT, { signal: ctl.signal });
            clearTimeout(to);

            if (res.ok) {
                payload = await res.json();
                ok = !!payload?.data?.current;
            } else {
                // Treat 503 (cache_empty) as a soft error — endpoint is
                // up, the upstream cron just hasn't populated yet.
                payload = await res.json().catch(() => null);
                ok = false;
                this._softFail = res.status === 503;
            }
        } catch (e) {
            ok = false;
            this._softFail = false;
        }

        if (ok) {
            this._failStreak = 0;
            this._lastTick = {
                payload,
                receivedAt: Date.now(),
                latencyMs:  Math.round(performance.now() - startedAt),
            };
            this._dispatch(payload);
        } else {
            this._failStreak++;
        }

        if (this.onTick) {
            try { this.onTick(this._lastTick, { ok, payload, failStreak: this._failStreak }); }
            catch { /* user callback errors don't kill the poller */ }
        }

        if (!this._running) return;
        const next = ok || this._softFail
            ? INTERVAL_OK
            : Math.min(INTERVAL_MAX,
                       INTERVAL_MIN * Math.pow(2, this._failStreak - 1));
        this._timer = setTimeout(() => this._tick(), next);
    }

    /**
     * Map the /api/solar-wind/latest payload into the same shape
     * SpaceWeatherFeed publishes on `swpc-update` so the existing
     * upper-atmosphere bus hook works without any changes.
     */
    _dispatch(payload) {
        const cur = payload?.data?.current ?? {};
        const detail = {
            solar_wind: {
                speed:   Number.isFinite(cur.speed_km_s) ? cur.speed_km_s : null,
                density: Number.isFinite(cur.density_cc) ? cur.density_cc : null,
                bz:      Number.isFinite(cur.bz_nT)      ? cur.bz_nT      : null,
                bt:      Number.isFinite(cur.bt_nT)      ? cur.bt_nT      : null,
            },
            geomagnetic: {
                kp: null,        // /api/solar-wind/latest doesn't carry Kp
            },
            solar_activity: {
                f107_sfu: null,  // unrelated endpoint — left for /api/noaa/radio-flux
            },
            meta: {
                source:    payload.source ?? 'solar_wind/latest',
                age_min:   payload.age_min ?? null,
                freshness: payload.freshness ?? null,
                alert:     cur.alert_level ?? null,
                trend:     cur.trend_direction ?? null,
            },
        };
        try {
            window.dispatchEvent(new CustomEvent('swpc-update', { detail }));
        } catch { /* SSR / no-DOM contexts */ }
    }
}
