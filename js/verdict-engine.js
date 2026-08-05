/**
 * verdict-engine.js — pure fusion logic for the EarthView verdict card.
 *
 * Turns the data earth.html already has (space weather, local weather,
 * NWS alerts, ISS passes, sun/moon, air quality) into one location-anchored
 * "answer": a verdict word, a temperature-first sentence, six factor chips,
 * an 18-hour temperature series, a 7-day week strip, a best-night pick and
 * tonight's sky rows (aurora + ISS). `factorForecast` additionally builds
 * the per-chip predictive series behind the tap-a-chip detail graphs.
 *
 * CONTRACT: every export in this file is a pure function — inputs → outputs.
 *   - No DOM. No fetch. No imports from feed modules.
 *   - No ambient time: `now` is always a parameter (defaulted at the edge).
 *   - Missing/partial inputs degrade fields to null / '--', never throw.
 * This is what makes the module unit-testable with fixture data
 * (tests/verdict-engine.mjs) without a browser.
 *
 * Input shape (all branches optional — see mkInputs in the tests):
 *   {
 *     swpc:     { kp, kpForecast:[{time:ms|Date, kp}] }
 *     wx:       { tempF, cloudPct }                    // current, at loc
 *     forecast: { hourly:[{time, tempF, precipProb, cloudPct, uv}], // ≥18 h
 *                 daily:[{date, hiF, loF, code, cloudPct, precipProbMax}] }
 *     alerts:   [{event, headline, severity}]          // pre-filtered to loc
 *     iss:      { passes:[{rise, riseAz, peakTime, peakAlt, set, setAz,
 *                          durationMin, rangeKm}] }    // from pass-predictor
 *     astro:    { sunset, sunrise, moonIllumPct }      // Dates; moon optional
 *     air:      { aqi, uvNow, uvPeak, uvPeakHour, aqiHourly:[{time, aqi}],
 *                 pollutants:{pm25,pm10,ozone,nitrogenDioxide,sulphurDioxide,
 *                             carbonMonoxide,aerosolOpticalDepth,dust},
 *                 pollutionUnits, airSource }
 *     loc:      { lat, lon, name, tz }
 *     fluxRope: { pHit, p10, p20, arrivalP10Ms, arrivalP50Ms, arrivalP90Ms,
 *                 minBzP50 }        // flux-rope ensemble summary (Phase 4) —
 *                                   // js/flux-rope-forecast.js `summary`
 *   }
 */

const DEG = Math.PI / 180;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => Number.isFinite(v);
const ms = (t) => (t instanceof Date ? t.getTime() : +t);

// ── Time formatting (tz-aware, Intl-backed) ─────────────────────────────────

/** "8:22P" — compact 12 h clock with single-letter meridiem (chip grammar). */
export function fmtClockShort(t, tz) {
    const s = fmtClock(t, tz);
    return s === '--' ? s : s.replace(' AM', 'A').replace(' PM', 'P');
}

/** "9:41 PM" — row grammar. */
export function fmtClock(t, tz) {
    if (t == null || !isNum(ms(t))) return '--';
    try {
        return new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', minute: '2-digit',
            ...(tz ? { timeZone: tz } : {}),
        }).format(new Date(ms(t)));
    } catch {
        // Bad tz string — retry in the runtime's local zone.
        return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
            .format(new Date(ms(t)));
    }
}

/** "~8PM" — verdict-word grammar ("Rain by ~8PM"). */
function fmtHourApprox(t, tz) {
    const s = fmtClock(t, tz);
    if (s === '--') return s;
    return '~' + s.replace(/:\d{2}\s?/, '').replace(' AM', 'AM').replace(' PM', 'PM');
}

/** Local hour-of-day (0-23) at `loc` for a UTC instant. */
function localHour(t, tz) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            hour: 'numeric', hourCycle: 'h23', ...(tz ? { timeZone: tz } : {}),
        }).formatToParts(new Date(ms(t)));
        const h = parts.find(p => p.type === 'hour');
        return h ? parseInt(h.value, 10) : new Date(ms(t)).getHours();
    } catch {
        return new Date(ms(t)).getHours();
    }
}

/** "Sat" style weekday at loc. */
function fmtWeekday(t, tz) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            weekday: 'short', ...(tz ? { timeZone: tz } : {}),
        }).format(new Date(ms(t)));
    } catch {
        return new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(new Date(ms(t)));
    }
}

// ── Solar / lunar geometry (approximate, documented) ────────────────────────

/**
 * Solar altitude in degrees — sub-solar-point + spherical law of cosines.
 * No equation-of-time or refraction, so ±1-2° vs. ephemeris. Only used for
 * dark-window detection (alt < −12°), where that error moves the window
 * edge by <10 min — irrelevant for a go/no-go verdict.
 */
export function sunAltitudeDeg(lat, lon, t) {
    const d = new Date(ms(t));
    const utcHrs = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
    const subSolarLon = -15 * (utcHrs - 12);
    const start = Date.UTC(d.getUTCFullYear(), 0, 0);
    const dayOfYear = Math.floor((ms(t) - start) / DAY_MS);
    const subSolarLat = 23.44 * Math.sin(2 * Math.PI * (dayOfYear - 81) / 365);
    const cosZ = Math.sin(lat * DEG) * Math.sin(subSolarLat * DEG)
               + Math.cos(lat * DEG) * Math.cos(subSolarLat * DEG)
               * Math.cos((lon - subSolarLon) * DEG);
    return 90 - Math.acos(clamp(cosZ, -1, 1)) / DEG;
}

/**
 * Geomagnetic (dipole) latitude in degrees.
 *
 * Centered-dipole approximation with the IGRF-13 (2020) north geomagnetic
 * pole at 80.7°N, 72.7°W. Ignores the dipole's offset from Earth's center
 * and all non-dipole terms, so it's good to ~±1° at mid-latitudes — the
 * NOAA Kp-visibility table this feeds is itself only quoted to ~0.1°
 * precision on a boundary that physically wanders by degrees per substorm.
 */
export function magneticLatitude(lat, lon) {
    const POLE_LAT = 80.7, POLE_LON = -72.7;
    const sinMlat = Math.sin(lat * DEG) * Math.sin(POLE_LAT * DEG)
                  + Math.cos(lat * DEG) * Math.cos(POLE_LAT * DEG)
                  * Math.cos((lon - POLE_LON) * DEG);
    return Math.asin(clamp(sinMlat, -1, 1)) / DEG;
}

const SYNODIC_DAYS = 29.53058867;
const NEW_MOON_EPOCH_MS = Date.UTC(2000, 0, 6, 18, 14); // known new moon
const MOON_GLYPHS = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];
const MOON_NAMES = ['new', 'waxing', 'first qtr', 'waxing', 'full', 'waning', 'last qtr', 'waning'];

/**
 * Moon phase from the mean synodic month. ±1 day vs. true phase (the real
 * lunation varies ±7 h and we skip the elliptical correction) — fine for a
 * glyph strip and a %-lit chip, not for eclipse work.
 */
export function moonPhase(t) {
    const days = (ms(t) - NEW_MOON_EPOCH_MS) / DAY_MS;
    const phase = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS / SYNODIC_DAYS;
    const illumPct = Math.round((1 - Math.cos(2 * Math.PI * phase)) / 2 * 100);
    const octile = Math.round(phase * 8) % 8;
    return {
        phase,
        illumPct,
        glyph: MOON_GLYPHS[octile],
        name: MOON_NAMES[octile],
        waxing: phase < 0.5,
    };
}

// ── Aurora verdict ───────────────────────────────────────────────────────────

// NOAA equatorward visibility boundary (overhead aurora) per integer Kp,
// in degrees of magnetic latitude. Linear interpolation between rows.
const KP_BOUNDARY = [66.5, 64.5, 62.4, 60.4, 58.3, 56.3, 54.2, 52.2, 50.1, 48.1];

/** Equatorward overhead-aurora boundary (°mlat) for a possibly-fractional Kp. */
export function boundaryForKp(kp) {
    const k = clamp(isNum(kp) ? kp : 0, 0, 9);
    const i = Math.floor(k);
    if (i >= 9) return KP_BOUNDARY[9];
    const frac = k - i;
    return KP_BOUNDARY[i] + (KP_BOUNDARY[i + 1] - KP_BOUNDARY[i]) * frac;
}

/**
 * Aurora Go / Maybe / No for an observer.
 *
 * @param {number} kp         effective Kp (max of current + tonight's dark-window forecast)
 * @param {number} userMagLat observer magnetic latitude (see magneticLatitude)
 * @param {number} cloudPct   cloud cover % during the dark window
 * @param {number} sunAltDeg  the DEEPEST sun altitude reached tonight — if it
 *                            never gets below −12° there is no dark window
 * @returns {{state:'go'|'maybe'|'no', margin:number, boundary:number, title:string, desc:string}}
 *
 * margin = boundary(Kp) − mlat: how far (°) the overhead oval sits poleward
 * of the observer. GO threshold is margin ≤ 5° — wider than the "overhead
 * only" 2° because near-boundary storms (Gannon, May 2024: overhead aurora
 * deep into the mid-latitudes) are exactly the nights this card exists for;
 * 2–5° south of the boundary is a whole-sky show, not a maybe.
 */
export function auroraVerdict(kp, userMagLat, cloudPct, sunAltDeg) {
    const boundary = boundaryForKp(kp);
    const mlat = isNum(userMagLat) ? Math.abs(userMagLat) : 90; // S hemisphere symmetric
    const margin = boundary - mlat;
    const clouds = isNum(cloudPct) ? cloudPct : 0;
    const noDark = isNum(sunAltDeg) && sunAltDeg > -12;

    if (noDark) {
        return {
            state: 'no', margin, boundary,
            title: 'Aurora: not tonight',
            desc: 'No true darkness at your latitude tonight — the sky never gets dark enough.',
        };
    }
    if (margin <= 5 && clouds < 60) {
        return {
            state: 'go', margin, boundary,
            title: 'Aurora: GO',
            desc: margin <= 0
                ? 'Oval overhead at this activity level — look up as soon as it\'s dark.'
                : 'Oval within reach — strong odds overhead to northern sky.',
        };
    }
    if (margin <= 10 && clouds < 60) {
        return {
            state: 'maybe', margin, boundary,
            title: 'Aurora: maybe',
            desc: 'Low on the northern horizon — the camera will catch it even if your eyes don\'t.',
        };
    }
    if (margin <= 10) {
        return {
            state: 'no', margin, boundary,
            title: 'Aurora: not tonight',
            desc: 'Storm in progress, but clouds block your window.',
        };
    }
    const miles = Math.round(margin * 69 / 50) * 50; // 1° mlat ≈ 69 mi; round for copy
    return {
        state: 'no', margin, boundary,
        title: 'Aurora: not tonight',
        desc: `Quiet field — oval sits ~${miles.toLocaleString('en-US')} mi north of you`,
    };
}

// ── Category mappers (§4.5) ─────────────────────────────────────────────────

/** US AQI → EPA category word (lowercase). */
export function aqiCategory(aqi) {
    if (!isNum(aqi)) return null;
    if (aqi <= 50) return 'good';
    if (aqi <= 100) return 'moderate';
    if (aqi <= 150) return 'sensitive';
    if (aqi <= 200) return 'unhealthy';
    return aqi <= 300 ? 'very unhealthy' : 'hazardous';
}

/** chip state for AQI: help ≤50, watch 51-100, block >100 */
export function aqiState(aqi) {
    if (!isNum(aqi)) return null;
    return aqi <= 50 ? 'help' : aqi <= 100 ? 'watch' : 'block';
}

/** chip state for UV by today's PEAK: help ≤2, watch 3-7, block ≥8 */
export function uvState(uvPeak) {
    if (!isNum(uvPeak)) return null;
    return uvPeak <= 2 ? 'help' : uvPeak <= 7 ? 'watch' : 'block';
}

function cloudState(pct) {
    if (!isNum(pct)) return null;
    return pct < 30 ? 'help' : pct <= 70 ? 'watch' : 'block';
}

function moonState(illum) {
    if (!isNum(illum)) return null;
    return illum < 30 ? 'help' : illum <= 70 ? 'watch' : 'block';
}

function kpCat(kp) {
    if (!isNum(kp)) return null;
    if (kp < 4) return 'quiet';
    if (kp < 5) return 'unsettled';
    return `G${clamp(Math.floor(kp) - 4, 1, 5)} storm`;
}

// WMO weather code (Open-Meteo) → glyph for the week strip.
export function weatherGlyph(code) {
    if (!isNum(code)) return '·';
    if (code === 0) return '☀️';
    if (code <= 2) return '🌤️';
    if (code === 3) return '☁️';
    if (code <= 48) return '🌫️';
    if (code <= 57) return '🌦️';
    if (code <= 67) return '🌧️';
    if (code <= 77) return '🌨️';
    if (code <= 82) return '🌦️';
    if (code <= 86) return '🌨️';
    return '⛈️';
}

// ── Small shared lookups ────────────────────────────────────────────────────

function daypart(hour) {
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
}

function tempWord(f) {
    if (!isNum(f)) return '';
    if (f >= 90) return 'hot';
    if (f >= 72) return 'warm';
    if (f >= 55) return 'mild';
    if (f >= 40) return 'cool';
    if (f >= 20) return 'cold';
    return 'frigid';
}

function skyWord(cloudPct) {
    if (!isNum(cloudPct)) return null;
    if (cloudPct < 25) return 'clear';
    if (cloudPct <= 70) return 'partly cloudy';
    return 'overcast';
}

/** Hourly rows from `from` (floored to the hour) to +hours, inclusive. */
function hourlyWindow(forecast, from, hours) {
    const rows = forecast?.hourly;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const start = Math.floor(from / HOUR_MS) * HOUR_MS;
    const end = start + hours * HOUR_MS;
    return rows
        .filter(r => isNum(ms(r.time)) && ms(r.time) >= start && ms(r.time) <= end)
        .sort((a, b) => ms(a.time) - ms(b.time));
}

// ── Sentence + verdict word (§4.1) ──────────────────────────────────────────

function buildSentence(inputs, now) {
    const tz = inputs.loc?.tz;
    const tempNow = isNum(inputs.wx?.tempF) ? Math.round(inputs.wx.tempF)
        : isNum(hourlyWindow(inputs.forecast, now, 1)[0]?.tempF)
            ? Math.round(hourlyWindow(inputs.forecast, now, 1)[0].tempF) : null;
    if (tempNow == null) return 'Live conditions are still loading for your location.';

    const next12 = hourlyWindow(inputs.forecast, now, 12).filter(r => isNum(r.tempF));
    let head;
    if (next12.length >= 3) {
        let min = next12[0], max = next12[0];
        for (const r of next12) {
            if (r.tempF < min.tempF) min = r;
            if (r.tempF > max.tempF) max = r;
        }
        const window = (t) => {
            const h = localHour(t, tz);
            if (h >= 21 || h < 6) return 'overnight';
            if (h < 12) return 'in the morning';
            if (h < 18) return 'by afternoon';
            return 'this evening';
        };
        if (tempNow - Math.round(min.tempF) >= 3 && (tempNow - min.tempF) >= (max.tempF - tempNow)) {
            head = `${tempNow}° now, cooling to ${Math.round(min.tempF)}° ${window(min.time)}`;
        } else if (Math.round(max.tempF) - tempNow >= 3) {
            head = `${tempNow}° now, warming to ${Math.round(max.tempF)}° ${window(max.time)}`;
        } else {
            head = `${tempNow}° now, holding steady through the next 12 hours`;
        }
    } else {
        head = `${tempNow}° now`;
    }

    const next24 = hourlyWindow(inputs.forecast, now, 24);
    const probs = next24.filter(r => isNum(r.precipProb));
    const maxProb = probs.length ? Math.max(...probs.map(r => r.precipProb)) : null;
    const firstWet = probs.find(r => r.precipProb >= 50);

    const tw = tempWord(tempNow);
    const sky = skyWord(inputs.wx?.cloudPct);
    const cond = maxProb != null && maxProb < 30
        ? `${tw} and dry through tonight`
        : sky ? `${tw} and ${sky} through tonight` : `${tw} through tonight`;

    let precip;
    if (maxProb == null) precip = 'precipitation outlook still loading';
    else if (firstWet) {
        const kind = isNum(firstWet.tempF) && firstWet.tempF < 34 ? 'snow' : 'rain';
        precip = `${kind} likely by ${fmtHourApprox(firstWet.time, tz).slice(1)}`;
    } else if (maxProb >= 30) precip = 'a slight chance of rain in the next 24 hours';
    else precip = 'no rain in the next 24 hours';

    return `**${head}** — ${cond}, ${precip}.`;
}

function buildWord(inputs, now, aurora, kpEff) {
    const tz = inputs.loc?.tz;

    // 1. Active NWS alert wins.
    const alert = (inputs.alerts || [])[0];
    if (alert?.event) {
        const severe = alert.severity === 'Severe' || alert.severity === 'Extreme';
        return {
            word: alert.event,
            sub: alert.headline || 'Active alert for your area',
            lamp: severe ? 'danger' : 'warn',
            icon: severe ? '⚠️' : '🌀',
        };
    }

    // 2. Precip within 6 h at ≥50%.
    const soon = hourlyWindow(inputs.forecast, now, 6).find(r => isNum(r.precipProb) && r.precipProb >= 50);
    if (soon) {
        const kind = isNum(soon.tempF) && soon.tempF < 34 ? 'Snow' : 'Rain';
        return {
            word: `${kind} by ${fmtHourApprox(soon.time, tz)}`,
            sub: `${Math.round(soon.precipProb)}% chance within 6 hours`,
            lamp: 'warn',
            icon: kind === 'Snow' ? '🌨️' : '🌧️',
        };
    }

    // 3. Storm-level space weather + a viable aurora takes the slot.
    if (isNum(kpEff) && kpEff >= 7 && aurora.state !== 'no') {
        return {
            word: 'GO — aurora likely',
            sub: `${kpCat(kpEff)} conditions tonight`,
            lamp: 'ok',
            icon: '🌌',
        };
    }

    // 4. Default: sky condition word.
    const cloud = inputs.wx?.cloudPct;
    const part = daypart(localHour(now, tz));
    const word = !isNum(cloud) ? `Live view`
        : cloud < 25 ? `Clear ${part}`
        : cloud <= 70 ? 'Partly cloudy'
        : 'Overcast';
    return {
        word,
        sub: 'No alerts for your area',
        lamp: 'ok',
        icon: !isNum(cloud) || cloud < 25 ? (part === 'night' || part === 'evening' ? '🌙' : '☀️') : '☁️',
    };
}

// ── Week / best-night (§4.4) ────────────────────────────────────────────────

function darkSkyScore(cloudPct, moonIllum) {
    const c = isNum(cloudPct) ? cloudPct : 50;
    const m = isNum(moonIllum) ? moonIllum : 50;
    return (100 - c) / 25 + (100 - m) / 33; // 0 … ~7
}

function buildWeek(inputs, now, kpEff) {
    const tz = inputs.loc?.tz;
    const lat = inputs.loc?.lat, lon = inputs.loc?.lon;
    const mlat = isNum(lat) && isNum(lon) ? magneticLatitude(lat, lon) : null;
    const daily = Array.isArray(inputs.forecast?.daily) ? inputs.forecast.daily.slice(0, 7) : [];
    const passes = inputs.iss?.passes || [];

    const week = [];
    const moonSeq = [];
    let best = null;

    for (let i = 0; i < 7; i++) {
        const d = daily[i];
        const dayStart = d?.date != null ? ms(d.date) : ms(now) + i * DAY_MS;
        const nightAnchor = dayStart + 22 * HOUR_MS; // ~10 PM local-ish anchor
        const moon = moonPhase(nightAnchor);
        const dayName = fmtWeekday(dayStart + 12 * HOUR_MS, tz);

        // Bright ISS pass that night? (mag handled upstream; peakAlt proxy here)
        const passTonight = passes.find(p => {
            const t = ms(p.rise);
            return isNum(t) && t >= dayStart && t < dayStart + DAY_MS && p.peakAlt >= 25;
        });
        const brightPass = passTonight && (passTonight.magEst == null || passTonight.magEst <= -3);

        // Aurora chance that night: only meaningful with a Kp forecast; use
        // the effective Kp for the first two nights, quiet-default beyond.
        const kpNight = i <= 1 && isNum(kpEff) ? kpEff : 2;
        const auroraNight = mlat != null
            ? auroraVerdict(kpNight, mlat, d?.cloudPct ?? 30, -18)
            : { state: 'no' };

        const score = darkSkyScore(d?.cloudPct, moon.illumPct)
            + (brightPass ? 2 : 0)
            + (auroraNight.state !== 'no' ? 3 : 0);

        const clearNight = isNum(d?.cloudPct) ? d.cloudPct < 40 : false;
        week.push({
            day: dayName,
            glyph: weatherGlyph(d?.code),
            hi: isNum(d?.hiF) ? Math.round(d.hiF) : null,
            lo: isNum(d?.loF) ? Math.round(d.loF) : null,
            pips: [
                { cls: clearNight ? 'on' : 'off' },
                { cls: (passTonight || auroraNight.state !== 'no') ? 'hot' : 'off' },
            ],
        });

        moonSeq.push({ day: dayName, phaseGlyph: moon.glyph, label: null, _illum: moon.illumPct });

        if (!best || score > best.score) {
            best = {
                score, i, dayName, moon, clearNight,
                pass: passTonight, aurora: auroraNight, cloudPct: d?.cloudPct,
            };
        }
    }

    // Mark at most ONE new/full label on the strip — the week's extreme.
    // (Mean-synodic illumination sits ≤2% for ~3 days around the true new
    // moon; labelling them all reads as a bug.)
    let extremeIdx = -1, extremeLabel = null;
    for (let i = 0; i < moonSeq.length; i++) {
        const m = moonSeq[i];
        if (m._illum <= 2 && (extremeIdx < 0 || m._illum < moonSeq[extremeIdx]._illum)) {
            extremeIdx = i; extremeLabel = 'new';
        }
    }
    if (extremeIdx < 0) {
        for (let i = 0; i < moonSeq.length; i++) {
            const m = moonSeq[i];
            if (m._illum >= 98 && (extremeIdx < 0 || m._illum > moonSeq[extremeIdx]._illum)) {
                extremeIdx = i; extremeLabel = 'full';
            }
        }
    }
    if (extremeIdx >= 0) {
        moonSeq[extremeIdx].label = extremeLabel;
        moonSeq[extremeIdx].day = extremeLabel;
    }
    for (const m of moonSeq) delete m._illum;

    let bestNight = null;
    if (best && daily.length) {
        const bits = [];
        bits.push(isNum(best.cloudPct) && best.cloudPct < 25 ? 'Clear' : 'Darkest usable sky');
        if (best.moon.illumPct <= 10) bits.push('new moon');
        else if (best.moon.illumPct < 40) bits.push(`${best.moon.illumPct}% moon`);
        if (best.pass) {
            const magTxt = best.pass.magEst != null ? `a ${best.pass.magEst.toFixed(1)} mag ` : 'an ';
            bits.push(`${magTxt}ISS pass at ${fmtClock(best.pass.rise, tz)}`);
        }
        if (best.aurora.state !== 'no') bits.push('aurora in play');
        const dayLabel = best.i === 0 ? 'Tonight' : best.dayName === fmtWeekday(ms(now) + DAY_MS, tz) ? 'Tomorrow' : best.dayName;
        bestNight = {
            day: dayLabel,
            reason: `${bits[0]}${bits.length > 1 ? ', ' + bits.slice(1).join(', and ') : ''} — best sky of the week.`,
        };
    }

    return { week, moonSeq, bestNight };
}

// ── ISS row (§4.3) ──────────────────────────────────────────────────────────

/**
 * Rough ISS apparent magnitude from slant range. Anchored at −4.0 for a
 * 400 km overhead pass, +5·log10 falloff. Ignores phase angle, so bright
 * passes read ~0.5 mag optimistic. Only used to rank/describe passes.
 */
export function issMagEstimate(rangeKm) {
    if (!isNum(rangeKm) || rangeKm <= 0) return null;
    return Math.round((-4 + 5 * Math.log10(rangeKm / 400)) * 10) / 10;
}

function buildIssRow(inputs, now) {
    const tz = inputs.loc?.tz;
    const lat = inputs.loc?.lat, lon = inputs.loc?.lon;
    const passes = (inputs.iss?.passes || [])
        .filter(p => isNum(ms(p.rise)) && ms(p.rise) > ms(now))
        .sort((a, b) => ms(a.rise) - ms(b.rise));

    // Visible pass ≈ observer in twilight-to-early-night while the ISS is
    // still sunlit. Rule-of-thumb window: sun altitude at the observer
    // between −6° (dark enough to see it) and −25° (past that the station
    // is usually inside Earth's shadow at pass altitudes). Approximation —
    // a proper cylindrical-shadow test needs the TEME state vector, which
    // the pass list doesn't carry.
    const visible = passes.find(p => {
        if (!(p.peakAlt >= 25)) return false;
        if (ms(p.rise) > ms(now) + 48 * HOUR_MS) return false;
        if (!isNum(lat) || !isNum(lon)) return true; // can't test → don't hide
        const alt = sunAltitudeDeg(lat, lon, p.peakTime ?? p.rise);
        return alt < -6 && alt > -25;
    });

    if (!visible) {
        return {
            id: 'iss', state: 'no',
            title: 'ISS pass: none visible',
            desc: 'No visible pass in the next 2 nights',
            when: '—',
        };
    }
    const mag = visible.magEst ?? issMagEstimate(visible.rangeKm);
    const dur = isNum(visible.durationMin) ? Math.max(1, Math.round(visible.durationMin)) : null;
    return {
        id: 'iss', state: 'go',
        title: `ISS pass: ${mag != null && mag <= -3 ? 'bright, ' : ''}${dur ? `${dur}-min arc` : 'overhead arc'}`,
        desc: `Rises ${visible.riseAz || '—'} → peaks ${Math.round(visible.peakAlt)}° → sets ${visible.setAz || '—'}`
            + (mag != null ? ` · mag ${mag}` : ''),
        when: fmtClock(visible.rise, tz),
    };
}

// ── Factors (§4.5) ──────────────────────────────────────────────────────────

function buildFactors(inputs, now, moonNow) {
    const tz = inputs.loc?.tz;
    const cloud = inputs.wx?.cloudPct;
    const kp = inputs.swpc?.kp;
    const air = inputs.air || {};

    return [
        {
            id: 'clouds', icon: '☁️', name: 'Clouds',
            val: isNum(cloud) ? `${Math.round(cloud)}%` : '--',
            cat: skyWord(cloud) === 'partly cloudy' ? 'partly' : (skyWord(cloud) || '--'),
            state: cloudState(cloud),
        },
        {
            id: 'sun', icon: '🌅', name: 'Sun',
            val: inputs.astro?.sunset ? `↓${fmtClockShort(inputs.astro.sunset, tz)}` : '--',
            cat: inputs.astro?.sunrise ? `↑${fmtClockShort(inputs.astro.sunrise, tz)}` : '--',
            state: 'help', // always neutral help-tint per spec
        },
        {
            id: 'activity', icon: '🧲', name: 'Activity',
            val: isNum(kp) ? `Kp ${kp.toFixed(1)}` : '--',
            cat: kpCat(kp) || '--',
            state: !isNum(kp) ? null : kp >= 5 ? 'help' : kp >= 4 ? 'watch' : null,
        },
        {
            id: 'moon', icon: moonNow?.glyph || '🌙', name: 'Moon',
            val: moonNow ? `${moonNow.illumPct}%` : '--',
            cat: moonNow?.name || '--',
            state: moonNow ? moonState(moonNow.illumPct) : null,
        },
        {
            id: 'aqi', icon: '🍃', name: 'AQI',
            val: isNum(air.aqi) ? String(Math.round(air.aqi)) : '--',
            cat: aqiCategory(air.aqi) || '--',
            state: aqiState(air.aqi),
        },
        {
            id: 'uv', icon: '🕶️', name: 'UV now',
            val: isNum(air.uvNow) ? String(Math.round(air.uvNow)) : '--',
            cat: isNum(air.uvPeak)
                ? `pk ${Math.round(air.uvPeak)}${air.uvPeakHour != null ? ' · ' + fmtClockShort(air.uvPeakHour, tz).replace(/:\d{2}/, '') : ''}`
                : '--',
            state: uvState(air.uvPeak),
        },
    ];
}

// ── Per-factor predictive series (chip detail graphs) ───────────────────────

/** UV index → WHO descriptor word. */
function uvWord(v) {
    if (!isNum(v)) return null;
    if (v < 3) return 'low';
    if (v < 6) return 'moderate';
    if (v < 8) return 'high';
    return v < 11 ? 'very high' : 'extreme';
}

/** Index of min / max value over a [{t, v}] series. */
function extremes(series) {
    let iMin = 0, iMax = 0;
    series.forEach((p, i) => {
        if (p.v < series[iMin].v) iMin = i;
        if (p.v > series[iMax].v) iMax = i;
    });
    return { iMin, iMax };
}

/**
 * Predictive series for ONE factor chip — powers the tap-a-chip detail
 * graph on the card. Same purity contract as the rest of this module:
 * inputs + now → chart model, no fetch, no ambient time, never throws.
 *
 * Returns null when the metric has nothing forecastable yet (feed still
 * loading, no location, empty Kp forecast) — the card renders an
 * explain-yourself empty state, not a fabricated flat line. Otherwise:
 *
 *   { id, title, unit, style:'line'|'bars', ticks:'hour'|'day',
 *     series:[{t(ms), v, kind?}], slotMs?, domain:{lo, hi},
 *     thresholds:[{v, label}], summary }
 *
 * Threshold values intentionally MIRROR the chip-state boundaries above
 * (cloudState 30/70, uvState 3/8, aqiState 50/100, Kp G-scale) so the
 * graph explains the chip's colour instead of inventing a second scale.
 */
export function factorForecast(id, inputs = {}, now = Date.now()) {
    const t0 = ms(now);
    const tz = inputs.loc?.tz;

    switch (id) {
        case 'clouds': {
            const rows = hourlyWindow(inputs.forecast, t0, 24).filter(r => isNum(r.cloudPct));
            if (rows.length < 4) return null;
            const series = rows.map(r => ({ t: ms(r.time), v: r.cloudPct }));
            const { iMin, iMax } = extremes(series);
            return {
                id, title: 'Cloud cover · next 24h', unit: '%', style: 'line', ticks: 'hour',
                series, domain: { lo: 0, hi: 100 },
                thresholds: [{ v: 30, label: 'clear' }, { v: 70, label: 'overcast' }],
                summary: `low ${Math.round(series[iMin].v)}% ${fmtClock(series[iMin].t, tz)} · `
                       + `high ${Math.round(series[iMax].v)}% ${fmtClock(series[iMax].t, tz)}`,
            };
        }

        case 'uv': {
            const rows = hourlyWindow(inputs.forecast, t0, 24).filter(r => isNum(r.uv));
            if (rows.length < 4) return null;
            const series = rows.map(r => ({ t: ms(r.time), v: r.uv }));
            const { iMax } = extremes(series);
            const peak = series[iMax];
            const hot = series.filter(p => p.v >= 3);
            const guard = hot.length
                ? `protect ${fmtClockShort(hot[0].t, tz)}–${fmtClockShort(hot[hot.length - 1].t + HOUR_MS, tz)}`
                : 'low all day';
            return {
                id, title: 'UV index · next 24h', unit: 'UV', style: 'line', ticks: 'hour',
                series, domain: { lo: 0, hi: Math.max(8.5, peak.v * 1.08) },
                thresholds: [{ v: 3, label: 'moderate' }, { v: 8, label: 'very high' }],
                summary: `peak ${Math.round(peak.v)} (${uvWord(peak.v)}) ${fmtClock(peak.t, tz)} · ${guard}`,
            };
        }

        case 'activity': {
            // NOAA 3-day Kp forecast (3-hourly slots). Honest step data →
            // bars, not a smoothed line. Empty forecast → null; a flat line
            // fabricated from the current Kp would read as a prediction.
            const rows = (inputs.swpc?.kpForecast || [])
                .filter(f => isNum(ms(f.time)) && isNum(f.kp)
                    && ms(f.time) >= t0 - 3 * HOUR_MS && ms(f.time) <= t0 + 48 * HOUR_MS)
                .sort((a, b) => ms(a.time) - ms(b.time))
                .map(f => ({ t: ms(f.time), v: clamp(f.kp, 0, 9), kind: f.kind || 'predicted' }));
            if (!rows.length) return null;
            const { iMax } = extremes(rows);
            const peak = rows[iMax];
            return {
                id, title: 'Kp forecast · next 48h', unit: 'Kp', style: 'bars', ticks: 'hour',
                series: rows, slotMs: 3 * HOUR_MS, domain: { lo: 0, hi: 9 },
                thresholds: [{ v: 5, label: 'G1 storm' }, { v: 7, label: 'G3' }],
                summary: `peak Kp ${peak.v.toFixed(1)} (${kpCat(peak.v)}) · ${fmtWeekday(peak.t, tz)} ${fmtClock(peak.t, tz)}`,
            };
        }

        case 'moon': {
            // Pure computation — nightly illumination for the coming week.
            const series = [];
            for (let i = 0; i < 8; i++) {
                const t = t0 + i * DAY_MS;
                series.push({ t, v: moonPhase(t).illumPct });
            }
            const nowPhase = moonPhase(t0);
            const dNew = (1 - nowPhase.phase) * SYNODIC_DAYS;
            const dFull = ((0.5 - nowPhase.phase + 1) % 1) * SYNODIC_DAYS;
            const inDays = (d, what) => (d < 0.75 ? `${what} tonight` : `${what} in ${Math.round(d)}d`);
            return {
                id, title: 'Moon illumination · next 7 nights', unit: '%', style: 'line', ticks: 'day',
                series, domain: { lo: 0, hi: 100 },
                thresholds: [{ v: 30, label: 'dark-sky' }],
                summary: `${nowPhase.illumPct}% ${nowPhase.name} tonight · `
                       + (dNew <= dFull ? inDays(dNew, 'new moon') : inDays(dFull, 'full moon')),
            };
        }

        case 'aqi': {
            const start = Math.floor(t0 / HOUR_MS) * HOUR_MS;
            const rows = (inputs.air?.aqiHourly || [])
                .filter(r => isNum(r.aqi) && isNum(ms(r.time))
                    && ms(r.time) >= start && ms(r.time) <= start + 24 * HOUR_MS)
                .sort((a, b) => ms(a.time) - ms(b.time))
                .map(r => ({ t: ms(r.time), v: r.aqi }));
            if (rows.length < 4) return null;
            const { iMax } = extremes(rows);
            const peak = rows[iMax];
            const cur = rows[0];
            const thresholds = [{ v: 50, label: 'good' }, { v: 100, label: 'sensitive' }];
            // The 150 line only when the chart actually gets near it —
            // domain 1.25× the peak keeps the line inside the plot.
            if (peak.v > 110) thresholds.push({ v: 150, label: 'unhealthy' });
            return {
                id, title: 'Air quality (US AQI) · next 24h', unit: 'AQI', style: 'line', ticks: 'hour',
                series: rows, domain: { lo: 0, hi: Math.max(110, peak.v * 1.25) },
                thresholds,
                summary: `now ${Math.round(cur.v)} (${aqiCategory(cur.v)}) · `
                       + `peak ${Math.round(peak.v)} (${aqiCategory(peak.v)}) ${fmtClock(peak.t, tz)}`,
            };
        }

        case 'sun': {
            const lat = inputs.loc?.lat, lon = inputs.loc?.lon;
            if (!isNum(lat) || !isNum(lon)) return null;
            const series = [];
            for (let m = 0; m <= 24 * 60; m += 30) {
                const t = t0 + m * 60_000;
                series.push({ t, v: sunAltitudeDeg(lat, lon, t) });
            }
            const { iMin, iMax } = extremes(series);
            // Prefer the page-supplied precise rise/set (sun-altitude.js);
            // fall back to this curve's own horizon crossings (±few min).
            let setT = inputs.astro?.sunset ?? null;
            let riseT = inputs.astro?.sunrise ?? null;
            if (setT == null || riseT == null) {
                for (let i = 1; i < series.length; i++) {
                    const a = series[i - 1], b = series[i];
                    if (setT == null && a.v >= 0 && b.v < 0) setT = b.t;
                    if (riseT == null && a.v < 0 && b.v >= 0) riseT = b.t;
                }
            }
            const bits = [];
            if (setT != null) bits.push(`sets ${fmtClock(setT, tz)}`);
            if (riseT != null) bits.push(`rises ${fmtClock(riseT, tz)}`);
            bits.push(`max +${Math.round(series[iMax].v)}°`);
            return {
                id, title: 'Sun altitude · next 24h', unit: '°', style: 'line', ticks: 'hour',
                series,
                domain: {
                    lo: Math.min(-25, Math.floor(series[iMin].v)),
                    hi: Math.max(30, Math.ceil(series[iMax].v) + 5),
                },
                thresholds: [{ v: 0, label: 'horizon' }, { v: -18, label: 'astro dark' }],
                summary: bits.join(' · '),
            };
        }

        default:
            return null;
    }
}

// ── Main fusion ─────────────────────────────────────────────────────────────

/**
 * Fuse all feed snapshots into the card model. Pure: same inputs + now →
 * same output. See the module header for the input contract.
 */
/**
 * 3-day storm outlook row from the flux-rope ensemble summary (Phase 4:
 * the EarthView consumer of js/flux-rope-forecast.js). Location-independent
 * — it describes the inbound CME, not local visibility (the aurora row owns
 * that). Returns a skyEvents-shaped row plus a `tier`
 * ('watch' | 'warning' | 'arriving'), or null when there is nothing worth a
 * row: no data, a deep miss (P(hit) < 15%), or a window already >12 h past.
 */
export function stormOutlook(fluxRope, now = Date.now()) {
    const f = fluxRope;
    const t0 = ms(now);
    if (!f || !isNum(f.pHit) || !isNum(f.arrivalP50Ms)) return null;
    if (f.pHit < 0.15) return null;
    if (isNum(f.arrivalP90Ms) && f.arrivalP90Ms < t0 - 12 * HOUR_MS) return null;

    const hours = (f.arrivalP50Ms - t0) / HOUR_MS;
    const sev = (f.p20 ?? 0) >= 0.4 ? 'strong (G2–G3) storm potential'
        : (f.p10 ?? 0) >= 0.4 ? 'moderate (G1–G2) storm potential'
        : 'minor storm potential';
    const pct = Math.round(f.pHit * 100);
    const win = (v) => (isNum(v) ? new Date(v).toISOString().slice(5, 16).replace('T', ' ') + 'Z' : '—');

    if (hours <= 0) {
        return {
            id: 'storm-outlook', tier: 'arriving',
            state: (f.p10 ?? 0) >= 0.3 ? 'go' : 'maybe',
            title: 'CME arriving',
            desc: `Flux-rope ensemble: ${sev} · P(hit) ${pct}%`,
            when: 'now',
        };
    }
    const tier = hours <= 24 ? 'warning' : 'watch';
    return {
        id: 'storm-outlook', tier,
        state: f.pHit >= 0.5 && (f.p10 ?? 0) >= 0.3 ? 'maybe' : 'no',
        title: tier === 'warning' ? 'CME warning — arrival within a day' : 'CME watch',
        desc: `Flux-rope ensemble: ${sev} · P(hit) ${pct}% · window ${win(f.arrivalP10Ms)}–${win(f.arrivalP90Ms)}`,
        when: `+${Math.round(hours)} h`,
    };
}

export function computeVerdict(inputs = {}, now = new Date()) {
    const t0 = ms(now);
    const tz = inputs.loc?.tz;
    const lat = inputs.loc?.lat, lon = inputs.loc?.lon;
    const hasLoc = isNum(lat) && isNum(lon);

    // Effective Kp tonight: max of current Kp and any forecast entries that
    // land inside the coming dark window (sun < −12°). Forecast peaks in
    // daylight are capped out per §4.2.
    const kpNow = inputs.swpc?.kp;
    let kpEff = isNum(kpNow) ? kpNow : null;
    let deepestSunAlt = hasLoc ? 90 : -90; // no loc → assume dark (can't test)
    if (hasLoc) {
        for (let h = 0; h <= 24; h++) {
            const alt = sunAltitudeDeg(lat, lon, t0 + h * HOUR_MS);
            if (alt < deepestSunAlt) deepestSunAlt = alt;
        }
        for (const f of inputs.swpc?.kpForecast || []) {
            const ft = ms(f.time);
            if (!isNum(ft) || !isNum(f.kp) || ft < t0 || ft > t0 + 24 * HOUR_MS) continue;
            if (sunAltitudeDeg(lat, lon, ft) < -12 && (kpEff == null || f.kp > kpEff)) kpEff = f.kp;
        }
    }

    // Cloud % during the dark window (mean), fallback to current clouds.
    let darkClouds = inputs.wx?.cloudPct;
    if (hasLoc) {
        const darkRows = hourlyWindow(inputs.forecast, t0, 24)
            .filter(r => isNum(r.cloudPct) && sunAltitudeDeg(lat, lon, ms(r.time)) < -12);
        if (darkRows.length) {
            darkClouds = darkRows.reduce((s, r) => s + r.cloudPct, 0) / darkRows.length;
        }
    }

    const mlat = hasLoc ? magneticLatitude(lat, lon) : null;
    // No location → no personal aurora verdict; evaluating at a placeholder
    // latitude would produce a confident-but-meaningless GO.
    const aurora = hasLoc
        ? auroraVerdict(kpEff ?? 0, mlat, darkClouds, deepestSunAlt)
        : {
            state: 'no', margin: null, boundary: null,
            title: 'Aurora: set a location',
            desc: 'Save a location to get a personal aurora verdict.',
        };

    const moonNow = moonPhase(t0);
    const head = buildWord(inputs, t0, aurora, kpEff);
    const sentence = buildSentence(inputs, t0);
    const factors = buildFactors(inputs, t0, moonNow);
    const { week, moonSeq, bestNight } = buildWeek(inputs, t0, kpEff);

    const tempSeries = hourlyWindow(inputs.forecast, t0, 18)
        .filter(r => isNum(r.tempF))
        .slice(0, 19)
        .map(r => ({ t: ms(r.time), tempF: r.tempF }));

    // Aurora row copy: when = start of tonight's dark window if go/maybe.
    let auroraWhen = '—';
    if (aurora.state !== 'no' && hasLoc) {
        for (let m = 0; m <= 24 * 60; m += 15) {
            if (sunAltitudeDeg(lat, lon, t0 + m * 60000) < -12) {
                auroraWhen = m === 0 ? 'now' : fmtClock(t0 + m * 60000, tz);
                break;
            }
        }
    }

    // 3-day storm outlook (Phase 4): APPENDED so the aurora/ISS indices the
    // card's CTA logic relies on ([0]/[1]) never move.
    const outlook = stormOutlook(inputs.fluxRope, t0);
    const skyEvents = [
        { id: 'aurora', state: aurora.state, title: aurora.title, desc: aurora.desc, when: auroraWhen },
        buildIssRow(inputs, t0),
        ...(outlook ? [outlook] : []),
    ];

    return {
        outlook,
        word: head.word,
        sub: head.sub,
        lamp: head.lamp,
        icon: head.icon,
        sentence,
        factors,
        tempSeries,
        week,
        moonSeq,
        bestNight,
        skyEvents,
        aurora,          // full aurora verdict for telemetry / CTA context
        kpEffective: kpEff,
    };
}
