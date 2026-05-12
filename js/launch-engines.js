/**
 * launch-engines.js — Engine specifications + thrust-comparison reference.
 *
 * Single source of truth for "how much thrust does this rocket actually
 * make?" — used by every vehicle module's info blob and by the live
 * thrust readouts in the planner UI.
 *
 * Sources (public): SpaceX Falcon User's Guide rev. 3, NASA RS-25 fact
 * sheet, Aerojet RSRM fact sheet, SpaceX IAC presentations + Musk public
 * statements for Raptor 2/3 (numbers move; we capture the most recent
 * publicly stated values and date the file).
 *
 * Last data refresh: 2025-Q1.
 *
 * Public API:
 *   ENGINES[id] → { name, sl_kn, vac_kn, isp_sl, isp_vac, propellant }
 *   REFERENCE_THRUSTS → array of { id, label, sl_mn, era } for the
 *     side-panel comparison bar. Includes vehicles we don't render in
 *     3D (Saturn V, SLS) so the user can see where today's hardware
 *     sits relative to the historic benchmarks.
 *   computeStageThrustKn({ engine, count, throttle? })
 *   computeTWR({ thrust_kn, mass_t })
 */

export const ENGINES = {
    merlin_1d: {
        name:       'Merlin 1D',
        sl_kn:      854,
        vac_kn:     981,
        isp_sl:     282,
        isp_vac:    311,
        propellant: 'RP-1 / LOX  (kerolox)',
    },
    merlin_vac: {
        name:       'Merlin Vacuum',
        sl_kn:      0,             // vacuum-optimized; can't fire at SL
        vac_kn:     981,
        isp_sl:     0,
        isp_vac:    348,
        propellant: 'RP-1 / LOX  (kerolox)',
    },
    raptor_2: {
        name:       'Raptor 2',
        sl_kn:      2300,
        vac_kn:     2500,
        isp_sl:     327,
        isp_vac:    350,
        propellant: 'CH4 / LOX  (methalox)',
    },
    raptor_2_vac: {
        name:       'Raptor 2 (Vacuum)',
        sl_kn:      0,
        vac_kn:     2750,
        isp_sl:     0,
        isp_vac:    380,
        propellant: 'CH4 / LOX  (methalox)',
    },
    raptor_3: {
        name:       'Raptor 3',
        sl_kn:      2750,
        vac_kn:     2850,
        isp_sl:     350,
        isp_vac:    380,
        propellant: 'CH4 / LOX  (methalox)',
    },
    rs_25: {
        name:       'RS-25 (SSME)',
        sl_kn:      1860,
        vac_kn:     2279,
        isp_sl:     366,
        isp_vac:    452,
        propellant: 'LH2 / LOX  (hydrolox)',
    },
    rsrm: {
        name:       'RSRM (Solid)',
        sl_kn:      12500,
        vac_kn:     13800,
        isp_sl:     242,
        isp_vac:    268,
        propellant: 'APCP solid',
    },
    f1: {
        name:       'F-1',
        sl_kn:      6770,
        vac_kn:     7770,
        isp_sl:     263,
        isp_vac:    304,
        propellant: 'RP-1 / LOX  (kerolox)',
    },
};

// Reference thrust comparison — the bar chart in the planner side panel
// renders these in order, and highlights whichever entry matches the
// currently-selected vehicle. Historical entries (Saturn V, N-1) are
// marked so the user knows they're benchmarks, not active hardware.

export const REFERENCE_THRUSTS = [
    { id: 'falcon9_b5',     label: 'Falcon 9 Block 5', sl_mn:  7.7, era: 'active'   },
    { id: 'falcon9_heavy',  label: 'Falcon Heavy',     sl_mn: 22.8, era: 'active'   },
    { id: 'shuttle',        label: 'Space Shuttle',    sl_mn: 30.6, era: 'historic' },
    { id: 'saturn_v',       label: 'Saturn V',         sl_mn: 35.1, era: 'historic' },
    { id: 'sls_block_1',    label: 'SLS Block 1',      sl_mn: 39.1, era: 'active'   },
    { id: 'starship_v1',    label: 'Starship V1',      sl_mn: 75.9, era: 'historic' },
    { id: 'starship_v2',    label: 'Starship V2',      sl_mn: 75.9, era: 'active'   },
    { id: 'starship_v3',    label: 'Starship V3',      sl_mn: 96.3, era: 'planned'  },
    { id: 'starship_future',label: 'Starship 12 m ✱',  sl_mn:126.0, era: 'concept'  },
];

// Max for bar normalization. Round up so the active vehicle bar never
// touches the right edge.
export const REFERENCE_MAX_MN = 135;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Total stage thrust in kN.
 *   { engine: 'merlin_1d', count: 9 }      → 7686
 *   { engine: 'raptor_2',  count: 33, throttle: 0.7 } → ~53130
 */
export function computeStageThrustKn({ engine, count, throttle = 1, vacuum = false }) {
    const e = ENGINES[engine];
    if (!e) return 0;
    const per = vacuum ? e.vac_kn : e.sl_kn;
    return per * count * throttle;
}

/**
 * Thrust-to-weight ratio. mass_t in metric tons; thrust_kn in kilonewtons.
 * 1 t·g₀ = 9.80665 kN, so TWR = thrust_kn / (mass_t × 9.80665).
 */
export function computeTWR({ thrust_kn, mass_t }) {
    if (!mass_t) return 0;
    return thrust_kn / (mass_t * 9.80665);
}
