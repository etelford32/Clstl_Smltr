/**
 * Vercel Edge Function: GET /api/weather/renewables
 *
 * Derived solar + wind energy forecast for a single location. Uses the
 * same Open-Meteo forecast API we already proxy elsewhere, asking for
 * the irradiance components and surface wind, then deriving:
 *
 *   - POA (plane-of-array) irradiance for a tilted PV panel via the
 *     Hay-Davies anisotropic transposition.
 *   - AC output per m² panel area, with a simple temperature derate
 *     (−0.40 %/°C above 25 °C cell temperature, sympathetic to the
 *     ~17 % rated module efficiency of mid-tier crystalline silicon).
 *   - Hub-height wind from 10 m using the 1/7 power-law extrapolation,
 *     then a generic IEC Class II power curve: cut-in 3 m/s, rated
 *     12 m/s, cut-out 25 m/s, cubic ramp between cut-in and rated.
 *   - 24-hour solar + wind capacity factors so the UI can render a
 *     single headline number alongside the hourly curves.
 *
 * Why we DON'T do clear-sky + cloud transmittance ourselves
 * ─────────────────────────────────────────────────────────
 * Open-Meteo already serves shortwave_radiation / direct_radiation /
 * diffuse_radiation / DNI directly on the same /v1/forecast endpoint
 * we already use. Re-deriving from a Bird & Hulstrom clear-sky model +
 * cloud transmittance would (a) bring no accuracy gain over the model
 * outputs (Open-Meteo runs its own radiation post-processing on the
 * NWP fields) and (b) add ~200 lines of code that can drift. Trust
 * the upstream radiation, derive only the geometric POA step we
 * actually need.
 *
 * Request
 * ───────
 *   GET /api/weather/renewables
 *       ?lat=40&lon=-105
 *       &tilt=40         (deg from horizontal; default = |lat|)
 *       &azimuth=180     (deg, 180 = facing south N-hemisphere;
 *                         0 = facing north S-hemisphere; default chosen
 *                         from lat sign)
 *       &hub=80          (wind turbine hub height in m; default 80)
 *       &days=2          (1..4; default 2)
 *
 * Response (truncated)
 * ────────────────────
 *   {
 *     lat, lon,
 *     panel:  { tilt_deg, azimuth_deg },
 *     wind:   { hub_height_m, cut_in_ms, rated_ms, cut_out_ms },
 *     as_of:  ISO,
 *     hourly: [
 *       { iso, ghi_w_m2, dni_w_m2, dhi_w_m2, poa_w_m2,
 *         solar_ac_w_m2, temp_c,
 *         wind_10m_ms, wind_hub_ms, wind_power_kw_norm },
 *       ...
 *     ],
 *     summary: {
 *       solar_capacity_factor_24h, wind_capacity_factor_24h,
 *       solar_peak_w_m2, wind_peak_ms, hours_evaluated
 *     },
 *     basis: { model, method, panel_efficiency, temp_derate_per_c }
 *   }
 *
 * Rate-limited 60 anon req / IP / hour. Signed-in bypass.
 */

import { jsonOk, jsonError, fetchWithTimeout } from '../_lib/responses.js';
import { checkAnonymousQuota } from '../_lib/anonymous-rate-limit.js';

export const config = { runtime: 'edge' };

const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

// ── Tunable constants ──────────────────────────────────────────────

// Mid-tier crystalline silicon PV. These are intentionally generic — a
// real installer would feed in IEC test-condition curves for a specific
// module. The UI labels every output "per m² panel area" so users can
// scale linearly to whatever array they care about.
const PANEL_EFFICIENCY        = 0.17;    // STC AC efficiency
const TEMP_DERATE_PER_C       = 0.0040;  // 0.40 %/°C above 25 °C cell
const REF_CELL_TEMP_C         = 25;
const NOCT_C                  = 45;      // typical NOCT for crystalline Si
const NOCT_INSOLATION_W_M2    = 800;
const SOLAR_AC_LOSS_FACTOR    = 0.95;    // inverter + cabling + soiling

// IEC Class II generic wind turbine power curve. Outputs are reported
// as a fraction of rated (0..1) so the UI can multiply by whatever
// turbine size the user models. v_cut_out hard-clips to zero (real
// turbines feather + park, not freewheel).
const WIND_CUT_IN_MS   = 3;
const WIND_RATED_MS    = 12;
const WIND_CUT_OUT_MS  = 25;
// 1/7 power-law shear exponent for neutral atmospheric stability over
// open terrain. Real sites vary 0.10..0.30; the picker accepts a hub
// height but the shear law stays generic.
const SHEAR_EXPONENT   = 1 / 7;

const RAD_PER_DEG = Math.PI / 180;
const DEG_PER_RAD = 180 / Math.PI;

const CACHE_TTL = 900;        // 15 min — matches /api/weather/forecast?type=point
const CACHE_SWR = 600;

// ── Solar position (NREL/SPA-lite) ────────────────────────────────
//
// We need the sun zenith + azimuth for each hour to project GHI/DNI/DHI
// onto a tilted panel. A full NREL SPA implementation is overkill for
// hourly grid-cell forecasting — the Spencer 1971 formulae for
// declination + equation of time give ~0.1° accuracy on declination,
// which translates to a small fraction of a percent error in POA.

function _solarPosition(date, lat_deg, lon_deg) {
    // Day of year (UTC).
    const start = Date.UTC(date.getUTCFullYear(), 0, 0);
    const diff  = date.getTime() - start;
    const doy   = diff / 86_400_000;

    // Fractional year in radians.
    const gamma = 2 * Math.PI * ((doy - 1) +
        (date.getUTCHours() - 12) / 24) / 365;

    // Equation of time (minutes).
    const eqt = 229.18 * (
        0.000075
        + 0.001868 * Math.cos(gamma)
        - 0.032077 * Math.sin(gamma)
        - 0.014615 * Math.cos(2 * gamma)
        - 0.040849 * Math.sin(2 * gamma)
    );

    // Solar declination (radians → deg).
    const decl = (
        0.006918
        - 0.399912 * Math.cos(gamma)
        + 0.070257 * Math.sin(gamma)
        - 0.006758 * Math.cos(2 * gamma)
        + 0.000907 * Math.sin(2 * gamma)
        - 0.002697 * Math.cos(3 * gamma)
        + 0.001480 * Math.sin(3 * gamma)
    );  // radians

    // True solar time (minutes), then hour angle (radians).
    const utcMinutes = date.getUTCHours() * 60
                     + date.getUTCMinutes()
                     + date.getUTCSeconds() / 60;
    const tst        = utcMinutes + eqt + 4 * lon_deg;
    const ha         = (tst / 4 - 180) * RAD_PER_DEG;  // hour angle, radians

    const lat_rad = lat_deg * RAD_PER_DEG;

    // Solar zenith.
    const cosZen = Math.sin(lat_rad) * Math.sin(decl)
                 + Math.cos(lat_rad) * Math.cos(decl) * Math.cos(ha);
    const zen    = Math.acos(Math.max(-1, Math.min(1, cosZen)));

    // Solar azimuth (0 = north, 180 = south, NOAA convention).
    const sinAz = -Math.sin(ha) * Math.cos(decl) / Math.sin(zen);
    const cosAz = (Math.sin(decl) - Math.sin(lat_rad) * cosZen)
                / (Math.cos(lat_rad) * Math.sin(zen));
    const azNorth = Math.atan2(sinAz, cosAz) * DEG_PER_RAD;   // [-180..180], 0 = north
    const az_deg  = (azNorth + 360) % 360;                    // [0..360)

    return {
        zenith_deg:  zen * DEG_PER_RAD,
        azimuth_deg: az_deg,
        cos_zen:     cosZen,
    };
}

// ── POA (Hay-Davies anisotropic transposition) ────────────────────

function _angleOfIncidence(zen_deg, sun_az_deg, tilt_deg, panel_az_deg) {
    const zen   = zen_deg   * RAD_PER_DEG;
    const sunAz = sun_az_deg * RAD_PER_DEG;
    const tilt  = tilt_deg  * RAD_PER_DEG;
    const pAz   = panel_az_deg * RAD_PER_DEG;
    const cosTheta =
        Math.cos(zen) * Math.cos(tilt)
      + Math.sin(zen) * Math.sin(tilt) * Math.cos(sunAz - pAz);
    return { cos_theta: Math.max(0, cosTheta) };
}

function _poaIrradiance(ghi, dni, dhi, zen_deg, sun_az_deg,
                        tilt_deg, panel_az_deg, albedo = 0.2) {
    if (zen_deg >= 90 || ghi <= 0) {
        return { poa: 0, beam: 0, diffuse: 0, reflected: 0 };
    }
    const { cos_theta } = _angleOfIncidence(zen_deg, sun_az_deg, tilt_deg, panel_az_deg);

    // Beam component on panel.
    const beam = dni * cos_theta;

    // Hay-Davies sky-diffuse with anisotropy index Ai = DNI / Extraterrestrial
    // — for hourly grid forecasts we approximate Ai ≈ DNI / 1367 (no need
    // for the per-day E0 correction; ~0.3 % swing across the year).
    const Ai = Math.max(0, Math.min(1, dni / 1367));
    const tilt = tilt_deg * RAD_PER_DEG;
    const zen  = zen_deg  * RAD_PER_DEG;
    const Rb   = Math.cos(zen) > 1e-3 ? cos_theta / Math.cos(zen) : 0;
    const diffuse = dhi * (Ai * Rb + (1 - Ai) * (1 + Math.cos(tilt)) / 2);

    // Ground-reflected component.
    const reflected = ghi * albedo * (1 - Math.cos(tilt)) / 2;

    const poa = Math.max(0, beam) + Math.max(0, diffuse) + Math.max(0, reflected);
    return { poa, beam, diffuse, reflected };
}

// ── PV cell temp + AC output ──────────────────────────────────────

function _cellTemp(ambient_c, poa_w_m2) {
    // NOCT-based: cell warms ~ (NOCT − 20) / 800 °C per W/m² of POA
    // relative to ambient.
    return ambient_c + (NOCT_C - 20) * poa_w_m2 / NOCT_INSOLATION_W_M2;
}

function _solarAcWperM2(poa_w_m2, cell_temp_c) {
    if (poa_w_m2 <= 0) return 0;
    const derate = Math.max(0, 1 - TEMP_DERATE_PER_C * (cell_temp_c - REF_CELL_TEMP_C));
    return poa_w_m2 * PANEL_EFFICIENCY * derate * SOLAR_AC_LOSS_FACTOR;
}

// ── Wind ─────────────────────────────────────────────────────────

function _windAtHub(v10_ms, hub_m) {
    if (!Number.isFinite(v10_ms) || v10_ms <= 0 || hub_m <= 0) return 0;
    return v10_ms * Math.pow(hub_m / 10, SHEAR_EXPONENT);
}

function _windPowerFraction(v_ms) {
    if (!Number.isFinite(v_ms) || v_ms < WIND_CUT_IN_MS) return 0;
    if (v_ms >= WIND_CUT_OUT_MS) return 0;
    if (v_ms >= WIND_RATED_MS)   return 1;
    // Cubic ramp between cut-in and rated.
    const num = Math.pow(v_ms,         3) - Math.pow(WIND_CUT_IN_MS, 3);
    const den = Math.pow(WIND_RATED_MS,3) - Math.pow(WIND_CUT_IN_MS, 3);
    return Math.max(0, Math.min(1, num / den));
}

// ── Param parsing ─────────────────────────────────────────────────

function _readParams(request) {
    const p   = new URL(request.url).searchParams;
    const lat = parseFloat(p.get('lat'));
    const lon = parseFloat(p.get('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        return { error: 'missing_lat_lon' };
    }
    if (lat < -90 || lat > 90)   return { error: 'lat_out_of_range' };
    if (lon < -180 || lon > 180) return { error: 'lon_out_of_range' };

    let tilt = parseFloat(p.get('tilt'));
    if (!Number.isFinite(tilt))  tilt = Math.abs(lat);
    tilt = Math.max(0, Math.min(90, tilt));

    let panel_az = parseFloat(p.get('azimuth'));
    if (!Number.isFinite(panel_az)) panel_az = lat >= 0 ? 180 : 0;
    panel_az = (panel_az % 360 + 360) % 360;

    let hub = parseFloat(p.get('hub'));
    if (!Number.isFinite(hub))   hub = 80;
    hub = Math.max(2, Math.min(200, hub));

    let days = parseFloat(p.get('days'));
    if (!Number.isFinite(days))  days = 2;
    days = Math.max(1, Math.min(4, Math.round(days)));

    return { lat, lon, tilt, panel_az, hub, days };
}

// ── Open-Meteo fetch ──────────────────────────────────────────────

async function _fetchHourly(lat, lon, days) {
    const url = new URL(OPEN_METEO);
    url.searchParams.set('latitude',  lat.toFixed(3));
    url.searchParams.set('longitude', lon.toFixed(3));
    url.searchParams.set('hourly', [
        'temperature_2m', 'cloud_cover',
        'shortwave_radiation', 'direct_radiation',
        'diffuse_radiation',   'direct_normal_irradiance',
        'wind_speed_10m', 'wind_gusts_10m',
    ].join(','));
    url.searchParams.set('temperature_unit', 'celsius');
    url.searchParams.set('wind_speed_unit',  'ms');
    url.searchParams.set('timezone',         'UTC');
    url.searchParams.set('forecast_days',    String(days));

    const res = await fetchWithTimeout(url, {
        timeoutMs: 8_000,
        headers:   { Accept: 'application/json' },
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
}

// ── Core compute ──────────────────────────────────────────────────

function _compute(upstream, lat, lon, tilt, panel_az, hub_m) {
    const hourly = upstream?.hourly;
    if (!hourly?.time?.length) return null;

    const N = hourly.time.length;
    const out = [];
    let solar_sum_kwh_m2  = 0;
    let wind_sum_kwh_norm = 0;
    let peak_poa          = 0;
    let peak_hub_ms       = 0;
    let hours_with_solar  = 0;

    for (let i = 0; i < N; i++) {
        const iso = hourly.time[i];
        const ms  = Date.parse(iso);
        if (!Number.isFinite(ms)) continue;

        const ghi = hourly.shortwave_radiation?.[i]       ?? 0;
        const dni = hourly.direct_normal_irradiance?.[i]  ?? 0;
        const dhi = hourly.diffuse_radiation?.[i]         ?? 0;
        const t_c = hourly.temperature_2m?.[i];
        const v10 = hourly.wind_speed_10m?.[i]            ?? 0;
        const gust= hourly.wind_gusts_10m?.[i]            ?? 0;
        const cc  = hourly.cloud_cover?.[i];

        const sun = _solarPosition(new Date(ms), lat, lon);
        const poa = _poaIrradiance(
            ghi, dni, dhi, sun.zenith_deg, sun.azimuth_deg,
            tilt, panel_az,
        );
        const tCell = _cellTemp(t_c ?? 15, poa.poa);
        const acW   = _solarAcWperM2(poa.poa, tCell);

        const vHub  = _windAtHub(v10, hub_m);
        const wPow  = _windPowerFraction(vHub);

        if (poa.poa > peak_poa)  peak_poa  = poa.poa;
        if (vHub    > peak_hub_ms) peak_hub_ms = vHub;
        if (poa.poa > 1)          hours_with_solar++;

        // Capacity-factor accumulators (treat each hour as 1h of time
        // so kWh = kW per hour). For solar we accumulate AC W/m²
        // divided by an aspirational 1000 W/m² peak — that gives a
        // dimensionless capacity factor consistent with how the
        // industry reports rooftop PV. For wind, the fraction is
        // already 0..1.
        solar_sum_kwh_m2  += acW / 1000;
        wind_sum_kwh_norm += wPow;

        out.push({
            iso,
            zenith_deg:        Math.round(sun.zenith_deg * 10) / 10,
            sun_azimuth_deg:   Math.round(sun.azimuth_deg * 10) / 10,
            ghi_w_m2:          Math.round(ghi),
            dni_w_m2:          Math.round(dni),
            dhi_w_m2:          Math.round(dhi),
            poa_w_m2:          Math.round(poa.poa),
            solar_ac_w_m2:     Math.round(acW * 10) / 10,
            cell_temp_c:       Math.round(tCell * 10) / 10,
            cloud_cover_pct:   cc ?? null,
            temp_c:            t_c ?? null,
            wind_10m_ms:       Math.round(v10 * 100) / 100,
            wind_hub_ms:       Math.round(vHub * 100) / 100,
            wind_gust_10m_ms:  Math.round(gust * 100) / 100,
            wind_power_norm:   Math.round(wPow * 1000) / 1000,
        });
    }

    if (out.length === 0) return null;

    // 24-hour rolling summary — first 24 hours of the response.
    const head24      = out.slice(0, 24);
    const head_hours  = head24.length;
    const solar_first24 = head24.reduce((a, h) => a + h.solar_ac_w_m2, 0) / 1000;
    const wind_first24  = head24.reduce((a, h) => a + h.wind_power_norm, 0);
    const solar_cf_24h  = head_hours > 0 ? solar_first24 / head_hours : 0;
    const wind_cf_24h   = head_hours > 0 ? wind_first24  / head_hours : 0;

    return {
        hourly: out,
        summary: {
            solar_capacity_factor_24h: Math.round(solar_cf_24h * 1000) / 1000,
            wind_capacity_factor_24h:  Math.round(wind_cf_24h * 1000) / 1000,
            solar_peak_w_m2:           Math.round(peak_poa),
            wind_peak_hub_ms:          Math.round(peak_hub_ms * 100) / 100,
            hours_evaluated:           out.length,
            hours_with_sun:            hours_with_solar,
        },
    };
}

// ── Handler ───────────────────────────────────────────────────────

export default async function handler(request) {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204 });
    }
    if (request.method !== 'GET') {
        return jsonError('method_not_allowed', null, { status: 405 });
    }

    const gate = checkAnonymousQuota(request, {
        feature:     'renewables',
        maxRequests: 60,
        windowMs:    60 * 60 * 1000,
    });
    if (!gate.allowed) {
        return new Response(JSON.stringify({
            error:       'rate_limited',
            retry_after: gate.retryAfterSec,
            hint:        'Sign in for unlimited queries.',
        }), {
            status: 429,
            headers: {
                'Retry-After':   String(gate.retryAfterSec),
                'Content-Type':  'application/json',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
            },
        });
    }

    const params = _readParams(request);
    if (params.error) return jsonError('bad_request', params.error, { status: 400 });

    let upstream;
    try {
        upstream = await _fetchHourly(params.lat, params.lon, params.days);
    } catch (e) {
        return jsonError('upstream_unavailable', e.message,
            { status: 502, source: 'open-meteo' });
    }

    const evald = _compute(
        upstream, params.lat, params.lon,
        params.tilt, params.panel_az, params.hub,
    );
    if (!evald) {
        return jsonError('no_data', 'empty hourly response from upstream',
            { status: 502 });
    }

    return jsonOk({
        lat:    params.lat,
        lon:    params.lon,
        panel:  {
            tilt_deg:    params.tilt,
            azimuth_deg: params.panel_az,
            area_m2:     1,
        },
        wind:   {
            hub_height_m: params.hub,
            cut_in_ms:    WIND_CUT_IN_MS,
            rated_ms:     WIND_RATED_MS,
            cut_out_ms:   WIND_CUT_OUT_MS,
        },
        as_of:  upstream?.generationtime_ms != null
                  ? new Date().toISOString()
                  : null,
        timezone: upstream?.timezone || 'UTC',
        hourly:   evald.hourly,
        summary:  evald.summary,
        basis: {
            model:              'open-meteo (best-available NWP)',
            method:             'NREL/Spencer solar pos + Hay-Davies POA + NOCT cell temp + 1/7 shear + cubic power curve',
            panel_efficiency:   PANEL_EFFICIENCY,
            temp_derate_per_c:  TEMP_DERATE_PER_C,
            shear_exponent:     SHEAR_EXPONENT,
        },
    }, { maxAge: CACHE_TTL, swr: CACHE_SWR });
}
