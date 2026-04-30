/**
 * soho-feed.js — SOHO/SDO live imagery catalog + STEREO-A beacon images
 *
 * No polling — emits 'soho-update' once on start() with a catalog of the
 * latest SOHO/LASCO and SDO/AIA image URLs, ready to drop straight into
 * <img src="..."> or a WebGL texture loader.
 *
 * STATE EVENT
 * ─────────────────────────────────────────────────────────────────────────────
 *  'soho-update'  { images: { ...SOHO_IMAGES }, stereo_images: { ...STEREO_IMAGES } }
 *
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *  import { SohoFeed } from './js/soho-feed.js';
 *
 *  new SohoFeed().start();
 *  window.addEventListener('soho-update', e => {
 *      document.getElementById('sun-img').src = e.detail.images.sdo_aia193;
 *  });
 *
 * IMAGE SOURCES
 * ─────────────────────────────────────────────────────────────────────────────
 *  SDO (Solar Dynamics Observatory) — updates every ~12 minutes:
 *    AIA 171Å  coronal loops, ~600 000 K          latest_1024_0171.jpg
 *    AIA 193Å  Fe XII corona, ~1.5 MK             latest_1024_0193.jpg
 *    AIA 211Å  active regions, ~2 MK              latest_1024_0211.jpg
 *    AIA 304Å  He II chromosphere, ~50 000 K      latest_1024_0304.jpg
 *    AIA 1600Å UV continuum, transition region     latest_1024_1600.jpg
 *    AIA 131Å  flare plasma, ~10 MK               latest_1024_0131.jpg
 *    HMI IC    continuum (sunspot photosphere)     latest_1024_HMIIC.jpg
 *    HMI Mag   line-of-sight magnetogram           latest_1024_HMIB.jpg
 *
 *  SOHO LASCO (coronagraphs) — updates every ~20–30 minutes:
 *    C2  inner corona,  2–6  solar radii           latest.jpg (c2/1024)
 *    C3  outer corona,  3–30 solar radii           latest.jpg (c3/1024)
 *
 *  STEREO-A SECCHI (behind-the-limb view) — updates ~1–2 hrs:
 *    COR2  outer coronagraph, 2–15 solar radii     (beacon image URL)
 *    EUVI 195Å  EUV full-disk                     (beacon image URL)
 */

'use strict';

/**
 * Static latest-image URL catalog for SDO/AIA, SOHO/LASCO, and SOHO/EIT.
 * All URLs point to NASA's public "latest.jpg" endpoints — no CORS issues,
 * no authentication, no rate limits.  Updated every 12–60 minutes by NASA
 * servers; just reload the <img> src to get a fresh frame.
 */
export const SOHO_IMAGES = {
    // ── SDO / AIA ────────────────────────────────────────────────────────────
    /** AIA 171Å — coronal loops, Fe IX, ~600 000 K (yellow/gold glow) */
    sdo_aia171:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg',
    /** AIA 193Å — Fe XII corona, ~1.5 MK + flare Fe XXIV (green tones) */
    sdo_aia193:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg',
    /** AIA 211Å — active region corona, Fe XIV, ~2 MK (purple/magenta) */
    sdo_aia211:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0211.jpg',
    /** AIA 304Å — He II chromosphere / transition region, ~50 000 K (red) */
    sdo_aia304:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0304.jpg',
    /** AIA 1600Å — UV continuum / C IV, ~100 000 K (white/UV) */
    sdo_aia1600: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_1600.jpg',
    /** AIA 131Å — flare plasma, Fe VIII + Fe XXI, ~10 MK (teal) */
    sdo_aia131:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0131.jpg',
    /** HMI Intensitygram — photospheric continuum, shows sunspots clearly */
    sdo_hmi_ic:  'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg',
    /** HMI Magnetogram — line-of-sight Bfield (black=south, white=north) */
    sdo_hmi_mag: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIB.jpg',

    // ── SOHO / LASCO coronagraphs ─────────────────────────────────────────────
    /** LASCO C2 — inner corona, 2–6 solar radii, ~20-min cadence */
    lasco_c2:    'https://soho.nascom.nasa.gov/data/realtime/c2/1024/latest.jpg',
    /** LASCO C3 — outer corona, 3.7–30 solar radii, CME detection */
    lasco_c3:    'https://soho.nascom.nasa.gov/data/realtime/c3/1024/latest.jpg',

    // ── SOHO / EIT (legacy, 12-min) ───────────────────────────────────────────
    /** EIT 195Å — Fe XII corona (same channel as AIA 193 but lower res) */
    eit_195:     'https://soho.nascom.nasa.gov/data/realtime/eit_195/1024/latest.jpg',
    /** EIT 304Å — He II chromosphere */
    eit_304:     'https://soho.nascom.nasa.gov/data/realtime/eit_304/1024/latest.jpg',
};

/**
 * STEREO-A SECCHI beacon images — transmitted daily from the spacecraft.
 * Lower cadence than SDO (~1–4 hrs between frames).
 */
export const STEREO_IMAGES = {
    /** COR2 outer coronagraph — 2–15 solar radii, CMEs visible from L4 vantage */
    cor2:    'https://stereo-ssc.nascom.nasa.gov/browse/2025/cor2a_latest.jpg',
    /** EUVI 195Å — full-disk EUV from STEREO-A vantage point */
    euvi195: 'https://stereo-ssc.nascom.nasa.gov/browse/2025/euvia_195_latest.jpg',
};

export class SohoFeed {
    /**
     * Emits 'soho-update' once on start() with a catalog of the latest image
     * URLs — no polling needed since the URLs themselves are always "latest".
     * Call refresh() to re-emit the catalog (e.g. to force texture reload).
     */
    start() {
        this._emit();
        return this;
    }

    refresh() { this._emit(); }

    get state() {
        return { images: { ...SOHO_IMAGES }, stereo_images: { ...STEREO_IMAGES } };
    }

    _emit() {
        window.dispatchEvent(new CustomEvent('soho-update', {
            detail: { images: { ...SOHO_IMAGES }, stereo_images: { ...STEREO_IMAGES } },
        }));
    }
}

export default SohoFeed;
