/**
 * api/_lib/tudelft-parse.js — shared TU Delft (Doornbos v02) density parser.
 *
 * Single source of truth for the per-mission URL templates, altitude
 * sanity windows, and the ASCII line parser, imported by BOTH:
 *   - api/density/tudelft.js          (the live Edge relay + R2 mirror)
 *   - scripts/build-density-mirror.mjs (the workstation mirror builder)
 *
 * Keeping the parser here means the bytes the mirror builder writes and
 * the bytes the live fallback parses can never drift apart. Pure JS, no
 * node: deps — safe in Vercel's edge runtime.
 *
 * File format (TU Delft v02): whitespace-separated, one record per line:
 *   YYYY-MM-DDThh:mm:ss   alt_km   lat_deg   lon_deg   density_kg_m3
 * Lines starting with # or % are headers and skipped.
 */

export const PARSER_VERSION = 'tudelft-v02-v1';

// ── Per-mission definitions ────────────────────────────────────────
//
// url_templates  — live-fetch fallback URLs (tried in order). Tokens:
//                  {Y}=year(4), {M}=month(2, zero-padded), {D}=day(2).
// alt_min/max    — outlier-filter window around the mission's orbit.
// mirror_key     — R2 object key the workstation builder uploads to.
//                  Bump the -vN suffix in lockstep with the schema.
export const MISSIONS = {
    grace_fo: {
        url_templates: [
            'http://thermosphere.tudelft.nl/acceldata/GraceFO/v02/density/{Y}/grcfo_density_{Y}_{M}_{D}.txt',
        ],
        alt_min: 200,
        alt_max: 700,
        label: 'GRACE-FO accelerometer density (Doornbos v02)',
        mirror_key: 'hindcast/gannon/density-grace_fo-v1.json',
        file_glob: /^grcfo_density_.*\.txt$/i,
    },
    swarm_c: {
        url_templates: [
            'http://thermosphere.tudelft.nl/acceldata/Swarm/v02/density/SwarmC/{Y}/swrmc_density_{Y}_{M}_{D}.txt',
            'http://thermosphere.tudelft.nl/acceldata/Swarm/v02/density/SwarmC/{Y}/swarmc_density_{Y}_{M}_{D}.txt',
            'http://thermosphere.tudelft.nl/acceldata/SwarmC/v02/density/{Y}/swrmc_density_{Y}_{M}_{D}.txt',
        ],
        alt_min: 200,
        alt_max: 600,
        label: 'Swarm-C accelerometer density (Doornbos v02)',
        mirror_key: 'hindcast/gannon/density-swarm_c-v1.json',
        file_glob: /^sw(r|ar)mc_density_.*\.txt$/i,
    },
};

const COL_COUNT = 5;   // t, alt, lat, lon, rho

/**
 * Parse one TU Delft v02 ASCII line.
 * Returns null on headers / malformed lines / out-of-range altitudes.
 * @returns {{t, t_ms, alt_km, lat_deg, lon_deg, rho_kg_m3} | null}
 */
export function parseTudelftLine(line, altMin, altMax) {
    if (!line) return null;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('%')) return null;
    const parts = trimmed.split(/\s+/);
    if (parts.length < COL_COUNT) return null;

    // Timestamp tolerant of "T" / " " separator and missing trailing Z.
    let ts = parts[0];
    if (!ts.includes('T') && ts.length >= 19 && ts.length <= 23) ts = ts.replace(' ', 'T');
    if (!ts.endsWith('Z')) ts = ts + 'Z';
    const tMs = Date.parse(ts);
    if (!Number.isFinite(tMs)) return null;

    const alt = Number(parts[1]);
    const lat = Number(parts[2]);
    const lon = Number(parts[3]);
    const rho = Number(parts[4]);
    if (![alt, lat, lon, rho].every(Number.isFinite)) return null;
    if (rho <= 0) return null;                       // density strictly positive
    if (alt < altMin || alt > altMax) return null;   // orbit-altitude sanity

    return {
        t:         new Date(tMs).toISOString(),
        t_ms:      tMs,
        alt_km:    alt,
        lat_deg:   lat,
        lon_deg:   lon,
        rho_kg_m3: rho,
    };
}

/** Expand a URL template's {Y}/{M}/{D} tokens for a given UTC Date. */
export function expandTemplate(tpl, d) {
    const Y = String(d.getUTCFullYear());
    const M = String(d.getUTCMonth() + 1).padStart(2, '0');
    const D = String(d.getUTCDate()).padStart(2, '0');
    return tpl.replaceAll('{Y}', Y).replaceAll('{M}', M).replaceAll('{D}', D);
}
