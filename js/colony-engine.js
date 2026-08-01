/**
 * colony-engine.js — the lunar colony RTS tick engine. PURE and seeded.
 * ═══════════════════════════════════════════════════════════════════════════
 * No DOM, no fetch, no ambient time, no Math.random (seeded mulberry32 in
 * state). Gated by tests/colony-engine.mjs: determinism under a fixed seed,
 * conservation laws (energy / water / oxygen / materials ledgers close every
 * tick), storm dose ratios, the worker loop, and the site survey table.
 * See LUNAR_COLONY_PLAN.md — this is Phase 0/1, the StarCraft-verbs MVP:
 * select workers, mine two resources, place buildings, survive the Sun.
 *
 * ── WHAT'S PHYSICS AND WHAT'S GAMEPLAY ───────────────────────────────────
 * Every rate constant below is tagged. `// SOURCE:` numbers come from the
 * literature and are order-of-magnitude honest. `// GAMEPLAY:` numbers are
 * tuned for fun (usually time-compressed) and say so. Never blur the two.
 * The environment (sun, GCR, SEP) enters ONLY through the `env` argument —
 * the page decides whether that's the live NOAA feed, a scripted drill, or
 * a hindcast replay. Moonquakes are engine-internal (seeded) because they
 * are the Moon's own clock, not the Sun's.
 *
 * ── UNITS OF MEASURE ─────────────────────────────────────────────────────
 * Distance m · time hours · mass kg · energy kWh · power kW · dose mSv.
 * One lunar day-night ("sol" here, loosely) = 708.7 h — the synodic month.
 * Site illumination shortens the dark fraction: rim-of-Shackleton class
 * sites are lit ~90% of the sol at grazing incidence. SOURCE: Mazarico et
 * al. 2011 illumination maps; grazing-angle derate is schematic.
 */

import { ARTEMIS_III_CANDIDATES } from './artemis-data.js';

// ── Clock ────────────────────────────────────────────────────────────────────
export const SOL_HOURS = 708.7;          // SOURCE: synodic month, 29.53 d
export const WIN_SOLS = 3;               // GAMEPLAY: survive 3 lunar days
export const WIN_CREW = 6;

// ── Dose model (mSv) ─────────────────────────────────────────────────────────
// SOURCE: LND/Chang'E-4 ≈ 1.37 mSv/day eq. surface dose; CRaTER; NASA
// STD-3001 600 mSv career standard. Acute 2 Sv as incapacitation onset.
export const DOSE = Object.freeze({
    gcrBaseMSvH: 0.010,     // SOURCE: quiet-sun floor ≈ 0.24 mSv/day
    gcrSpanMSvH: 0.020,     // × env.gcrFlux (0..1 solar-cycle modulation)
    sepPeakMSvH: 30,        // SOURCE-ish: extreme SPE skin-dose scale; × sepFlux²
    shieldFactor: { outside: 1, lander: 0.6, habitat: 0.4, shelter: 0.05 },
    warnMSv: 100,
    careerMSv: 600,         // SOURCE: NASA STD-3001 → unit "grounded"
    acuteLethalMSv: 2000,   // simplified acute threshold → unit lost
});

// ── Life support (per person) ────────────────────────────────────────────────
// SOURCE: NASA BVAD ~3.5 kg potable water/day, 0.84 kg O₂/day; ISS ECLSS
// recovers ~90% water / ~50% O₂ — constants below are NET losses the
// colony must mine to replace.
export const LIFE = Object.freeze({
    waterKgH: 2.0 / 24,
    oxygenKgH: 0.45 / 24,
    starveHpH: 8,           // GAMEPLAY: hp/h drain when a resource is dry
    coldHpH: 3,             // GAMEPLAY: hp/h drain when power is dead at night
});

// ── Electrolysis ─────────────────────────────────────────────────────────────
// SOURCE: 2H₂O → 2H₂ + O₂; O₂ is 8/9 of split mass. ~5 kWh/kg water at
// realistic efficiency.
export const ELECTROLYZER = Object.freeze({
    kgWaterPerH: 2, kWhPerKg: 5, o2Fraction: 8 / 9,
});

// ── Ilmenite smelting (hydrogen reduction) ───────────────────────────────────
// SOURCE: FeTiO₃ + H₂ → Fe + TiO₂ + H₂O, then the water is electrolyzed to
// recover the H₂ and bank the O₂. Per kg of ilmenite (M = 151.7 g/mol):
// Fe 55.8/151.7 = 0.368 kg metal, releasable O 16/151.7 = 0.105 kg, TiO₂
// 79.9/151.7 = 0.527 kg slag — which IS a usable construction aggregate.
// The three fractions sum to exactly 1: the node test closes this mass
// balance. Processing rate/power are GAMEPLAY-scaled.
export const SMELTER = Object.freeze({
    kgOrePerH: 6,
    metalFraction: 55.8 / 151.7,
    o2Fraction: 16 / 151.7,
    slagFraction: 79.9 / 151.7,
});

// ── Helium-3 ─────────────────────────────────────────────────────────────────
// SOURCE: solar-wind-implanted ³He in mature sunlit regolith, ~5–15 ppb —
// real extraction means baking thousands of tonnes. GAMEPLAY: an extractor
// unit parked on a deposit accrues grams/hour directly (the haul mass is
// negligible); the deposit's reserveG abstracts the mineable patch.
export const HE3 = Object.freeze({
    supplyCostG: 50,      // one resupply capsule, paid in ³He export value
    supplyEtaH: 24,
    supplyCrew: 2, supplyRovers: 1, supplyMetalKg: 150,
});

// ── Build catalog ────────────────────────────────────────────────────────────
// Costs/times GAMEPLAY-scaled (real ISRU construction is months); power and
// storage numbers are small-outpost order of magnitude. Two construction
// inputs: `materials` (bulk regolith/slag aggregate) and `metal` (refined
// Fe from the ilmenite chain — machines need it, berms don't).
export const BUILD_CATALOG = Object.freeze({
    solar: Object.freeze({
        name: 'Solar array', materials: 120, metal: 80, buildH: 2, hp: 100,
        genKW: 10, radius: 26,
        desc: '10 kW peak. Dies with the sun — pair with batteries.',
    }),
    battery: Object.freeze({
        name: 'Battery bank', materials: 90, metal: 60, buildH: 2, hp: 120,
        storeKWh: 50, radius: 18,
        desc: '50 kWh buffer for night and storm downtime.',
    }),
    habitat: Object.freeze({
        name: 'Habitat', materials: 500, metal: 200, buildH: 8, hp: 200,
        crew: 4, drawKW: 4, radius: 34,
        desc: '+4 crew capacity. 4 kW life-support draw. New crew lands 24 h after completion.',
    }),
    electrolyzer: Object.freeze({
        name: 'Electrolyzer', materials: 160, metal: 90, buildH: 3, hp: 120,
        drawKW: 10, radius: 22,
        desc: 'Splits mined water into oxygen (8/9 by mass). 10 kW while running.',
    }),
    smelter: Object.freeze({
        name: 'Smelter', materials: 220, metal: 120, buildH: 4, hp: 150,
        drawKW: 8, radius: 26,
        desc: 'Hydrogen-reduces ilmenite ore: 37% iron, 10% oxygen, 53% slag→materials. 8 kW while running.',
    }),
    shelter: Object.freeze({
        name: 'Storm shelter', materials: 600, metal: 0, buildH: 6, hp: 300,
        capacity: 8, drawKW: 1, radius: 30,
        desc: 'Regolith-buried, no metal needed. 20× dose reduction — the answer to an SEP event.',
    }),
});

// ── Units ────────────────────────────────────────────────────────────────────
export const UNIT_CATALOG = Object.freeze({
    astronaut: Object.freeze({
        name: 'Astronaut', speedMH: 4000, mineKgH: 10, carryKg: 20,
        he3GH: 0.8, buildRate: 1, hp: 100, takesDose: true, radius: 6,
    }),
    rover: Object.freeze({
        name: 'Rover', speedMH: 9000, mineKgH: 30, carryKg: 60,
        he3GH: 2, buildRate: 0.5, hp: 150, takesDose: false, radius: 9,
    }),
});

// Lander (the starting HQ) — not buildable.
export const LANDER = Object.freeze({
    name: 'Lander', hp: 400, crew: 4, genKW: 2 /* fuel cell trickle */,
    storeKWh: 40, drawKW: 2, radius: 30,
});

// ── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
}

// ═══════════════════════════════════════════════════════════════════════════
//  SITE SURVEY — the Phase 0 deliverable
// ═══════════════════════════════════════════════════════════════════════════
// Marquee sites hand-tuned from the literature; the rest of the Artemis III
// candidate list gets stable seeded stats in plausible south-pole bands.
// SOURCE: Mazarico 2011 (illumination), LCROSS/Colaprete 2010 (Cabeus ice),
// Watters 2019 (scarp proximity → quake exposure). Ratings are coarse on
// purpose — this is a strategy layer, not a landing-site product.
const MARQUEE = {
    'Peak Near Shackleton': { illum: 0.90, iceDistM: 1450, iceRich: 0.9, quakeRisk: 0.5 },
    'Shackleton–de Gerlache Ridge': { illum: 0.88, iceDistM: 1200, iceRich: 0.8, quakeRisk: 0.4 },
    'de Gerlache Rim 1': { illum: 0.85, iceDistM: 950, iceRich: 0.7, quakeRisk: 0.4 },
    'Malapert Massif': { illum: 0.86, iceDistM: 1700, iceRich: 0.5, quakeRisk: 0.3 },
    'Connecting Ridge': { illum: 0.89, iceDistM: 1300, iceRich: 0.8, quakeRisk: 0.5 },
};

export function siteProfiles() {
    return ARTEMIS_III_CANDIDATES.map(c => {
        const m = MARQUEE[c.name];
        const r = makeRng(hashStr(c.name));
        const illum = m ? m.illum : 0.62 + r() * 0.22;
        const iceDistM = m ? m.iceDistM : 800 + Math.round(r() * 1400);
        const iceRich = m ? m.iceRich : 0.35 + r() * 0.5;
        const quakeRisk = m ? m.quakeRisk : 0.2 + r() * 0.7;
        // Composite 0–100: power is king, ice second, quakes a tax.
        return {
            id: c.id, name: c.name, lat: c.lat, lon: c.lon, note: c.note,
            illum, iceDistM, iceRich, quakeRisk,
            score: Math.round((55 * illum + 30 * iceRich * (1 - iceDistM / 3000) + 15 * (1 - quakeRisk)) * 10) / 10,
        };
    }).sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════════════════
//  GAME CREATION
// ═══════════════════════════════════════════════════════════════════════════
export const MAP_W = 2600, MAP_H = 1700;   // metres

export function createGame(siteId, { seed = 1 } = {}) {
    const site = siteProfiles().find(s => s.id === siteId) || siteProfiles()[0];
    const rng = makeRng((seed ^ hashStr(site.id)) >>> 0);

    const state = {
        v: 2, seed, rngState: null, siteId: site.id, site,
        t: 0,                         // hours since landing
        alive: true, victory: false,
        // metal starts nonzero — lander structural scrap — so the first
        // machines are buildable before the smelter chain exists.
        resources: {
            energyKWh: LANDER.storeKWh, water: 200, oxygen: 120,
            materials: 400, metal: 300, ilmenite: 0, helium3: 0,
        },
        power: { genKW: 0, drawKW: 0, netKW: 0, capKWh: LANDER.storeKWh, sun: 0 },
        units: [], buildings: [], nodes: [],
        storm: { sepFlux: 0, sLevel: 0, etaH: null },
        autoShelter: true, _stormActive: false,
        supplyEtaH: null,
        quakeCooldownH: 0,
        nextId: 1,
        log: [],
        // Conservation ledgers — the node test closes these every run.
        ledger: {
            genKWh: 0, drawKWh: 0, wasteKWh: 0,
            minedWater: 0, minedMaterials: 0, minedIlmenite: 0, minedHe3G: 0,
            usedWater: 0, usedMaterials: 0, usedMetal: 0, electrolyzedWater: 0,
            madeOxygen: 0, usedOxygen: 0,
            smeltedOre: 0, madeMetal: 0, madeSlag: 0, smelterOxygen: 0,
            he3SpentG: 0, supplyMetal: 0,
        },
        stats: { doseWorstMSv: 0, quakes: 0, stormsSurvived: 0, capsules: 0 },
    };
    const id = () => state.nextId++;

    // The lander sits in the lit zone, left-of-centre.
    const lander = {
        id: id(), kind: 'lander', x: MAP_W * 0.42, y: MAP_H * 0.52,
        built: 1, hp: LANDER.hp, hpMax: LANDER.hp, enabled: true,
    };
    state.buildings.push(lander);

    // PSR (permanent shadow) ellipse holds the ice, at the site's ice range.
    const psrX = Math.min(MAP_W - 260, lander.x + site.iceDistM);
    const psr = { x: psrX, y: MAP_H * 0.30, rx: 340, ry: 240 };
    state.psr = psr;
    const iceNodes = 3 + Math.round(site.iceRich * 2);
    for (let i = 0; i < iceNodes; i++) {
        const a = rng() * Math.PI * 2, rr = Math.sqrt(rng());
        state.nodes.push({
            id: id(), kind: 'ice',
            x: psr.x + Math.cos(a) * psr.rx * 0.8 * rr,
            y: psr.y + Math.sin(a) * psr.ry * 0.8 * rr,
            // GAMEPLAY: nodes yield extractable WATER directly; real cold-trap
            // deposits are ~5.6 wt% ice in regolith (LCROSS) — the ore-dressing
            // step is abstracted into the mine rate.
            reserveKg: Math.round(4000 + rng() * 6000 * (0.5 + site.iceRich)),
        });
    }
    // Regolith pits — materials, closer to home, effectively unlimited.
    for (let i = 0; i < 3; i++) {
        state.nodes.push({
            id: id(), kind: 'regolith',
            x: lander.x + (rng() - 0.3) * 700,
            y: lander.y + (rng() - 0.5) * 800,
            reserveKg: Infinity,
        });
    }
    // Ilmenite outcrops — the metal chain. SOURCE: FeTiO₃ is real mare-basalt
    // ore; siting one in south-pole highlands is GAMEPLAY (call it a
    // basaltic impact-melt deposit).
    for (let i = 0; i < 2; i++) {
        state.nodes.push({
            id: id(), kind: 'ilmenite',
            x: lander.x + 350 + rng() * 500,
            y: lander.y + (i === 0 ? 1 : -1) * (250 + rng() * 350),
            reserveKg: Math.round(3000 + rng() * 3000),
        });
    }
    // Helium-3 patches — mature sunlit regolith, far from the PSR shadow.
    for (let i = 0; i < 2; i++) {
        state.nodes.push({
            id: id(), kind: 'helium3',
            x: MAP_W * (0.12 + rng() * 0.15),
            y: MAP_H * (0.25 + rng() * 0.5),
            reserveG: Math.round(180 + rng() * 220),
        });
    }

    // Starting roster: 4 astronauts, 2 rovers, parked by the lander.
    for (let i = 0; i < 4; i++) {
        state.units.push(_mkUnit(id(), 'astronaut', lander.x + 50 + i * 18, lander.y + 45));
    }
    for (let i = 0; i < 2; i++) {
        state.units.push(_mkUnit(id(), 'rover', lander.x + 55 + i * 26, lander.y - 45));
    }

    state.rngState = rng();   // burn one draw; store as resume marker
    state._rng = rng;         // non-enumerable-ish; page never serializes fns
    log(state, `Touchdown at ${site.name}. Illumination ${(site.illum * 100).toFixed(0)}%, ice ${site.iceDistM} m out.`, 'good');
    return state;
}

function _mkUnit(id, kind, x, y) {
    const c = UNIT_CATALOG[kind];
    return {
        id, kind, x, y, hp: c.hp, hpMax: c.hp,
        doseMSv: 0, grounded: false,
        carrying: 0, carryKind: null,
        order: { type: 'idle' }, inside: null,   // building id when sheltered
        autoSheltered: false, resume: null,      // storm auto-shelter stash
    };
}

/** Rebind the RNG after deserialization (fns don't survive JSON). */
export function rehydrate(state) {
    if (typeof state._rng !== 'function') {
        state._rng = makeRng((hashStr(state.siteId) ^ state.seed ^ Math.floor(state.t * 1e3)) >>> 0);
    }
    // Defensive defaults for saves from older engine versions.
    const r = state.resources;
    r.metal ??= 0; r.ilmenite ??= 0; r.helium3 ??= 0;
    state.autoShelter ??= true;
    state._stormActive ??= false;
    state.supplyEtaH ??= null;
    for (const k of ['minedIlmenite', 'minedHe3G', 'usedMetal', 'smeltedOre',
        'madeMetal', 'madeSlag', 'smelterOxygen', 'he3SpentG', 'supplyMetal']) {
        state.ledger[k] ??= 0;
    }
    state.stats.capsules ??= 0;
    return state;
}

export function log(state, msg, kind = 'info') {
    state.log.push({ t: state.t, msg, kind });
    if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ORDERS  (the StarCraft verbs)
// ═══════════════════════════════════════════════════════════════════════════
export function issueOrder(state, unitIds, order) {
    for (const uid of unitIds) {
        const u = state.units.find(x => x.id === uid);
        if (!u || u.hp <= 0) continue;
        if (u.grounded && order.type !== 'shelter' && order.type !== 'move') continue;
        u.inside = null;
        // A player order overrides any auto-shelter stash — their agency wins.
        u.autoSheltered = false; u.resume = null;
        u.order = { ...order };
        if (order.type === 'harvest') u.order.phase = 'toNode';
        if (order.type === 'build' || order.type === 'repair') u.order.phase = 'toSite';
        if (order.type === 'shelter') u.order.phase = 'toShelter';
    }
}

/** Spend banked ³He export value on a resupply capsule (crew + rover + metal). */
export function requestSupply(state) {
    if (state.supplyEtaH != null) return { ok: false, reason: 'capsule already inbound' };
    if (state.resources.helium3 < HE3.supplyCostG) {
        return { ok: false, reason: `need ${HE3.supplyCostG} g ³He` };
    }
    state.resources.helium3 -= HE3.supplyCostG;
    state.ledger.he3SpentG += HE3.supplyCostG;
    state.supplyEtaH = HE3.supplyEtaH;
    log(state, `🚀 Supply capsule purchased (${HE3.supplyCostG} g ³He) — landing in ${HE3.supplyEtaH} h.`, 'good');
    return { ok: true };
}

/** Validate + place a blueprint. Deducts materials + metal immediately. */
export function placeBlueprint(state, kind, x, y) {
    const cat = BUILD_CATALOG[kind];
    if (!cat) return { ok: false, reason: 'unknown building' };
    if (state.resources.materials < cat.materials) return { ok: false, reason: 'not enough materials' };
    if (state.resources.metal < (cat.metal || 0)) return { ok: false, reason: 'not enough metal' };
    if (x < 40 || y < 40 || x > MAP_W - 40 || y > MAP_H - 40) return { ok: false, reason: 'out of bounds' };
    for (const b of state.buildings) {
        const br = _bRadius(b);
        if (Math.hypot(b.x - x, b.y - y) < br + cat.radius + 8) return { ok: false, reason: 'too close to structure' };
    }
    state.resources.materials -= cat.materials;
    state.ledger.usedMaterials += cat.materials;
    state.resources.metal -= (cat.metal || 0);
    state.ledger.usedMetal += (cat.metal || 0);
    const b = {
        id: state.nextId++, kind, x, y,
        built: 0, hp: cat.hp * 0.1, hpMax: cat.hp, enabled: true,
        crewEtaH: null,
    };
    state.buildings.push(b);
    log(state, `${cat.name} site staked (⛏${cat.materials}${cat.metal ? ` + 🔩${cat.metal}` : ''} kg).`);
    return { ok: true, id: b.id };
}

function _bRadius(b) {
    return b.kind === 'lander' ? LANDER.radius : BUILD_CATALOG[b.kind].radius;
}

// ═══════════════════════════════════════════════════════════════════════════
//  THE TICK
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Advance the sim. `env` is the outside world, supplied by the PAGE:
 *   { gcrFlux: 0..1, sepFlux: 0..1, sLevel: 0..5, stormEtaH: number|null }
 * dtH is split into ≤0.1 h sub-steps for stability.
 */
export function tick(state, dtH, env) {
    if (!state.alive) return;
    let remaining = dtH;
    while (remaining > 1e-9) {
        const dt = Math.min(0.1, remaining);
        _step(state, dt, env);
        remaining -= dt;
        if (!state.alive) break;
    }
}

export function sunFactor(state) {
    // Dark window of length (1−illum)·SOL centred at phase 0.5; grazing sun
    // the rest of the sol. GAMEPLAY: binary lit/dark with a soft cosine lip.
    const phase = (state.t / SOL_HOURS) % 1;
    const darkHalf = (1 - state.site.illum) / 2;
    const d = Math.abs(phase - 0.5);
    if (d < darkHalf) return 0;
    const lip = Math.min(1, (d - darkHalf) / 0.02);
    return (0.72 + 0.28 * Math.sin(Math.PI * Math.min(1, (d - darkHalf) / (0.5 - darkHalf)))) * lip;
}

function _step(state, dt, env) {
    state.t += dt;
    state.storm.sepFlux = env.sepFlux ?? 0;
    state.storm.sLevel = env.sLevel ?? 0;
    state.storm.etaH = env.stormEtaH ?? null;

    // ── Power ────────────────────────────────────────────────────────────
    const sun = sunFactor(state);
    state.power.sun = sun;
    let genKW = 0, drawKW = 0, capKWh = 0;
    for (const b of state.buildings) {
        if (b.hp <= 0) continue;
        if (b.kind === 'lander') { genKW += LANDER.genKW; drawKW += LANDER.drawKW; capKWh += LANDER.storeKWh; continue; }
        const cat = BUILD_CATALOG[b.kind];
        if (b.built < 1) continue;
        if (cat.genKW) genKW += cat.genKW * sun * (b.enabled ? 1 : 0);
        if (cat.storeKWh) capKWh += cat.storeKWh;
        if (cat.drawKW && b.enabled) drawKW += cat.drawKW * (b.kind === 'electrolyzer' && state.resources.water <= 0 ? 0 : 1);
    }
    const r = state.resources;
    const net = genKW - drawKW;
    state.power.genKW = genKW; state.power.drawKW = drawKW; state.power.netKW = net;
    state.power.capKWh = capKWh;
    state.ledger.genKWh += genKW * dt;
    let powered = true;
    if (net >= 0) {
        const room = capKWh - r.energyKWh;
        const stored = Math.min(net * dt, room);
        r.energyKWh += stored;
        state.ledger.wasteKWh += net * dt - stored;      // curtailed
        state.ledger.drawKWh += drawKW * dt;
    } else {
        const need = -net * dt;
        if (r.energyKWh >= need) {
            r.energyKWh -= need;
            state.ledger.drawKWh += drawKW * dt;
        } else {
            // Brownout: batteries flat. Loads shed; life support degrades.
            state.ledger.drawKWh += genKW * dt + r.energyKWh;
            r.energyKWh = 0;
            powered = false;
        }
    }
    state.power.brownout = !powered;

    // ── Electrolyzer chemistry ───────────────────────────────────────────
    if (powered) {
        for (const b of state.buildings) {
            if (b.kind !== 'electrolyzer' || b.built < 1 || !b.enabled || b.hp <= 0) continue;
            const kg = Math.min(ELECTROLYZER.kgWaterPerH * dt, r.water);
            if (kg <= 0) continue;
            r.water -= kg;
            r.oxygen += kg * ELECTROLYZER.o2Fraction;
            state.ledger.electrolyzedWater += kg;
            state.ledger.madeOxygen += kg * ELECTROLYZER.o2Fraction;
        }
        // Smelter: FeTiO₃ + H₂ → Fe + TiO₂(slag→materials) + O₂ recovered
        for (const b of state.buildings) {
            if (b.kind !== 'smelter' || b.built < 1 || !b.enabled || b.hp <= 0) continue;
            const kg = Math.min(SMELTER.kgOrePerH * dt, r.ilmenite);
            if (kg <= 0) continue;
            r.ilmenite -= kg;
            r.metal += kg * SMELTER.metalFraction;
            r.oxygen += kg * SMELTER.o2Fraction;
            r.materials += kg * SMELTER.slagFraction;
            state.ledger.smeltedOre += kg;
            state.ledger.madeMetal += kg * SMELTER.metalFraction;
            state.ledger.smelterOxygen += kg * SMELTER.o2Fraction;
            state.ledger.madeSlag += kg * SMELTER.slagFraction;
        }
    }

    // ── Supply capsule ───────────────────────────────────────────────────
    if (state.supplyEtaH != null) {
        state.supplyEtaH -= dt;
        if (state.supplyEtaH <= 0) {
            state.supplyEtaH = null;
            const hq = _dropoff(state) || state.buildings[0];
            for (let i = 0; i < HE3.supplyCrew; i++) {
                state.units.push(_mkUnit(state.nextId++, 'astronaut', hq.x - 60 - i * 16, hq.y + 40));
            }
            for (let i = 0; i < HE3.supplyRovers; i++) {
                state.units.push(_mkUnit(state.nextId++, 'rover', hq.x - 60 - i * 24, hq.y - 40));
            }
            r.metal += HE3.supplyMetalKg;
            state.ledger.supplyMetal += HE3.supplyMetalKg;
            state.stats.capsules++;
            log(state, `🚀 Supply capsule down: +${HE3.supplyCrew} crew, +${HE3.supplyRovers} rover, +${HE3.supplyMetalKg} kg metal.`, 'good');
        }
    }

    // ── Crew life support ────────────────────────────────────────────────
    const livingCrew = state.units.filter(u => u.kind === 'astronaut' && u.hp > 0);
    const wNeed = LIFE.waterKgH * livingCrew.length * dt;
    const oNeed = LIFE.oxygenKgH * livingCrew.length * dt;
    const wGot = Math.min(wNeed, r.water), oGot = Math.min(oNeed, r.oxygen);
    r.water -= wGot; r.oxygen -= oGot;
    state.ledger.usedWater += wGot; state.ledger.usedOxygen += oGot;
    const starving = wGot < wNeed - 1e-9 || oGot < oNeed - 1e-9;
    if (starving) {
        for (const u of livingCrew) _hurtUnit(state, u, LIFE.starveHpH * dt, 'life support depleted');
        if (Math.floor(state.t) % 6 < dt) log(state, '⚠ Life support reserves empty — crew health failing.', 'bad');
    }
    if (!powered && sun === 0) {
        for (const u of livingCrew) _hurtUnit(state, u, LIFE.coldHpH * dt, 'cold and dark — batteries flat');
    }

    // ── Radiation ────────────────────────────────────────────────────────
    const gcrH = DOSE.gcrBaseMSvH + DOSE.gcrSpanMSvH * (env.gcrFlux ?? 0.5);
    const sepH = DOSE.sepPeakMSvH * (env.sepFlux ?? 0) * (env.sepFlux ?? 0);
    for (const u of state.units) {
        if (!UNIT_CATALOG[u.kind].takesDose || u.hp <= 0) continue;
        let place = 'outside';
        if (u.inside) {
            const b = state.buildings.find(x => x.id === u.inside);
            place = b ? (b.kind === 'shelter' ? 'shelter' : b.kind === 'lander' ? 'lander' : 'habitat') : 'outside';
        }
        const f = DOSE.shieldFactor[place];
        u.doseMSv += (gcrH + sepH) * f * dt;
        state.stats.doseWorstMSv = Math.max(state.stats.doseWorstMSv, u.doseMSv);
        if (!u.grounded && u.doseMSv >= DOSE.careerMSv) {
            u.grounded = true;
            u.order = { type: 'shelter', phase: 'toShelter' };
            log(state, `${_uname(u)} hit the ${DOSE.careerMSv} mSv career limit — grounded to shelter duty.`, 'bad');
        }
        if (u.doseMSv >= DOSE.acuteLethalMSv) _hurtUnit(state, u, 1e9, 'acute radiation exposure');
    }

    // ── Auto-shelter: storm onset stashes orders, storm end restores ─────
    const sepNow = env.sepFlux ?? 0;
    if (!state._stormActive && sepNow >= 0.05) {
        state._stormActive = true;
        if (state.autoShelter) {
            let sent = 0;
            for (const u of state.units) {
                if (u.kind !== 'astronaut' || u.hp <= 0 || u.inside) continue;
                u.resume = u.order;
                u.autoSheltered = true;
                u.order = { type: 'shelter', phase: 'toShelter' };
                sent++;
            }
            if (sent) log(state, `☢ Storm onset — auto-shelter sent ${sent} astronaut${sent > 1 ? 's' : ''} underground (rovers keep working).`, 'bad');
        } else {
            log(state, '☢ Storm onset — auto-shelter is OFF; your crew is where you left them.', 'bad');
        }
    } else if (state._stormActive && sepNow < 0.02) {
        state._stormActive = false;
        state.stats.stormsSurvived++;
        let resumed = 0;
        for (const u of state.units) {
            if (!u.autoSheltered || u.hp <= 0) continue;
            u.autoSheltered = false;
            u.inside = null;
            u.order = u.resume && u.resume.type !== 'sheltered' ? u.resume : { type: 'idle' };
            u.resume = null;
            // Re-normalize the phase — the unit is at the shelter now, not
            // wherever the stashed order left off.
            if (u.order.type === 'harvest') u.order.phase = u.carrying > 0 ? 'return' : 'toNode';
            if (u.order.type === 'build' || u.order.type === 'repair') u.order.phase = 'toSite';
            if (u.order.type !== 'idle') resumed++;
        }
        log(state, `Storm cleared.${resumed ? ` ${resumed} crew back to work.` : ''}`, 'good');
    }

    // ── Moonquakes — the Moon's own clock (seeded, engine-internal) ──────
    // SOURCE: 28 shallow events in 8 yr ≈ 1/104 d. GAMEPLAY: ~20× compression
    // scaled by the site's scarp-proximity risk so the hazard exists inside
    // a 3-sol run. Damage model is schematic.
    state.quakeCooldownH -= dt;
    if (state.quakeCooldownH <= 0) {
        // Expected ~2 events per 3-sol run at quakeRisk 0.5 (before cooldown).
        const pPerH = state.site.quakeRisk * 0.002;
        if (state._rng() < pPerH * dt) {
            const targets = state.buildings.filter(b => b.hp > 0 && b.kind !== 'shelter');
            if (targets.length) {
                const b = targets[Math.floor(state._rng() * targets.length)];
                const dmg = (0.2 + state._rng() * 0.3) * b.hpMax;
                b.hp = Math.max(1, b.hp - dmg);
                state.stats.quakes++;
                state.quakeCooldownH = 48;
                log(state, `☰ Shallow moonquake! ${_bname(b)} damaged (${Math.round(b.hp)}/${b.hpMax} hp). Minutes-long shaking — dry regolith barely attenuates.`, 'bad');
            }
        }
    }

    // ── Units: movement + work ───────────────────────────────────────────
    for (const u of state.units) {
        if (u.hp <= 0) continue;
        _runOrder(state, u, dt, powered);
    }

    // ── Habitats deliver crew ────────────────────────────────────────────
    for (const b of state.buildings) {
        if (b.kind !== 'habitat' || b.built < 1) continue;
        if (b.crewEtaH === null) continue;
        b.crewEtaH -= dt;
        if (b.crewEtaH <= 0) {
            b.crewEtaH = null;
            for (let i = 0; i < 2; i++) {
                state.units.push(_mkUnit(state.nextId++, 'astronaut', b.x + 40 + i * 16, b.y + 30));
            }
            log(state, 'Crew capsule landed — 2 new astronauts join the roster.', 'good');
        }
    }

    // ── Win / lose ───────────────────────────────────────────────────────
    const crewAlive = state.units.filter(u => u.kind === 'astronaut' && u.hp > 0).length;
    if (crewAlive === 0) {
        state.alive = false;
        log(state, 'All crew lost. The base goes quiet.', 'bad');
    }
    if (!state.victory && state.t >= WIN_SOLS * SOL_HOURS && crewAlive >= WIN_CREW) {
        state.victory = true;
        log(state, `★ Foothold established: ${WIN_SOLS} lunar days survived with ${crewAlive} crew. Sandbox continues.`, 'good');
    }
}

function _hurtUnit(state, u, hpLoss, why) {
    if (u.hp <= 0) return;
    u.hp -= hpLoss;
    if (u.hp <= 0) {
        u.hp = 0;
        log(state, `✝ ${_uname(u)} lost — ${why}.`, 'bad');
    }
}
function _uname(u) { return `${UNIT_CATALOG[u.kind].name} #${u.id}`; }
function _bname(b) { return b.kind === 'lander' ? 'Lander' : BUILD_CATALOG[b.kind].name; }

// ── Order FSM ────────────────────────────────────────────────────────────────
/**
 * Deterministic per-unit arrival offset (golden-angle spread) so workers
 * fan out around a shared target instead of stacking on one pixel.
 */
function _jitter(unitId, radius) {
    const a = unitId * 2.399963229728653;   // golden angle
    const r = radius * (0.5 + ((unitId * 40503) % 977) / 1954);
    return [Math.cos(a) * r, Math.sin(a) * r];
}

function _moveToward(u, tx, ty, dt) {
    const speed = UNIT_CATALOG[u.kind].speedMH;
    const dx = tx - u.x, dy = ty - u.y;
    const dist = Math.hypot(dx, dy);
    const step = speed * dt;
    if (dist <= step) { u.x = tx; u.y = ty; return true; }
    u.x += dx / dist * step; u.y += dy / dist * step;
    return false;
}

function _dropoff(state) {
    return state.buildings.find(b => b.kind === 'lander' && b.hp > 0);
}

function _runOrder(state, u, dt, powered) {
    const o = u.order;
    const cat = UNIT_CATALOG[u.kind];
    switch (o.type) {
        case 'idle': return;
        case 'move': {
            if (_moveToward(u, o.x, o.y, dt)) u.order = { type: 'idle' };
            return;
        }
        case 'harvest': {
            let node = state.nodes.find(n => n.id === o.nodeId);
            const empty = (n) => !n || (n.kind === 'helium3' ? n.reserveG <= 0 : n.reserveKg <= 0);
            if (empty(node)) {
                if (u.carrying > 0) {
                    o.phase = 'return';
                } else {
                    // Auto-retarget: nearest same-kind node with reserves —
                    // the worker keeps working instead of standing down.
                    const kind = node?.kind ?? o.nodeKind;
                    const next = state.nodes
                        .filter(n => n.kind === kind && !empty(n))
                        .sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
                    if (next) {
                        o.nodeId = next.id; o.phase = 'toNode'; node = next;
                        log(state, `${_uname(u)} moved on to the next ${kind} deposit.`, 'info');
                    } else { u.order = { type: 'idle' }; return; }
                }
            }
            o.nodeKind = node?.kind ?? o.nodeKind;
            if (o.phase === 'toNode') {
                const [jx, jy] = _jitter(u.id, 16);
                if (_moveToward(u, node.x + jx, node.y + jy, dt)) o.phase = 'mine';
            } else if (o.phase === 'mine') {
                if (node.kind === 'helium3') {
                    // In-place volatile extraction — grams accrue directly
                    // (GAMEPLAY: the haul mass is negligible; see HE3 note).
                    const g = Math.min(cat.he3GH * dt, node.reserveG);
                    state.resources.helium3 += g;
                    state.ledger.minedHe3G += g;
                    node.reserveG -= g;
                    if (node.reserveG <= 0) log(state, '³He patch worked out.', 'info');
                    return;
                }
                const kg = Math.min(cat.mineKgH * dt, cat.carryKg - u.carrying, node.reserveKg);
                u.carrying += kg;
                u.carryKind = node.kind;
                node.reserveKg -= kg;
                if (u.carrying >= cat.carryKg - 1e-9 || node.reserveKg <= 0) o.phase = 'return';
                if (node.reserveKg <= 0 && node.kind !== 'regolith') log(state, `${node.kind === 'ice' ? 'Ice' : 'Ilmenite'} node exhausted.`, 'info');
            } else { // return
                const d = _dropoff(state);
                if (!d) { u.order = { type: 'idle' }; return; }
                const [jx, jy] = _jitter(u.id, 22);
                if (_moveToward(u, d.x + jx, d.y + 42 + jy, dt)) {
                    if (u.carryKind === 'ice') { state.resources.water += u.carrying; state.ledger.minedWater += u.carrying; }
                    else if (u.carryKind === 'ilmenite') { state.resources.ilmenite += u.carrying; state.ledger.minedIlmenite += u.carrying; }
                    else { state.resources.materials += u.carrying; state.ledger.minedMaterials += u.carrying; }
                    u.carrying = 0; u.carryKind = null;
                    o.phase = 'toNode';
                }
            }
            return;
        }
        case 'build': case 'repair': {
            const b = state.buildings.find(x => x.id === o.buildingId);
            if (!b || b.hp <= 0) { u.order = { type: 'idle' }; return; }
            if (o.phase === 'toSite') {
                const br = _bRadius(b);
                if (_moveToward(u, b.x + br + 10, b.y, dt)) o.phase = 'work';
                return;
            }
            const catB = BUILD_CATALOG[b.kind];
            if (o.type === 'build' && b.built < 1) {
                const rate = cat.buildRate / catB.buildH;
                b.built = Math.min(1, b.built + rate * dt);
                b.hp = Math.max(b.hp, b.built * b.hpMax);
                if (b.built >= 1) {
                    b.hp = b.hpMax;
                    if (b.kind === 'habitat') b.crewEtaH = 24;   // GAMEPLAY: capsule inbound
                    log(state, `${catB.name} online.`, 'good');
                    u.order = { type: 'idle' };
                }
            } else {
                // repair
                b.hp = Math.min(b.hpMax, b.hp + b.hpMax * (cat.buildRate / catB.buildH) * dt);
                if (b.hp >= b.hpMax) { u.order = { type: 'idle' }; log(state, `${catB.name} repaired.`, 'good'); }
            }
            return;
        }
        case 'shelter': {
            const target = state.buildings
                .filter(b => b.hp > 0 && b.built >= 1 && (b.kind === 'shelter' || b.kind === 'lander' || b.kind === 'habitat'))
                .sort((a, b) => {
                    const rank = k => (k === 'shelter' ? 0 : k === 'habitat' ? 1 : 2);
                    return rank(a.kind) - rank(b.kind) ||
                        Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y);
                })[0];
            if (!target) { u.order = { type: 'idle' }; return; }
            if (_moveToward(u, target.x, target.y, dt)) {
                u.inside = target.id;
                u.order = { type: 'sheltered' };
            }
            return;
        }
        case 'sheltered': return;   // stays until a new order clears u.inside
        default: u.order = { type: 'idle' };
    }
}

// ── Convenience queries for the page ─────────────────────────────────────────
export function crewSummary(state) {
    const crew = state.units.filter(u => u.kind === 'astronaut');
    const alive = crew.filter(u => u.hp > 0);
    return {
        alive: alive.length,
        capacity: state.buildings.reduce((n, b) =>
            n + (b.hp > 0 && b.built >= 1 ? (b.kind === 'lander' ? LANDER.crew : (BUILD_CATALOG[b.kind].crew || 0)) : 0), 0),
        worstDoseMSv: alive.reduce((m, u) => Math.max(m, u.doseMSv), 0),
        grounded: alive.filter(u => u.grounded).length,
    };
}
