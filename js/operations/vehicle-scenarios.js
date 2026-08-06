/**
 * vehicle-scenarios.js — pure spacecraft templates + action-branch physics.
 *
 * Templates are illustrative starting assumptions, never claims about a
 * particular operator vehicle. All fields are editable in the workbench.
 */

const MU_KM3_S2 = 398600.8;
const RE_KM = 6378.135;
const G0 = 9.80665;

export const ATTITUDES = Object.freeze([
    { id: 'nominal', label: 'Nominal mission', areaKey: 'areaNominalM2' },
    { id: 'low-drag', label: 'Low-drag / feathered', areaKey: 'areaLowDragM2' },
    { id: 'sun-pointing', label: 'Sun-pointing / broadside', areaKey: 'areaSunM2' },
]);

export const VEHICLE_PROFILES = Object.freeze([
    {
        id: 'cubesat-3u', label: '3U CubeSat · cold gas', classLabel: 'CubeSat',
        massKg: 4, areaNominalM2: 0.035, areaLowDragM2: 0.012, areaSunM2: 0.09,
        cd: 2.2, thrustN: 0.02, ispS: 65, propellantKg: 0.12,
        visual: { form: 'cube', bus: [0.42, 0.70, 0.42], panelSpan: 0.75, panelWidth: 0.34, thrusters: 1, scale: 0.008, plume: 'chemical' },
    },
    {
        id: 'cubesat-12u', label: '12U CubeSat · green monoprop', classLabel: 'CubeSat',
        massKg: 24, areaNominalM2: 0.16, areaLowDragM2: 0.055, areaSunM2: 0.42,
        cd: 2.2, thrustN: 1, ispS: 220, propellantKg: 1.6,
        visual: { form: 'cube', bus: [0.58, 0.86, 0.50], panelSpan: 1.10, panelWidth: 0.42, thrusters: 1, scale: 0.0085, plume: 'chemical' },
    },
    {
        id: 'small-eo', label: '150 kg Earth observer', classLabel: 'Small EO',
        massKg: 150, areaNominalM2: 1.2, areaLowDragM2: 0.42, areaSunM2: 4.8,
        cd: 2.25, thrustN: 5, ispS: 230, propellantKg: 18,
        visual: { form: 'winged', bus: [0.70, 0.95, 0.58], panelSpan: 1.70, panelWidth: 0.55, thrusters: 2, scale: 0.009, plume: 'chemical' },
    },
    {
        id: 'microsat-300', label: '300 kg microsat', classLabel: 'Microsat',
        massKg: 300, areaNominalM2: 2.2, areaLowDragM2: 0.75, areaSunM2: 7.5,
        cd: 2.25, thrustN: 22, ispS: 230, propellantKg: 38,
        visual: { form: 'winged', bus: [0.82, 1.18, 0.70], panelSpan: 2.10, panelWidth: 0.68, thrusters: 2, scale: 0.0095, plume: 'chemical' },
    },
    {
        id: 'flat-electric', label: '800 kg flat-sat · electric', classLabel: 'Flat constellation',
        massKg: 800, areaNominalM2: 4.0, areaLowDragM2: 1.4, areaSunM2: 22,
        cd: 2.2, thrustN: 0.15, ispS: 1600, propellantKg: 12,
        visual: { form: 'flat', bus: [1.05, 0.74, 0.16], panelSpan: 2.20, panelWidth: 0.58, thrusters: 1, scale: 0.0095, plume: 'electric' },
    },
    {
        id: 'large-platform', label: 'Large orbital platform', classLabel: 'Platform',
        massKg: 10000, areaNominalM2: 85, areaLowDragM2: 24, areaSunM2: 180,
        cd: 2.2, thrustN: 800, ispS: 320, propellantKg: 1200,
        visual: { form: 'platform', bus: [1.10, 2.20, 0.90], panelSpan: 3.10, panelWidth: 0.88, thrusters: 4, scale: 0.011, plume: 'chemical' },
    },
]);

const PROFILE_BY_ID = new Map(VEHICLE_PROFILES.map(p => [p.id, p]));

export function getVehicleProfile(id) {
    return PROFILE_BY_ID.get(id) ?? VEHICLE_PROFILES[2];
}

export function suggestVehicleProfile({ name = '', massKg = null } = {}) {
    const n = String(name).toUpperCase();
    if (/STARLINK|ONEWEB|CONSTELLATION/.test(n)) return 'flat-electric';
    if (/ISS|TIANGONG|STATION|PLATFORM/.test(n) || massKg > 2000) return 'large-platform';
    if (/CUBESAT|\b3U\b/.test(n) || (massKg != null && massKg < 10)) return 'cubesat-3u';
    if (/\b12U\b/.test(n) || (massKg != null && massKg < 40)) return 'cubesat-12u';
    if (massKg != null && massKg > 220) return 'microsat-300';
    return 'small-eo';
}

export function configFromProfile(profileId, overrides = {}) {
    const p = getVehicleProfile(profileId);
    return {
        profileId: p.id,
        attitude: 'nominal',
        massKg: p.massKg,
        areaNominalM2: p.areaNominalM2,
        areaLowDragM2: p.areaLowDragM2,
        areaSunM2: p.areaSunM2,
        cd: p.cd,
        thrustN: p.thrustN,
        ispS: p.ispS,
        propellantKg: p.propellantKg,
        raiseKm: 10,
        delayHours: 24,
        maneuverDvMs: 1,
        activeAction: 'do-nothing',
        ...overrides,
    };
}

export function sanitizeVehicleConfig(input = {}) {
    const base = configFromProfile(input.profileId);
    const positive = (v, fallback, min = 0) => Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : fallback;
    const attitude = ATTITUDES.some(a => a.id === input.attitude) ? input.attitude : base.attitude;
    const actionIds = new Set(['do-nothing', 'low-drag', 'raise', 'delay', 'maneuver']);
    return {
        ...base,
        ...input,
        profileId: getVehicleProfile(input.profileId).id,
        attitude,
        massKg: positive(input.massKg, base.massKg, 0.01),
        areaNominalM2: positive(input.areaNominalM2, base.areaNominalM2),
        areaLowDragM2: positive(input.areaLowDragM2, base.areaLowDragM2),
        areaSunM2: positive(input.areaSunM2, base.areaSunM2),
        cd: positive(input.cd, base.cd, 0.1),
        thrustN: positive(input.thrustN, base.thrustN),
        ispS: positive(input.ispS, base.ispS, 1),
        propellantKg: positive(input.propellantKg, base.propellantKg),
        raiseKm: positive(input.raiseKm, base.raiseKm),
        delayHours: positive(input.delayHours, base.delayHours),
        maneuverDvMs: Number.isFinite(Number(input.maneuverDvMs)) ? Number(input.maneuverDvMs) : base.maneuverDvMs,
        activeAction: actionIds.has(input.activeAction) ? input.activeAction : base.activeAction,
    };
}

export function effectiveAreaM2(config, attitude = config?.attitude) {
    const c = sanitizeVehicleConfig(config);
    const a = ATTITUDES.find(x => x.id === attitude) ?? ATTITUDES[0];
    return c[a.areaKey];
}

export function ballisticCoefficient(config, attitude = config?.attitude) {
    const c = sanitizeVehicleConfig(config);
    return c.cd * effectiveAreaM2(c, attitude) / c.massKg;
}

export function propellantForDv(massKg, dvMs, ispS) {
    if (!(massKg > 0) || !(ispS > 0) || !Number.isFinite(dvMs)) return null;
    return massKg * (1 - Math.exp(-Math.abs(dvMs) / (ispS * G0)));
}

export function burnDurationSec(propellantKg, thrustN, ispS) {
    if (!(propellantKg >= 0) || !(thrustN > 0) || !(ispS > 0)) return Infinity;
    return propellantKg * ispS * G0 / thrustN;
}

/** Two-impulse circular Hohmann raise. */
export function hohmannRaiseDvMs(altitudeKm, raiseKm) {
    if (!Number.isFinite(altitudeKm) || !Number.isFinite(raiseKm) || raiseKm <= 0) return 0;
    const r1 = RE_KM + altitudeKm;
    const r2 = r1 + raiseKm;
    const transferA = (r1 + r2) / 2;
    const v1 = Math.sqrt(MU_KM3_S2 / r1);
    const v2 = Math.sqrt(MU_KM3_S2 / r2);
    const dv1 = Math.sqrt(MU_KM3_S2 * (2 / r1 - 1 / transferA)) - v1;
    const dv2 = v2 - Math.sqrt(MU_KM3_S2 * (2 / r2 - 1 / transferA));
    return (Math.abs(dv1) + Math.abs(dv2)) * 1000;
}

/** Semi-major-axis change from an instantaneous tangential burn on a circular orbit. */
export function tangentialSemiMajorShiftKm(altitudeKm, dvMs) {
    if (!Number.isFinite(altitudeKm) || !Number.isFinite(dvMs)) return 0;
    const r = RE_KM + altitudeKm;
    const v = Math.sqrt(MU_KM3_S2 / r);
    const vp = v + dvMs / 1000;
    const energy = vp * vp / 2 - MU_KM3_S2 / r;
    if (!(energy < 0)) return Infinity;
    return -MU_KM3_S2 / (2 * energy) - r;
}

function fmtBranch({ id, label, attitude, startPerigeeKm, endPerigeeKm, rateKmDay, dvMs = 0, orbitShiftKm = 0, config }) {
    const propellantUsedKg = propellantForDv(config.massKg, dvMs, config.ispS) ?? Infinity;
    const burnSec = dvMs === 0 ? 0 : burnDurationSec(propellantUsedKg, config.thrustN, config.ispS);
    const feasible = propellantUsedKg <= config.propellantKg + 1e-12 && (dvMs === 0 || Number.isFinite(burnSec));
    return {
        id, label, attitude,
        startPerigeeKm,
        endPerigeeKm,
        altitudeDeltaKm: endPerigeeKm - startPerigeeKm,
        dragLossM: Math.max(0, (startPerigeeKm + Math.max(0, orbitShiftKm) - endPerigeeKm) * 1000),
        rateKmDay,
        dvMs,
        orbitShiftKm,
        propellantUsedKg,
        propellantRemainingKg: Math.max(0, config.propellantKg - propellantUsedKg),
        burnSec,
        feasible,
    };
}

/**
 * Compare five 72-hour operator branches. `densityRatioAt(deltaAltKm)` is
 * supplied by the Operations page from MSIS, with an exponential fallback.
 */
export function compareVehicleActions({
    config,
    perigeeKm,
    baselineRateKmDay,
    baselineBallisticCoefficient,
    horizonHours = 72,
    densityRatioAt = deltaAltKm => Math.exp(-deltaAltKm / 55),
} = {}) {
    const c = sanitizeVehicleConfig(config);
    if (!Number.isFinite(perigeeKm)) return [];
    const horizonDays = Math.max(0, horizonHours) / 24;
    const baseRate = Number.isFinite(baselineRateKmDay) ? Math.min(0, baselineRateKmDay) : 0;
    const baseBc = baselineBallisticCoefficient > 0 ? baselineBallisticCoefficient : ballisticCoefficient(c, 'nominal');
    const rateFor = (attitude, altitudeDeltaKm = 0) => {
        const bcScale = ballisticCoefficient(c, attitude) / baseBc;
        const rhoScale = Math.max(0, Number(densityRatioAt(altitudeDeltaKm)) || 0);
        return baseRate * bcScale * rhoScale;
    };

    const nominalRate = rateFor(c.attitude);
    const doNothingEnd = perigeeKm + nominalRate * horizonDays;
    const lowRate = rateFor('low-drag');
    const lowEnd = perigeeKm + lowRate * horizonDays;

    const raiseDv = hohmannRaiseDvMs(perigeeKm, c.raiseKm);
    const raisedRate = rateFor(c.attitude, c.raiseKm);
    const raisedEnd = perigeeKm + c.raiseKm + raisedRate * horizonDays;

    const delayDays = Math.min(horizonDays, c.delayHours / 24);
    const coastEnd = perigeeKm + nominalRate * delayDays;
    const delayExecutes = delayDays < horizonDays;
    const delayedRaisedEnd = delayExecutes
        ? coastEnd + c.raiseKm + rateFor(c.attitude, c.raiseKm) * (horizonDays - delayDays)
        : coastEnd;

    const maneuverShift = tangentialSemiMajorShiftKm(perigeeKm, c.maneuverDvMs);
    // A prograde impulse raises apogee but leaves the burn point as perigee;
    // a retrograde impulse lowers the opposite apsis. Keep this distinction
    // visible instead of pretending every +T collision burn raises perigee.
    const maneuverPerigeeKick = c.maneuverDvMs < 0 && Number.isFinite(maneuverShift)
        ? 2 * maneuverShift
        : 0;
    const maneuverRate = rateFor(c.attitude, Number.isFinite(maneuverShift) ? maneuverShift : 0);
    const maneuverEnd = perigeeKm + maneuverPerigeeKick + maneuverRate * horizonDays;

    return [
        fmtBranch({ id: 'do-nothing', label: 'Do nothing', attitude: c.attitude, startPerigeeKm: perigeeKm, endPerigeeKm: doNothingEnd, rateKmDay: nominalRate, config: c }),
        fmtBranch({ id: 'low-drag', label: 'Low-drag', attitude: 'low-drag', startPerigeeKm: perigeeKm, endPerigeeKm: lowEnd, rateKmDay: lowRate, config: c }),
        fmtBranch({ id: 'raise', label: `Raise ${c.raiseKm} km`, attitude: c.attitude, startPerigeeKm: perigeeKm, endPerigeeKm: raisedEnd, rateKmDay: raisedRate, dvMs: raiseDv, orbitShiftKm: c.raiseKm, config: c }),
        fmtBranch({ id: 'delay', label: `Delay ${c.delayHours} h`, attitude: c.attitude, startPerigeeKm: perigeeKm, endPerigeeKm: delayedRaisedEnd, rateKmDay: delayExecutes ? raisedRate : nominalRate, dvMs: delayExecutes ? raiseDv : 0, orbitShiftKm: delayExecutes ? c.raiseKm : 0, config: c }),
        fmtBranch({ id: 'maneuver', label: `Maneuver ${c.maneuverDvMs >= 0 ? '+' : ''}${c.maneuverDvMs} m/s T`, attitude: c.attitude, startPerigeeKm: perigeeKm, endPerigeeKm: maneuverEnd, rateKmDay: maneuverRate, dvMs: Math.abs(c.maneuverDvMs), orbitShiftKm: maneuverShift, config: c }),
    ];
}
