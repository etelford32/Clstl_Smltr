import assert from 'node:assert/strict';
import {
    PERSEVERANCE_MISSION,
    derivePositionFromLocalOffset,
    estimatedMissionSol,
    formatMarsClock,
    localMeanSolarTimeHours,
    marsSolarLongitudeFromJulianDate,
    marsSubsolarPoint,
    observationFreshness,
} from '../js/mars-mission-state.js';

const { landing_site: landing, position } = PERSEVERANCE_MISSION;
const derived = derivePositionFromLocalOffset({
    landingLatDeg: landing.lat_deg,
    landingLonDeg: landing.lon_deg,
    northM: position.local_offset_m.north,
    westM: position.local_offset_m.west,
});

assert.ok(Math.abs(derived.lat_deg - 18.4277546024) < 1e-9, 'PDS north offset converts to the plotted latitude');
assert.ok(Math.abs(derived.lon_deg - 77.2352914998) < 1e-9, 'PDS west offset converts to the plotted longitude');
assert.equal(estimatedMissionSol(new Date('2026-08-05T20:00:00Z')), 1940, 'mission clock agrees with NASA map sol on verification date');
assert.equal(formatMarsClock(localMeanSolarTimeHours(position.lon_deg, new Date('2026-08-05T20:00:00Z'))), '06:43:33');
assert.equal(marsSolarLongitudeFromJulianDate(2_460_565.5), 0, 'published Mars-year anchor is Ls 0°');
const equinoxSun = marsSubsolarPoint(new Date('2024-09-12T00:00:00Z'));
assert.ok(Math.abs(equinoxSun.lat_deg) < 1e-9, 'subsolar latitude crosses the equator at Ls 0°');
assert.ok(equinoxSun.lon_deg >= -180 && equinoxSun.lon_deg < 180, 'subsolar longitude is normalized');
assert.deepEqual(
    PERSEVERANCE_MISSION.latest_drive.position,
    {
        lat_deg: 18.42638931,
        lon_deg: 77.22455732,
        elevation_m: -1963.64,
        source: 'https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json',
    },
    'latest drive position is pinned to NASA MMGIS sol 1940',
);
assert.deepEqual(
    observationFreshness({ terrestrial_date: '2024-04-27' }, new Date('2026-08-05T20:00:00Z')),
    { status: 'historical', age_days: 830 },
    'the last public daily MEDA summary cannot be mislabeled recent',
);
assert.deepEqual(
    observationFreshness({ terrestrial_date: '2026-08-04' }, new Date('2026-08-05T20:00:00Z')),
    { status: 'recent', age_days: 1 },
);

console.log('mars-mission-state: positions, mission clock, solar geometry, LMST, and freshness assertions passed');
