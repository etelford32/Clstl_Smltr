/**
 * ocean-currents-feed.js — surface ocean current vector field
 * ═══════════════════════════════════════════════════════════════════════════
 * Provides a (lat, lon) → {uMs, vMs, speedMs} probe that approximates the
 * world's major surface currents from oceanographic climatology.
 *
 * NASA GIBS does not ship OSCAR/HYCOM vectors as web-friendly imagery, and the
 * raw NetCDF feeds (PO.DAAC OSCAR, NOAA RTOFS) require auth + server-side
 * decoding that this static-hosted page can't do. To still give the globe a
 * physically meaningful "rivers in the sea" layer, we encode the principal
 * gyres + western boundary currents as a parametric model:
 *
 *   • Wind-driven gyres in each ocean basin (Sverdrup/Stommel circulation):
 *     anticyclonic in the subtropics (~25°), cyclonic in the subpolar
 *     latitudes (~50°). Returns a smooth rotational flow.
 *   • Western boundary intensification baked in via narrow Gaussian "jets"
 *     along well-known current axes (Gulf Stream, Kuroshio, Agulhas, Brazil,
 *     East Australian).
 *   • Equatorial system: westward North/South Equatorial Currents and
 *     eastward Equatorial Counter-Current near 5–8°N.
 *   • Antarctic Circumpolar Current: continuous eastward flow band 45–60°S.
 *
 * Speeds are tuned to reported climatology (Gulf Stream core ≈ 2 m/s, ACC
 * ≈ 0.2 m/s, equatorial currents ≈ 0.3 m/s, gyre interiors ≈ 0.05 m/s).
 *
 * Land mask: all probes return null over major continents using a coarse
 * lat/lon polygon test so particles don't trace currents over Kansas.
 *
 * The feed is purely synchronous & deterministic — there's no network
 * dependency. A future enhancement can blend in real OSCAR data when we add
 * a server-side proxy.
 */

const DEG = Math.PI / 180;

// ── Major surface-current axes ────────────────────────────────────────────
//
// Each entry is a polyline of (lat, lon, speed_ms) waypoints. The probe
// samples nearest-segment distance and applies a Gaussian falloff in the
// transverse direction. Direction at the probe = local segment tangent.
//
// Speed values are climatological surface-core peaks from Talley et al.
// (Descriptive Physical Oceanography, 2011) and AVISO altimetry maps.
//
// Order: tropical → subtropical → subpolar → polar.

const CURRENT_AXES = [
    // ── Equatorial system ─────────────────────────────────────────────
    { name: 'North Equatorial Current (Pacific)',
      sigma: 4, peakMs: 0.45,
      pts: [[12, -260], [11, -200], [10, -150], [10, -120]] },
    { name: 'North Equatorial Current (Atlantic)',
      sigma: 4, peakMs: 0.30,
      pts: [[12, -45], [10, -30], [10, -20]] },
    { name: 'South Equatorial Current (Pacific)',
      sigma: 4, peakMs: 0.50,
      pts: [[-3, -80], [-3, -130], [-4, -180], [-5, -220]] },
    { name: 'South Equatorial Current (Atlantic)',
      sigma: 4, peakMs: 0.40,
      pts: [[-5, 0], [-5, -15], [-5, -30], [-5, -38]] },
    { name: 'South Equatorial Current (Indian)',
      sigma: 4, peakMs: 0.40,
      pts: [[-12, 100], [-12, 80], [-12, 60], [-12, 45]] },
    { name: 'Equatorial Counter Current (Pacific)',
      sigma: 2.5, peakMs: 0.40,
      pts: [[6, -240], [6, -200], [6, -150], [6, -120], [6, -90]] },
    { name: 'Equatorial Counter Current (Atlantic)',
      sigma: 2.5, peakMs: 0.30,
      pts: [[5, -25], [5, -10], [5, 0], [5, 8]] },

    // ── Western boundary currents (Northern Hemisphere) ───────────────
    { name: 'Gulf Stream',
      sigma: 2.5, peakMs: 1.80,
      pts: [[24, -80], [29, -79], [33, -77], [36, -74], [39, -68],
            [41, -60], [42, -50], [44, -40], [48, -30], [52, -22]] },
    { name: 'North Atlantic Drift',
      sigma: 4, peakMs: 0.40,
      // Routed through the open Norwegian Sea (west of Norway),
      // terminating before the Barents Sea coast.
      pts: [[52, -22], [55, -15], [58, -5], [62, 2], [66, 5]] },
    { name: 'Kuroshio',
      sigma: 2.5, peakMs: 1.50,
      pts: [[20, 122], [25, 128], [30, 135], [34, 140], [36, 143],
            [38, 148], [40, 155], [42, 165], [44, 175]] },
    { name: 'North Pacific Current',
      sigma: 4, peakMs: 0.30,
      pts: [[44, 175], [44, -170], [44, -150], [44, -135], [44, -125]] },

    // ── Western boundary currents (Southern Hemisphere) ───────────────
    { name: 'Brazil Current',
      sigma: 3, peakMs: 0.60,
      pts: [[-12, -36], [-20, -38], [-28, -45], [-35, -52], [-40, -55]] },
    { name: 'Agulhas Current',
      sigma: 2.5, peakMs: 1.40,
      pts: [[-25, 35], [-30, 32], [-34, 28], [-37, 22], [-40, 18]] },
    { name: 'Agulhas Retroflection',
      sigma: 3, peakMs: 0.70,
      pts: [[-40, 18], [-42, 22], [-43, 30], [-42, 40], [-40, 50]] },
    { name: 'East Australian Current',
      sigma: 3, peakMs: 0.80,
      pts: [[-20, 154], [-26, 154], [-32, 153], [-37, 151], [-42, 150]] },

    // ── Eastern boundary currents (cold, equatorward) ────────────────
    { name: 'California Current',
      sigma: 3, peakMs: 0.30,
      pts: [[48, -127], [42, -126], [36, -124], [30, -120], [24, -114]] },
    { name: 'Canary Current',
      sigma: 3, peakMs: 0.30,
      pts: [[35, -10], [30, -12], [25, -16], [20, -19], [15, -22]] },
    { name: 'Humboldt (Peru) Current',
      sigma: 3, peakMs: 0.30,
      pts: [[-45, -75], [-35, -73], [-25, -72], [-15, -76], [-5, -82]] },
    { name: 'Benguela Current',
      sigma: 3, peakMs: 0.30,
      pts: [[-34, 18], [-28, 14], [-20, 11], [-12, 10], [-5, 9]] },
    { name: 'West Australian Current',
      sigma: 3, peakMs: 0.20,
      pts: [[-35, 114], [-28, 112], [-20, 110], [-12, 108]] },

    // ── Subpolar gyre limbs ───────────────────────────────────────────
    { name: 'Labrador Current',
      sigma: 2.5, peakMs: 0.40,
      pts: [[68, -55], [62, -55], [55, -53], [48, -50], [42, -52]] },
    { name: 'Oyashio Current',
      sigma: 2.5, peakMs: 0.35,
      pts: [[58, 160], [52, 155], [46, 148], [42, 145]] },

    // ── Antarctic Circumpolar Current (full belt, 0-360 wrapped) ─────
    // Drawn as several segments around the globe so the polyline doesn't
    // wrap badly across the antimeridian.
    { name: 'ACC (Atlantic sector)',
      sigma: 6, peakMs: 0.25,
      pts: [[-55, -50], [-55, -30], [-55, -10], [-54, 10]] },
    { name: 'ACC (Indian sector)',
      sigma: 6, peakMs: 0.25,
      pts: [[-54, 10], [-52, 40], [-52, 70], [-53, 100], [-55, 130]] },
    { name: 'ACC (Pacific sector)',
      sigma: 6, peakMs: 0.25,
      pts: [[-55, 130], [-58, 160], [-60, -170], [-60, -140], [-58, -110],
            [-58, -80], [-58, -65], [-55, -50]] },

    // ── Indian Ocean monsoon mean (annual-mean Somali / Arabian gyre) ──
    { name: 'Somali Current (annual mean)',
      sigma: 2.5, peakMs: 0.60,
      pts: [[2, 48], [6, 51], [10, 52], [12, 55]] },
    { name: 'North Indian (mean)',
      sigma: 4, peakMs: 0.20,
      pts: [[15, 55], [16, 65], [16, 75], [15, 85]] },
];

// ── Subtropical gyre rotation centres ─────────────────────────────────
// (lat, lon, sign) — sign +1 for clockwise (Northern hem anticyclone),
// −1 for counter-clockwise (Southern hem anticyclone). These add a
// gentle background rotation between the boundary jets so gyre interiors
// aren't dead calm.
const GYRE_CENTERS = [
    { lat:  30, lon: -40,  sign:  1, radius: 25, peakMs: 0.10 }, // N Atl
    { lat:  30, lon: 175,  sign:  1, radius: 35, peakMs: 0.10 }, // N Pac
    { lat: -30, lon: -25,  sign: -1, radius: 22, peakMs: 0.08 }, // S Atl
    { lat: -30, lon: -110, sign: -1, radius: 35, peakMs: 0.10 }, // S Pac
    { lat: -30, lon:  75,  sign: -1, radius: 25, peakMs: 0.08 }, // S Ind
    { lat:  50, lon: -35,  sign: -1, radius: 12, peakMs: 0.10 }, // N Atl subpolar
    { lat:  50, lon: 175,  sign: -1, radius: 15, peakMs: 0.10 }, // N Pac subpolar
];

// ── Coarse land mask ─────────────────────────────────────────────────
// Each entry is an axis-aligned (lat, lon) box treated as land. Coarse
// on purpose — we just need the particles to skip continents, not a
// pixel-perfect coastline. Boxes are slightly inset from the true coast
// so currents that hug shores still light up.
// Boxes are *inset* from real coastlines so the major boundary currents
// (Gulf Stream, Kuroshio, Brazil, Agulhas) stay over ocean in the model.
// A few coastal pixels of "land" technically being ocean is a fine
// trade for keeping the western boundary jets on-screen.
const LAND_BOXES = [
    // Continental US (east coast clipped at -77° so the Gulf Stream
    // offshore corridor at lon −75 to −50 reads as ocean).
    [25, 50, -123, -77],
    // Canada interior (well west of the Atlantic)
    [50, 70, -135, -65],
    // Alaska + Yukon
    [55, 72, -168, -135],
    // Central America mainland (east edge at -83 so Caribbean basin
    // and Yucatan channel are ocean).
    [8, 22, -98, -83],
    // South America — split by latitude bands so the box edges follow
    // the meridional variation of the actual coastline. Both major
    // boundary currents (Brazil, Humboldt) ride offshore corridors that
    // these boxes deliberately leave as ocean.
    //
    // Northern (Amazon basin / Guianas)
    [-10, 12, -78, -50],
    // Brazil (eastern bulge, east edge at -38 just inland of Recife)
    [-25, -10, -72, -38],
    // S Brazil + Uruguay + Argentina (east edge at -53 = Argentine coast)
    [-40, -25, -72, -53],
    // Patagonia
    [-55, -40, -72, -64],
    // Greenland (most of it; coastlines beyond are ocean)
    [62, 82, -50, -22],
    // Asia continental block (east edge at 141 leaves Sea of Japan
    // and the Kuroshio offshore corridor as ocean; south edge at 12
    // keeps Bay of Bengal / Arabian Sea / South China Sea open).
    [12, 75, 60, 141],
    // Sakhalin / mainland Far East coast
    [44, 75, 130, 145],
    // Kamchatka peninsula — narrow strip so Oyashio offshore (lon 150-160)
    // stays ocean.
    [51, 62, 156, 163],
    // Continental Europe (south block) — west edge at -2
    [35, 55, -2, 60],
    // Scandinavia + NW Russia (north block) — west edge at 8 so the
    // North Atlantic Drift's Norwegian Sea track (lat 60+, lon 0–7)
    // reads as ocean. Most of Norway's interior sits east of 8°E above
    // 60°N, so this trades a tiny coastal strip for a clean current.
    [55, 72, 8, 60],
    // Iberia / W France (kept south of 49° so the Gulf Stream's
    // northeast branch through the British shelf reads as ocean).
    [36, 49, -10, -2],
    // North Africa + Middle East
    [12, 35, -10, 52],
    // Sub-Saharan Africa (west edge at 14 so Benguela Current at lon 11
    // stays ocean; east edge tucks back inside Mozambique Channel).
    [-30, 12, 14, 40],
    // Australia
    [-37, -13, 115, 150],
    // Antarctica (south of 70°S)
    [-90, -70, -180, 180],
    // Madagascar
    [-25, -12, 44, 50],
    // Indonesia main islands (Sumatra, Borneo, Java) — coarse
    [-8, 5, 100, 140],
    // Japan main islands — east edge at 141 so Kuroshio (140-148) stays ocean
    [33, 44, 130, 141],
    // British Isles main mass (England + Wales + S Scotland) — east edge
    // tucked back to -2 so the Gulf-Stream branch through the North Sea
    // and west of Ireland reads as ocean.
    [51, 56, -7, -2],
];

function isLand(lat, lon) {
    // Normalise lon to [-180, 180].
    let L = lon;
    while (L >  180) L -= 360;
    while (L < -180) L += 360;
    for (let i = 0; i < LAND_BOXES.length; i++) {
        const b = LAND_BOXES[i];
        if (lat >= b[0] && lat <= b[1] && L >= b[2] && L <= b[3]) return true;
    }
    return false;
}

// ── Helpers ───────────────────────────────────────────────────────────

function angularDistDeg(lat1, lon1, lat2, lon2) {
    // Great-circle distance in degrees. Cheap haversine.
    const φ1 = lat1 * DEG, φ2 = lat2 * DEG;
    let dλ  = (lon2 - lon1) * DEG;
    // Wrap longitude difference into [-π, π].
    if (dλ >  Math.PI) dλ -= 2 * Math.PI;
    if (dλ < -Math.PI) dλ += 2 * Math.PI;
    const dφ = φ2 - φ1;
    const a = Math.sin(dφ * 0.5) ** 2 +
              Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ * 0.5) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(a))) / DEG;
}

/** Local east/north unit vectors as (dlat/deg, dlon/deg) pairs. */
function tangentAt(lat, fromLat, fromLon, toLat, toLon) {
    // Compute heading from segment endpoints.
    const φ1 = fromLat * DEG, φ2 = toLat * DEG;
    let dλ = (toLon - fromLon) * DEG;
    if (dλ >  Math.PI) dλ -= 2 * Math.PI;
    if (dλ < -Math.PI) dλ += 2 * Math.PI;
    // Forward azimuth (measured clockwise from north).
    const y = Math.sin(dλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) -
              Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
    const az = Math.atan2(y, x);
    // u (east) = sin(az), v (north) = cos(az).
    return { u: Math.sin(az), v: Math.cos(az) };
}

function projectOnSegment(lat, lon, aLat, aLon, bLat, bLon) {
    // Equirectangular projection at the segment midpoint — fine for the
    // sigma scales we use (≤ ~6° transverse). Returns { t, distDeg }
    // where t∈[0,1] is the along-segment parameter and distDeg is the
    // transverse great-circle distance in degrees.
    const midLat = 0.5 * (aLat + bLat);
    const cosM   = Math.max(0.1, Math.cos(midLat * DEG));
    const ax = (aLon) * cosM, ay = aLat;
    const bx = (bLon) * cosM, by = bLat;
    let   px = (lon)  * cosM, py = lat;

    // Handle ±180 wrap by shifting probe by ±360·cosM if it improves match.
    const wrap = 360 * cosM;
    const candidates = [px, px + wrap, px - wrap];
    let best = null;
    for (const cx of candidates) {
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        if (len2 < 1e-9) continue;
        let t = ((cx - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        const qx = ax + t * dx, qy = ay + t * dy;
        const d = Math.hypot(cx - qx, py - qy);
        if (!best || d < best.distDeg) best = { t, distDeg: d, lon: cx / cosM };
    }
    return best;
}

// ── Public probe ──────────────────────────────────────────────────────

/**
 * @typedef {{uMs:number, vMs:number, speedMs:number}} CurrentSample
 *  - u positive = eastward, v positive = northward (oceanographic convention)
 *  - speedMs = sqrt(u² + v²)
 *
 * Returns null on land or where the model gives no signal.
 */
export function lookupOceanCurrent(lat, lon) {
    if (lat > 82 || lat < -82) return null;       // skip near-poles (singular)
    if (isLand(lat, lon))      return null;

    let u = 0, v = 0;          // accumulated (east, north) m/s

    // ── Boundary-jet contributions ────────────────────────────────────
    for (let a = 0; a < CURRENT_AXES.length; a++) {
        const ax = CURRENT_AXES[a];
        const pts = ax.pts;
        let bestSeg = null;
        for (let i = 0; i < pts.length - 1; i++) {
            const p0 = pts[i], p1 = pts[i + 1];
            const proj = projectOnSegment(lat, lon, p0[0], p0[1], p1[0], p1[1]);
            if (!proj) continue;
            if (!bestSeg || proj.distDeg < bestSeg.distDeg) {
                bestSeg = { ...proj, p0, p1 };
            }
        }
        if (!bestSeg) continue;

        // Transverse Gaussian falloff. Hard cut-off at 3·sigma so far-field
        // probes don't accumulate noise from every axis on the planet.
        if (bestSeg.distDeg > 3 * ax.sigma) continue;
        const w = Math.exp(-0.5 * (bestSeg.distDeg / ax.sigma) ** 2);

        const tang = tangentAt(lat,
            bestSeg.p0[0], bestSeg.p0[1],
            bestSeg.p1[0], bestSeg.p1[1]);
        u += w * ax.peakMs * tang.u;
        v += w * ax.peakMs * tang.v;
    }

    // ── Subtropical / subpolar gyre rotation ──────────────────────────
    // Inside each gyre disc, add a solid-body rotation contribution that
    // tapers with distance from centre. Anticyclonic in the subtropics
    // (high-pressure cell at sea surface, Coriolis steers the surface
    // current clockwise in N-hem and counter-clockwise in S-hem).
    for (let g = 0; g < GYRE_CENTERS.length; g++) {
        const G = GYRE_CENTERS[g];
        const d = angularDistDeg(lat, lon, G.lat, G.lon);
        if (d > G.radius) continue;
        const w = (1 - d / G.radius);   // 1 at centre → 0 at edge
        // Tangential direction = perpendicular to the centre→probe vector.
        // Build that vector in equirectangular space, then rotate by ±90°.
        const cosLat = Math.max(0.1, Math.cos(G.lat * DEG));
        const dx = (lon - G.lon) * cosLat;
        const dy = (lat - G.lat);
        const r  = Math.hypot(dx, dy);
        if (r < 1e-3) continue;
        // Normalised centre→probe unit vector.
        const ex = dx / r, ey = dy / r;
        // Tangent: rotate (ex, ey) by +90° gives (-ey, ex). For
        // sign=+1 (clockwise when viewed from above) that becomes
        // (ey, -ex). Multiply both by sign.
        const tu = -G.sign * ey;        // east component
        const tv =  G.sign * ex;        // north component
        u += w * G.peakMs * tu;
        v += w * G.peakMs * tv;
    }

    const speedMs = Math.hypot(u, v);
    if (speedMs < 1e-3) return null;
    return { uMs: u, vMs: v, speedMs };
}

/**
 * Return a static dataset descriptor for status pip + panel readouts.
 */
export function oceanCurrentsMeta() {
    return {
        name:    'Surface Currents (climatology)',
        source:  'Talley et al. 2011 + AVISO climatology, parametric model',
        time:    null,
        updated: new Date(),
        status:  'live',
        unit:    'm/s',
        description:
            'Major surface currents: Gulf Stream, Kuroshio, Agulhas, ACC, ' +
            'equatorial system, eastern boundary cold currents, gyre flow.',
    };
}
