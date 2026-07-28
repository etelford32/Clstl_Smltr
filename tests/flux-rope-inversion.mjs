// flux-rope-inversion.mjs — round-trip gate for the per-event DBM drag
// retrieval (js/flux-rope-inversion.js) against the §5 closed form. Pure
// node:
//
//   node tests/flux-rope-inversion.mjs

import {
    dbmApexKm, dbmSpeedKms, invertGamma, invertGammaW, retrievedPopulation,
    AU_KM, RSUN_KM,
} from '../js/flux-rope-inversion.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

const D0 = 21.5 * RSUN_KM;
const R_OBS = 0.99 * AU_KM;

/** Forward transit time to R_OBS by bisection on the closed form. */
function transitS(v0, w, g) {
    let lo = 0, hi = 30 * 86400;
    for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (dbmApexKm(D0, v0, w, g, mid) < R_OBS) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

// ── Mode 1: Γ from transit time (w assumed) — round trips ────────────────────
{
    for (const [v0, w, g] of [
        [1100, 400, 0.2e-7],   // St-Patrick-class decelerating
        [1900, 450, 1.2e-7],   // fast + heavy drag
        [300, 420, 0.5e-7],    // slow CME accelerated by the wind
    ]) {
        const T = transitS(v0, w, g);
        const r = invertGamma({ v0Kms: v0, wKms: w, transitS: T });
        check(`invertGamma round-trip v0=${v0} Γ=${g.toExponential(1)}`,
            r.ok && Math.abs(r.gammaPerKm - g) / g < 1e-3,
            r.ok ? r.gammaPerKm.toExponential(3) : r.reason);
    }
    // Honesty: a transit FASTER than ballistic cannot be produced by drag
    // toward a slower wind — must refuse, never force.
    const tBallistic = transitS(1100, 400, 0);
    const r1 = invertGamma({ v0Kms: 1100, wKms: 400, transitS: tBallistic * 0.8 });
    check('invertGamma refuses super-ballistic transits',
        r1.ok === false && r1.reason === 'transit-faster-than-ballistic');
    const r2 = invertGamma({ v0Kms: 1100, wKms: 400, transitS: 20 * 86400 });
    check('invertGamma refuses slower-than-max-drag transits',
        r2.ok === false && r2.reason === 'transit-slower-than-max-drag');
}

// ── Mode 2: (Γ, w) from transit + arrival speed — round trips ────────────────
{
    for (const [v0, w, g] of [
        [1250, 380, 0.3e-7],
        [1600, 500, 0.8e-7],
        [900, 430, 0.15e-7],
        [320, 460, 0.6e-7],    // accelerated branch
    ]) {
        const T = transitS(v0, w, g);
        const vArr = dbmSpeedKms(v0, w, g, T);
        const r = invertGammaW({ v0Kms: v0, transitS: T, vArrKms: vArr });
        check(`invertGammaW round-trip v0=${v0} → (Γ, w)`,
            r.ok && Math.abs(r.gammaPerKm - g) / g < 5e-3 && Math.abs(r.wKms - w) < 3,
            r.ok ? `Γ ${r.gammaPerKm.toExponential(3)} w ${r.wKms.toFixed(1)}` : r.reason);
    }
    // Honesty: arrival speed outside the [wLo, wHi] ambient band.
    const r = invertGammaW({ v0Kms: 1200, transitS: 50 * 3600, vArrKms: 200 });
    check('invertGammaW refuses an arrival speed outside the ambient band',
        r.ok === false, r.reason);
    // Degenerate: no net drag signal.
    const rd = invertGammaW({ v0Kms: 800, transitS: 50 * 3600, vArrKms: 800 });
    check('invertGammaW reports the zero-net-drag degeneracy',
        rd.ok === false && rd.reason === 'zero-net-drag-degenerate');
}

// ── Population priors (the ledger → engine feedback loop) ────────────────────
{
    // A synthetic season around Γ* = 0.25e-7 with ×/÷ spread and w ≈ 420.
    const season = [0.15, 0.2, 0.25, 0.25, 0.3, 0.4, 0.5].map((g, i) => ({
        ok: true, gammaPerKm: g * 1e-7, wKms: 400 + 10 * (i - 3),
    }));
    const pop = retrievedPopulation(season);
    check('population: median Γ + log-space MAD spread',
        pop.ok && Math.abs(pop.gammaMedianPerKm - 0.25e-7) < 1e-10
        && pop.lnsigGamma > 0.2 && pop.lnsigGamma < 0.8,
        `Γmed ${pop.gammaMedianPerKm?.toExponential(2)} lnσ ${pop.lnsigGamma?.toFixed(2)}`);
    check('population: ambient wind stats (fixture median 400, MAD-σ ≈ 30)',
        Math.abs(pop.wMedianKms - 400) < 1 && Math.abs(pop.sigWKms - 29.7) < 1,
        `w ${pop.wMedianKms} ± ${pop.sigWKms?.toFixed(1)}`);
    check('population: refuses a thin season',
        retrievedPopulation(season.slice(0, 3)).ok === false);
    check('population: failed retrievals excluded',
        retrievedPopulation([...season, { ok: false }, { ok: false }]).n === 7);
}

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope inversion checks passed');
process.exit(failures ? 1 : 0);
