/**
 * conjunction-alert.js — Satellite conjunction monitoring for alert system
 *
 * Periodically screens the user's tracked satellites (from Supabase
 * satellite_alerts table) for close approaches using the SGP4 propagator.
 * Fires alerts when a conjunction is predicted within the user's threshold.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *  1. Loads user's satellite subscriptions from Supabase
 *  2. Fetches TLEs for subscribed satellites via /api/celestrak/tle
 *  3. Runs screenConjunctions() every SCAN_INTERVAL (default 30 min)
 *  4. Compares results against each subscription's threshold_km
 *  5. Dispatches 'conjunction-alert' CustomEvent for the alert engine
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *  import { ConjunctionMonitor } from './js/conjunction-alert.js';
 *  const monitor = new ConjunctionMonitor().start();
 *  window.addEventListener('conjunction-alert', e => { ... });
 */

import { auth } from './auth.js';
import { getSupabase, isConfigured } from './supabase-config.js';

const SCAN_INTERVAL_MS = 30 * 60_000;   // 30 minutes
const SCREEN_HOURS     = 72;             // look-ahead window
const SCREEN_STEP_MIN  = 10;             // propagation time step

export class ConjunctionMonitor {
    constructor() {
        this._timer        = null;
        this._subscriptions = [];   // from satellite_alerts table
        this._tracker      = null;  // lazy-loaded SatelliteTracker
        this._lastResults  = [];    // latest screening results
        this._cooldowns    = new Map();  // norad_id → last alert timestamp
    }

    /** Start periodic conjunction screening. */
    start() {
        // Initial scan after short delay (let page load)
        setTimeout(() => this._scan(), 5000);
        this._timer = setInterval(() => this._scan(), SCAN_INTERVAL_MS);
        return this;
    }

    stop() {
        clearInterval(this._timer);
    }

    /** Get latest screening results. */
    getResults() {
        return this._lastResults;
    }

    // ── Private ──────────────────────────────────────────────────────────────

    async _scan() {
        if (!auth.isSignedIn() || !auth.canUseAdvancedAlerts()) return;

        // Load subscriptions from Supabase
        await this._loadSubscriptions();
        if (!this._subscriptions.length) return;

        // Lazy-load the satellite tracker
        if (!this._tracker) {
            try {
                const { SatelliteTracker } = await import('./satellite-tracker.js');
                // Create a headless tracker (no scene needed for pure propagation)
                this._tracker = new SatelliteTracker(null, 1.0);
                // Load a broad catalog for screening against
                await this._tracker.loadGroup('active');
            } catch (e) {
                console.warn('[ConjunctionMonitor] Failed to load satellite tracker:', e.message);
                return;
            }
        }

        // Screen each subscribed satellite
        const allResults = [];
        const now = Date.now();
        const cooldownMs = 2 * 60 * 60_000;  // 2-hour cooldown per satellite

        for (const sub of this._subscriptions) {
            if (!sub.active) continue;

            // Ensure the target satellite is loaded
            try {
                const existing = this._tracker.getSatellite(sub.norad_id);
                if (!existing) {
                    await this._tracker.loadNorad(sub.norad_id);
                }
            } catch (e) {
                console.debug(`[ConjunctionMonitor] Cannot load NORAD ${sub.norad_id}:`, e.message);
                continue;
            }

            // Run conjunction screening
            let conjunctions;
            try {
                conjunctions = await this._tracker.screenConjunctions(
                    sub.norad_id,
                    SCREEN_HOURS,
                    SCREEN_STEP_MIN,
                    sub.threshold_km ?? 25,
                );
            } catch (e) {
                console.debug(`[ConjunctionMonitor] Screening failed for ${sub.norad_id}:`, e.message);
                continue;
            }

            if (!conjunctions?.length) continue;

            // Filter to those within threshold
            const threats = conjunctions.filter(c => c.dist_km <= (sub.threshold_km ?? 25));

            for (const conj of threats) {
                const key = `${sub.norad_id}_${conj.norad_id}`;
                const lastAlert = this._cooldowns.get(key) ?? 0;
                if (now - lastAlert < cooldownMs) continue;

                allResults.push({
                    target_name:  sub.satellite_name ?? `NORAD ${sub.norad_id}`,
                    target_norad: sub.norad_id,
                    chaser_name:  conj.name ?? `NORAD ${conj.norad_id}`,
                    chaser_norad: conj.norad_id,
                    dist_km:      conj.dist_km,
                    hours_ahead:  conj.hours_ahead,
                    threshold_km: sub.threshold_km ?? 25,
                });

                this._cooldowns.set(key, now);
            }
        }

        this._lastResults = allResults;

        // Dispatch events for each conjunction found
        for (const result of allResults) {
            window.dispatchEvent(new CustomEvent('conjunction-alert', {
                detail: result,
            }));
        }

        if (allResults.length) {
            console.info(`[ConjunctionMonitor] Found ${allResults.length} conjunction(s)`);
        }
    }

    async _loadSubscriptions() {
        if (!isConfigured()) return;
        const userId = auth.getUser()?.id;
        if (!userId) return;

        try {
            const sb = await getSupabase();
            const { data } = await sb
                .from('satellite_alerts')
                .select('norad_id, satellite_name, threshold_km, active')
                .eq('user_id', userId)
                .eq('active', true);
            this._subscriptions = data ?? [];
        } catch (e) {
            console.warn('[ConjunctionMonitor] Failed to load subscriptions:', e.message);
        }
    }
}
