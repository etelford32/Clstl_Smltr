/**
 * ring-current-inspector.js — Phase 1 of the particle-behavior analytics
 * (RING_CURRENT_ANALYTICS_PLAN.md): click a particle, the sim predicts its
 * future from its OWN physics, then scores that prediction when the clock
 * gets there.
 *
 * Pure and DOM/THREE-free: every number comes from the particle's stored
 * attributes (built by ring-current-particles.js) or a closed-form model
 * function — the same physics the GPU integrates, so a prediction here is
 * a statement about what WILL render. tests/ring-current-inspector.mjs
 * runs this exact module under node.
 *
 * ── What is genuinely predictive here? ──────────────────────────────────────
 * Position is deterministic given survival (particlePose is the reference
 * the shader transcribes), so the position line mostly demonstrates that
 * the sim keeps its word through pause/scrub/τ changes. The REAL forecast
 * content is survival and fate: this particle's drawn lifetime is one draw
 * from the charge-exchange physics, while P(survive Δt) = exp(−Δt/τ_CE) is
 * the honest ensemble statement — both are shown, labeled as such.
 *
 * MLT convention (GSM scene): θ=0 is sunward (+X, noon 12 MLT), θ=π is
 * midnight (0 MLT), θ=−π/2 dusk (18 MLT) — westward drift (ions, θ
 * increasing) sweeps midnight → dusk → noon, matching the partial-ring
 * asymmetry the model paints at ~18–19 MLT.
 */

import {
    driftPeriodHours, chargeExchangeLifetimeHours, lossConeAngle,
} from './ring-current-model.js';
import { particlePose, DEATH_WINDOW } from './ring-current-particles.js';

export const SPECIES_LABEL = Object.freeze({
    ionsH:     { name: 'H⁺ ion',   color: '#ffa040', drift: 'westward' },
    ionsO:     { name: 'O⁺ ion',   color: '#94ff57', drift: 'westward' },
    electrons: { name: 'electron', color: '#59baff', drift: 'eastward' },
});

/** Scene azimuth θ (rad) → magnetic local time (hours, 0 = midnight). */
export function mltFromTheta(theta) {
    return ((12 - theta * 12 / Math.PI) % 24 + 24) % 24;
}

const r2d = 180 / Math.PI;

/**
 * Full present-state inspection of particle i of population `key`.
 * @param {ReturnType<import('./ring-current-particles.js').buildPopulation>} pop
 * @param {'ionsH'|'ionsO'|'electrons'} key
 * @param {number} simHours   the globe's drift/lifecycle clock (SIM hours)
 * @param {number} bounceSec  the globe's bounce clock (wall seconds)
 */
export function inspectParticle(pop, key, i, simHours, bounceSec) {
    const j = i * 3, k = i * 4;
    const L    = pop.seed[j];
    const lamM = pop.seed[j + 2];
    const eKev = pop.eKev[i];
    const lt   = pop.life[k + 1];
    const q = particlePose(pop, i, simHours, bounceSec);

    // Timescales from the SAME stored kinematics the shader draws (kin[j]
    // is scene-θ rad/h, kin[j+1] is 2π/T_b rad/s) — cross-checked against
    // the closed forms in tests.
    const driftPeriodH = 2 * Math.PI / Math.abs(pop.kin[j]);
    const bouncePerS   = 2 * Math.PI / pop.kin[j + 1];

    const lossDeg = lossConeAngle(L) * r2d;
    const mode = pop.life[k + 2];                      // 0 ENA · ±1 precip
    const fate = mode === 0 ? 'ena' : mode > 0 ? 'precip-N' : 'precip-S';
    // Ensemble charge-exchange lifetime at ITS (E, L) — for ions this is
    // the physics its drawn lifetime was sampled from; electrons carry a
    // nominal scattering lifetime instead (no closed form; labeled).
    const species = key === 'electrons' ? 'electron' : key === 'ionsO' ? 'oxygen' : 'ion';
    const tauCEH = species === 'electron' ? null
        : chargeExchangeLifetimeHours(eKev, L, species);

    return {
        key, i, species, eKev, L,
        mirrorLatDeg: lamM * r2d,
        lossConeDeg:  lossDeg,
        driftPeriodH,
        driftDir: SPECIES_LABEL[key].drift,
        bouncePeriodS: bouncePerS,
        lifetimeH: lt,
        ageH: q.ph * lt,
        remainH: Math.max(0, (1 - DEATH_WINDOW - q.ph) * lt),   // to death onset
        ph: q.ph,
        cycle: q.cycle,
        dying: q.dying,
        fate,
        tauCEH,
        mlt: mltFromTheta(q.theta),
        pose: { x: q.x, y: q.y, z: q.z, theta: q.theta },
    };
}

/**
 * Predict this particle's state Δt SIM-hours ahead.
 * Deterministic given the sim's drawn lifetime; the exp(−Δt/τ_CE) survival
 * is the ensemble probability the lifetime was sampled from.
 */
export function predictParticle(pop, key, i, simHours, bounceSec, dtH) {
    const now = inspectParticle(pop, key, i, simHours, bounceSec);
    const targetSimHours = simHours + dtH;
    const survives = now.ph + dtH / now.lifetimeH < 1 - DEATH_WINDOW;
    const pSurvive = now.tauCEH != null ? Math.exp(-dtH / now.tauCEH) : null;
    let mlt = null, pose = null, laps = null;
    if (survives) {
        const q = particlePose(pop, i, targetSimHours, bounceSec);
        mlt = mltFromTheta(q.theta);
        pose = { x: q.x, y: q.y, z: q.z };
        laps = dtH / now.driftPeriodH;
    }
    return {
        key, i, dtH, targetSimHours,
        madeAtSimHours: simHours,
        baseCycle: now.cycle,
        survives, pSurvive, mlt, pose, laps,
        fate: now.fate,
    };
}

/**
 * Score a prediction once the sim clock has reached (or passed) its target.
 * Returns null while still pending.
 */
export function verifyPrediction(pred, pop, simHours, bounceSec) {
    if (simHours < pred.targetSimHours) return null;
    const q = particlePose(pop, pred.i, pred.targetSimHours, bounceSec);
    const aliveAtTarget = q.cycle === pred.baseCycle && q.ph < 1 - DEATH_WINDOW;
    if (pred.survives !== aliveAtTarget) {
        return { ok: false, aliveAtTarget, dMltH: null };
    }
    if (!pred.survives) return { ok: true, aliveAtTarget, dMltH: null };
    let d = Math.abs(mltFromTheta(q.theta) - pred.mlt) % 24;
    if (d > 12) d = 24 - d;
    return { ok: d < 0.25, aliveAtTarget, dMltH: d };
}

// ── Card rendering (pure string — the page injects it) ──────────────────────

const fmtH = (h) => !Number.isFinite(h) ? '—'
    : h >= 48 ? `${(h / 24).toFixed(1)} d`
    : h >= 1 ? `${h.toFixed(1)} h`
    : `${Math.round(h * 60)} min`;
const fmtMlt = (m) => `${Math.floor(m)}:${String(Math.round((m % 1) * 60)).padStart(2, '0')} MLT`;
const row = (k, v) => `<div class="rc-insp-kv"><span>${k}</span><b>${v}</b></div>`;

const FATE_TEXT = {
    'ena':      'charge exchange → escapes as ENA',
    'precip-N': 'precipitates — N atmosphere',
    'precip-S': 'precipitates — S atmosphere',
};

/**
 * @param {ReturnType<typeof inspectParticle>} d
 * @param {ReturnType<typeof predictParticle>|null} pred
 * @param {ReturnType<typeof verifyPrediction>|null} verdict
 */
export function renderInspectorHtml(d, pred, verdict) {
    const s = SPECIES_LABEL[d.key];
    const head =
        `<b style="color:${s.color}">${s.name}</b> · ${d.eKev.toFixed(0)} keV · L ${d.L.toFixed(2)}`;
    const state =
        row('now', `${fmtMlt(d.mlt)} · λm ${d.mirrorLatDeg.toFixed(0)}°`) +
        row('age', `${fmtH(d.ageH)} of ${fmtH(d.lifetimeH)} · dies in ${fmtH(d.remainH)}`);
    const physics =
        row('drift', `${fmtH(d.driftPeriodH)}/lap ${d.driftDir}`) +
        row('bounce', `${d.bouncePeriodS.toFixed(1)} s`) +
        row('fate', FATE_TEXT[d.fate]) +
        (d.tauCEH != null
            ? row('τ_CE (E,L)', `${fmtH(d.tauCEH)} · ensemble e<sup>−Δt/τ</sup>`)
            : row('lifetime', 'nominal wave scattering (e⁻)'));
    let predHtml = '';
    if (pred) {
        const p = pred.pSurvive != null ? ` · P<sub>CE</sub> ${Math.round(pred.pSurvive * 100)}%` : '';
        predHtml = `<div class="rc-insp-pred">@ +${fmtH(pred.dtH)} sim: ` +
            (pred.survives
                ? `<b>${fmtMlt(pred.mlt)}</b> after ${pred.laps.toFixed(2)} laps${p}`
                : `<b>dead — ${FATE_TEXT[pred.fate]}</b>${p}`) +
            (verdict == null
                ? ' <span class="rc-insp-wait">…awaiting sim</span>'
                : verdict.ok
                    ? ` <span class="rc-insp-ok">✓ verified${verdict.dMltH != null ? ` ΔMLT ${(verdict.dMltH * 60).toFixed(0)} min` : ''}</span>`
                    : ' <span class="rc-insp-bad">✗ missed</span>') +
            '</div>';
    }
    const rebirth = d.dying > 0
        ? `<div class="rc-insp-pred"><b style="color:#ffd9b0">${d.fate === 'ena' ? 'neutralising — escaping as ENA' : 'precipitating now'}</b></div>`
        : '';
    return head + state + physics + rebirth + predHtml;
}
