// flux-rope-live.mjs — fixture gate for the Phase 3 live-input parsers
// (js/flux-rope-live.js). Pure node, no network:
//
//   node tests/flux-rope-live.mjs

import {
    parseDonkiCmes, donkiToPreset, parseRtsw, rtswDriver,
    staPositionApprox, stereoBeaconDriver,
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
check('seed: size cap respected',
    donkiToPreset({ ...cmes[1], halfAngleDeg: 90 }).rope.sigma1AuAu <= 0.2);

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
