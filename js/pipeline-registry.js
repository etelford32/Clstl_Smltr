/**
 * pipeline-registry.js — single source of truth for the API surface
 * ═══════════════════════════════════════════════════════════════════════════
 * Every consumer of "the list of pipelines we serve" should import from
 * here:
 *
 *   - status.html          probes each entry to surface freshness
 *   - api/cron/prewarm-*   pre-warms entries by `prewarm` tier so cold
 *                          visitor requests always hit a warm Edge cache
 *   - admin.html           pipeline-health dashboard
 *
 * Adding a new endpoint? Append it here once. Status page picks it up
 * automatically; the right pre-warm cron picks it up on next cron tick.
 *
 * Field reference
 *   id          stable kebab-case key (used by status panel)
 *   label       human display name
 *   endpoint    same-origin path Vercel serves
 *   category    'space-weather' | 'events' | 'atmosphere' | 'weather' |
 *               'orbital' | 'admin'
 *   upstream    short label for the data origin
 *   cadence_s   upstream publish cadence (seconds). Drives the warn/crit
 *               freshness thresholds; also the cache TTL ceiling.
 *   prewarm     'hot' (5 min) | 'medium' (30 min) | 'cold' (6 h) | null
 *               null = not pre-warmed (admin-only, write-only, or
 *               event-driven only). Cron jobs filter on this.
 *   warnAgeS    age above which the status pill goes amber
 *   critAgeS    age above which the status pill goes red
 *   notes       optional one-liner — why this exists, gotchas
 */

export const PIPELINES = [
    // ── Space weather · NOAA SWPC live feeds ───────────────────────────────
    { id: 'noaa-kp-1m',         label: 'NOAA Kp 1-min',
      endpoint: '/api/noaa/kp-1m',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  30 * 60, critAgeS: 120 * 60,
      notes: 'Drives Surface Outlook + auroral oval projection.' },

    { id: 'noaa-xray',          label: 'NOAA GOES X-ray',
      endpoint: '/api/noaa/xray',
      category: 'space-weather', upstream: 'NOAA GOES XRS',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  30 * 60, critAgeS: 120 * 60 },

    { id: 'noaa-protons',       label: 'NOAA proton flux',
      endpoint: '/api/noaa/protons',
      category: 'space-weather', upstream: 'NOAA GOES SEISS',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  30 * 60, critAgeS: 120 * 60 },

    { id: 'noaa-electrons',     label: 'NOAA electron flux',
      endpoint: '/api/noaa/electrons',
      category: 'space-weather', upstream: 'NOAA GOES MAGED',
      cadence_s: 300,   prewarm: 'hot',
      warnAgeS:  60 * 60, critAgeS: 240 * 60 },

    { id: 'noaa-dst',           label: 'NOAA Dst index',
      endpoint: '/api/noaa/dst',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 300,   prewarm: 'hot',
      warnAgeS:  60 * 60, critAgeS: 240 * 60 },

    { id: 'noaa-radio-flux',    label: 'NOAA F10.7 cm flux',
      endpoint: '/api/noaa/radio-flux',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 86_400, prewarm: 'cold',
      warnAgeS:  36 * 3600, critAgeS: 72 * 3600 },

    { id: 'noaa-aurora',        label: 'NOAA OVATION aurora',
      endpoint: '/api/noaa/aurora',
      category: 'space-weather', upstream: 'NOAA OVATION',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 240 * 60 },

    { id: 'noaa-alerts',        label: 'NOAA alerts',
      endpoint: '/api/noaa/alerts',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 300,   prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'noaa-regions',       label: 'NOAA active regions',
      endpoint: '/api/noaa/regions',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 86_400, prewarm: 'cold',
      warnAgeS:  36 * 3600, critAgeS: 72 * 3600 },

    { id: 'noaa-flares',        label: 'NOAA flare list',
      endpoint: '/api/noaa/flares',
      category: 'space-weather', upstream: 'NOAA GOES XRS',
      cadence_s: 300,   prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 240 * 60 },

    { id: 'noaa-forecast-3day', label: 'NOAA 3-day forecast',
      endpoint: '/api/noaa/forecast-3day',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  9 * 3600, critAgeS: 24 * 3600 },

    // ── Solar wind ─────────────────────────────────────────────────────────
    { id: 'solar-wind-latest',  label: 'DSCOVR/ACE latest',
      endpoint: '/api/solar-wind/latest',
      category: 'space-weather', upstream: 'NOAA SWPC RTSW',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  10 * 60, critAgeS: 30 * 60,
      notes: 'Supabase ring buffer fed by /api/cron/refresh-solar-wind every 2 min (canonical) + browser write-throughs via /api/solar-wind/ingest (deduped on UNIQUE observed_at,source).' },

    { id: 'solar-wind-speed',   label: 'Solar wind speed',
      endpoint: '/api/solar-wind/wind-speed',
      category: 'space-weather', upstream: 'NOAA SWPC RTSW',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  10 * 60, critAgeS: 30 * 60 },

    // ── DONKI · NASA event feeds ───────────────────────────────────────────
    { id: 'donki-cme',          label: 'DONKI CME analysis',
      endpoint: '/api/donki/cme',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-flares',       label: 'DONKI flares',
      endpoint: '/api/donki/flares',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-gst',          label: 'DONKI geomag storms',
      endpoint: '/api/donki/gst',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-sep',          label: 'DONKI SEP events',
      endpoint: '/api/donki/sep',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-notifications',label: 'DONKI notifications',
      endpoint: '/api/donki/notifications',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    // ── Atmosphere · Parker Physics seed-grid ──────────────────────────────
    { id: 'atmosphere-profile', label: 'Upper atmosphere profile',
      endpoint: '/api/atmosphere/profile',
      category: 'atmosphere', upstream: 'Parker Physics seed grid',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600 },

    { id: 'atmosphere-snapshot',label: 'Upper atmosphere snapshot',
      endpoint: '/api/atmosphere/snapshot',
      category: 'atmosphere', upstream: 'Parker Physics seed grid',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600 },

    // ── Weather · GFS + NOAA CPC ───────────────────────────────────────────
    { id: 'weather-grid',       label: 'Weather grid (648-pt)',
      endpoint: '/api/weather/grid',
      category: 'weather', upstream: 'Open-Meteo GFS · cron-fed',
      cadence_s: 3_600, prewarm: null,
      warnAgeS:  90 * 60, critAgeS: 180 * 60,
      notes: 'Populated by /api/cron/refresh-weather-grid hourly cron — pre-warm not needed.' },

    { id: 'weather-forecast',   label: 'Weather forecast',
      endpoint: '/api/weather/forecast',
      category: 'weather', upstream: 'Open-Meteo + NWS',
      cadence_s: 1_800, prewarm: null,
      warnAgeS:  60 * 60, critAgeS: 240 * 60,
      notes: 'Per-location query; not pre-warmable — each call is unique.' },

    { id: 'polar-vortex',       label: 'Polar vortex',
      endpoint: '/api/weather/polar-vortex',
      category: 'atmosphere', upstream: 'Open-Meteo GFS @ 60°N',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  9 * 3600, critAgeS: 24 * 3600 },

    { id: 'teleconnections',    label: 'AO + NAO indices',
      endpoint: '/api/weather/teleconnections',
      category: 'atmosphere', upstream: 'NOAA CPC daily',
      cadence_s: 86_400, prewarm: 'cold',
      warnAgeS:  36 * 3600, critAgeS: 72 * 3600 },

    { id: 'surface-outlook',    label: 'Surface outlook combiner',
      endpoint: '/api/weather/surface-outlook',
      category: 'atmosphere', upstream: 'composes vortex + teleco',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  9 * 3600, critAgeS: 24 * 3600 },

    // ── NWS · severe weather ───────────────────────────────────────────────
    { id: 'nws-convective',     label: 'NWS convective outlook',
      endpoint: '/api/nws/convective',
      category: 'weather', upstream: 'NWS SPC',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  60 * 60, critAgeS: 240 * 60 },

    { id: 'lightning-strikes',  label: 'Lightning strikes',
      endpoint: '/api/lightning/strikes',
      category: 'weather', upstream: 'NWS · NLDN',
      cadence_s: 300,   prewarm: 'medium',
      warnAgeS:  30 * 60, critAgeS: 120 * 60 },

    // ── Orbital · CelesTrak / launches ─────────────────────────────────────
    { id: 'celestrak-tle',      label: 'CelesTrak TLE',
      endpoint: '/api/celestrak/tle',
      category: 'orbital', upstream: 'CelesTrak',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600,
      notes: 'Per-NORAD query; pre-warm hits a default cohort.' },

    { id: 'launches-upcoming',  label: 'Upcoming launches',
      endpoint: '/api/launches/upcoming',
      category: 'orbital', upstream: 'TheSpaceDevs LL2',
      cadence_s: 3_600, prewarm: 'medium',
      warnAgeS:  90 * 60, critAgeS: 180 * 60 },
];

/**
 * Convenience filters for cron jobs and the status page.
 */
export const HOT_PIPELINES    = PIPELINES.filter(p => p.prewarm === 'hot');
export const MEDIUM_PIPELINES = PIPELINES.filter(p => p.prewarm === 'medium');
export const COLD_PIPELINES   = PIPELINES.filter(p => p.prewarm === 'cold');

export const CATEGORIES = [
    { id: 'space-weather', label: 'Space Weather · live'  },
    { id: 'atmosphere',    label: 'Atmosphere · DSMC + GFS' },
    { id: 'events',        label: 'Solar/Geomag Events'   },
    { id: 'weather',       label: 'Terrestrial Weather'   },
    { id: 'orbital',       label: 'Orbital · TLE / Launches' },
];

export function pipelinesByCategory(catId) {
    return PIPELINES.filter(p => p.category === catId);
}
