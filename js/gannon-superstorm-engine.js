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

    let cursorS = 0;                       // seconds from window start

    function clampS(s) { return Math.max(0, Math.min(dur, s)); }

    function indexAt(s) {
        return Math.max(0, Math.min(nSamples - 1, Math.round(s / (stepMs / 1000))));
    }

    function phaseAt(s) {
        const h = s / 3600;
        if (h < PHASE_BOUNDARIES.rampEndH) return 'ramp';
        if (h < PHASE_BOUNDARIES.peakEndH) return 'peak';
        return 'recovery';
    }

    function timestampAt(s) {
        return new Date(t0Ms + s * 1000).toISOString();
    }

    function sample() {
        const idx = indexAt(cursorS);
        const drv = replay.drivers_compact;
        const dens = replay.density_400km;
        return {
            t: timestampAt(cursorS),
            hoursFromStart: cursorS / 3600,
            idx,
            phase: phaseAt(cursorS),
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
        get cursorSeconds() { return cursorS; },
        get cursorHours() { return cursorS / 3600; },
        get durationHours() { return dur / 3600; },
        seekSeconds(s) { cursorS = clampS(s); return sample(); },
        seekHours(h)   { cursorS = clampS(h * 3600); return sample(); },
        seekFraction(f){ cursorS = clampS(f * dur); return sample(); },
        seekISO(iso) {
            const s = (Date.parse(iso) - t0Ms) / 1000;
            cursorS = clampS(s);
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
