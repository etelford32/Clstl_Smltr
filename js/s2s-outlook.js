/**
 * s2s-outlook.js — Subseasonal-to-seasonal (S2S) probabilistic outlook engine.
 * ═══════════════════════════════════════════════════════════════════════════
 * The honest answer to "what's the weather a month out?" Deterministic NWP
 * skill is gone by ~10 days (Lorenz). Past that, the only thing with skill is
 * the SHIFT in PROBABILITIES driven by the slowly-varying boundary state:
 * ENSO, the MJO, and the annular modes (AO/NAO, the surface face of the
 * stratospheric polar vortex). So this engine outputs TERCILE PROBABILITIES
 * (chance of below- / near- / above-normal), never a single number, and it
 * names which driver is responsible for each lean.
 *
 * This is a transparent statistical-composite ("poor-man's analog") model, not
 * a black box and not a dynamical model. For a location, season, and lead it
 * sums each active driver's documented regional composite signal into a tilt
 * away from the 33/33/33 climatological baseline, capped to a humble ceiling
 * (~49/31/20) because that is the realistic limit of subseasonal skill.
 *
 * Scientific basis for the coefficient signs/magnitudes (all well-established):
 *   • ENSO  — CPC El Niño / La Niña U.S. temperature & precipitation composites
 *             (e.g. warm/dry Pacific NW + wet/cool South in El Niño winters).
 *   • MJO   — RMM phase composites of downstream midlatitude temperature
 *             (e.g. phases 4–6 warm the eastern U.S., 8–2 favour cold; phases
 *             5–6 drive West-Coast atmospheric rivers). Strongest in winter,
 *             needs amplitude ≳ 1 to be coherent.
 *   • AO/NAO— Annular-mode surface regressions: positive → mild zonal
 *             midlatitudes; negative → blocking, cold-air outbreaks and
 *             storminess over the eastern U.S. and Europe.
 * Coefficients are deliberately modest and seasonally/lead-scaled. They encode
 * DIRECTION and RELATIVE strength, not a tuned fit — the honest framing is
 * "these are the climatological tendencies, here is the current driver state."
 *
 * Pure functions, no I/O, no DOM — the panel (month-outlook.js) fetches the
 * driver state and renders; the server may run the same engine. Unit-tested.
 *
 * Exports:
 *   computeOutlook({ lat, lon, date?, drivers }) → Outlook
 *   classifyRegion(lat, lon) → { id, name }
 *   seasonOf(date, lat) → 'winter'|'spring'|'summer'|'autumn'   (local season)
 *   S2S_METHOD, S2S_REFERENCE_SKILL  (disclosure strings for the UI)
 */

// ── Climate regions ─────────────────────────────────────────────────────────
// Coarse, documentation-grade regions. CONUS is split because the teleconnection
// composites differ sharply across it; elsewhere we fall back to broad zones
// with damped coefficients and lower confidence (we only claim the skill we can
// defend). Region ids drive the coefficient lookups below.

const REGIONS = {
    us_nw: 'Pacific Northwest / N. Rockies',
    us_sw: 'Southwest / California',
    us_sp: 'Southern Plains',
    us_se: 'Southeast / Gulf',
    us_ne: 'Northeast',
    us_mw: 'Midwest / Upper Midwest',
    eur:   'Europe',
    row:   'your region',
};

export function classifyRegion(lat, lon) {
    // CONUS box, then split by lon/lat.
    if (lat >= 24 && lat <= 50 && lon >= -125 && lon <= -66) {
        const north = lat >= 40;
        if (lon < -111) return mk(north ? 'us_nw' : 'us_sw');     // West
        if (lon < -95)  return mk(north ? 'us_mw' : 'us_sp');     // Central
        return mk(north ? 'us_ne' : 'us_se');                     // East
    }
    // Europe (AO/NAO regime is well documented here).
    if (lat >= 35 && lat <= 71 && lon >= -11 && lon <= 40) return mk('eur');
    return mk('row');
    function mk(id) { return { id, name: REGIONS[id] }; }
}

// ── Season (local) ──────────────────────────────────────────────────────────
// Teleconnection→surface links are strongly seasonal (winter strongest in the
// NH). Use meteorological seasons, flipped for the Southern Hemisphere so
// "winter" always means the local cold season.

export function seasonOf(date, lat = 45) {
    const m = date.getUTCMonth() + 1; // 1..12
    const nh = lat >= 0;
    const nhSeason = (m === 12 || m <= 2) ? 'winter'
                   : (m <= 5) ? 'spring'
                   : (m <= 8) ? 'summer'
                   : 'autumn';
    if (nh) return nhSeason;
    return { winter: 'summer', summer: 'winter', spring: 'autumn', autumn: 'spring' }[nhSeason];
}

// ── Coefficient tables ──────────────────────────────────────────────────────
// c^T: temperature tendency (+ = favours ABOVE-normal). c^P: precipitation
// (+ = favours ABOVE-normal / wetter). Unlisted regions default to 0.
// ENSO coefficients are written in the El Niño direction; La Niña falls out
// automatically because we multiply by the signed ONI.

const ENSO_T = { us_nw: 0.50, us_mw: 0.45, us_ne: 0.20, us_sw: -0.15, us_sp: -0.30, us_se: -0.40, eur: 0.10, row: 0.12 };
const ENSO_P = { us_nw: -0.50, us_mw: -0.20, us_ne: 0.15, us_sw: 0.55, us_sp: 0.60, us_se: 0.55, eur: 0.00, row: 0.00 };

const AO_T = { us_ne: 0.50, us_mw: 0.45, us_se: 0.20, us_nw: 0.10, us_sw: 0.00, us_sp: 0.15, eur: 0.40, row: 0.10 };
const AO_P = { us_ne: -0.25, us_mw: -0.15, us_se: -0.10, eur: -0.20 };

const NAO_T = { eur: 0.50, us_ne: 0.35, us_se: 0.15, us_mw: 0.20, us_nw: 0.05, us_sw: 0.05, us_sp: 0.05, row: 0.05 };
const NAO_P = { eur: 0.20, us_ne: -0.10 };

// MJO downstream midlatitude tendencies by RMM phase (1..8), winter NH.
// "east"/"west" refer to the two canonical U.S. responses; other regions get a
// damped "east-like" response. + temp = warm; + precip = wet.
const MJO_T_EAST = { 1: -0.25, 2: -0.45, 3: -0.10, 4: 0.25, 5: 0.50, 6: 0.35, 7: 0.00, 8: -0.30 };
const MJO_T_WEST = { 1: 0.10, 2: 0.00, 3: -0.10, 4: -0.20, 5: -0.10, 6: 0.10, 7: 0.25, 8: 0.20 };
const MJO_P_WEST = { 1: -0.20, 2: -0.30, 3: -0.10, 4: 0.10, 5: 0.40, 6: 0.45, 7: 0.20, 8: 0.00 };
const MJO_P_EAST = { 1: 0.10, 2: 0.20, 3: 0.30, 4: 0.20, 5: 0.00, 6: -0.10, 7: -0.20, 8: 0.00 };

const MJO_WEST_REGIONS = new Set(['us_nw', 'us_sw']);

// Seasonal scaling per driver family (winter = full strength).
const SEASON_SCALE = {
    enso: { winter: 1.0, autumn: 0.6, spring: 0.5, summer: 0.35 },
    mjo:  { winter: 1.0, autumn: 0.5, spring: 0.4, summer: 0.25 },
    ann:  { winter: 1.0, autumn: 0.5, spring: 0.4, summer: 0.20 }, // AO + NAO
};

// Lead (window) weighting. ENSO persists; MJO decays past ~4 weeks; annular
// anomalies decorrelate fastest unless SSW-forced.
const LEAD_WEIGHT = {
    wk34: { enso: 1.0, mjo: 1.0, ao: 0.60, nao: 0.60 },
    wk56: { enso: 1.0, mjo: 0.40, ao: 0.25, nao: 0.25 },
};

const WINDOWS = [
    { id: 'wk34', label: 'Weeks 3–4', leadDays: [15, 28] },
    { id: 'wk56', label: 'Weeks 5–6', leadDays: [29, 42] },
];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const coef  = (table, region) => table[region] ?? 0;

// ── Per-driver contribution ─────────────────────────────────────────────────
// Each returns { tC, pC }: the pre-lead-weight temperature and precipitation
// tendency contributions for this driver, already season-scaled. null/missing
// inputs contribute 0 so the engine degrades gracefully to climatology.

function ensoContrib(drivers, region, season) {
    const oni = drivers?.enso?.oni;
    if (!Number.isFinite(oni)) return { tC: 0, pC: 0, g: 0 };
    const g = clamp(oni / 1.2, -1.6, 1.6);          // signed ENSO strength
    const s = SEASON_SCALE.enso[season];
    return { tC: g * coef(ENSO_T, region) * s, pC: g * coef(ENSO_P, region) * s, g };
}

function mjoContrib(drivers, region, season) {
    const phase = drivers?.mjo?.phase;
    const amp   = drivers?.mjo?.amplitude;
    if (!Number.isInteger(phase) || phase < 1 || phase > 8 || !Number.isFinite(amp)) {
        return { tC: 0, pC: 0, amp: 0 };
    }
    // Amplitude < 0.5 → MJO is incoherent → ~no organised signal.
    const ampScale = clamp((amp - 0.5) / 1.0, 0, 1.4);
    const west = MJO_WEST_REGIONS.has(region);
    const tBase = west ? MJO_T_WEST[phase] : MJO_T_EAST[phase];
    const pBase = west ? MJO_P_WEST[phase] : MJO_P_EAST[phase];
    // Non-US regions get a damped east-like response (MJO teleconnections are
    // weaker/less documented outside North America).
    const regionDamp = (region === 'eur') ? 0.5 : (region === 'row') ? 0.3 : 1.0;
    const s = SEASON_SCALE.mjo[season] * ampScale * regionDamp;
    return { tC: tBase * s, pC: pBase * s, amp };
}

function annularContrib(drivers, region, season, which) {
    const value = drivers?.[which]?.value;
    if (!Number.isFinite(value)) return { tC: 0, pC: 0, g: 0 };
    const g = clamp(value / 2, -1.4, 1.4);
    const s = SEASON_SCALE.ann[season];
    const tT = which === 'ao' ? AO_T : NAO_T;
    const pT = which === 'ao' ? AO_P : NAO_P;
    return { tC: g * coef(tT, region) * s, pC: g * coef(pT, region) * s, g };
}

// ── Tercile mapping ─────────────────────────────────────────────────────────
// Softmax over logits [−βs, 0, +βs] keeps "near-normal" central, sums to 1,
// and returns 33/33/33 at s=0. β tuned so a strong aligned signal (|s|→1)
// peaks near 49/31/20 — the realistic subseasonal ceiling.

const BETA = 0.45;

function toTerciles(s) {
    const sEff = Math.tanh(s);                 // squash; caps the skew
    const eB = Math.exp(-BETA * sEff);
    const eN = 1;
    const eA = Math.exp(BETA * sEff);
    const z = eB + eN + eA;
    return { below: eB / z, near: eN / z, above: eA / z, sEff };
}

// Integer percents that sum to exactly 100 (largest-remainder method) so a
// rendered bar never reads "99%" or "101%".
export function toPercents(t) {
    const rows = [['below', t.below * 100], ['near', t.near * 100], ['above', t.above * 100]];
    const floored = rows.map(([k, v]) => ({ k, f: Math.floor(v), r: v - Math.floor(v) }));
    let rem = 100 - floored.reduce((s, o) => s + o.f, 0);
    floored.sort((a, b) => b.r - a.r);
    for (let i = 0; i < floored.length && rem > 0; i++, rem--) floored[i].f++;
    const out = {};
    for (const o of floored) out[o.k] = o.f;
    return out;
}

function leanOfPct(p) {
    if (p.above >= p.below && p.above >= p.near) return { dir: 'above', prob: p.above };
    if (p.below >= p.above && p.below >= p.near) return { dir: 'below', prob: p.below };
    return { dir: 'near', prob: p.near };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * @param {{ lat:number, lon:number, date?:Date, drivers:object }} args
 * @returns {Outlook}
 */
export function computeOutlook({ lat, lon, date = new Date(), drivers = {} }) {
    const region = classifyRegion(lat, lon);
    const season = seasonOf(date, lat);

    // Driver contributions (pre-lead-weight, season-scaled).
    const parts = {
        enso: ensoContrib(drivers, region.id, season),
        mjo:  mjoContrib(drivers, region.id, season),
        ao:   annularContrib(drivers, region.id, season, 'ao'),
        nao:  annularContrib(drivers, region.id, season, 'nao'),
    };

    // Confidence damping for regions/seasons where documented skill is weaker.
    const regionConfidenceScale = region.id === 'row' ? 0.45 : region.id === 'eur' ? 0.8 : 1.0;

    const windows = WINDOWS.map(w => {
        const lw = LEAD_WEIGHT[w.id];
        let sT = 0, sP = 0, strength = 0;
        for (const key of ['enso', 'mjo', 'ao', 'nao']) {
            const weight = lw[key];
            sT += parts[key].tC * weight;
            sP += parts[key].pC * weight;
            strength += (Math.abs(parts[key].tC) + Math.abs(parts[key].pC)) * weight;
        }
        const temp    = toTerciles(sT);
        const precip  = toTerciles(sP);
        const tempPct = toPercents(temp), precipPct = toPercents(precip);
        const tLean = leanOfPct(tempPct), pLean = leanOfPct(precipPct);

        // Confidence reflects total driver strength (cancelling drivers → low
        // confidence even if individually active), damped by region/season and
        // by lead (weeks 5–6 inherently less certain than 3–4).
        const leadDamp = w.id === 'wk56' ? 0.75 : 1.0;
        const cScore = clamp(strength * regionConfidenceScale * leadDamp / 0.9, 0, 1);
        const confidence = cScore < 0.28 ? 'low' : cScore < 0.6 ? 'moderate' : 'elevated';

        return {
            id: w.id, label: w.label, leadDays: w.leadDays,
            temp:   { below: temp.below, near: temp.near, above: temp.above },
            precip: { below: precip.below, near: precip.near, above: precip.above },
            tempPct, precipPct,
            tempLean: tLean.dir, tempProb: tLean.prob,
            precipLean: pLean.dir, precipProb: pLean.prob,
            confidence, confidenceScore: +cScore.toFixed(2),
            // Signed expected 2-m temperature anomaly (°C), for future
            // verification logging. Tercile half-width ≈ 1.2 °C climatologically.
            expectedTempAnomalyC: +(temp.sEff * 1.2).toFixed(1),
        };
    });

    // Attribution at the near-term (wk34) weighting — the drivers a user most
    // wants named. Only drivers that are actually active (nonzero) appear.
    const lw = LEAD_WEIGHT.wk34;
    const attribution = [
        ensoAttribution(drivers, parts.enso, lw.enso),
        mjoAttribution(drivers, parts.mjo, lw.mjo),
        annAttribution('ao', 'AO', drivers, parts.ao, lw.ao),
        annAttribution('nao', 'NAO', drivers, parts.nao, lw.nao),
    ].filter(d => d && (Math.abs(d.tempContrib) > 0.02 || Math.abs(d.precipContrib) > 0.02));
    attribution.sort((a, b) =>
        (Math.abs(b.tempContrib) + Math.abs(b.precipContrib)) -
        (Math.abs(a.tempContrib) + Math.abs(a.precipContrib)));

    return {
        asOf: date.toISOString(),
        lat, lon, region, season,
        windows,
        drivers: attribution,
        driversAvailable: attribution.length > 0,
        baseline: { below: 1 / 3, near: 1 / 3, above: 1 / 3 },
        method: S2S_METHOD,
    };
}

// ── Attribution helpers (human-readable) ────────────────────────────────────

function dirWord(c, warmCold = true) {
    if (Math.abs(c) < 0.02) return 'little effect';
    if (warmCold) return c > 0 ? 'warmer' : 'cooler';
    return c > 0 ? 'wetter' : 'drier';
}

function ensoAttribution(drivers, part, w) {
    const oni = drivers?.enso?.oni;
    if (!Number.isFinite(oni)) return null;
    const state = oni >= 0.5 ? `El Niño (+${oni.toFixed(1)})`
                : oni <= -0.5 ? `La Niña (${oni.toFixed(1)})`
                : `ENSO-neutral (${oni.toFixed(1)})`;
    return {
        id: 'enso', name: 'ENSO', state,
        tempContrib: +(part.tC * w).toFixed(3),
        precipContrib: +(part.pC * w).toFixed(3),
        note: `Leans ${dirWord(part.tC)} & ${dirWord(part.pC, false)} here.`,
    };
}

function mjoAttribution(drivers, part, w) {
    const phase = drivers?.mjo?.phase, amp = drivers?.mjo?.amplitude;
    if (!Number.isInteger(phase) || !Number.isFinite(amp)) return null;
    const active = amp >= 1;
    const state = `Phase ${phase}, amp ${amp.toFixed(1)}${active ? '' : ' (weak)'}`;
    return {
        id: 'mjo', name: 'MJO', state,
        tempContrib: +(part.tC * w).toFixed(3),
        precipContrib: +(part.pC * w).toFixed(3),
        note: active
            ? `Phase ${phase} leans ${dirWord(part.tC)} & ${dirWord(part.pC, false)}.`
            : 'Amplitude below ~1 — incoherent, little downstream effect.',
    };
}

function annAttribution(id, name, drivers, part, w) {
    const value = drivers?.[id]?.value;
    if (!Number.isFinite(value)) return null;
    const sign = value >= 0.5 ? 'positive' : value <= -0.5 ? 'negative' : 'neutral';
    return {
        id, name, state: `${sign} (${value >= 0 ? '+' : ''}${value.toFixed(1)}σ)`,
        tempContrib: +(part.tC * w).toFixed(3),
        precipContrib: +(part.pC * w).toFixed(3),
        note: value <= -0.5
            ? `${name}-negative favours blocking — leans ${dirWord(part.tC)} here.`
            : `Leans ${dirWord(part.tC)} here.`,
    };
}

// ── Disclosure strings (shown in the UI methodology panel) ───────────────────

export const S2S_METHOD =
    'Transparent teleconnection-composite model. Beyond ~10 days, individual '
  + 'weather events are not predictable; this shows how ENSO, the MJO, and the '
  + 'AO/NAO shift the ODDS of a below-, near-, or above-normal fortnight away '
  + 'from the 33/33/33 climatological baseline, capped at a realistic skill '
  + 'ceiling. Each driver’s contribution is shown so the lean is explainable.';

export const S2S_REFERENCE_SKILL =
    'Reference: week 3–4 tercile outlooks conditioned on ENSO/MJO typically '
  + 'beat the 33% climatology baseline (hit rates ~45–58% during active '
  + 'phases). Live verification at your location accrues as outlooks are scored '
  + 'against what actually happens.';
