/**
 * alert-engine.js — Client-side alert trigger engine
 *
 * Evaluates live space weather data against the user's alert preferences
 * and fires in-app notifications when thresholds are crossed.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *  1. Listens to 'swpc-update' events (solar wind, Kp, flares, CMEs)
 *  2. Checks each alert type against user preferences from auth.getAlertPrefs()
 *  3. Applies cooldown to prevent re-firing the same alert type repeatedly
 *  4. Plan-gates: basic tier gets Tier 1 alerts, advanced gets all
 *  5. Writes to Supabase alert_history table (if connected)
 *  6. Dispatches 'user-alert' CustomEvent for the notification bell
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  import { AlertEngine } from './js/alert-engine.js';
 *  const engine = new AlertEngine().start();
 *  window.addEventListener('user-alert', e => showBell(e.detail));
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';

// ── Flare class helpers ──────────────────────────────────────────────────────

const FLARE_ORDER = { A: 0, B: 1, C: 2, M: 3, X: 4 };

function flareClassToLetter(flux) {
    if (flux >= 1e-4) return 'X';
    if (flux >= 1e-5) return 'M';
    if (flux >= 1e-6) return 'C';
    if (flux >= 1e-7) return 'B';
    return 'A';
}

function flareAtOrAbove(currentFlux, threshold) {
    const cur = FLARE_ORDER[flareClassToLetter(currentFlux)] ?? 0;
    const thr = FLARE_ORDER[threshold?.charAt?.(0)?.toUpperCase()] ?? 3;
    return cur >= thr;
}

// ── G-scale from Kp ──────────────────────────────────────────────────────────

function kpToGScale(kp) {
    if (kp >= 9) return 5;
    if (kp >= 8) return 4;
    if (kp >= 7) return 3;
    if (kp >= 6) return 2;
    if (kp >= 5) return 1;
    return 0;
}

// ── R-scale from X-ray flux ──────────────────────────────────────────────────

function fluxToRScale(flux) {
    if (flux >= 2e-3) return 5;   // X20+
    if (flux >= 1e-3) return 4;   // X10
    if (flux >= 1e-4) return 3;   // X1
    if (flux >= 5e-5) return 2;   // M5
    if (flux >= 1e-5) return 1;   // M1
    return 0;
}

// ── Severity mapping ─────────────────────────────────────────────────────────

function gScaleSeverity(g) {
    if (g >= 4) return 'critical';
    if (g >= 2) return 'warning';
    return 'info';
}

// ── Alert definitions ────────────────────────────────────────────────────────

/**
 * Each alert type has:
 *   key       — matches the notify_* preference field
 *   type      — alert_type enum in alert_history table
 *   tier      — 'basic' or 'advanced' plan requirement
 *   evaluate  — fn(state, prefs) → { fire, title, body, severity, metadata } | null
 */
const ALERT_DEFS = [
    {
        key: 'notify_storm',
        type: 'storm',
        tier: 'basic',
        evaluate(state, prefs) {
            const kp = state.kp ?? 0;
            const g = kpToGScale(kp);
            const threshold = prefs.storm_g_threshold ?? 1;
            if (g < threshold) return null;
            return {
                fire: true,
                title: `G${g} Geomagnetic Storm`,
                body: `Kp index reached ${kp.toFixed(1)} — G${g} ${g >= 4 ? 'Severe' : g >= 3 ? 'Strong' : g >= 2 ? 'Moderate' : 'Minor'} geomagnetic storm conditions.`,
                severity: gScaleSeverity(g),
                metadata: { kp, g_scale: g },
            };
        },
    },
    {
        key: 'notify_flare',
        type: 'flare',
        tier: 'basic',
        evaluate(state, prefs) {
            const flux = state.xray_flux ?? 0;
            const threshold = prefs.flare_class_threshold ?? 'M';
            if (!flareAtOrAbove(flux, threshold)) return null;
            const cls = flareClassToLetter(flux);
            return {
                fire: true,
                title: `${cls}-Class Solar Flare`,
                body: `GOES X-ray flux reached ${cls}-class level (${flux.toExponential(1)} W/m²).`,
                severity: cls === 'X' ? 'critical' : cls === 'M' ? 'warning' : 'info',
                metadata: { flux, class: cls },
            };
        },
    },
    {
        key: 'notify_aurora',
        type: 'aurora',
        tier: 'basic',
        evaluate(state, prefs) {
            const kp = state.kp ?? 0;
            const threshold = prefs.aurora_kp_threshold ?? 5;
            if (kp < threshold) return null;
            // Location-aware: check if aurora is visible at user's location
            const loc = auth.getUser()?.location;
            if (loc) {
                const magLat = Math.abs(loc.lat) + 3;  // rough geomagnetic offset
                const boundary = 72 - kp * (17 / 9);
                if (magLat < boundary) return null;  // aurora oval doesn't reach user
            }
            const city = loc?.city ?? 'your location';
            return {
                fire: true,
                title: 'Aurora Alert',
                body: `Kp ${kp.toFixed(1)} — aurora may be visible from ${city}. Look north for green/purple curtains.`,
                severity: kp >= 7 ? 'critical' : 'warning',
                metadata: { kp, location: city },
            };
        },
    },
    {
        key: 'notify_cme',
        type: 'storm',
        tier: 'basic',
        evaluate(state) {
            const cme = state.earth_directed_cme;
            if (!cme) return null;
            const eta = state.cme_eta_hours;
            const etaStr = eta != null
                ? (eta > 24 ? `${(eta / 24).toFixed(1)} days` : `${Math.round(eta)} hours`)
                : 'unknown';
            return {
                fire: true,
                title: 'Earth-Directed CME',
                body: `A coronal mass ejection is heading toward Earth. Speed: ${cme.speed ?? '?'} km/s. ETA: ${etaStr}.`,
                severity: (cme.speed ?? 400) > 1000 ? 'critical' : 'warning',
                metadata: { speed: cme.speed, eta_hours: eta },
            };
        },
    },
    {
        key: 'notify_radio_blackout',
        type: 'flare',
        tier: 'advanced',
        evaluate(state) {
            const flux = state.xray_flux ?? 0;
            const r = fluxToRScale(flux);
            if (r < 2) return null;  // R2+ only
            return {
                fire: true,
                title: `R${r} Radio Blackout`,
                body: `HF radio blackout in progress — X-ray flux at ${flareClassToLetter(flux)}-class. Sunlit hemisphere affected.`,
                severity: r >= 4 ? 'critical' : 'warning',
                metadata: { r_scale: r, flux },
            };
        },
    },
    {
        key: 'notify_gps',
        type: 'storm',
        tier: 'advanced',
        evaluate(state) {
            const kp = state.kp ?? 0;
            if (kp < 6) return null;
            const loc = auth.getUser()?.location;
            // GPS degradation is worse at equatorial and polar latitudes
            const lat = Math.abs(loc?.lat ?? 45);
            const isVulnerable = lat > 60 || lat < 25;
            if (kp < 7 && !isVulnerable) return null;
            return {
                fire: true,
                title: 'GPS Accuracy Degraded',
                body: `Kp ${kp.toFixed(1)} — ionospheric scintillation may degrade GPS/GNSS positioning accuracy${isVulnerable ? ' at your latitude' : ''}.`,
                severity: kp >= 8 ? 'critical' : 'warning',
                metadata: { kp, lat },
            };
        },
    },
    {
        key: 'notify_power_grid',
        type: 'storm',
        tier: 'advanced',
        evaluate(state) {
            const kp = state.kp ?? 0;
            const g = kpToGScale(kp);
            if (g < 4) return null;  // G4+ only
            const loc = auth.getUser()?.location;
            const lat = Math.abs(loc?.lat ?? 45);
            // Power grid GIC risk is primarily high-latitude
            if (lat < 40 && g < 5) return null;
            return {
                fire: true,
                title: `G${g} Power Grid Risk`,
                body: `Extreme geomagnetic storm (G${g}) — geomagnetically induced currents may affect power infrastructure${lat > 45 ? ' in your region' : ''}.`,
                severity: 'critical',
                metadata: { kp, g_scale: g, lat },
            };
        },
    },
];

// ─────────────────────────────────────────────────────────────────────────────
//  AlertEngine
// ─────────────────────────────────────────────────────────────────────────────

export class AlertEngine {
    constructor() {
        /** @type {Map<string, number>} alert type key → last fire timestamp (ms) */
        this._cooldowns = new Map();

        /** @type {Array<object>} recent alerts (in-memory for bell UI, newest first) */
        this.recent = [];

        /** Max recent alerts to keep in memory */
        this._maxRecent = 50;

        /** Supabase client (lazy) */
        this._sb = null;

        this._onSwpc = this._onSwpc.bind(this);
    }

    /** Start listening to swpc-update events. */
    start() {
        window.addEventListener('swpc-update', this._onSwpc);
        // Also load recent alerts from Supabase on start
        this._loadRecentFromDB();
        return this;
    }

    stop() {
        window.removeEventListener('swpc-update', this._onSwpc);
    }

    /** Get unread count. */
    getUnreadCount() {
        return this.recent.filter(a => !a.read).length;
    }

    /** Mark an alert as read by id. */
    markRead(alertId) {
        const alert = this.recent.find(a => a.id === alertId);
        if (alert) alert.read = true;
        // Persist to DB
        this._markReadInDB(alertId);
        this._dispatch();
    }

    /** Mark all as read. */
    markAllRead() {
        this.recent.forEach(a => { a.read = true; });
        this._markAllReadInDB();
        this._dispatch();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _onSwpc(ev) {
        if (!auth.isSignedIn() || !auth.canUseAlerts()) return;

        const state = ev.detail;
        const prefs = auth.getAlertPrefs();
        const cooldownMs = (prefs.alert_cooldown_min ?? 60) * 60_000;
        const isAdvanced = auth.canUseAdvancedAlerts();
        const now = Date.now();

        for (const def of ALERT_DEFS) {
            // Plan gate
            if (def.tier === 'advanced' && !isAdvanced) continue;

            // Preference check
            if (!prefs[def.key]) continue;

            // Cooldown check
            const lastFire = this._cooldowns.get(def.key) ?? 0;
            if (now - lastFire < cooldownMs) continue;

            // Evaluate
            let result;
            try {
                result = def.evaluate(state, prefs);
            } catch (e) {
                console.warn(`[AlertEngine] Error evaluating ${def.key}:`, e.message);
                continue;
            }

            if (!result?.fire) continue;

            // Fire!
            const alert = {
                id: `${def.key}_${now}`,
                alert_type: def.type,
                severity: result.severity ?? 'info',
                title: result.title,
                body: result.body,
                metadata: result.metadata ?? {},
                read: false,
                created_at: new Date().toISOString(),
                _key: def.key,
            };

            this._cooldowns.set(def.key, now);
            this.recent.unshift(alert);
            if (this.recent.length > this._maxRecent) this.recent.pop();

            // Persist to DB
            this._writeAlertToDB(alert);

            // Dispatch event for bell UI
            this._dispatch(alert);

            console.info(`[AlertEngine] Fired: ${alert.title}`);
        }
    }

    _dispatch(newAlert = null) {
        window.dispatchEvent(new CustomEvent('user-alert', {
            detail: {
                alert: newAlert,
                recent: this.recent,
                unread: this.getUnreadCount(),
            },
        }));
    }

    async _getSb() {
        if (this._sb) return this._sb;
        if (!isConfigured()) return null;
        try { this._sb = await getSupabase(); } catch (_) {}
        return this._sb;
    }

    async _writeAlertToDB(alert) {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            await sb.from('alert_history').insert({
                user_id: userId,
                alert_type: alert.alert_type,
                severity: alert.severity,
                title: alert.title,
                body: alert.body,
                metadata: alert.metadata,
                read: false,
            });
        } catch (e) {
            console.warn('[AlertEngine] DB write failed:', e.message);
        }
    }

    async _loadRecentFromDB() {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            const { data } = await sb
                .from('alert_history')
                .select('id, alert_type, severity, title, body, metadata, read, created_at')
                .eq('user_id', userId)
                .order('created_at', { ascending: false })
                .limit(this._maxRecent);
            if (data?.length) {
                this.recent = data;
                this._dispatch();
            }
        } catch (e) {
            console.warn('[AlertEngine] DB load failed:', e.message);
        }
    }

    async _markReadInDB(alertId) {
        const sb = await this._getSb();
        if (!sb) return;
        try {
            // alert_history.id is a UUID from DB; in-memory IDs are synthetic
            // Only update if it looks like a UUID
            if (alertId?.length === 36 && alertId.includes('-')) {
                await sb.from('alert_history').update({ read: true }).eq('id', alertId);
            }
        } catch (_) {}
    }

    async _markAllReadInDB() {
        const sb = await this._getSb();
        if (!sb) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;
        try {
            await sb.from('alert_history').update({ read: true }).eq('user_id', userId).eq('read', false);
        } catch (_) {}
    }
}
