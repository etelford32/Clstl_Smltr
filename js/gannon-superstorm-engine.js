/**
 * gannon-superstorm-engine.js — May 2024 Gannon G5 replay engine
 * ═══════════════════════════════════════════════════════════════════════
 * Replay player + driver-selection math for the Gannon superstorm
 * hindcast page. Loads the static bundle at
 *   /data/hindcast/gannon_may_2024_replay.json
 * and exposes a small API the UI modules consume:
 *
 *   const replay = await loadReplay();
 *   const player = createPlayer(replay);
 *   player.seekHours(36);
 *   const sample = player.sample();
 *   //   { t, idx, drivers:{ap_real, ap_mhd, ap_gnd, ...},
 *   //     density400:{msis_apreal, msis_apmhd, msis_apgnd},
 *   //     phase: "ramp"|"peak"|"recovery" }
 *
 * No NRLMSISE re-derivation lives here — `density()` calls delegate to
 * `upper-atmosphere-engine.js` so the storm-time composition shifts
 * stay physically consistent with the existing upper-atmosphere page.
 *
 * Phase 1 (post-MVP) hooks already named:
 *   - `driveCounterfactual(player, { ap_source })` — for the
 *     fleet-analyzer A/B view.
 *   - `loadReplay({ url })` — swap in a different event's bundle.
 *
 * Schema versioning is read off `schema_version`; this module supports
 * v1 only. A v2 bump must be additive (extra arrays, never reshapes).
 */

import { density, exosphereTempK, kpToAp } from './upper-atmosphere-engine.js';

const DEFAULT_URL = '/data/hindcast/gannon_may_2024_replay.json';
const F107_DURING_GANNON = 165;   // background SFU, May 2024
const SUPPORTED_SCHEMA = 1;

// Storm-phase boundaries in hours-from-window-start. Anchored to the
// drivers in the bundle, not to wall-clock dates, so a re-shifted
// window still works.
const PHASE_BOUNDARIES = {
    rampEndH: 8,        // 12:00Z May 10 + 8h ≈ shock + first hour of peak
    peakEndH: 30,       // ~18:00Z May 11
    // anything past peakEndH is "recovery"
};

/**
 * Fetch the replay bundle. Throws on schema mismatch — fail loud, the
 * page is uninteresting without a real bundle.
 */
export async function loadReplay({ url = DEFAULT_URL } = {}) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`gannon: replay fetch failed (${res.status})`);
    const bundle = await res.json();
    if (bundle.schema_version !== SUPPORTED_SCHEMA) {
        throw new Error(
            `gannon: replay schema_version=${bundle.schema_version}, this engine expects ${SUPPORTED_SCHEMA}`
        );
    }
    return bundle;
}

/**
 * Create a player over a loaded bundle. Players hold cursor state and
 * sample the driver arrays at the current time. Cheap to construct;
 * one per page is fine, multiple players can coexist for A/B views.
 */
export function createPlayer(replay) {
    const w = replay.window;
    const t0Ms = Date.parse(w.start);
    const t1Ms = Date.parse(w.end);
    const stepMs = (w.step_minutes || 60) * 60 * 1000;
    const nSamples = Math.round((t1Ms - t0Ms) / stepMs) + 1;
    const dur = (t1Ms - t0Ms) / 1000;     // seconds

    // Anchor: h=0 in the public-facing API corresponds to this UT moment
    // (May 10 12:00 UT for Gannon — original ground-truth window start).
    // Defaults to window.start for back-compat with pre-extension bundles
    // that didn't carry the anchor explicitly.
    const anchorMs = Date.parse(w.anchor_iso || w.start);
    const anchorOffsetS = (anchorMs - t0Ms) / 1000;   // ≥ 0; positive iff window starts before anchor

    // Anchor-relative hours range. `hoursMin` is negative for any window
    // whose start precedes the anchor (e.g. the Sun-Earth-chain preroll).
    const hoursMin = -anchorOffsetS / 3600;
    const hoursMax = (dur - anchorOffsetS) / 3600;

    let cursorH = 0;                       // hours from anchor (public API)

    function clampH(h) { return Math.max(hoursMin, Math.min(hoursMax, h)); }

    function indexAt_h(h) {
        // h is anchor-relative; convert to seconds-from-window-start for array indexing.
        const sFromStart = (h - hoursMin) * 3600;
        return Math.max(0, Math.min(nSamples - 1, Math.round(sFromStart / (stepMs / 1000))));
    }

    function phaseAt(h) {
        // Negative h is preroll — CMEs are in transit, Earth is quiet.
        if (h < 0) return 'preroll';
        if (h < PHASE_BOUNDARIES.rampEndH) return 'ramp';
        if (h < PHASE_BOUNDARIES.peakEndH) return 'peak';
        return 'recovery';
    }

    function timestampAt(h) {
        return new Date(anchorMs + h * 3600_000).toISOString();
    }

    function sample() {
        const idx = indexAt_h(cursorH);
        const drv = replay.drivers_compact;
        const dens = replay.density_400km;
        return {
            t: timestampAt(cursorH),
            hoursFromAnchor: cursorH,
            // Back-compat alias — the previous engine called it
            // "hoursFromStart" because there was no preroll. Same value
            // when no preroll; offset by hoursMin when there is.
            hoursFromStart:  cursorH - hoursMin,
            idx,
            phase: phaseAt(cursorH),
            drivers: {
                ap_real:    drv.ap_real[idx],
                ap_mhd:     drv.ap_mhd[idx],
                ap_gnd:     drv.ap_gnd[idx],
                phi_pc_kv:  drv.phi_pc_kv[idx],
                hpi_gw:     drv.hpi_gw[idx],
                sme_nt:     drv.sme_nt[idx],
                bz_nt:      drv.bz_nt[idx],
                v_kms:      drv.v_kms[idx],
            },
            density400: {
                msis_apreal: dens.msis_apreal[idx],
                msis_apmhd:  dens.msis_apmhd[idx],
                msis_apgnd:  dens.msis_apgnd[idx],
            },
        };
    }

    return {
        get replay() { return replay; },
        get nSamples() { return nSamples; },
        get cursorHours() { return cursorH; },      // anchor-relative
        get durationHours() { return hoursMax - hoursMin; },
        get hoursMin() { return hoursMin; },
        get hoursMax() { return hoursMax; },
        get anchorISO() { return new Date(anchorMs).toISOString(); },
        seekHours(h)   { cursorH = clampH(h); return sample(); },
        seekFraction(f){ cursorH = clampH(hoursMin + f * (hoursMax - hoursMin)); return sample(); },
        seekISO(iso) {
            const h = (Date.parse(iso) - anchorMs) / 3600_000;
            cursorH = clampH(h);
            return sample();
        },
        sample,
        timestampAt,
        phaseAt,
    };
}

/**
 * Density profile at a given altitude under one of the three Ap
 * tracks. Re-uses `upper-atmosphere-engine.density()`, so the
 * storm-time composition shift comes for free.
 *
 * `track` ∈ {"real", "mhd", "gnd"}.
 */
export function densityAt({ player, altitudeKm, track = 'mhd', f107Sfu = F107_DURING_GANNON }) {
    const s = player.sample();
    const apKey = ({ real: 'ap_real', mhd: 'ap_mhd', gnd: 'ap_gnd' })[track];
    if (!apKey) throw new Error(`gannon: unknown track "${track}"`);
    const ap = s.drivers[apKey];
    return density({ altitudeKm, f107Sfu, ap });
}

/**
 * Skill numbers, if the bundle has been validated. Returns nulls
 * while the placeholder bundle is in place; the page renders a
 * "validation pending" pill in that case.
 */
export function skillSummary(replay) {
    return {
        ...replay.skill,
        isPlaceholder: !!replay._is_placeholder,
    };
}

/**
 * Phase-1 hook: A/B counterfactual driver. Replays the whole window
 * under a single fixed-track driver and yields per-sample density.
 * Cheap (just an array map) — fine to call on every UI redraw.
 */
export function driveCounterfactual(player, { track = 'mhd' } = {}) {
    const r = player.replay;
    const apKey = ({ real: 'ap_real', mhd: 'ap_mhd', gnd: 'ap_gnd' })[track];
    if (!apKey) throw new Error(`gannon: unknown track "${track}"`);
    const ap = r.drivers_compact[apKey];
    return ap.map((apVal, i) => ({
        t: new Date(Date.parse(r.window.start) + i * (r.window.step_minutes || 60) * 60_000).toISOString(),
        ap: apVal,
        rho400: density({ altitudeKm: 400, f107Sfu: F107_DURING_GANNON, ap: apVal }),
    }));
}

// Convenience re-exports so the UI module only imports from here.
export { density, exosphereTempK, kpToAp };
export const GANNON_F107_SFU = F107_DURING_GANNON;
