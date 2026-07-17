/**
 * Pins for js/ring-current-storm-phase.js. Run:
 *   node tests/ring-current-storm-phase.mjs
 */
import { detectStormPhase, formatStormPhase } from '../js/ring-current-storm-phase.js';
import { DPS_J_PER_NT } from '../js/ring-current-model.js';

let failures = 0;
const check = (name, ok, detail = '') => {
    console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures++;
};

const H = 3.6e6;
const T0 = Date.parse('2026-07-17T00:00:00Z');
/** Build a series from a fn(hours) → dst, 10-min cadence. */
const mk = (hours, fn) => {
    const out = [];
    for (let h = 0; h <= hours; h += 1 / 6) {
        const dst = fn(h);
        out.push({ t: T0 + h * H, dst, dstStar: dst - 15 });   // fixed MP term
    }
    return out;
};

console.log('ring-current-storm-phase');

// ── Quiet ────────────────────────────────────────────────────────────────────
{
    const s = mk(24, () => -8 + Math.sin(0) * 2);
    const r = detectStormPhase(s, T0 + 24 * H);
    check('flat −8 nT reads quiet', r?.phase === 'quiet', r?.phase);
    check('quiet has no ledger', r?.ledger === null);
    check('format quiet', formatStormPhase(r) === 'quiet');
}

// ── Initial phase (compression) ──────────────────────────────────────────────
{
    const s = mk(6, (h) => h < 5 ? -5 : +22);
    const r = detectStormPhase(s, T0 + 6 * H);
    check('+22 nT excursion reads initial', r?.phase === 'initial', r?.phase);
}

// ── Main phase ───────────────────────────────────────────────────────────────
{
    // Ramp −5 → −125 over hours 4..10 (−20 nT/h), evaluated mid-ramp.
    const s = mk(8, (h) => h < 4 ? -5 : -5 - 20 * (h - 4));
    const r = detectStormPhase(s, T0 + 8 * H);
    check('steep fall reads main', r?.phase === 'main', r?.phase);
    check('onset found near the −30 crossing',
        r?.onsetT != null && Math.abs((r.onsetT - T0) / H - 5.25) < 0.6,
        `onset at h=${((r?.onsetT ?? 0) - T0) / H}`);
    check('format main mentions onset + min',
        /MAIN · onset \d\d:\d\d · min -8\d nT/.test(formatStormPhase(r) ?? ''), formatStormPhase(r));
}

// ── Recovery + τ fit + ledger ────────────────────────────────────────────────
{
    const TAU = 10;
    const s = mk(30, (h) => {
        if (h < 4) return -5;
        if (h < 10) return -5 - 20 * (h - 4);              // main to −125
        return -110 * Math.exp(-(h - 10) / TAU) - 15;      // Dst* decays w/ τ=10
    });
    const r = detectStormPhase(s, T0 + 30 * H);
    check('post-minimum reads recovery', r?.phase === 'recovery', r?.phase);
    check('minimum located at ramp end',
        Math.abs((r.minT - T0) / H - 10) < 0.5, `min at h=${(r.minT - T0) / H}`);
    // dstStar = dst − 15 = −110·e^… − 30 … not a pure exponential of Dst*;
    // the fit sees ln(110·e^{-t/τ} + 30) — slower than τ. Accept a band.
    check('recovery τ fit is in a sane band', r.recoveryTauH > 8 && r.recoveryTauH < 30,
        `τ ${r.recoveryTauH?.toFixed(1)} h`);
    check('ledger present with peak > now', !!r.ledger && r.ledger.wPeakJ > r.ledger.wNowJ);
    // Peak W matches DPS at the Dst* minimum (−125−15 = −140 nT).
    check('peak W = |Dst*min|·DPS', Math.abs(r.ledger.wPeakJ - 140 * DPS_J_PER_NT) / r.ledger.wPeakJ < 0.01,
        `${(r.ledger.wPeakJ / 1e14).toFixed(2)}e14 J`);
    check('shed fraction sane (recovered for 20 h)',
        r.ledger.shedJ / r.ledger.wPeakJ > 0.4, `${Math.round(100 * r.ledger.shedJ / r.ledger.wPeakJ)}%`);
    check('format recovery mentions τ + shed',
        /RECOVERY .*τ .* shed \d+%/.test(formatStormPhase(r) ?? ''), formatStormPhase(r));
}

// ── Degenerate inputs ────────────────────────────────────────────────────────
{
    check('null on empty', detectStormPhase([], Date.now()) === null);
    check('null on short', detectStormPhase([{ t: 1, dst: -5 }], 2) === null);
    check('format null-safe', formatStormPhase(null) === null);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall pins hold');
process.exit(failures ? 1 : 0);
