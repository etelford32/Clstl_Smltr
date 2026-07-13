/**
 * bake-gravity-epochs.mjs — generate js/gravity-lab/epochs.js (P2.2).
 *
 * Two modes:
 *
 *   node tools/bake-gravity-epochs.mjs
 *       Queries the JPL Horizons API for satellite state vectors at each
 *       canonical epoch (planet-centered, body-equator frame; ecliptic for
 *       Earth-Moon) and bakes them with source: 'horizons'. Requires
 *       outbound network access to ssd.jpl.nasa.gov.
 *
 *   node tools/bake-gravity-epochs.mjs --analytic
 *       Offline fallback: propagates each system's audited J2000 mean
 *       elements to the target epochs by Kepler mean motion, plus the J2
 *       secular node/apse drift where the system declares oblateness
 *       (without it Phobos' node would be wrong by ~159°/yr × 26 yr).
 *       Ignores mutual perturbations — every entry is honestly labeled
 *       source: 'analytic-mean-elements' and the UI displays it.
 *
 * The output file is committed. Arbitrary-date fetch (SUPER-gated, via a
 * server-side proxy) is deferred per the plan — baked epochs ship first.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dir, '..', 'js', 'gravity-lab', 'epochs.js');

const { SYSTEMS, SYSTEM_ORDER } = await import('../js/gravity-lab/systems.js');
const { elementsToState, G_SI } = await import('../js/gravity-lab/physics.js');

const ANALYTIC = process.argv.includes('--analytic');
const J2000_JD = 2451545.0;

// ── Canonical epochs ─────────────────────────────────────────────────────────

function jdUTC(y, mo, d) {
    return Date.UTC(y, mo - 1, d) / 86400000 + 2440587.5;
}

const EPOCH_DATES = [
    { jd: jdUTC(2026, 3, 20),  label: '2026 Mar 20 · equinox'  },
    { jd: jdUTC(2026, 6, 21),  label: '2026 Jun 21 · solstice' },
    { jd: jdUTC(2026, 7, 1),   label: '2026 Jul 01'            },
    { jd: jdUTC(2026, 9, 23),  label: '2026 Sep 23 · equinox'  },
    { jd: jdUTC(2026, 12, 21), label: '2026 Dec 21 · solstice' },
];

// Stellar systems have no ephemerides; sandbox is not a system.
const SKIP = new Set(['algol-triple']);

// ── Horizons body/center ids ─────────────────────────────────────────────────

const HORIZONS = {
    'earth-moon':        { center: '500@399', refPlane: 'ECLIPTIC',      ids: { moon: '301' } },
    'mars-system':       { center: '500@499', refPlane: "'BODY EQUATOR'", ids: { phobos: '401', deimos: '402' } },
    'jupiter-galileans': { center: '500@599', refPlane: "'BODY EQUATOR'", ids: { io: '501', europa: '502', ganymede: '503', callisto: '504' } },
    'saturn-major':      { center: '500@699', refPlane: "'BODY EQUATOR'", ids: { mimas: '601', enceladus: '602', tethys: '603', dione: '604', rhea: '605', titan: '606', iapetus: '608' } },
    'saturn-coorbitals': { center: '500@699', refPlane: "'BODY EQUATOR'", ids: { janus: '610', epimetheus: '611' } },
    'neptune-triton':    { center: '500@899', refPlane: "'BODY EQUATOR'", ids: { proteus: '808', triton: '801' } },
    'pluto-charon':      { center: '500@999', refPlane: "'BODY EQUATOR'", ids: { charon: '901', nix: '902', hydra: '903' } },
};

async function fetchHorizonsVectors(bodyId, center, refPlane, jds) {
    const url = 'https://ssd.jpl.nasa.gov/api/horizons.api?format=json'
        + `&COMMAND='${bodyId}'&OBJ_DATA='NO'&MAKE_EPHEM='YES'&EPHEM_TYPE='VECTORS'`
        + `&CENTER='${center}'&TLIST='${jds.join(',')}'&REF_PLANE=${refPlane}`
        + `&OUT_UNITS='KM-S'&VEC_TABLE='2'&CSV_FORMAT='YES'`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Horizons HTTP ${res.status} for body ${bodyId}`);
    const json = await res.json();
    const text = json.result;
    if (!text) throw new Error(`Horizons returned no result for body ${bodyId}`);
    // CSV rows live between $$SOE and $$EOE: JDTDB, date, X, Y, Z, VX, VY, VZ,
    const m = text.match(/\$\$SOE([\s\S]*?)\$\$EOE/);
    if (!m) throw new Error(`No vector block for body ${bodyId}:\n${text.slice(0, 400)}`);
    const out = [];
    for (const line of m[1].trim().split('\n')) {
        const c = line.split(',').map(s => s.trim());
        if (c.length < 8) continue;
        out.push({
            jd: parseFloat(c[0]),
            r: [parseFloat(c[2]) * 1e3, parseFloat(c[3]) * 1e3, parseFloat(c[4]) * 1e3],
            v: [parseFloat(c[5]) * 1e3, parseFloat(c[6]) * 1e3, parseFloat(c[7]) * 1e3],
        });
    }
    if (out.length !== jds.length) {
        throw new Error(`Expected ${jds.length} rows for body ${bodyId}, got ${out.length}`);
    }
    return out;
}

// ── Analytic propagation ─────────────────────────────────────────────────────

const D2R = Math.PI / 180, R2D = 180 / Math.PI;

/**
 * Rebuild a system's satellite vectors at epoch jd by mean-motion advance
 * of the audited J2000 elements (+ J2 secular node/apse drift when the
 * system declares oblateness). Mirrors _build()'s assembly, including the
 * circumbinary running-barycenter path.
 */
function analyticVectors(sys, jd) {
    const dt = (jd - J2000_JD) * 86400;
    const parent = sys.bodies.find(b => b.is_parent);
    const placed = [{ m: parent.m, r: [0, 0, 0], v: [0, 0, 0] }];
    const out = {};
    for (const b of sys.bodies) {
        if (b.is_parent || !b.elements_j2000) continue;
        const el = b.elements_j2000;
        let mu;
        let frame = { r: [0, 0, 0], v: [0, 0, 0] };
        if (b.circumbinary) {
            let M = 0;
            const rB = [0, 0, 0], vB = [0, 0, 0];
            for (const p of placed) {
                M += p.m;
                for (let k = 0; k < 3; k++) { rB[k] += p.m * p.r[k]; vB[k] += p.m * p.v[k]; }
            }
            for (let k = 0; k < 3; k++) { rB[k] /= M; vB[k] /= M; }
            mu = G_SI * (M + b.m);
            frame = { r: rB, v: vB };
        } else {
            mu = G_SI * (parent.m + b.m);
        }
        const n = Math.sqrt(mu / el.a ** 3);   // rad/s
        let raan = el.raan_deg, argp = el.argp_deg;
        if (sys.oblateness) {
            // J2 secular rates (Vallado §9): the dominant real drift for
            // close-in moons like Phobos.
            const p_sl = el.a * (1 - el.e * el.e);
            const fac = 1.5 * n * sys.oblateness.J2 * (sys.oblateness.R_eq_m / p_sl) ** 2;
            const ci = Math.cos(el.i_deg * D2R);
            raan += (-fac * ci) * dt * R2D;
            argp += (0.5 * fac * (5 * ci * ci - 1)) * dt * R2D;
        }
        const M_deg = el.M_deg + n * dt * R2D;
        const st = elementsToState({ ...el, raan_deg: raan, argp_deg: argp, M_deg, mu });
        const r = [st.r[0] + frame.r[0], st.r[1] + frame.r[1], st.r[2] + frame.r[2]];
        const v = [st.v[0] + frame.v[0], st.v[1] + frame.v[1], st.v[2] + frame.v[2]];
        placed.push({ m: b.m, r, v });
        out[b.name] = { r, v };
    }
    return out;
}

// ── Bake ─────────────────────────────────────────────────────────────────────

const source = ANALYTIC ? 'analytic-mean-elements' : 'horizons';
const epochs = {};

for (const id of SYSTEM_ORDER) {
    if (SKIP.has(id)) continue;
    const sys = SYSTEMS[id];
    const entries = [];
    if (ANALYTIC) {
        for (const ep of EPOCH_DATES) {
            entries.push({ jd: ep.jd, label: ep.label, source, bodies: analyticVectors(sys, ep.jd) });
        }
    } else {
        const cfg = HORIZONS[id];
        if (!cfg) { console.warn(`no Horizons mapping for ${id}, skipping`); continue; }
        const jds = EPOCH_DATES.map(e => e.jd);
        const perBody = {};
        for (const [name, hid] of Object.entries(cfg.ids)) {
            process.stdout.write(`  ${id}/${name} ← Horizons ${hid} ... `);
            perBody[name] = await fetchHorizonsVectors(hid, cfg.center, cfg.refPlane, jds);
            console.log('ok');
            await new Promise(r => setTimeout(r, 500));   // be polite
        }
        for (let k = 0; k < EPOCH_DATES.length; k++) {
            const bodies = {};
            for (const [name, rows] of Object.entries(perBody)) {
                bodies[name] = { r: rows[k].r, v: rows[k].v };
            }
            entries.push({ jd: EPOCH_DATES[k].jd, label: EPOCH_DATES[k].label, source, bodies });
        }
    }
    epochs[id] = entries;
    console.log(`${id}: ${entries.length} epochs (${source})`);
}

const num = x => Number(x.toPrecision(12));
const body = JSON.stringify(epochs, (k, v) => typeof v === 'number' ? num(v) : v, 0);

writeFileSync(OUT, `/**
 * epochs.js — GENERATED by tools/bake-gravity-epochs.mjs. DO NOT EDIT.
 *
 * Baked satellite state vectors (SI: m, m/s; parent-centered, same frame
 * conventions as systems.js) at canonical epochs.
 *
 * source: '${source}'
 *   - 'horizons': real JPL Horizons vectors.
 *   - 'analytic-mean-elements': offline mean-motion propagation of the
 *     audited J2000 elements (+ J2 secular node/apse drift); mutual
 *     perturbations are NOT included. Regenerate with network access to
 *     upgrade: node tools/bake-gravity-epochs.mjs
 *
 * baked: ${new Date().toISOString()}
 */

export const EPOCHS = ${body};
`);
console.log(`\nwrote ${OUT} (source: ${source})`);
