import assert from 'node:assert/strict';
import {
    VEHICLE_PROFILES, ballisticCoefficient, burnDurationSec,
    compareVehicleActions, configFromProfile, hohmannRaiseDvMs,
    propellantForDv, tangentialSemiMajorShiftKm,
} from '../js/operations/vehicle-scenarios.js';

assert.ok(VEHICLE_PROFILES.length >= 6, 'multiple representative designs');
assert.ok(new Set(VEHICLE_PROFILES.map(p => p.id)).size === VEHICLE_PROFILES.length, 'profile ids unique');

const vehicle = configFromProfile('small-eo', { raiseKm: 10, delayHours: 24, maneuverDvMs: 1 });
assert.ok(ballisticCoefficient(vehicle, 'low-drag') < ballisticCoefficient(vehicle, 'nominal'));
assert.ok(ballisticCoefficient(vehicle, 'sun-pointing') > ballisticCoefficient(vehicle, 'nominal'));

const dvRaise = hohmannRaiseDvMs(420, 10);
assert.ok(dvRaise > 0 && dvRaise < 20, `10 km LEO raise is a modest two-burn Δv (${dvRaise})`);
const prop = propellantForDv(vehicle.massKg, dvRaise, vehicle.ispS);
assert.ok(prop > 0 && prop < vehicle.propellantKg);
assert.ok(burnDurationSec(prop, vehicle.thrustN, vehicle.ispS) > 0);
assert.ok(tangentialSemiMajorShiftKm(420, 1) > 1, 'positive along-track burn raises semi-major axis');
assert.ok(tangentialSemiMajorShiftKm(420, -1) < 0, 'negative along-track burn lowers semi-major axis');

const branches = compareVehicleActions({
    config: vehicle,
    perigeeKm: 420,
    baselineRateKmDay: -1,
    baselineBallisticCoefficient: ballisticCoefficient(vehicle, 'nominal'),
    densityRatioAt: dh => Math.exp(-dh / 55),
});
assert.deepEqual(branches.map(b => b.id), ['do-nothing', 'low-drag', 'raise', 'delay', 'maneuver']);
const byId = Object.fromEntries(branches.map(b => [b.id, b]));
assert.ok(byId['low-drag'].endPerigeeKm > byId['do-nothing'].endPerigeeKm, 'low-drag preserves altitude');
assert.ok(byId.raise.endPerigeeKm > byId.delay.endPerigeeKm, 'immediate raise beats delayed raise');
assert.ok(byId.raise.dvMs > 0 && byId.raise.propellantUsedKg > 0 && byId.raise.feasible);
assert.equal(byId.maneuver.dvMs, 1);

const impossible = compareVehicleActions({
    config: { ...vehicle, propellantKg: 0, thrustN: 0 },
    perigeeKm: 420,
    baselineRateKmDay: -1,
    baselineBallisticCoefficient: ballisticCoefficient(vehicle, 'nominal'),
})[2];
assert.equal(impossible.feasible, false, 'burn branch reports infeasible without thrust/propellant');

console.log('operations vehicle scenarios: ok');
