// flux-rope-live.mjs — fixture gate for the Phase 3 live-input parsers
// (js/flux-rope-live.js). Pure node, no network:
//
//   node tests/flux-rope-live.mjs

import {
    parseDonkiCmes, donkiToPreset, parseRtsw, rtswDriver,
    staPositionApprox, stereoBeaconDriver,
    earthRelevant, ballisticArrivalMs, selectTrainCmes, donkiToTrainPreset,
} from '../js/flux-rope-live.js';

let failures = 0;
function check(label, ok, detail = '') {
    if (ok) console.log(`  ok  ${label}${detail ? ` — ${detail}` : ''}`);
    else { failures++; console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ── DONKI parsing (shape mirrors api/donki/cme.js output) ────────────────────
const donkiPayload = {
    data: {
        cmes: [
            { time: '2026-07-19T14:39Z', cme_id: 'CME-1', most_accurate: true, speed_km_s: 1240, latitude_deg: -8, longitude_deg: 12, half_angle_deg: 42, earth_directed: true, note: 'halo' },
            { time: '2026-07-20T02:00Z', cme_id: 'CME-2', most_accurate: false, speed_km_s: 610, latitude_deg: 4, longitude_deg: -75, half_angle_deg: 18, earth_directed: false, note: '' },
            { time: '2026-07-18T00:00Z', cme_id: 'CME-3', most_accurate: true, speed_km_s: null, latitude_deg: 0, longitude_deg: 0, half_angle_deg: 30, earth_directed: true, note: 'no speed — dropped' },
        ],
    },
};
const cmes = parseDonkiCmes(donkiPayload);
check('donki: drops speedless analyses', cmes.length === 2);
check('donki: newest first', cmes[0].cmeId === 'CME-2' && cmes[1].cmeId === 'CME-1');
check('donki: fields normalized', cmes[1].earthDirected === true && cmes[1].halfAngleDeg === 42);
check('donki: empty payload → []', parseDonkiCmes({}).length === 0);

// ── DONKI → preset seeding (spec §12) ────────────────────────────────────────
const preset = donkiToPreset(cmes[1], { ambientWKms: 430 });
check('seed: launch epoch = time21_5', preset.launchIso === '2026-07-19T14:39Z');
check('seed: v0 = DONKI speed at 21.5 Rs', preset.rope.v0Kms === 1240);
check('seed: direction from cone fit', preset.rope.lonDeg === 12 && preset.rope.latDeg === -8);
check('seed: half-angle scales the size prior',
    preset.rope.sigma1AuAu > 0.115 && preset.rope.sigma1AuAu <= 0.2,
    `${preset.rope.sigma1AuAu.toFixed(3)} AU`);
check('seed: ambient wind from live L1', preset.rope.wKms === 430);
check('seed: chirality honestly unknown (pFlip 0.5)', preset.spreads.pFlip === 0.5);
check('seed: wide tilt prior (cone fits do not constrain tilt)', preset.spreads.sigTiltDeg >= 40);
check('seed: live forecasts carry the sheath forward model (spec §14)',
    preset.rope.sheathDeltaNt > 0);
check('seed: size cap respected',
    donkiToPreset({ ...cmes[1], halfAngleDeg: 90 }).rope.sigma1AuAu <= 0.2);

// ── Compounding-train selection + seeding (spec §12 train conventions) ───────
{
    const NOW = Date.parse('2026-07-27T12:00:00Z');
    const mk = (hAgo, over = {}) => ({
        id: `cme-${hAgo}h`,
        timeIso: new Date(NOW - hAgo * 3600e3).toISOString(),
        speedKms: 900, latDeg: 0, lonDeg: 0, halfAngleDeg: 35,
        earthDirected: true, ...over,
    });

    check('relevance: earth-directed flag always passes',
        earthRelevant({ earthDirected: true, latDeg: 0, lonDeg: 80, halfAngleDeg: 20 }));
    check('relevance: cone-edge margin admits glancing candidates',
        earthRelevant({ earthDirected: false, latDeg: 0, lonDeg: 45, halfAngleDeg: 30 })
        && !earthRelevant({ earthDirected: false, latDeg: 0, lonDeg: 75, halfAngleDeg: 30 }));
    check('ballistic arrival: 1 AU at the cone speed',
        Math.abs(ballisticArrivalMs(mk(0)) - (NOW + 1.495978707e8 / 900 * 1000)) < 1000);

    // Window membership: recent launches in; passed storms out; in-transit in.
    const recent = mk(6);
    const recent2 = mk(20, { speedKms: 1400 });
    const inTransit = mk(40, { speedKms: 700 });        // arrival ≈ +59 h > now
    const passed = mk(140, { speedKms: 1200 });         // arrived ≈ +35 h, long gone
    const flankPartner = mk(10, { earthDirected: false, lonDeg: 40, halfAngleDeg: 30 });
    const farFlank = mk(5, { earthDirected: false, lonDeg: 80, halfAngleDeg: 25 });
    const sel = selectTrainCmes([passed, recent, farFlank, inTransit, flankPartner, recent2],
        { nowMs: NOW });
    check('train select: recent + in-transit + glancing partner, launch-ascending',
        sel.map((c) => c.id).join(',') === 'cme-40h,cme-20h,cme-10h,cme-6h',
        sel.map((c) => c.id).join(','));
    check('train select: passed storm and far flank excluded',
        !sel.some((c) => c.id === 'cme-140h' || c.id === 'cme-5h'));
    check('train select: partners without an anchor → idle []',
        selectTrainCmes([flankPartner], { nowMs: NOW }).length === 0);
    check('train select: future-dated rows dropped',
        selectTrainCmes([mk(-2), recent], { nowMs: NOW }).length === 1);
    // Cap: oldest NON-anchor drops first, then oldest anchor.
    const crowd = [mk(23), mk(19), mk(15, { earthDirected: false, lonDeg: 40 }), mk(11),
        mk(7), mk(3), mk(1)];
    const capped = selectTrainCmes(crowd, { nowMs: NOW, maxRopes: 6 });
    check('train select: over the cap the oldest non-anchor drops first',
        capped.length === 6 && !capped.some((c) => c.id === 'cme-15h'),
        capped.map((c) => c.id).join(','));
    const capped2 = selectTrainCmes(crowd, { nowMs: NOW, maxRopes: 5 });
    check('train select: then the oldest anchor',
        capped2.length === 5 && !capped2.some((c) => c.id === 'cme-23h'));

    // Seeding: epoch = earliest launch = rope 0, offsets forward, §16 ON.
    const train = donkiToTrainPreset(sel, { ambientWKms: 430 });
    check('train seed: epoch is the EARLIEST launch (rope 0 = the reference)',
        train.launchIso === inTransit.timeIso && train.rope === train.ropes[0]);
    check('train seed: launch offsets ascend from 0',
        train.ropes[0].launchOffsetS === 0
        && train.ropes.every((r, i) => i === 0 || r.launchOffsetS > train.ropes[i - 1].launchOffsetS)
        && train.ropes[3].launchOffsetS === (40 - 6) * 3600);
    check('train seed: every rope carries its own cone fit',
        train.ropes[1].v0Kms === 1400 && train.ropes[2].lonDeg === 40);
    check('train seed: §16 interaction ON', train.interaction?.enabled === true);
    check('train seed: live forward model keeps the sheath (spec §14)',
        train.ropes.every((r) => r.sheathDeltaNt > 0));
    check('train seed: spreads are the per-CME priors merged by MAX',
        train.spreads.sigV0Kms === Math.max(100, 1400 * 0.15)
        && train.spreads.pFlip === 0.5);
    check('train seed: ambient wind threads through', train.ropes[0].wKms === 430);
    check('train seed: marked live + train with the member CMEs attached',
        train.live === true && train.train === true && train.cmes.length === 4);
    check('train seed: single-CME train degenerates cleanly',
        donkiToTrainPreset([recent]).ropes.length === 1
        && donkiToTrainPreset([recent]).ropes[0].launchOffsetS === 0
        && donkiToTrainPreset([]) === null);
}

// ── RTSW merge (mag + plasma are separate products) ──────────────────────────
const mag = [
    { time_tag: '2026-07-21T10:00:00', bx_gsm: -1.2, by_gsm: 3.4, bz_gsm: -5.6 },
    { time_tag: '2026-07-21T10:01:00', bx_gsm: -1.0, by_gsm: 3.0, bz_gsm: -9999 },  // fill
    { time_tag: '2026-07-21T10:02:00', bx_gsm: 0.5, by_gsm: 2.2, bz_gsm: 2.0 },
];
const wind = [
    { time_tag: '2026-07-21T10:00:00', proton_speed: 420, proton_density: 5.5 },
    { time_tag: '2026-07-21T10:02:00', proton_speed: 431, proton_density: 6.1 },
];
const samples = parseRtsw(mag, wind);
check('rtsw: merged by minute', samples.length === 3);
check('rtsw: mag + plasma joined', samples[0].bz === -5.6 && samples[0].v === 420);
check('rtsw: NOAA fill → NaN', Number.isNaN(samples[1].bz));
check('rtsw: plasma gap stays NaN', Number.isNaN(samples[1].v));

const drv = rtswDriver(mag, wind);
check('rtsw driver: source observed / frame gsm',
    drv.meta.source === 'observed' && drv.meta.frame === 'gsm');
check('rtsw driver: pdyn derived where plasma exists',
    Number.isFinite(drv.samples[0].pdyn) && Number.isNaN(drv.samples[1].pdyn));
check('rtsw driver: interpolates continuous channels',
    Math.abs(drv.at(Date.parse('2026-07-21T10:00:30Z')).bx - (-1.1)) < 1e-9);
check('rtsw driver: never interpolates THROUGH a gap (contract honesty)',
    Number.isNaN(drv.at(Date.parse('2026-07-21T10:01:30Z')).v));

// ── STEREO-A ephemeris + beacon (spec §13) ───────────────────────────────────
const atConj = staPositionApprox(Date.UTC(2023, 7, 12));
check('sta: zero longitude at the 2023-08 conjunction', Math.abs(atConj.lonDeg) < 0.2,
    `${atConj.lonDeg}°`);
const atGannon = staPositionApprox(Date.UTC(2024, 4, 10));
check('sta: Gannon-epoch position matches the literature within tolerance',
    atGannon.lonDeg > 11 && atGannon.lonDeg < 18, `+${atGannon.lonDeg}° (lit ≈ +13°)`);
check('sta: drifts ahead of Earth over time',
    staPositionApprox(Date.UTC(2026, 6, 21)).lonDeg > atGannon.lonDeg);
check('sta: approximation is labeled', atGannon.approx === true && atGannon.rAu === 0.96);

const staDrv = stereoBeaconDriver([
    { time_tag: '2026-07-21T09:00:00', bx_gsm: 0.5, by_gsm: -2.0, bz_gsm: -6.5 },
    { time_tag: '2026-07-21T09:01:00', bx_gsm: 0.4, by_gsm: -2.1, bz_gsm: -9999 },
]);
check('sta beacon driver: labeled + observed + mag-only (plasma NaN)',
    staDrv.meta.label === 'STEREO-A beacon' && staDrv.meta.source === 'observed'
    && staDrv.samples[0].bz === -6.5 && Number.isNaN(staDrv.samples[0].v));
check('sta beacon driver: fill values → NaN', Number.isNaN(staDrv.samples[1].bz));

console.log(failures ? `\n${failures} failure(s)` : '\nall flux-rope live-input checks passed');
process.exit(failures ? 1 : 0);
