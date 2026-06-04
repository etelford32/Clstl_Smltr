/**
 * sw-model.js — Space-weather TIME model for the Operations console.
 *
 * This is the coupling that turns the console from a viewer into a
 * *forecast*. The time-bus owns simTimeMs; this module turns that instant
 * into the F10.7 / Ap that drive every drag-sensitive number on the page
 * (Decay Watch, Prop Budget, and the atmospheric drag shell). Because
 * decision-deck.js already recomputes on `idx.f107` / `idx.ap` provStore
 * changes, making those two keys move with the scrubber is the whole game:
 * scrub into a forecast storm and the indices rise → the drag shell
 * brightens → perigee drops → decay ETAs shorten, all from one clock.
 *
 * Three regimes, keyed off simTimeMs vs real-now:
 *
 *   live      (t ≈ now)  — the live anchor straight from swpc-bridge.
 *   observed  (t < now)  — persistence of the live anchor. We do NOT yet
 *                          carry a historical index series, so the past is
 *                          held flat at the last live value and labelled
 *                          honestly. Seam: a real F10.7 / Ap history (or
 *                          the GSA Dst reconstruction) slots in behind
 *                          evalSpaceWeatherAt() without touching callers.
 *   forecast  (t > now)  — F10.7 persistence (a slow driver) and a
 *                          climatology-relaxed Ap, with σ that WIDENS with
 *                          horizon. Geomagnetic forecast skill collapses
 *                          past ~3 d, so σ_Ap grows fast; σ_F10.7 grows
 *                          slowly. Selling certainty is the competitor's
 *                          move — the widening band is ours.
 *
 * A scenario overlay injects a named storm (Gannon-class G5, the Feb-2022
 * Starlink storm) into the FORWARD window as a what-if. We inject forward
 * rather than replay the historical date because the SGP4 fleet propagates
 * in real calendar time — a forward injection keeps the satellites, the
 * drag shell, and the decay maths on one clock. The storm is labelled as a
 * posited scenario, not a measurement. Historical replay (with period TLEs)
 * is a later upgrade.
 *
 * The single writer of `idx.f107`, `idx.ap`, and `drag.rho450` is
 * startSwDriver(); swpc-bridge feeds the live anchor via setLiveAnchor().
 */

import { timeBus }  from './time-bus.js';
import { provStore } from './provenance.js';
import { density }   from '../upper-atmosphere-engine.js';

const DAY_MS      = 86_400_000;
const HOUR_MS     = 3_600_000;
const F107_DEFAULT = 150;     // quiet-time solar flux fallback (SFU)
const AP_DEFAULT   = 12;      // quiet-time Ap fallback
const AP_CLIMO     = 12;      // Ap value the forecast relaxes toward
const SHELL_ALT_KM = 450;     // representative LEO altitude for the drag shell

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

/* ─── Live anchor (fed by swpc-bridge) ──────────────────────────── */

const _anchor = { f107: null, ap: null, fetchedAt: 0, source: null };
const _anchorSubs = new Set();

/**
 * Push the latest live F10.7 / Ap. Partial updates are honoured (F10.7
 * and Kp arrive on different cadences). Notifies anchor subscribers so
 * the driver republishes immediately rather than waiting for the next
 * time-bus tick.
 */
export function setLiveAnchor({ f107, ap, source } = {}) {
    let moved = false;
    if (Number.isFinite(f107) && f107 !== _anchor.f107) { _anchor.f107 = f107; moved = true; }
    if (Number.isFinite(ap)   && ap   !== _anchor.ap)   { _anchor.ap   = ap;   moved = true; }
    _anchor.fetchedAt = Date.now();
    if (source) _anchor.source = source;
    if (moved) for (const fn of _anchorSubs) { try { fn(getLiveAnchor()); } catch (_) {} }
}

export function getLiveAnchor() { return { ..._anchor }; }
export function onAnchor(fn) { _anchorSubs.add(fn); return () => _anchorSubs.delete(fn); }

/* ─── Storm scenarios ───────────────────────────────────────────── */

/**
 * Stylised storm profiles. Shapes are calibrated to the named event's
 * peak — a fast main-phase rise then a multi-day recovery — not to a
 * minute-by-minute reconstruction. The point is the *coupling* (drag →
 * decay), surfaced honestly as a scenario.
 */
export const STORM_PRESETS = Object.freeze({
    gannon: {
        id: 'gannon',
        label: 'Gannon G5 (May 2024)',
        blurb: 'G5 extreme — Ap peaked near 400. The canonical drag-spike proof point.',
        apPeak: 400, f107Peak: 215, riseH: 6, decayH: 60,
    },
    starlink: {
        id: 'starlink',
        label: 'Feb-2022 Starlink storm',
        blurb: 'Only G1–G2, but enough thermospheric drag to down 38 Starlinks at insertion.',
        apPeak: 60, f107Peak: 130, riseH: 8, decayH: 40,
    },
    ar3842: {
        id: 'ar3842',
        label: 'AR3842 (Oct 2024)',
        blurb: 'X9-class flares + a G4 storm — a solar-max F10.7 spike that lifted the drag floor for days.',
        apPeak: 180, f107Peak: 255, riseH: 7, decayH: 50,
    },
});

// Peak of the rise·decay envelope, memoised per preset so stormState()
// can normalise its envelope to 1 at the storm peak.
const _peakEnvCache = new Map();
function peakEnv(preset) {
    if (_peakEnvCache.has(preset.id)) return _peakEnvCache.get(preset.id);
    let max = 1e-6;
    for (let h = 0; h <= preset.decayH * 3; h += 0.5) {
        const e = (1 - Math.exp(-h / preset.riseH)) * Math.exp(-h / preset.decayH);
        if (e > max) max = e;
    }
    _peakEnvCache.set(preset.id, max);
    return max;
}

/** Storm index state at hoursSinceOnset, or null before onset. */
function stormState(preset, hoursSinceOnset) {
    const h = hoursSinceOnset;
    if (h < 0) return null;                      // pre-onset → quiet forecast governs
    const env = ((1 - Math.exp(-h / preset.riseH)) * Math.exp(-h / preset.decayH)) / peakEnv(preset);
    return {
        ap:   AP_CLIMO     + (preset.apPeak   - AP_CLIMO)     * env,
        f107: F107_DEFAULT + (preset.f107Peak - F107_DEFAULT) * env,
        env,
    };
}

let _scenario = null;   // { preset, onsetMs }
const _scenSubs = new Set();

/**
 * Activate (or clear, with a falsy id) a forward storm scenario. Default
 * onset is +2 d so the operator can scrub from a calm now into the storm.
 */
export function setScenario(presetId, opts = {}) {
    if (!presetId) { _scenario = null; _emitScenario(); return null; }
    const preset = STORM_PRESETS[presetId];
    if (!preset) return null;
    const onsetMs = Number.isFinite(opts.onsetMs) ? opts.onsetMs : Date.now() + 2 * DAY_MS;
    _scenario = { preset, onsetMs };
    _emitScenario();
    return getScenario();
}

export function getScenario() {
    if (!_scenario) return null;
    return { presetId: _scenario.preset.id, label: _scenario.preset.label, onsetMs: _scenario.onsetMs };
}

export function onScenario(fn) { _scenSubs.add(fn); return () => _scenSubs.delete(fn); }
function _emitScenario() {
    const s = getScenario();
    for (const fn of _scenSubs) { try { fn(s); } catch (_) {} }
}

/* ─── Evaluation ────────────────────────────────────────────────── */

/**
 * Resolve the space-weather state at simMs. Pure; safe to call from the
 * drag shell, the regime readout, or any future export. σ widens with
 * forecast horizon. A forward scenario, if active, takes the max over the
 * quiet forecast so its onset/recovery edges blend cleanly.
 */
export function evalSpaceWeatherAt(simMs, nowMs = Date.now()) {
    const horizonMs   = simMs - nowMs;
    const horizonDays = horizonMs / DAY_MS;
    const f107Anchor  = Number.isFinite(_anchor.f107) ? _anchor.f107 : F107_DEFAULT;
    const apAnchor    = Number.isFinite(_anchor.ap)   ? _anchor.ap   : AP_DEFAULT;
    const haveLive    = Number.isFinite(_anchor.f107) || Number.isFinite(_anchor.ap);

    let f107, ap, sigF107, sigAp, regime;

    if (horizonMs <= 0) {
        // observed / live — persistence of the anchor. σ grows mildly going
        // back because we're persisting, not measuring, the past.
        const backDays = clamp(-horizonDays, 0, 7);
        f107 = f107Anchor;
        ap   = apAnchor;
        sigF107 = 6 + 2 * backDays;
        sigAp   = 4 + 2 * backDays;
        regime  = Math.abs(horizonMs) < 6 * HOUR_MS ? 'live' : 'observed';
    } else {
        // forecast — F10.7 persists (slow driver); Ap relaxes to climatology
        // as skill decays. Bands widen with horizon, Ap fastest.
        const k = 1 - Math.exp(-horizonDays / 3);
        f107 = f107Anchor;
        ap   = apAnchor * (1 - k) + AP_CLIMO * k;
        sigF107 = clamp(8 + 4 * horizonDays, 8, 60);
        sigAp   = clamp(4 + 6 * horizonDays, 4, 55);
        regime  = 'forecast';
    }

    let scenario = null;
    if (_scenario) {
        const st = stormState(_scenario.preset, (simMs - _scenario.onsetMs) / HOUR_MS);
        if (st) {
            ap   = Math.max(ap, st.ap);
            f107 = Math.max(f107, st.f107);
            // A posited storm carries its own (model-shape) uncertainty.
            sigAp   = Math.max(sigAp, 0.25 * st.ap);
            sigF107 = Math.max(sigF107, 0.12 * st.f107);
            regime  = 'scenario';
            scenario = { id: _scenario.preset.id, label: _scenario.preset.label, env: st.env };
        }
    }

    return {
        f107, ap, sigF107, sigAp,
        regime, horizonDays, haveLive, scenario,
        source: _anchor.source || 'NOAA SWPC (pending live fetch)',
        simMs, nowMs,
    };
}

/* ─── Drag-state helper ─────────────────────────────────────────── */

/**
 * Thermospheric mass density at the shell altitude for a given index
 * state, with a ±σ band propagated from the F10.7 / Ap spreads. Shared by
 * the driver (provStore write) and exposed for the drag shell so its
 * colour matches the published number exactly.
 */
export function dragDensityAt(f107, ap, sigF107 = 0, sigAp = 0, altKm = SHELL_ALT_KM) {
    const rho = density({ altitudeKm: altKm, f107Sfu: f107, ap }).rho;
    // One-sided perturbations → symmetric σ on ρ. Storm density rises with
    // both drivers, so +σ on both is the heavy tail.
    const rhoHi = density({ altitudeKm: altKm, f107Sfu: f107 + sigF107, ap: ap + sigAp }).rho;
    const rhoLo = density({
        altitudeKm: altKm,
        f107Sfu: Math.max(60, f107 - sigF107),
        ap: Math.max(0, ap - sigAp),
    }).rho;
    const sigma = Math.max(0, (rhoHi - rhoLo) / 2);
    return { rho, sigma, altKm };
}

export const SHELL_ALTITUDE_KM = SHELL_ALT_KM;

// Quiet-time reference density at the shell altitude. The drag shell and
// the "drag ×N vs quiet" overhead both normalise against this, so the
// number on the panel and the colour on the globe never drift apart.
export const RHO_REF_450 = density({ altitudeKm: SHELL_ALT_KM, f107Sfu: 150, ap: 12 }).rho;

/* ─── Driver: time-bus → provStore ──────────────────────────────── */

const REPUBLISH_MIN_MS = 120;   // floor between provStore writes (DOM cost)
const F107_EPS = 0.4;
const AP_EPS   = 0.4;

function regimeCache(regime, haveLive) {
    if (!haveLive) return 'synthetic';
    if (regime === 'live')     return 'live';
    if (regime === 'observed') return 'observed';
    return 'forecast';          // forecast + scenario
}

function horizonLabel(days) {
    const a = Math.abs(days);
    if (a < 1) return `${Math.round(a * 24)} h`;
    return `${a.toFixed(1)} d`;
}

function caveatFor(sw) {
    if (sw.regime === 'scenario') {
        return `Scenario: ${sw.scenario.label} — a posited forward storm (what-if), not a measurement.`;
    }
    if (sw.regime === 'forecast') {
        return `Forecast +${horizonLabel(sw.horizonDays)} ahead. F10.7 held by persistence; Ap relaxes to ` +
               `climatology. Geomagnetic skill degrades past ~3 d — the band widens to say so.`;
    }
    if (sw.regime === 'observed') {
        return `Observed (persistence of the last live value ${horizonLabel(sw.horizonDays)} back; ` +
               `no historical index series wired yet).`;
    }
    return 'Live NOAA SWPC value at real time.';
}

function writeIndices(sw) {
    const validAt   = new Date(sw.simMs).toISOString();
    const forecast  = sw.horizonDays > 0;
    const cache     = regimeCache(sw.regime, sw.haveLive);
    const caveat    = caveatFor(sw);
    const srcF107   = sw.haveLive ? sw.source : 'NOAA SWPC F10.7 (pending live fetch)';
    const srcAp     = sw.haveLive ? sw.source : 'NOAA SWPC Kp→Ap (pending live fetch)';

    provStore.set('idx.f107', {
        value: round1(sw.f107), unit: 'SFU', sigma: round1(sw.sigF107),
        source: srcF107,
        model:  forecast ? 'sw-model v1 (persistence + scenario)' : 'NOAA F10.7 daily',
        cacheState: cache, validAt,
        description: `Solar 10.7 cm radio flux — the thermospheric heating driver. ${caveat}`,
    });
    provStore.set('idx.ap', {
        value: Math.round(sw.ap), unit: '', sigma: round1(sw.sigAp),
        source: srcAp,
        model:  forecast ? 'sw-model v1 (climatology relax + scenario)' : 'NOAA Kp → Ap',
        cacheState: cache, validAt,
        description: `Geomagnetic Ap — storm activity puffs the thermosphere and steps drag up 20–40%. ${caveat}`,
    });

    // Drag-shell density at the published index state. Same numbers the
    // shell colours itself with and the decay maths consume — one source.
    const d = dragDensityAt(sw.f107, sw.ap, sw.sigF107, sw.sigAp);
    provStore.set('drag.rho450', {
        value: d.rho, unit: 'kg/m³', sigma: d.sigma,
        source: 'derived (Parkers thermosphere surrogate)',
        model:  'Bates(1959) T(z) · diffusive-equilibrium ρ',
        formula: 'ρ(450 km; F10.7, Ap)',
        inputs: ['idx.f107', 'idx.ap'],
        cacheState: sw.haveLive ? 'derived' : 'synthetic',
        validAt,
        description:
            `Neutral mass density at ${SHELL_ALT_KM} km — the drag floor the fleet flies through. ` +
            `Drives the atmospheric drag shell on the globe. ${caveat}`,
    });

    // Drag overhead — ρ relative to quiet, the single legible "how much
    // more drag than a calm day" number. ×1 at quiet, ~×20 at a G5. Its
    // σ propagates from the ρ band. This is the headline coupling readout:
    // it spikes the instant a scrub crosses a storm onset.
    provStore.set('drag.overhead', {
        value: d.rho / RHO_REF_450, unit: '×', sigma: d.sigma / RHO_REF_450,
        source: 'derived (ρ ÷ quiet-day ρ)',
        model:  'Bates(1959) T(z) · diffusive-equilibrium ρ',
        formula: 'ρ(450 km) / ρ(450 km; F10.7=150, Ap=12)',
        inputs: ['drag.rho450'],
        cacheState: sw.haveLive ? 'derived' : 'synthetic',
        validAt,
        description:
            `Drag at ${SHELL_ALT_KM} km relative to a quiet day. ×1 is calm; a G5 storm ` +
            `pushes it past ×15. This is the multiplier on every satellite's atmospheric ` +
            `drag — and on how fast perigee decays. ${caveat}`,
    });
}

/**
 * Start driving provStore from the time-bus. Returns a stop function.
 * Gated so it only writes when the indices actually move (or the regime
 * flips), which keeps Decay Watch / Prop Budget recomputes off the 10 Hz
 * emit treadmill while still tracking a scrub smoothly.
 */
export function startSwDriver() {
    let last = { f107: NaN, ap: NaN, regime: null, at: 0 };

    function publish(force = false) {
        const { simTimeMs, nowMs } = timeBus.getState();
        const sw  = evalSpaceWeatherAt(simTimeMs, nowMs);
        const now = performance.now();
        const moved =
            Math.abs(sw.f107 - last.f107) >= F107_EPS ||
            Math.abs(sw.ap   - last.ap)   >= AP_EPS   ||
            sw.regime !== last.regime;
        if (!force && !moved) return;
        if (!force && (now - last.at) < REPUBLISH_MIN_MS) return;
        last = { f107: sw.f107, ap: sw.ap, regime: sw.regime, at: now };
        writeIndices(sw);
    }

    const offBus    = timeBus.subscribe(() => publish());
    const offAnchor = onAnchor(() => publish(true));
    const offScen   = onScenario(() => publish(true));
    publish(true);

    return () => { offBus(); offAnchor(); offScen(); };
}
