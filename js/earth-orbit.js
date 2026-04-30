/**
 * earth-orbit.js — High-precision Earth ephemeris via VSOP87D truncated series
 *
 * Replaces the Meeus 3-term equation of center used in horizons.js with a
 * full VSOP87D development (Bretagnon & Francou 1988) for sub-arcsecond
 * heliocentric longitude, latitude and radius accuracy.
 *
 * ACCURACY (truncated series, ~40 L0 terms):
 *   Heliocentric longitude  < 1″  for  1900–2100
 *   Heliocentric latitude   < 0.1″
 *   Heliocentric radius     < 0.000001 AU
 *
 * EXPORTS
 * ───────
 *   vsop87Earth(jd)    → { L_rad, B_rad, R_AU, x_AU, y_AU, z_AU }
 *   earthOrbitFull(jd) → full orbital state (see below)
 *
 * earthOrbitFull returns:
 *   Position        L_rad, B_rad, R_AU, x_AU, y_AU, z_AU, lon_rad, lat_rad, dist_AU
 *   Velocity        vx_km_s, vy_km_s, vz_km_s, speed_km_s
 *   Anomalies       nu_rad/deg (true), E_rad/deg (eccentric), M_rad/deg (mean)
 *   Elements        a, e, omega_bar_deg, r_perihelion_AU, r_aphelion_AU
 *   Perihelion/aph  days_to_perihelion, days_to_aphelion, date_next_perihelion/aphelion
 *   Carrington      carrington_number, carrington_lon
 *   Nutation        dpsi_deg, deps_deg, obliquity_deg
 *   Lagrange        lagrange.{L1,L2,L3,L4,L5} each { x_AU, y_AU, z_AU, dist_AU }
 */

// Inline jdNow to avoid circular dependency with horizons.js
const _jdNow = () => Date.now() / 86400000 + 2440587.5;

const D2R    = Math.PI / 180;
const R2D    = 180 / Math.PI;
const AU_KM  = 149597870.7;          // 1 AU in km
const MU     = 3.003467e-6;          // m_Earth / m_Sun (includes Moon system)

// ── VSOP87D series: each entry [A, B, C] → A · cos(B + C·τ)
// τ = Julian millennia from J2000.0 = (JDE − 2451545.0) / 365250

// ── Earth Longitude (L) ───────────────────────────────────────────────────────

const L0 = [
    [175347046, 0,        0          ],
    [3341656,   4.6692568, 6283.0758500],
    [34894,     4.62610,  12566.15170 ],
    [3497,      2.7441,   5753.3849   ],
    [3418,      2.8289,   3.5231      ],
    [3136,      3.6277,   77713.7715  ],
    [2676,      4.4181,   7860.4194   ],
    [2343,      6.1352,   3930.2097   ],
    [1324,      0.7425,   11506.7698  ],
    [1273,      2.0371,   529.6910    ],
    [1199,      1.1096,   1577.3435   ],
    [990,       5.233,    5884.927    ],
    [902,       2.045,    26.298      ],
    [857,       3.508,    398.149     ],
    [780,       1.179,    5223.694    ],
    [753,       2.533,    5507.553    ],
    [505,       4.583,    18849.228   ],
    [492,       4.205,    775.523     ],
    [357,       2.920,    0.067       ],
    [317,       5.849,    11790.629   ],
    [284,       1.899,    796.298     ],
    [271,       0.315,    10977.079   ],
    [243,       0.345,    5486.778    ],
    [206,       4.806,    2544.314    ],
    [205,       1.869,    5573.143    ],
    [202,       2.458,    6069.777    ],
    [156,       0.833,    213.299     ],
    [132,       3.411,    2942.463    ],
    [126,       1.083,    20.775      ],
    [115,       0.645,    0.980       ],
    [103,       0.636,    4694.003    ],
    [99,        6.21,     15720.84    ],
    [98,        0.68,     7084.90     ],
    [86,        5.98,     161000.69   ],
    [72,        1.14,     5088.63     ],
    [68,        1.87,     801.82      ],
    [67,        4.41,     10447.39    ],
    [59,        2.89,     9437.76     ],
    [56,        2.17,     10213.29    ],
    [45,        0.40,     5614.73     ],
    [36,        0.47,     2146.17     ],
    [29,        2.65,     9779.11     ],
    [21,        5.34,     1349.87     ],
    [19,        1.85,     4690.48     ],
    [19,        4.97,     748.69      ],
    [17,        2.99,     21.34       ],
    [16,        1.43,     7234.79     ],
    [15,        1.21,     14712.32    ],
    [12,        2.83,     1748.02     ],
    [12,        5.27,     1194.45     ],
];

const L1 = [
    [628331966747, 0,        0          ],
    [206059,       2.678235, 6283.075850 ],
    [4303,         2.6351,   12566.1517  ],
    [425,          1.590,    3.523       ],
    [119,          5.796,    26.298      ],
    [109,          2.966,    1577.344    ],
    [93,           2.59,     18849.23    ],
    [72,           1.14,     529.69      ],
    [68,           1.87,     398.15      ],
    [67,           4.41,     5507.55     ],
    [59,           2.89,     5223.69     ],
    [56,           2.17,     155.42      ],
    [45,           0.40,     796.30      ],
    [36,           0.47,     775.52      ],
    [29,           2.65,     7.11        ],
    [21,           5.34,     0.98        ],
    [19,           1.85,     5486.78     ],
    [19,           4.97,     213.30      ],
    [17,           2.99,     6275.96     ],
    [16,           0.03,     2544.31     ],
    [16,           1.43,     2146.17     ],
    [15,           1.21,     10977.08    ],
    [12,           2.83,     1748.02     ],
    [12,           3.26,     5088.63     ],
    [12,           5.27,     1194.45     ],
    [12,           2.08,     4694.00     ],
    [11,           0.77,     553.57      ],
    [10,           1.30,     6286.60     ],
    [10,           4.24,     1349.87     ],
    [9,            2.70,     242.73      ],
    [9,            5.64,     951.72      ],
    [8,            5.30,     2352.87     ],
];

const L2 = [
    [52919, 0,      0        ],
    [8720,  1.0721, 6283.0758],
    [309,   0.867,  12566.152],
    [27,    0.05,   3.52     ],
    [16,    5.19,   26.30    ],
    [16,    3.68,   155.42   ],
    [10,    0.76,   18849.23 ],
    [9,     2.06,   77713.77 ],
    [7,     0.83,   775.52   ],
    [5,     4.66,   1577.34  ],
    [4,     1.03,   7.11     ],
    [4,     3.44,   5573.14  ],
    [3,     5.14,   796.30   ],
    [3,     6.05,   5507.55  ],
    [3,     1.19,   242.73   ],
    [3,     6.12,   529.69   ],
    [3,     0.31,   398.15   ],
    [3,     2.28,   553.57   ],
    [2,     4.38,   5223.69  ],
    [2,     3.75,   0.98     ],
];

const L3 = [
    [289, 5.844, 6283.076 ],
    [35,  0,     0        ],
    [17,  5.49,  12566.15 ],
    [3,   5.20,  155.42   ],
    [1,   4.72,  3.52     ],
    [1,   5.30,  18849.23 ],
    [1,   5.97,  242.73   ],
];

const L4 = [
    [114, 3.142, 0       ],
    [8,   4.13,  6283.08 ],
    [1,   3.84,  12566.15],
];

const L5 = [
    [1, 3.14, 0],
];

// ── Earth Latitude (B) ────────────────────────────────────────────────────────

const B0 = [
    [280, 3.199, 84334.662],
    [102, 5.422, 5507.553  ],
    [80,  3.88,  5223.69   ],
    [44,  3.70,  2352.87   ],
    [32,  4.00,  1577.34   ],
];

const B1 = [
    [9, 3.90, 5507.55],
    [6, 1.73, 5223.69],
];

// ── Earth Radius (R) ──────────────────────────────────────────────────────────

const R0 = [
    [100013989, 0,        0          ],
    [1670700,   3.0984635, 6283.0758500],
    [13956,     3.05525,  12566.15170 ],
    [3084,      5.1985,   77713.7715  ],
    [1628,      1.1739,   5753.3849   ],
    [1576,      2.8469,   7860.4194   ],
    [925,       5.453,    11506.770   ],
    [542,       4.564,    3930.210    ],
    [472,       3.661,    5884.927    ],
    [346,       0.964,    5507.553    ],
    [329,       5.900,    5223.694    ],
    [307,       0.299,    5573.143    ],
    [243,       4.273,    11790.629   ],
    [212,       5.847,    1577.344    ],
    [186,       5.022,    10977.079   ],
    [175,       3.012,    18849.228   ],
    [110,       5.055,    5486.778    ],
    [98,        0.89,     6069.78     ],
    [86,        5.69,     15720.84    ],
    [86,        1.27,     161000.69   ],
    [65,        0.27,     17260.15    ],
    [63,        0.92,     529.69      ],
    [57,        2.01,     83996.85    ],
    [56,        5.24,     71430.70    ],
    [49,        3.25,     2544.31     ],
    [47,        2.58,     775.52      ],
    [45,        5.54,     9437.76     ],
    [43,        6.01,     10447.39    ],
    [39,        5.36,     5573.14     ],
    [38,        2.39,     1748.02     ],
    [37,        0.83,     7084.90     ],
    [37,        4.90,     14712.32    ],
    [36,        1.67,     4694.00     ],
    [35,        1.84,     4690.48     ],
    [33,        0.24,     13916.02    ],
    [32,        0.18,     12036.46    ],
    [32,        1.78,     5088.63     ],
    [28,        1.21,     5765.85     ],
    [28,        1.89,     7058.60     ],
    [26,        3.20,     10213.29    ],
];

const R1 = [
    [103019, 1.107490, 6283.075850],
    [1721,   1.0644,   12566.1517  ],
    [702,    3.142,    0           ],
    [32,     1.02,     18849.23    ],
    [31,     2.84,     5507.55     ],
    [25,     1.32,     5223.69     ],
    [18,     1.42,     1577.34     ],
    [10,     5.91,     10977.08    ],
    [9,      1.42,     6275.96     ],
    [9,      0.27,     5486.78     ],
];

const R2 = [
    [4359, 5.7846, 6283.0758 ],
    [124,  5.579,  12566.152  ],
    [12,   3.14,   0          ],
    [9,    3.63,   77713.77   ],
    [6,    1.87,   5573.14    ],
    [3,    5.47,   18849.23   ],
];

const R3 = [
    [145, 4.273, 6283.076 ],
    [7,   3.92,  12566.15  ],
];

const R4 = [
    [4, 2.56, 6283.08],
];

// ── Core evaluation ───────────────────────────────────────────────────────────

/** Evaluate one VSOP87 sub-series at millennia τ. */
function _evalSeries(series, tau) {
    let sum = 0;
    for (const [A, B, C] of series) sum += A * Math.cos(B + C * tau);
    return sum;
}

/**
 * Raw VSOP87D Earth position.
 * @param {number} jd  Julian Day Number
 * @returns {{ L_rad, B_rad, R_AU, x_AU, y_AU, z_AU }}
 */
export function vsop87Earth(jd) {
    const tau = (jd - 2451545.0) / 365250.0;   // Julian millennia from J2000
    const t2  = tau * tau, t3 = t2 * tau, t4 = t3 * tau, t5 = t4 * tau;

    const L_raw = _evalSeries(L0, tau)
                + _evalSeries(L1, tau) * tau
                + _evalSeries(L2, tau) * t2
                + _evalSeries(L3, tau) * t3
                + _evalSeries(L4, tau) * t4
                + _evalSeries(L5, tau) * t5;

    const B_raw = _evalSeries(B0, tau)
                + _evalSeries(B1, tau) * tau;

    const R_raw = _evalSeries(R0, tau)
                + _evalSeries(R1, tau) * tau
                + _evalSeries(R2, tau) * t2
                + _evalSeries(R3, tau) * t3
                + _evalSeries(R4, tau) * t4;

    // Convert from VSOP87 internal units
    let L_rad = (L_raw * 1e-8) % (2 * Math.PI);
    if (L_rad < 0) L_rad += 2 * Math.PI;
    const B_rad = B_raw * 1e-8;
    const R_AU  = R_raw * 1e-8;

    // Heliocentric ecliptic Cartesian
    const cosB = Math.cos(B_rad);
    const x_AU = R_AU * cosB * Math.cos(L_rad);
    const y_AU = R_AU * cosB * Math.sin(L_rad);
    const z_AU = R_AU * Math.sin(B_rad);

    return { L_rad, B_rad, R_AU, x_AU, y_AU, z_AU };
}

// ── Full orbital state ────────────────────────────────────────────────────────

/**
 * Complete Earth orbital state at the given Julian Day.
 *
 * Includes: VSOP87 position, numerical velocity, orbital anomalies,
 * orbital elements, perihelion/aphelion dates, Carrington rotation,
 * nutation/obliquity, and all 5 Sun–Earth Lagrange points.
 *
 * @param {number} [jd]  Julian Day Number (defaults to now)
 */
export function earthOrbitFull(jd = _jdNow()) {
    const T   = (jd - 2451545.0) / 36525.0;   // Julian centuries

    // ── VSOP87 position ──────────────────────────────────────────────────────
    const pos = vsop87Earth(jd);

    // ── Orbital elements (current epoch) ────────────────────────────────────
    const a = 1.000001018;   // semi-major axis (AU) — essentially constant
    const e = Math.max(0.001, 0.016708634 - 0.000042037 * T - 0.0000001267 * T * T);

    // Longitude of perihelion (ω̄ = Ω + ω), precessing ~1.72°/century
    const omega_bar_deg = 102.93735 + 1.71946 * T + 0.00046 * T * T;
    const omega_bar_rad = omega_bar_deg * D2R;

    // ── True anomaly from current radius + orbital elements ──────────────────
    // cos(ν) = (p/r − 1) / e  where p = a(1−e²) is the semi-latus rectum
    const p        = a * (1 - e * e);
    const cos_nu   = Math.max(-1, Math.min(1, (p / pos.R_AU - 1) / e));
    const nu_abs   = Math.acos(cos_nu);

    // Sign: ν > 0 (approaching aphelion) when heliocentric longitude > ω̄
    let diff = pos.L_rad - omega_bar_rad;
    diff     = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;   // normalise to (−π, π)
    const nu_rad = diff >= 0 ? nu_abs : 2 * Math.PI - nu_abs;

    // ── Eccentric anomaly from true anomaly ──────────────────────────────────
    const tan_half_nu = Math.tan(nu_rad / 2);
    const tan_half_E  = Math.sqrt((1 - e) / (1 + e)) * tan_half_nu;
    const E_rad       = 2 * Math.atan(tan_half_E);

    // ── Mean anomaly (Kepler's equation) ─────────────────────────────────────
    const M_rad_raw  = E_rad - e * Math.sin(E_rad);
    const M_rad      = ((M_rad_raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

    // ── Perihelion / aphelion dates ──────────────────────────────────────────
    const r_peri = a * (1 - e);   // perihelion distance (AU)
    const r_aph  = a * (1 + e);   // aphelion  distance (AU)

    // Orbital period: Kepler's 3rd law (T in days, a in AU)
    const T_orb   = 365.25 * Math.pow(a, 1.5);   // ≈ 365.25 days
    const n       = 2 * Math.PI / T_orb;          // mean motion (rad/day)

    // Days until M wraps back to 0 (perihelion)
    const days_to_peri = ((2 * Math.PI - M_rad) / n + T_orb) % T_orb;

    // Days until M reaches π (aphelion)
    const M_to_aph   = ((Math.PI - M_rad) + 2 * Math.PI) % (2 * Math.PI);
    const days_to_aph = M_to_aph / n;

    const ms_peri = (jd + days_to_peri - 2440587.5) * 86400000;
    const ms_aph  = (jd + days_to_aph  - 2440587.5) * 86400000;

    // ── Velocity — numerical central difference (±1 min) ────────────────────
    const dt    = 1 / 1440;                   // 1 minute in JD days
    const posP  = vsop87Earth(jd + dt);
    const posM  = vsop87Earth(jd - dt);
    const scale = AU_KM / (86400 * 2 * dt);   // AU/day → km/s

    const vx_km_s = (posP.x_AU - posM.x_AU) * scale;
    const vy_km_s = (posP.y_AU - posM.y_AU) * scale;
    const vz_km_s = (posP.z_AU - posM.z_AU) * scale;
    const speed_km_s = Math.sqrt(vx_km_s ** 2 + vy_km_s ** 2 + vz_km_s ** 2);

    // ── Carrington rotation ──────────────────────────────────────────────────
    // Rotation #1 started at JD 2398167.4 (Nov 9, 1853)
    const CR_EPOCH  = 2398167.4;
    const CR_PERIOD = 27.2753;   // synodic rotation period (days)

    const cr_cycles = (jd - CR_EPOCH) / CR_PERIOD;
    const cr_number = Math.floor(cr_cycles) + 1;
    const cr_frac   = cr_cycles - Math.floor(cr_cycles);
    const cr_lon    = ((360 * (1 - cr_frac)) % 360 + 360) % 360;

    // ── Nutation (Meeus Ch.22, main terms) ──────────────────────────────────
    const Omega  = (125.04452 - 1934.136261 * T) * D2R;   // Moon's ascending node
    const L_sun  = (280.4665  +  36000.7698 * T) * D2R;   // Sun mean longitude
    const L_moon = (218.3165  + 481267.8813 * T) * D2R;   // Moon mean longitude

    const dpsi_deg = (-17.20 * Math.sin(Omega)
                      - 1.32 * Math.sin(2 * L_sun)
                      - 0.23 * Math.sin(2 * L_moon)
                      + 0.21 * Math.sin(2 * Omega)) / 3600;

    const deps_deg = (9.20 * Math.cos(Omega)
                    + 0.57 * Math.cos(2 * L_sun)
                    + 0.10 * Math.cos(2 * L_moon)
                    - 0.09 * Math.cos(2 * Omega)) / 3600;

    const eps0_deg    = 23.439291 - 0.013004 * T - 1.64e-7 * T * T + 5.04e-7 * T * T * T;
    const obliquity_deg = eps0_deg + deps_deg;

    // ── Lagrange points (Sun–Earth system) ──────────────────────────────────
    // Hill sphere radius approximation
    const mu_cbrt = Math.pow(MU / 3, 1 / 3);   // ≈ 0.01000

    // Unit vector from Sun to Earth
    const uR = pos.R_AU;
    const ux = pos.x_AU / uR;
    const uy = pos.y_AU / uR;
    const uz = pos.z_AU / uR;

    const r_L1 = pos.R_AU * (1 - mu_cbrt);           // ~0.99 AU
    const r_L2 = pos.R_AU * (1 + mu_cbrt);           // ~1.01 AU
    const r_L3 = pos.R_AU * (1 + 7 * MU / 12);      // ~1.000021 AU on opposite side

    // L4/L5 are 60° ahead/behind Earth on its orbital circle
    const L4_lon = pos.L_rad + Math.PI / 3;   // +60°
    const L5_lon = pos.L_rad - Math.PI / 3;   // −60°
    const cosB   = Math.cos(pos.B_rad);
    const sinB   = Math.sin(pos.B_rad);

    const lagrange = {
        L1: {
            x_AU: ux * r_L1, y_AU: uy * r_L1, z_AU: uz * r_L1,
            dist_AU: r_L1,
            dist_km: r_L1 * AU_KM,
        },
        L2: {
            x_AU: ux * r_L2, y_AU: uy * r_L2, z_AU: uz * r_L2,
            dist_AU: r_L2,
            dist_km: r_L2 * AU_KM,
        },
        L3: {
            x_AU: -ux * r_L3, y_AU: -uy * r_L3, z_AU: -uz * r_L3,
            dist_AU: r_L3,
        },
        L4: {
            x_AU: pos.R_AU * cosB * Math.cos(L4_lon),
            y_AU: pos.R_AU * cosB * Math.sin(L4_lon),
            z_AU: pos.R_AU * sinB,
            dist_AU: pos.R_AU,
        },
        L5: {
            x_AU: pos.R_AU * cosB * Math.cos(L5_lon),
            y_AU: pos.R_AU * cosB * Math.sin(L5_lon),
            z_AU: pos.R_AU * sinB,
            dist_AU: pos.R_AU,
        },
    };

    return {
        // ── Position ─────────────────────────────────────────────────────────
        L_rad:    pos.L_rad,
        B_rad:    pos.B_rad,
        R_AU:     pos.R_AU,
        x_AU:     pos.x_AU,
        y_AU:     pos.y_AU,
        z_AU:     pos.z_AU,
        lon_rad:  pos.L_rad,   // alias for horizons.js compatibility
        lat_rad:  pos.B_rad,
        dist_AU:  pos.R_AU,

        // ── Velocity ─────────────────────────────────────────────────────────
        vx_km_s,
        vy_km_s,
        vz_km_s,
        speed_km_s,

        // ── Anomalies ────────────────────────────────────────────────────────
        nu_rad,   nu_deg: ((nu_rad * R2D) % 360 + 360) % 360,
        E_rad,    E_deg:  E_rad * R2D,
        M_rad,    M_deg:  M_rad * R2D,

        // ── Orbital elements ─────────────────────────────────────────────────
        a,
        e,
        omega_bar_deg,
        omega_bar_rad,
        r_perihelion_AU: r_peri,
        r_aphelion_AU:   r_aph,

        // ── Perihelion / aphelion timing ──────────────────────────────────────
        days_to_perihelion:    days_to_peri,
        days_to_aphelion:      days_to_aph,
        date_next_perihelion:  new Date(ms_peri),
        date_next_aphelion:    new Date(ms_aph),

        // ── Carrington ───────────────────────────────────────────────────────
        carrington_number: cr_number,
        carrington_lon:    cr_lon,   // degrees (0–360, decreases with time)

        // ── Nutation & obliquity ─────────────────────────────────────────────
        dpsi_deg,
        deps_deg,
        obliquity_deg,

        // ── Lagrange points ──────────────────────────────────────────────────
        lagrange,
    };
}
