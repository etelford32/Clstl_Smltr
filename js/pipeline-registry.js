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
 *               'orbital' | 'environment' | 'planetary' | 'admin'
 *               Must also appear in CATEGORIES below, or the status page
 *               silently renders no table for it.
 *   upstream    short label for the data origin
 *   cadence_s   upstream publish cadence (seconds). Drives the warn/crit
 *               freshness thresholds; also the cache TTL ceiling.
 *   prewarm     'hot' (5 min) | 'medium' (30 min) | 'cold' (6 h) | null
 *               null = not pre-warmed (admin-only, write-only, or
 *               event-driven only). Cron jobs filter on this.
 *   warnAgeS    age above which the status pill goes amber
 *   critAgeS    age above which the status pill goes red
 *   probePath   optional override URL for the status-page probe. Use when
 *               the endpoint REQUIRES query params (e.g. per-location
 *               forecast) — the probe would otherwise 400 by design.
 *               Pre-warm crons keep using `endpoint`.
 *   probeTimeoutMs  optional per-endpoint probe timeout (default 8000).
 *               NASA DONKI regularly takes 8-15s on a cold cache — an 8s
 *               probe abort reads as "network error" when the endpoint is
 *               merely slow.
 *   freshnessExempt  true = a 200 with no freshness metadata is healthy.
 *               For computed-at-request endpoints (seed-grid lookups,
 *               per-location passthroughs) "age" has no meaning.
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

    // Kyoto quicklook Dst is an HOURLY product — a 60-75 min age is its
    // normal steady state, so the warn line sits at 2.5 h (missed update),
    // not 1 h (previous setting amber-flagged every probe).
    { id: 'noaa-dst',           label: 'NOAA Dst index',
      endpoint: '/api/noaa/dst',
      category: 'space-weather', upstream: 'NOAA SWPC',
      cadence_s: 3_600, prewarm: 'hot',
      warnAgeS:  150 * 60, critAgeS: 360 * 60 },

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
      warnAgeS:  10 * 60, critAgeS: 30 * 60 },

    { id: 'solar-wind-speed',   label: 'Solar wind speed',
      endpoint: '/api/solar-wind/wind-speed',
      category: 'space-weather', upstream: 'NOAA SWPC RTSW',
      cadence_s: 60,    prewarm: 'hot',
      warnAgeS:  10 * 60, critAgeS: 30 * 60 },

    // ── DONKI · NASA event feeds ───────────────────────────────────────────
    // probeTimeoutMs 16000 on all five: api.nasa.gov regularly takes 8-15 s
    // on a cold edge cache. The default 8 s probe abort was reporting
    // "network error" for endpoints that were healthy-but-slow.
    { id: 'donki-cme',          label: 'DONKI CME analysis',
      endpoint: '/api/donki/cme',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-flares',       label: 'DONKI flares',
      endpoint: '/api/donki/flares',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-gst',          label: 'DONKI geomag storms',
      endpoint: '/api/donki/gst',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-sep',          label: 'DONKI SEP events',
      endpoint: '/api/donki/sep',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    { id: 'donki-notifications',label: 'DONKI notifications',
      endpoint: '/api/donki/notifications',
      category: 'events', upstream: 'NASA DONKI',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  60 * 60, critAgeS: 360 * 60 },

    // ── Atmosphere · SPARTA DSMC surrogate ──────────────────────────────
    // Both endpoints serve the SPARTA-bootstrap (climatology) profile until
    // the SPARTA DSMC pipeline (dsmc/sparta/generate_tables.py) drops
    // refined CSVs in; same contract on either side, the `model` field in
    // the response distinguishes 'SPARTA-bootstrap' vs 'SPARTA-lookup'.
    { id: 'atmosphere-profile', label: 'SPARTA · upper-atm profile',
      endpoint: '/api/atmosphere/profile',
      category: 'atmosphere', upstream: 'SPARTA DSMC · seed grid',
      cadence_s: 21_600, prewarm: 'cold', freshnessExempt: true,
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600,
      notes: 'Bootstrap climatology served until the SPARTA DSMC build replaces the seed grid.' },

    { id: 'atmosphere-snapshot',label: 'SPARTA · upper-atm snapshot',
      endpoint: '/api/atmosphere/snapshot',
      category: 'atmosphere', upstream: 'SPARTA DSMC · seed grid',
      cadence_s: 21_600, prewarm: 'cold', freshnessExempt: true,
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600 },

    // ── Weather · GFS + NOAA CPC ───────────────────────────────────────────
    { id: 'weather-grid',       label: 'Weather grid (2592-pt)',
      endpoint: '/api/weather/grid',
      category: 'weather', upstream: 'Open-Meteo GFS · cron-fed',
      cadence_s: 3_600, prewarm: null,
      warnAgeS:  90 * 60, critAgeS: 180 * 60,
      notes: 'Populated by /api/cron/refresh-weather-grid hourly cron — pre-warm not needed.' },

    { id: 'weather-forecast',   label: 'Weather forecast',
      endpoint: '/api/weather/forecast',
      // Endpoint REQUIRES ?type&lat&lon — a bare probe 400s by design.
      // Probe with a fixed canonical coord (KSC) so the status row
      // exercises the real path; the response is raw Open-Meteo JSON with
      // no top-level timestamp, hence freshnessExempt.
      probePath: '/api/weather/forecast?type=point&lat=28.39&lon=-80.6',
      category: 'weather', upstream: 'Open-Meteo + NWS',
      cadence_s: 1_800, prewarm: null, freshnessExempt: true,
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
      category: 'weather', upstream: 'Blitzortung',
      cadence_s: 300,   prewarm: 'medium',
      warnAgeS:  30 * 60, critAgeS: 120 * 60 },

    // ── Orbital · CelesTrak / launches ─────────────────────────────────────
    { id: 'celestrak-tle',      label: 'CelesTrak · TLE catalog',
      endpoint: '/api/celestrak/tle',
      category: 'orbital', upstream: 'CelesTrak GP / 18 SDS',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600,
      notes: 'Per-NORAD query; pre-warm hits a default cohort.' },

    // CelesTrak GP active-payload feed — fronts the satellite-tracker
    // groups on satellites.html and operations.html. Probed separately so
    // a stations-only failure surfaces here without polluting the catch-all
    // celestrak-tle row.
    { id: 'celestrak-stations', label: 'CelesTrak · stations (ISS, CSS)',
      endpoint: '/api/celestrak/tle?group=stations',
      category: 'orbital', upstream: 'CelesTrak GP / 18 SDS',
      cadence_s: 21_600, prewarm: null,
      warnAgeS:  12 * 3600, critAgeS: 48 * 3600,
      notes: 'Default-on layer for satellites.html + operations.html.' },

    // CelesTrak debris feed — composite of FY-1C, Cosmos 1408, Iridium-33,
    // Cosmos-2251 fragmentation events. Drives the LEO debris cloud on the
    // Upper Atmosphere, Satellite Track, and Operations sims. Critical
    // signal: if this row goes red the debris layer disappears.
    { id: 'celestrak-debris',   label: 'CelesTrak · LEO debris (composite)',
      endpoint: '/api/celestrak/tle?group=debris',
      category: 'orbital', upstream: 'CelesTrak GP / 18 SDS',
      cadence_s: 21_600, prewarm: 'cold',
      warnAgeS:  24 * 3600, critAgeS: 72 * 3600,
      notes: 'Fans out to 4 per-event groups; partial failures still serve.' },

    // SOCRATES daily conjunction feed (rebranded "Aristotle" in our UI to
    // disambiguate from the LLM that took the original name). Powers the
    // Aristotle decision-deck panel on operations.html.
    { id: 'celestrak-aristotle',label: 'SOCRATES · Aristotle conjunctions',
      endpoint: '/api/celestrak/aristotle',
      category: 'orbital', upstream: 'CelesTrak SOCRATES',
      cadence_s: 43_200, prewarm: 'medium',
      warnAgeS:  18 * 3600, critAgeS: 36 * 3600,
      notes: 'SOCRATES recomputes every ~12h. Format-drift detection runs server-side.' },

    { id: 'launches-upcoming',  label: 'Upcoming launches',
      endpoint: '/api/launches/upcoming',
      category: 'orbital', upstream: 'TheSpaceDevs LL2',
      cadence_s: 3_600, prewarm: 'medium',
      warnAgeS:  90 * 60, critAgeS: 180 * 60 },

    // ── Tropical / severe weather ─────────────────────────────────────────
    { id: 'storms-cyclones',    label: 'NHC active tropical cyclones',
      endpoint: '/api/storms',
      category: 'weather', upstream: 'NOAA NHC CurrentStorms',
      cadence_s: 1_800, prewarm: 'medium',
      warnAgeS:  6 * 3600, critAgeS: 24 * 3600,
      notes: 'Powers the storm-feed overlay on Earth + satellite-track sims.' },

    // ── Environment · air quality + wildfire (earth.html, pollution.html) ──
    // The two 2026-07 AQ routes (#971) shipped without registry rows — the
    // exact silent-gap failure this file's header warns about. Registered
    // retroactively; both serve per-request timestamped frames rather than a
    // top-level fetched_at, hence freshnessExempt.
    { id: 'air-quality-grid',   label: 'CAMS air-quality grid',
      endpoint: '/api/air-quality/grid',
      category: 'environment', upstream: 'Open-Meteo · CAMS Global',
      cadence_s: 3_600, prewarm: 'medium', freshnessExempt: true,
      warnAgeS:  2 * 3600, critAgeS: 6 * 3600,
      notes: 'Timestamped CAMS model frames for the EarthView numeric AQI layer; freshness lives inside frame.validAt, not a top-level field.' },

    { id: 'air-quality-stations', label: 'AirNow monitor observations',
      endpoint: '/api/air-quality/stations',
      category: 'environment', upstream: 'EPA AirNow HourlyAQObs',
      cadence_s: 3_600, prewarm: null, freshnessExempt: true,
      warnAgeS:  2 * 3600, critAgeS: 6 * 3600,
      notes: 'Regional per-request query (defaults to CONUS center) — not usefully pre-warmable; AirNow publishes each hour file ~1 h behind wall time by design.' },

    { id: 'air-quality-stations-intl', label: 'International monitors (OpenAQ)',
      endpoint: '/api/air-quality/stations-intl',
      category: 'environment', upstream: 'OpenAQ v3 · CC BY 4.0',
      cadence_s: 3_600, prewarm: null,
      warnAgeS:  2 * 3600, critAgeS: 6 * 3600,
      notes: 'Global ground-station PM2.5 — the international counterpart to the US-only AirNow row. AMBER UNTIL CONFIGURED: needs the free OPENAQ_API_KEY env var (explore.openaq.org/register); until then the route answers freshness:stale with the setup pointer in `reason`.' },

    { id: 'air-quality-residuals', label: 'Model−obs residuals (PM2.5)',
      endpoint: '/api/air-quality/residuals',
      category: 'environment', upstream: 'OpenAQ v3 + Open-Meteo CAMS',
      cadence_s: 3_600, prewarm: null,
      warnAgeS:  2 * 3600, critAgeS: 6 * 3600,
      notes: 'CAMS sampled at OpenAQ monitors → obs−model residual per station + bias/rmse. Shows where the model is WRONG — the physics-first skill surface. Amber until OPENAQ_API_KEY is set (shares the stations-intl key).' },

    { id: 'air-quality-nowcast-validation', label: 'NowCast vs AirNow (index check)',
      endpoint: '/api/air-quality/nowcast-validation',
      category: 'environment', upstream: 'EPA AirNow HourlyAQObs (12 files)',
      cadence_s: 3_600, prewarm: 'cold',
      warnAgeS:  6 * 3600, critAgeS: 24 * 3600,
      notes: 'Recomputes EPA NowCast from AirNow PM2.5 series and diffs it against AirNow\'s own published PM25_AQI across every US monitor. Checks our INDEX MATH against the authority — distinct from the residuals row, which checks the MODEL against reality. Keyless. Cold-tier: 12 × ~2 MB upstream GETs, CDN-cached 1 h.' },

    { id: 'air-quality-centers', label: 'City pollution centers (CAMS)',
      endpoint: '/api/air-quality/centers',
      category: 'environment', upstream: 'Open-Meteo · CAMS Global',
      cadence_s: 3_600, prewarm: 'medium',
      warnAgeS:  2 * 3600, critAgeS: 6 * 3600,
      notes: 'One batched request: current AQI/PM for the top ~100 major-cities.js metros. Powers the EarthView Pollution Centers layer + Pollution Lab. 200 + freshness:stale + empty list when CAMS is down.' },

    { id: 'wildfire-events',    label: 'Active wildfire events',
      endpoint: '/api/wildfires/events',
      category: 'environment', upstream: 'NASA EONET v3',
      cadence_s: 43_200, prewarm: 'medium',
      warnAgeS:  24 * 3600, critAgeS: 72 * 3600,
      notes: 'Named open wildfire events (discrete markers) — complements the GIBS Active Fires imagery layer. EONET curates ~2×/day. 200 + freshness:stale + empty list when EONET is down.' },

    // ── Planetary · Mars (mars.html) ───────────────────────────────────────
    // All three answer 200 even when their upstream is down, because the page
    // has a working fallback for each and a 5xx would be indistinguishable
    // from "the site is broken" to a client whose fallback is a static file.
    // They therefore signal degradation with a top-level `freshness: 'stale'`,
    // which _rtProxyHealth() already understands — a row here going amber means
    // "serving the fallback", not "endpoint down". See data/mars/SOURCES.md.

    // Only genuinely live Mars feed. JPL Horizons has never been retired and
    // is not DEMO_KEY rate-limited, unlike every NASA rover endpoint below.
    { id: 'mars-ephemeris',     label: 'Mars geometry (Ls, light time)',
      endpoint: '/api/mars/ephemeris',
      category: 'planetary', upstream: 'JPL Horizons',
      cadence_s: 1_800, prewarm: 'medium', probeTimeoutMs: 24_000,
      warnAgeS:  90 * 60, critAgeS: 6 * 3600,
      notes: 'Amber = fell back to the analytic mean-motion Ls model (~11° error near solstices). Horizons queries can take 20 s cold, hence the raised probe timeout.' },

    // Live rover position. Amber here means the globe is drawing the bundled
    // snapshot in data/mars/perseverance-route.json instead of live MMGIS.
    { id: 'mars-route',         label: 'Perseverance traverse (MMGIS)',
      endpoint: '/api/mars/route',
      category: 'planetary', upstream: 'NASA MMGIS · M20 waypoints',
      cadence_s: 3_600, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  3 * 3600, critAgeS: 12 * 3600,
      notes: 'Amber = serving the bundled route snapshot. MMGIS publishes ≤1 localization per sol (24h 39m).' },

    // EXPECT THIS ROW TO BE AMBER. The mars.nasa.gov RSS rover-weather
    // endpoints have been frozen or intermittent since 2024 and InSight ended
    // in Dec 2022; the adapter itself is healthy, its upstreams are not. The
    // `sources[]` array in the response names which one failed and why.
    { id: 'mars-weather',       label: 'Mars surface weather (MEDA/REMS)',
      endpoint: '/api/mars/weather',
      category: 'planetary', upstream: 'NASA MEDA · REMS · InSight',
      cadence_s: 3_600, prewarm: 'medium', probeTimeoutMs: 16_000,
      warnAgeS:  3 * 3600, critAgeS: 12 * 3600,
      notes: 'Amber is the expected steady state: NASA rover daily-summary feeds are frozen/retired, so the page serves a bundled MEDA snapshot and labels it historical.' },
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
    { id: 'environment',   label: 'Environment · Air & Fire' },
    { id: 'planetary',     label: 'Planetary · Mars'      },
];

export function pipelinesByCategory(catId) {
    return PIPELINES.filter(p => p.category === catId);
}

/**
 * HEARTBEAT_PIPELINES — cadence-aware staleness thresholds for every row in
 * the Supabase `pipeline_heartbeat` table. Shared by status.html and
 * admin.html so both UIs agree on what "healthy" means.
 *
 * warnMin / critMin are MINUTES since last_success_at. Each is derived from
 * the pipeline's actual schedule (vercel.json crons + Supabase pg_cron):
 * warn ≈ one missed run + margin, crit ≈ several missed runs. Before this
 * list existed, everything not named solar_wind/weather_grid fell into a
 * 15 m/60 m default — which flagged the 6-hourly aurora outlook and the
 * daily/weekly synthetic-auth journeys "critical" while they were running
 * exactly on schedule.
 *
 * A heartbeat row NOT listed here still renders (with the conservative
 * 15 m/60 m default) — that's deliberate: a new pipeline shows up
 * amber/red until someone registers its cadence, which is the prompt to
 * add it.
 */
export const HEARTBEAT_PIPELINES = [
    // vercel.json: * * * * * (every minute)
    { key: 'solar_wind',              label: 'Solar Wind',              warnMin: 5,      critMin: 60 },
    // vercel.json: 0 * * * * (hourly)
    { key: 'weather_grid',            label: 'Weather Grid',            warnMin: 75,     critMin: 180 },
    // vercel.json: */10 * * * *
    { key: 'sync_dataset',            label: 'Sync Dataset (SW⇄geomag)',warnMin: 25,     critMin: 60 },
    // Supabase pg_cron omni_hourly_refresh: 0 * * * * (CDAWeb HAPI)
    { key: 'omni_hourly',             label: 'OMNI hourly (CDAWeb)',    warnMin: 75,     critMin: 240 },
    // vercel.json: 0 */6 * * *
    { key: 'aurora_outlook',          label: 'Aurora 30-day Outlook',   warnMin: 7 * 60, critMin: 25 * 60 },
    // vercel.json: */30 * * * *
    { key: 'refresh_saved_locations', label: 'Saved-Location Prewarm',  warnMin: 45,     critMin: 120 },
    // vercel.json: 30 12 * * * (daily)
    { key: 'synthetic_auth_daily',    label: 'Synthetic Auth (daily)',  warnMin: 25 * 60, critMin: 49 * 60 },
    // vercel.json: 40 12 * * 1 (weekly, Monday)
    { key: 'synthetic_auth_weekly',   label: 'Synthetic Auth (weekly)', warnMin: 8 * 1440, critMin: 15 * 1440 },
];
