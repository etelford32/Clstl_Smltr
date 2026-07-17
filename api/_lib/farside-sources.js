/**
 * api/_lib/farside-sources.js — shared far-side upstream resolution.
 *
 * Single source of truth for the far-side map upstreams, imported by BOTH the
 * browser-facing edge proxy (api/solar/farside.js) and the ingestion cron
 * (api/cron/farside-ingest.js) so the two never drift.
 *
 * The real NSO/ESA archive paths shift over time and may need allow-listing in
 * the deployment's network policy before they resolve, so each upstream is
 * OVERRIDABLE via a Vercel env var with no code change.
 */

// Best-known "latest far-side map" URLs (honest priority order: GONG always,
// imagers when geometry cooperates, HMI as a seismic cross-check).
//
// VERIFIED domains (NSO/Stanford publish far-side maps every 12 h and feed them
// to NOAA SWPC): the canonical far-side site is `farside.nso.edu`; Stanford
// mirrors at `jsoc.stanford.edu/data/farside/` and `soi.stanford.edu/data/full_farside/`;
// composite far-side IMAGES also appear at `sdo.gsfc.nasa.gov/data/`. The exact
// "latest" FITS filename is product-specific and shifts, so set the precise URL
// per deployment via the env override below — the defaults are the directory/
// landing path and a known image fallback, not a guaranteed numeric-grid file.
export const DEFAULT_UPSTREAM = Object.freeze({
    gong:   'https://farside.nso.edu/oQR/fqo/latest.fits',          // set exact file via FARSIDE_GONG_URL
    solo:   'https://www.sidc.be/EUI/data/lastingestednonop/L2/farside_latest.fits',
    stereo: 'https://stereo-ssc.nascom.nasa.gov/beacon/latest_256/ahead_euvi_195_latest.fits',
    hmi:    'http://jsoc.stanford.edu/data/farside/farside_latest.fits',
});

// Image-only fallback for the page backdrop when no numeric FITS is configured.
// sdo.gsfc.nasa.gov is already reachable in prod (see api/solar/aia.js).
export const IMAGE_FALLBACK = Object.freeze({
    gong: 'https://sdo.gsfc.nasa.gov/assets/img/farside/farside_latest.png',
});

export const ENV_KEY = Object.freeze({
    gong:   'FARSIDE_GONG_URL',
    solo:   'FARSIDE_SOLO_URL',
    stereo: 'FARSIDE_STEREO_URL',
    hmi:    'FARSIDE_HMI_URL',
});

export const SOURCES = Object.keys(DEFAULT_UPSTREAM);

/** Resolve the upstream URL for a source, honouring the env override. */
export function resolveUpstream(source) {
    const s = String(source || '').toLowerCase();
    if (!DEFAULT_UPSTREAM[s]) return null;
    return process.env[ENV_KEY[s]] || DEFAULT_UPSTREAM[s];
}

export function isKnownSource(source) {
    return !!DEFAULT_UPSTREAM[String(source || '').toLowerCase()];
}
