/**
 * constellation-catalog.js — major LEO/MEO satellite constellations
 * ═══════════════════════════════════════════════════════════════════════════
 * Static catalog of the operational constellations users care about
 * when reasoning about the orbital environment. Each entry carries
 * enough Walker-constellation parameters (i:t/p/f) to render a
 * representative shell of dots without needing to fetch and propagate
 * thousands of individual TLEs.
 *
 * This is for VISUALIZATION CONTEXT only — operational fleet
 * propagation should pull live TLEs from /api/celestrak/tle?group=…
 * (see js/satellite-tracker.js for the heavy lift).
 *
 * Walker-Delta notation (Walker 1984): t/p/f
 *   t  = total satellites
 *   p  = number of equally spaced orbital planes
 *   f  = phasing factor (relative phasing between adjacent planes)
 *
 * Inclination + altitude define the shell; the constellation visually
 * appears as a uniformly distributed cloud of t dots in p planes.
 */

export const CONSTELLATIONS = [
    {
        id: 'starlink',
        name: 'Starlink',
        operator: 'SpaceX',
        color: '#60a0ff',
        countActive: 6800,         // Live count varies; tracked Mar 2026
        sampleCount: 200,          // dots rendered for visualization
        shells: [
            { altKm: 550, inclDeg: 53.0,  planes: 72, perPlane: 22 },
            { altKm: 540, inclDeg: 53.2,  planes: 72, perPlane: 22 },
            { altKm: 570, inclDeg: 70.0,  planes:  6, perPlane: 58 },
            { altKm: 560, inclDeg: 97.6,  planes:  4, perPlane: 43 },
        ],
        summary: 'SpaceX Ku-band broadband constellation; primary contributor '
               + 'to LEO traffic and conjunction screening volume.',
    },
    {
        id: 'starlink-v2',
        name: 'Starlink v2 mini',
        operator: 'SpaceX',
        color: '#80b8ff',
        countActive: 1200,
        sampleCount: 80,
        shells: [
            { altKm: 530, inclDeg: 43.0,  planes: 28, perPlane: 30 },
        ],
        summary: 'Larger v2-mini birds in 530 km / 43° shell. Direct-to-cell '
               + 'capability; future Starship-launched v2 full will dwarf this.',
    },
    {
        id: 'oneweb',
        name: 'OneWeb',
        operator: 'Eutelsat OneWeb',
        color: '#a080ff',
        countActive: 650,
        sampleCount: 80,
        shells: [
            { altKm: 1200, inclDeg: 87.9, planes: 18, perPlane: 36 },
        ],
        summary: 'Polar Ku-band constellation at 1200 km. Higher altitude '
               + 'means longer debris-persistence on failure.',
    },
    {
        id: 'iridium',
        name: 'Iridium NEXT',
        operator: 'Iridium',
        color: '#c080ff',
        countActive: 75,
        sampleCount: 75,
        shells: [
            { altKm: 780, inclDeg: 86.4, planes:  6, perPlane: 11 },
        ],
        summary: 'Polar L-band voice + IoT. The Iridium-33 / Cosmos-2251 '
               + 'collision in 2009 was the first major operational COLA '
               + 'wake-up call.',
    },
    {
        id: 'globalstar',
        name: 'Globalstar',
        operator: 'Globalstar',
        color: '#ff80c0',
        countActive: 24,
        sampleCount: 24,
        shells: [
            { altKm: 1414, inclDeg: 52.0, planes: 8, perPlane: 6 },
        ],
        summary: 'Big LEO voice/data; Apple iPhone emergency-SOS partner.',
    },
    {
        id: 'planet',
        name: 'Planet (Dove + SkySat)',
        operator: 'Planet Labs',
        color: '#ffc070',
        countActive: 200,
        sampleCount: 60,
        shells: [
            { altKm: 475, inclDeg: 97.4, planes: 1, perPlane: 100 },
            { altKm: 500, inclDeg: 51.6, planes: 1, perPlane: 80  },
        ],
        summary: 'Earth-imaging cubesats. Many dispensed from ISS so they '
               + 'live just below the station shell.',
    },
    {
        id: 'gps',
        name: 'GPS (Navstar)',
        operator: 'US Space Force',
        color: '#60d8a0',
        countActive: 31,
        sampleCount: 31,
        shells: [
            { altKm: 20180, inclDeg: 55.0, planes: 6, perPlane: 5 },
        ],
        summary: 'L-band PNT in MEO. Conjunction risk much lower at GPS '
               + 'altitude due to lower object density per shell volume.',
        meo: true,
    },
    {
        id: 'galileo',
        name: 'Galileo',
        operator: 'EU / EUSPA',
        color: '#80e0c0',
        countActive: 28,
        sampleCount: 28,
        shells: [
            { altKm: 23222, inclDeg: 56.0, planes: 3, perPlane: 9 },
        ],
        summary: 'European GNSS at 23 200 km. Slightly higher than GPS.',
        meo: true,
    },
    {
        id: 'glonass',
        name: 'GLONASS',
        operator: 'Roscosmos',
        color: '#ffe060',
        countActive: 24,
        sampleCount: 24,
        shells: [
            { altKm: 19130, inclDeg: 64.8, planes: 3, perPlane: 8 },
        ],
        summary: 'Russian GNSS. Highest inclination of the major GNSS '
               + 'systems; better polar coverage.',
        meo: true,
    },
    {
        id: 'beidou-meo',
        name: 'BeiDou-3 MEO',
        operator: 'CNSA',
        color: '#ffa060',
        countActive: 24,
        sampleCount: 24,
        shells: [
            { altKm: 21528, inclDeg: 55.0, planes: 3, perPlane: 8 },
        ],
        summary: 'Chinese GNSS MEO segment. Full system also has IGSO + GEO '
               + 'satellites not modelled here.',
        meo: true,
    },
];

const _BY_ID = Object.fromEntries(CONSTELLATIONS.map(c => [c.id, c]));
export function getConstellation(id) { return _BY_ID[id] || null; }

/**
 * Generate Walker-constellation positions as orbital-element specs,
 * suitable for the existing _propagateKeplerian + _buildProbeLookup
 * machinery in upper-atmosphere-globe.js.
 *
 * Returns up to `cap` element sets evenly distributed across all
 * shells and planes — fewer when shell.planes × shell.perPlane <
 * proportional-to-cap, more when more is requested.
 *
 * @param {object} constellation  one entry from CONSTELLATIONS
 * @param {number} [cap]           upper bound on returned dot count
 *                                (default = constellation.sampleCount)
 * @returns {Array<{
 *   id:string, color:string, altitudeKm:number,
 *   orbital: {
 *     inclinationDeg, raanDeg, argPerigeeDeg,
 *     meanAnomalyDeg0, eccentricity, periodMin
 *   }
 * }>}
 */
export function spawnConstellationPositions(constellation, cap) {
    const limit = Math.min(cap ?? constellation.sampleCount, 500);
    const out = [];

    // Balance the dot budget across shells in proportion to shell.planes
    // × shell.perPlane (i.e. the "true" relative size of the shell).
    let shellTotals = constellation.shells.map(s => s.planes * s.perPlane);
    const grand = shellTotals.reduce((a, b) => a + b, 0);
    if (grand <= 0) return out;

    constellation.shells.forEach((shell, sIdx) => {
        const want = Math.max(1, Math.round(limit * shellTotals[sIdx] / grand));
        const planes = Math.min(shell.planes, Math.max(2, Math.ceil(Math.sqrt(want))));
        const perPl  = Math.max(1, Math.round(want / planes));

        // Walker-Delta f=1 phasing — each consecutive plane shifts the
        // mean-anomaly-at-ascending-node by 360°/t. Approximate t with
        // planes × perPl.
        const t = planes * perPl;

        for (let p = 0; p < planes; p++) {
            const raanDeg = (360 / planes) * p;
            for (let q = 0; q < perPl; q++) {
                const inPlanePhaseDeg = (360 / perPl) * q;
                // f = 1 phasing: M0 of plane p offset by p · 360/t
                const phasingOffsetDeg = (360 / t) * p;
                const M0 = (inPlanePhaseDeg + phasingOffsetDeg) % 360;

                out.push({
                    id: `${constellation.id}-s${sIdx}-p${p}-q${q}`,
                    color: constellation.color,
                    altitudeKm: shell.altKm,
                    _constellationId: constellation.id,
                    orbital: {
                        inclinationDeg:  shell.inclDeg,
                        raanDeg,
                        argPerigeeDeg:    0,
                        meanAnomalyDeg0:  M0,
                        eccentricity:     0.0001,
                        periodMin:        _periodMinFromAlt(shell.altKm),
                    },
                });
                if (out.length >= limit) return;
            }
            if (out.length >= limit) return;
        }
    });

    return out.slice(0, limit);
}

function _periodMinFromAlt(altKm) {
    const RE = 6378.135;
    const MU = 398600.4418;
    const a  = RE + altKm;
    return (2 * Math.PI * Math.sqrt(a * a * a / MU)) / 60;
}
