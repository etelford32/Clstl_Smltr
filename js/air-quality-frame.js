/**
 * Stable numeric air-quality frame contract shared by EarthView's point feed,
 * server adapters, scrubber cache, and LOD renderer.
 *
 * The critical distinction is provenance.kind:
 *   model       — CAMS gridded analysis/forecast sampled by Open-Meteo
 *   observation — preliminary hourly EPA AirNow monitor measurements
 *
 * Those records may be displayed together, but are never relabelled or
 * silently substituted for one another.
 */

export const AIR_QUALITY_FRAME_SCHEMA = 'pp.air-quality.frame.v1';
export const AIR_HOUR_MS = 3_600_000;

export const CAMS_PROVENANCE = Object.freeze({
    id: 'open-meteo-cams-global',
    provider: 'Open-Meteo',
    dataset: 'Copernicus Atmosphere Monitoring Service (CAMS) Global',
    kind: 'model',
    label: 'CAMS modeled air quality',
    isGroundObservation: false,
    nativeResolutionKm: 45,
    nativeCadenceHours: 3,
    interpolatedCadenceHours: 1,
});

export const AIRNOW_PROVENANCE = Object.freeze({
    id: 'epa-airnow-hourly-observations',
    provider: 'EPA AirNow',
    dataset: 'Hourly AQ Obs',
    kind: 'observation',
    label: 'Preliminary AirNow monitor observations',
    isGroundObservation: true,
    preliminary: true,
    nativeCadenceHours: 1,
});

export const AIR_QUALITY_METRICS = Object.freeze({
    aqi:  Object.freeze({ label: 'US AQI', unit: 'AQI' }),
    pm25: Object.freeze({ label: 'PM2.5', unit: 'µg/m³' }),
    pm10: Object.freeze({ label: 'PM10', unit: 'µg/m³' }),
    aod:  Object.freeze({ label: 'AOD 550 nm', unit: '' }),
});

export function airHourStart(ms) {
    return Math.floor(Number(ms) / AIR_HOUR_MS) * AIR_HOUR_MS;
}

export function airHourKey(ms) {
    return new Date(airHourStart(ms)).toISOString().slice(0, 13) + ':00Z';
}

/** Resolve one shared-timeline instant to the availability of each source. */
export function resolveAirQualityTime({ simTimeMs, nowMs = Date.now() } = {}) {
    const requestedMs = Number.isFinite(simTimeMs) ? simTimeMs : nowMs;
    const targetMs = airHourStart(requestedMs);
    const nowHourMs = airHourStart(nowMs);
    const mode = targetMs < nowHourMs ? 'replay'
        : targetMs > nowHourMs ? 'forecast' : 'live';
    return {
        key: airHourKey(targetMs),
        targetMs,
        requestedMs,
        nowHourMs,
        mode,
        modelAvailable: targetMs >= nowHourMs - 7 * 24 * AIR_HOUR_MS
            && targetMs <= nowHourMs + 5 * 24 * AIR_HOUR_MS,
        observationsAvailable: targetMs <= nowHourMs
            && targetMs >= nowHourMs - 7 * 24 * AIR_HOUR_MS,
    };
}

function wrapLon(lon) {
    return ((Number(lon) + 540) % 360) - 180;
}

/**
 * Build the bounded coordinate sample requested from CAMS.
 * Global is deliberately sparse; regional/local grids replace it as the
 * camera approaches instead of downloading a full global raster per hour.
 */
export function buildCamsGrid(detail = 'global', focusLat = 0, focusLon = 0) {
    if (detail === 'global') {
        const coordinates = [];
        for (const lat of [-60, -30, 0, 30, 60]) {
            for (let lon = -160; lon <= 160; lon += 40) coordinates.push({ lat, lon });
        }
        return {
            scope: { key: 'global-40x30', kind: 'global', detail, stepDeg: 30 },
            coordinates,
        };
    }

    const stepDeg = detail === 'local' ? 2.5 : 5;
    const centerLat = Math.max(-75, Math.min(75,
        Math.round(Number(focusLat || 0) / stepDeg) * stepDeg));
    const centerLon = wrapLon(Math.round(Number(focusLon || 0) / stepDeg) * stepDeg);
    const coordinates = [];
    for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) {
            coordinates.push({
                lat: Math.max(-85, Math.min(85, centerLat + y * stepDeg)),
                lon: wrapLon(centerLon + x * stepDeg),
            });
        }
    }
    return {
        scope: {
            key: `${detail}-${centerLat.toFixed(1)}-${centerLon.toFixed(1)}-${stepDeg}`,
            kind: 'grid', detail, centerLat, centerLon, stepDeg,
        },
        coordinates,
    };
}

export function frameRequestKey(provenanceId, scopeKey, requestedMs) {
    return `${provenanceId}:${scopeKey}:${airHourKey(requestedMs)}`;
}

function finiteOrNull(value) {
    if (value === '' || value == null) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > -900 ? number : null;
}

function temporalMode(validMs, nowMs) {
    const validHour = airHourStart(validMs);
    const nowHour = airHourStart(nowMs);
    return validHour < nowHour ? 'replay' : validHour > nowHour ? 'forecast' : 'live';
}

function makeFrame({ provenance, requestedMs, validMs, retrievedMs, scope, units, points }) {
    const requestKey = frameRequestKey(provenance.id, scope.key, requestedMs);
    return {
        schema: AIR_QUALITY_FRAME_SCHEMA,
        id: `${provenance.id}:${scope.key}:${airHourKey(validMs)}`,
        requestKey,
        requestedAt: new Date(requestedMs).toISOString(),
        validAt: new Date(validMs).toISOString(),
        retrievedAt: new Date(retrievedMs).toISOString(),
        temporalMode: temporalMode(validMs, retrievedMs),
        provenance,
        scope,
        units,
        points,
    };
}

/** Normalize Open-Meteo's multi-coordinate CAMS response into one frame. */
export function normalizeCamsFrame(payload, {
    requestedMs,
    retrievedMs = Date.now(),
    scope = { key: 'unknown', kind: 'grid' },
} = {}) {
    const locations = Array.isArray(payload) ? payload : payload ? [payload] : [];
    const targetMs = airHourStart(requestedMs);
    let validMs = targetMs;
    const points = [];

    for (const location of locations) {
        const hourly = location?.hourly ?? {};
        const times = Array.isArray(hourly.time) ? hourly.time : [];
        if (!times.length) continue;
        let idx = 0;
        let best = Infinity;
        for (let i = 0; i < times.length; i++) {
            const ms = Number(times[i]) * 1000;
            const delta = Math.abs(ms - targetMs);
            if (Number.isFinite(ms) && delta < best) { best = delta; idx = i; }
        }
        const rowTime = Number(times[idx]) * 1000;
        if (Number.isFinite(rowTime)) validMs = rowTime;
        const point = {
            id: `cams-${location.location_id ?? points.length}`,
            lat: finiteOrNull(location.latitude),
            lon: finiteOrNull(location.longitude),
            aqi: finiteOrNull(hourly.us_aqi?.[idx]),
            pm25: finiteOrNull(hourly.pm2_5?.[idx]),
            pm10: finiteOrNull(hourly.pm10?.[idx]),
            aod: finiteOrNull(hourly.aerosol_optical_depth?.[idx]),
        };
        if (point.lat != null && point.lon != null
                && [point.aqi, point.pm25, point.pm10, point.aod].some(v => v != null)) {
            points.push(point);
        }
    }

    return makeFrame({
        provenance: CAMS_PROVENANCE,
        requestedMs: targetMs,
        validMs,
        retrievedMs,
        scope,
        units: { aqi: 'AQI', pm25: 'µg/m³', pm10: 'µg/m³', aod: '' },
        points,
    });
}

/** RFC-4180-enough parser for the quoted AirNow HourlyAQObs CSV rows. */
export function parseCsvRow(line) {
    const out = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < String(line).length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
            out.push(value); value = '';
        } else value += ch;
    }
    out.push(value);
    return out;
}

function parseAirNowUtc(dateText, timeText) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dateText ?? ''));
    const t = /^(\d{2}):(\d{2})$/.exec(String(timeText ?? ''));
    if (!m || !t) return null;
    const ms = Date.UTC(+m[3], +m[1] - 1, +m[2], +t[1], +t[2]);
    return Number.isFinite(ms) ? ms : null;
}

function inScope(lat, lon, scope) {
    if (!scope || scope.kind === 'global') return true;
    // spanDeg describes the full viewport width. Filtering by half that value
    // keeps a 20° regional request to ±10° instead of accidentally expanding
    // it into a 40°-wide North American download.
    const radius = Math.max(1.25, (Number(scope.spanDeg) || 20) / 2);
    const dLon = Math.abs(wrapLon(lon - Number(scope.centerLon || 0)));
    return Math.abs(lat - Number(scope.centerLat || 0)) <= radius && dLon <= radius;
}

/** Normalize one AirNow HourlyAQObs file into the same frame contract. */
export function normalizeAirNowFrame(text, {
    requestedMs,
    retrievedMs = Date.now(),
    scope = { key: 'global', kind: 'global' },
} = {}) {
    const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
    const header = parseCsvRow(lines.shift() ?? '');
    const col = Object.fromEntries(header.map((name, index) => [name, index]));
    const points = [];
    let validMs = airHourStart(requestedMs);

    for (const line of lines) {
        const row = parseCsvRow(line);
        const value = name => row[col[name]] ?? '';
        const lat = finiteOrNull(value('Latitude'));
        const lon = finiteOrNull(value('Longitude'));
        if (lat == null || lon == null || !inScope(lat, lon, scope)) continue;
        const rowValidMs = parseAirNowUtc(value('ValidDate'), value('ValidTime'));
        if (rowValidMs != null) validMs = rowValidMs;
        const aqis = ['OZONE_AQI', 'PM10_AQI', 'PM25_AQI', 'NO2_AQI']
            .map(name => finiteOrNull(value(name))).filter(v => v != null && v >= 0);
        const point = {
            id: value('AQSID'),
            name: value('SiteName') || value('AQSID'),
            lat, lon,
            aqi: aqis.length ? Math.max(...aqis) : null,
            pm25: finiteOrNull(value('PM25')),
            pm10: finiteOrNull(value('PM10')),
            aod: null,
            ozone: finiteOrNull(value('OZONE')),
            nitrogenDioxide: finiteOrNull(value('NO2')),
            carbonMonoxide: finiteOrNull(value('CO')),
            sulphurDioxide: finiteOrNull(value('SO2')),
            units: {
                pm25: value('PM25_Unit') || 'UG/M3',
                pm10: value('PM10_Unit') || 'UG/M3',
                ozone: value('OZONE_Unit') || null,
                nitrogenDioxide: value('NO2_Unit') || null,
                carbonMonoxide: value('CO_Unit') || null,
                sulphurDioxide: value('SO2_Unit') || null,
            },
            agency: value('DataSource') || null,
            country: value('CountryCode') || null,
            region: value('StateName') || value('EPARegion') || null,
        };
        if ([point.aqi, point.pm25, point.pm10, point.ozone,
            point.nitrogenDioxide, point.carbonMonoxide, point.sulphurDioxide]
            .some(v => v != null)) points.push(point);
    }

    return makeFrame({
        provenance: AIRNOW_PROVENANCE,
        requestedMs: airHourStart(requestedMs),
        validMs,
        retrievedMs,
        scope,
        units: { aqi: 'AQI', pm25: 'µg/m³', pm10: 'µg/m³', aod: null },
        points,
    });
}

/** EPA-category-compatible color stops, returned as normalized RGB. */
export function airQualityMetricColor(metric, value, fallback = false) {
    if (fallback || !Number.isFinite(value)) return [0.34, 0.39, 0.46];
    let score;
    if (metric === 'aqi') score = value;
    else if (metric === 'pm25') score = value <= 9 ? value / 9 * 50
        : value <= 35.4 ? 50 + (value - 9) / 26.4 * 100 : 150 + (value - 35.4) * 2;
    else if (metric === 'pm10') score = value <= 54 ? value / 54 * 50
        : value <= 154 ? 50 + (value - 54) : 150 + (value - 154);
    else score = value * 280; // AOD: 0.18≈AQI-50 visual intensity; 1.0≈280.
    if (score <= 50) return [0.10, 0.88, 0.48];
    if (score <= 100) return [1.00, 0.86, 0.18];
    if (score <= 150) return [1.00, 0.49, 0.05];
    if (score <= 200) return [1.00, 0.15, 0.18];
    if (score <= 300) return [0.62, 0.25, 0.78];
    return [0.55, 0.04, 0.18];
}
