/**
 * js/composite-indices.js
 *
 * Pure-function meteorological composite indices, derived from the
 * surface fields already sampled by earth.html's hover-readout pipeline.
 * No network calls, no DOM. Callers run `computeAdvisories(weather)`
 * and render whichever entries clear their info threshold.
 *
 * Indices included (and where they came from)
 * ──────────────────────────────────────────
 *   heatIndex      Rothfusz / NWS regression in °F + adjustments for
 *                  RH extremes. Valid above ~80 °F.
 *   windChill      NWS 2001 formula in °F + mph. Valid T ≤ 50 °F and
 *                  V > 3 mph.
 *   apparentTemp   Whichever of heatIndex / windChill applies — the
 *                  one combined "feels like" number.
 *   frostRisk      T_air ≤ 36 °F AND dew_point depression ≤ 5 °F is
 *                  the operational frost-watch threshold; warning at
 *                  ≤ 32 °F.
 *   fireWeather    Fosberg FFWI (0..100). Equilibrium moisture of
 *                  dead 1-h fuels × wind correction. Flag at FFWI > 50.
 *   hotDryWindy    HDW = max(VPD) × max(V). Operationally calibrated
 *                  to fire-spread potential — flag at HDW > 5.
 *
 * Each computed entry is `{ id, label, value, units, severity, blurb,
 * formula }`. `severity` is one of:
 *   'info'      — interesting but not actionable
 *   'caution'   — worth keeping an eye on (yellow)
 *   'warning'   — actionable (orange)
 *   'danger'    — high-risk threshold crossed (red)
 *
 * Empty advisories (below threshold or missing inputs) are filtered
 * out by computeAdvisories so the UI only renders what's relevant.
 */

// ── Unit conversions / helpers ─────────────────────────────────────

export function cToF(c) { return c * 9 / 5 + 32; }
export function fToC(f) { return (f - 32) * 5 / 9; }
export function msToMph(ms) { return ms * 2.23694; }
export function mphToMs(mph) { return mph / 2.23694; }

/**
 * Magnus-Tetens dew point in °C from T_air (°C) + RH (%).
 * Coefficients a, b chosen for −45..+60 °C range (Sonntag 1990).
 */
export function dewPointC(tempC, rhPct) {
    if (!Number.isFinite(tempC) || !Number.isFinite(rhPct)) return NaN;
    const clampedRh = Math.max(0.1, Math.min(100, rhPct));
    const a = 17.62, b = 243.12;
    const gamma = Math.log(clampedRh / 100) + (a * tempC) / (b + tempC);
    return (b * gamma) / (a - gamma);
}

/**
 * Saturation vapor pressure (hPa) at T °C — Tetens equation, the same
 * one used inside the dew-point inversion above so the two functions
 * stay self-consistent.
 */
export function satVaporHpa(tempC) {
    return 6.112 * Math.exp((17.62 * tempC) / (243.12 + tempC));
}

/**
 * Vapor-pressure deficit (hPa) = e_s(T) − e_a(T, RH). Output is the
 * "thirst of the air" — how much more water it can hold. Drives the
 * HDW index and matters for plant stress.
 */
export function vpdHpa(tempC, rhPct) {
    const es = satVaporHpa(tempC);
    return es * (1 - Math.max(0, Math.min(100, rhPct)) / 100);
}

// ── Heat index (Rothfusz / NWS) ────────────────────────────────────

/**
 * NWS heat-index regression. Inputs in °F + RH%. Returns °F.
 *
 * The simple (Steadman 1979) form is used below ~80 °F; the
 * full Rothfusz polynomial + RH/temperature adjustments are applied
 * when the simple form predicts ≥ 80 °F. This matches the operational
 * NWS algorithm verbatim.
 */
export function heatIndexF(tempF, rhPct) {
    if (!Number.isFinite(tempF) || !Number.isFinite(rhPct)) return NaN;
    if (tempF < 40) return tempF;  // formula breaks at low temps

    // Steadman simple estimate first.
    const simple = 0.5 * (tempF + 61.0 + ((tempF - 68.0) * 1.2) + (rhPct * 0.094));
    const avg = (simple + tempF) / 2;
    if (avg < 80) return avg;

    // Rothfusz full polynomial.
    let hi =
        -42.379
        + 2.04901523    * tempF
        + 10.14333127   * rhPct
        - 0.22475541    * tempF * rhPct
        - 0.00683783    * tempF * tempF
        - 0.05481717    * rhPct * rhPct
        + 0.00122874    * tempF * tempF * rhPct
        + 0.00085282    * tempF * rhPct * rhPct
        - 0.00000199    * tempF * tempF * rhPct * rhPct;

    // RH extreme adjustments.
    if (rhPct < 13 && tempF >= 80 && tempF <= 112) {
        hi -= ((13 - rhPct) / 4) * Math.sqrt((17 - Math.abs(tempF - 95)) / 17);
    } else if (rhPct > 85 && tempF >= 80 && tempF <= 87) {
        hi += ((rhPct - 85) / 10) * ((87 - tempF) / 5);
    }
    return hi;
}

// ── Wind chill (NWS 2001) ──────────────────────────────────────────

/**
 * NWS 2001 wind chill. Inputs in °F + mph. Returns °F.
 * Valid for T ≤ 50 °F and V > 3 mph; outside that, falls back to T.
 */
export function windChillF(tempF, windMph) {
    if (!Number.isFinite(tempF) || !Number.isFinite(windMph)) return NaN;
    if (tempF > 50 || windMph <= 3) return tempF;
    return 35.74
         + 0.6215 * tempF
         - 35.75  * Math.pow(windMph, 0.16)
         + 0.4275 * tempF * Math.pow(windMph, 0.16);
}

// ── Fosberg Fire Weather Index ─────────────────────────────────────

/**
 * FFWI 0..100. Inputs in °F + RH% + mph. Derived from the equilibrium
 * moisture content (EMC) of dead 1-hr time-lag fuels and a wind factor.
 *
 * Calibration (Fosberg 1978):
 *   < 20  benign
 *   20–50 elevated
 *   > 50  critical fire-spread potential
 */
export function fosbergFFWI(tempF, rhPct, windMph) {
    if (!Number.isFinite(tempF) || !Number.isFinite(rhPct) || !Number.isFinite(windMph)) {
        return NaN;
    }
    let m;
    if (rhPct < 10)      m = 0.03229 + 0.281073 * rhPct - 0.000578 * rhPct * tempF;
    else if (rhPct < 50) m = 2.22749 + 0.160107 * rhPct - 0.014784 * tempF;
    else                 m = 21.0606 + 0.005565 * rhPct * rhPct
                              - 0.00035  * rhPct * tempF
                              - 0.483199 * rhPct;
    const eta = 1 - 2 * (m / 30) + 1.5 * Math.pow(m / 30, 2)
                  - 0.5 * Math.pow(m / 30, 3);
    return Math.max(0, Math.min(100,
        (eta * Math.sqrt(1 + windMph * windMph)) / 0.3002));
}

// ── Hot-Dry-Windy Index ────────────────────────────────────────────

/**
 * HDW = VPD (hPa) × wind speed (m/s). McDonald et al. 2018 — designed
 * specifically for catastrophic fire-weather days where high VPD plus
 * sustained wind aligns. Flag operationally at HDW > 5 (very high)
 * and > 8 (extreme).
 */
export function hotDryWindyIndex(tempC, rhPct, windMs) {
    if (!Number.isFinite(tempC) || !Number.isFinite(rhPct) || !Number.isFinite(windMs)) {
        return NaN;
    }
    return vpdHpa(tempC, rhPct) * windMs;
}

// ── Frost risk ─────────────────────────────────────────────────────

/**
 * Operational frost-risk classifier. Returns one of:
 *   'none' | 'watch' | 'advisory' | 'warning'
 * mirroring NWS frost/freeze terminology.
 */
export function frostRisk(tempC, dewC) {
    if (!Number.isFinite(tempC)) return 'none';
    const tempF = cToF(tempC);
    const dpF   = Number.isFinite(dewC) ? cToF(dewC) : null;
    // Dew-point depression — small depression = high humidity =
    // condensation will form readily. < 5 °F is the operational
    // frost-watch threshold.
    const depression = dpF != null ? Math.abs(tempF - dpF) : null;

    if (tempF <= 28)              return 'warning';     // hard freeze
    if (tempF <= 32)              return 'advisory';    // freeze
    if (tempF <= 36 && depression != null && depression <= 5) {
        return 'watch';                                 // frost likely
    }
    return 'none';
}

// ── Public bundle ──────────────────────────────────────────────────

/**
 * @typedef {{
 *   tempC: number, rhPct: number, windMs?: number, dewC?: number,
 *   lowCloudPct?: number, highCloudPct?: number,
 * }} WeatherSample
 *
 * @typedef {{
 *   id:       string,
 *   label:    string,
 *   value:    number,
 *   units:    string,
 *   severity: 'info'|'caution'|'warning'|'danger',
 *   blurb:    string,
 *   formula?: string,
 * }} Advisory
 */

/**
 * Compute the active advisories for the given sample. Returns only
 * entries above the index's "info" threshold so callers can render
 * everything indiscriminately.
 *
 * @param {WeatherSample} wx
 * @returns {Advisory[]}
 */
export function computeAdvisories(wx) {
    if (!wx) return [];
    const tempC   = Number.isFinite(wx.tempC)   ? wx.tempC   : NaN;
    const rhPct   = Number.isFinite(wx.rhPct)   ? wx.rhPct   : NaN;
    const windMs  = Number.isFinite(wx.windMs)  ? wx.windMs  : NaN;
    const tempF   = cToF(tempC);
    const windMph = msToMph(windMs);
    const dewC    = Number.isFinite(wx.dewC) ? wx.dewC : dewPointC(tempC, rhPct);
    const out     = [];

    // ── Heat index ─────────────────────────────────────────────────
    if (Number.isFinite(tempF) && Number.isFinite(rhPct) && tempF >= 80) {
        const hi = heatIndexF(tempF, rhPct);
        const sev = hi >= 125 ? 'danger'
                  : hi >= 105 ? 'warning'
                  : hi >= 90  ? 'caution'
                  : 'info';
        if (hi >= 85 || sev !== 'info') {
            out.push({
                id:      'heat-index',
                label:   'Heat Index',
                value:   Math.round(hi),
                units:   '°F',
                severity:sev,
                blurb:
                    sev === 'danger'  ? 'Extreme caution — heat stroke likely with prolonged exposure.'
                  : sev === 'warning' ? 'Heat exhaustion possible with prolonged exposure.'
                  : sev === 'caution' ? 'Fatigue possible with extended outdoor activity.'
                  :                     'Feels warmer than the dry-bulb temperature.',
                formula: 'NWS Rothfusz regression',
            });
        }
    }

    // ── Wind chill ─────────────────────────────────────────────────
    if (Number.isFinite(tempF) && Number.isFinite(windMph)
        && tempF <= 50 && windMph > 3) {
        const wc = windChillF(tempF, windMph);
        const sev = wc <= -25 ? 'danger'
                  : wc <= 0   ? 'warning'
                  : wc <= 20  ? 'caution'
                  : 'info';
        if (sev !== 'info' || (tempF - wc) >= 5) {
            out.push({
                id:      'wind-chill',
                label:   'Wind Chill',
                value:   Math.round(wc),
                units:   '°F',
                severity:sev,
                blurb:
                    sev === 'danger'  ? 'Frostbite within minutes on exposed skin.'
                  : sev === 'warning' ? 'Frostbite possible in 30 minutes on exposed skin.'
                  : sev === 'caution' ? 'Colder than the dry-bulb temperature.'
                  :                     'Slightly colder than the dry-bulb temperature.',
                formula: 'NWS 2001',
            });
        }
    }

    // ── Fosberg FFWI ───────────────────────────────────────────────
    // Frozen-fuels gate: FFWI's EMC model assumes liquid water in dead
    // fuels. Below freezing the fuel is glassy ice and the formula
    // over-flags cold windy days. Skip the index when T < 32 °F.
    if (Number.isFinite(tempF) && Number.isFinite(rhPct)
        && Number.isFinite(windMph) && tempF >= 32) {
        const ffwi = fosbergFFWI(tempF, rhPct, windMph);
        const sev = ffwi >= 70 ? 'danger'
                  : ffwi >= 50 ? 'warning'
                  : ffwi >= 30 ? 'caution'
                  : 'info';
        if (sev !== 'info') {
            out.push({
                id:      'fire-weather',
                label:   'Fire Weather (FFWI)',
                value:   Math.round(ffwi),
                units:   '',
                severity:sev,
                blurb:
                    sev === 'danger'  ? 'Critical fire-spread potential.'
                  : sev === 'warning' ? 'Elevated — fast-moving fires possible.'
                  :                     'Above-average fire-spread potential.',
                formula: 'Fosberg 1978',
            });
        }
    }

    // ── Hot-Dry-Windy ──────────────────────────────────────────────
    // McDonald 2018 typically scales VPD in kPa × V in m/s, with
    // "very high" days at ~50 and "extreme" ~100. We compute VPD in
    // hPa for self-consistency with the rest of this module (Tetens,
    // dew point), which scales the index 10× relative to the original
    // formulation. Thresholds below reflect that hPa-based unit.
    // Also gate on tempC ≥ 5 °C — cold air physically can't carry
    // enough vapor to deserve a "dry+windy" flag regardless of RH.
    if (Number.isFinite(tempC) && Number.isFinite(rhPct)
        && Number.isFinite(windMs) && tempC >= 5) {
        const hdw = hotDryWindyIndex(tempC, rhPct, windMs);
        const sev = hdw >= 200 ? 'danger'
                  : hdw >= 100 ? 'warning'
                  : hdw >= 50  ? 'caution'
                  : 'info';
        if (sev !== 'info') {
            out.push({
                id:      'hot-dry-windy',
                label:   'Hot-Dry-Windy',
                value:   Math.round(hdw * 10) / 10,
                units:   '',
                severity:sev,
                blurb:
                    sev === 'danger'  ? 'Catastrophic fire-spread alignment (VPD × wind).'
                  : sev === 'warning' ? 'High alignment between drying air and wind.'
                  :                     'Above-average dryness × wind product.',
                formula: 'McDonald 2018: VPD(hPa) × V(m/s)',
            });
        }
    }

    // ── Frost risk ─────────────────────────────────────────────────
    const frost = frostRisk(tempC, dewC);
    if (frost !== 'none') {
        const sev = frost === 'warning'  ? 'danger'
                  : frost === 'advisory' ? 'warning'
                  :                        'caution';
        out.push({
            id:      'frost',
            label:   'Frost Risk',
            value:   Math.round(cToF(tempC)),
            units:   '°F',
            severity:sev,
            blurb:
                frost === 'warning'  ? 'Hard freeze — kills tender vegetation.'
              : frost === 'advisory' ? 'Freeze conditions.'
              :                        'Frost likely on still surfaces — narrow dew-point depression.',
            formula: 'NWS frost/freeze thresholds',
        });
    }

    // Sort by severity (danger first) so the strip reads worst → best.
    const sevRank = { danger: 0, warning: 1, caution: 2, info: 3 };
    out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);
    return out;
}

/**
 * Render the advisories array as HTML rows compatible with the
 * existing #coord-tip / #ct-readouts box. Caller wraps and inserts.
 *
 * Kept as a string-builder rather than a DOM helper so the existing
 * `rows.push('<div class=...>...</div>')` pattern in earth.html stays
 * uniform — the hover readout code interpolates these alongside its
 * own rows in one innerHTML write.
 */
export function advisoriesToHtmlRows(advisories) {
    if (!advisories || advisories.length === 0) return [];
    return advisories.map(a => {
        const icon =
            a.id === 'heat-index'     ? '🌡️'
          : a.id === 'wind-chill'     ? '❄️'
          : a.id === 'fire-weather'   ? '🔥'
          : a.id === 'hot-dry-windy'  ? '🌪️'
          : a.id === 'frost'          ? '🧊'
          : '⚠';
        const valTxt = `${a.value}${a.units}`;
        return `<div class="ct-readout ct-rd-adv" data-sev="${a.severity}">`
            + `<span class="ct-rd-icon">${icon}</span>`
            + `<span class="ct-rd-val">${valTxt}</span> `
            + `<span class="ct-rd-adv-label">${escapeHtml(a.label)}</span>`
            + `</div>`;
    });
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    })[ch]);
}
