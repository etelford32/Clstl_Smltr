/**
 * js/farside/farside-shader-regions.js — far-side tracks → photosphere shader
 * regions (Tier 5).
 *
 * Both Sun sims on the Space-Weather page feed NOAA active regions into the
 * photosphere shader through a fixed `u_regions` uniform array (max 8 entries of
 * {lat_rad, lon_rad, intensity, complex}). This converts Far-Side Watch tracks
 * into the SAME shape so far-side signatures render on the sun's own surface —
 * placed at their Carrington longitude, they sit on the back of the globe and
 * rotate into Earth view as the sun turns.
 *
 * Budget: far-side regions are capped (`max`) and fed AFTER the front-side ARs,
 * so they only ever fill leftover slots — the real, observed ARs keep priority.
 * Pure + dependency-free so it unit-tests and both engines share it.
 */

const DEG = Math.PI / 180;

/**
 * @param {object[]} tracks  far-side watch tracks ({lon, lat, latestStrength,
 *                           strong, onDisc, ...}) or raw detections
 * @param {object} [opts]    { max=3, includeFront=false }
 * @returns {Array<{lat_deg,lat_rad,lon_carr_deg,lon_rad,intensity,area_norm,is_complex,farSide}>}
 *          strongest-first, far-side only (unless includeFront).
 */
export function tracksToShaderRegions(tracks, opts = {}) {
    const { max = 3, includeFront = false } = opts;
    if (!Array.isArray(tracks)) return [];
    const strengthOf = (t) => t.latestStrength ?? t.peakStrength ?? t.strength ?? 0;
    return tracks
        .filter((t) => typeof t.lon === 'number' && typeof t.lat === 'number')
        .filter((t) => includeFront || t.onDisc !== true)   // far side only by default
        .sort((a, b) => strengthOf(b) - strengthOf(a))
        .slice(0, Math.max(0, max))
        .map((t) => {
            // Modest intensity: far-side is inferred, so it should never outshine
            // an observed front-side AR. `is_complex` stays false (we don't know
            // the magnetic class) so it won't trigger the eruption/pulse paths.
            const intensity = t.strong ? 0.6 : 0.38;
            return {
                lat_deg: t.lat,
                lat_rad: t.lat * DEG,
                lon_carr_deg: t.lon,
                lon_rad: t.lon * DEG,
                intensity,
                area_norm: intensity,
                is_complex: false,
                farSide: true,
            };
        });
}
