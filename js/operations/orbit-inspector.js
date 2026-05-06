/**
 * orbit-inspector.js — Per-satellite trajectory & perturbation panel.
 *
 * Shows the operator a single-asset view of:
 *
 *   - TLE-derived classical elements (a, e, i, Ω, ω, M₀)
 *   - period, apogee, perigee, mean motion
 *   - J2 secular drift rates (Ω̇ nodal regression, ω̇ apsidal
 *     precession, Ṁ — the slow drifts that move the orbit plane
 *     and ground track over days/weeks)
 *   - altitude profile over one orbit (sparkline; visualises the
 *     eccentric shape that perigee / apogee numbers compress)
 *
 * Reads from TLE elements directly (Brouwer-Lyddane mean elements
 * the SGP4 model fits). Stable, instant; doesn't recompute on
 * every time-bus tick. Refreshes only when the selection or the
 * tracker's TLE for the selected sat changes.
 *
 * Scope is deliberately bounded — this is the v1 of operator-
 * facing orbit analysis. Follow-ups worth building:
 *   - osculating elements at the time-bus instant (changes per
 *     orbit due to short-period perturbations)
 *   - drag-induced semi-major-axis decay rate (currently surfaced
 *     for the fleet via Decay Watch; could repeat here)
 *   - third-body / SRP perturbation budget for HEO/GEO
 *   - ground track over the next N orbits
 *
 * Mounted in the operations right column near the maneuver panel.
 */

import { propagate, tleEpochToJd, getWasmSgp4 } from '../satellite-tracker.js';
import { decayWithSigma, deltaAPerDay, fmtLifetime } from './decision-deck.js';
import { provStore } from './provenance.js';

const MIN_PER_DAY = 1440;
const RE_KM       = 6378.135;     // WGS-72, matches the SGP4 propagator
const MU_KM3_S2   = 398600.8;     // WGS-72 μ
const J2          = 0.001082616;
const DEG         = Math.PI / 180;
const RAD         = 180 / Math.PI;

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * Compute J2 secular drift rates from classical mean elements.
 * Ω̇ (nodal regression) and ω̇ (apsidal precession) are the two
 * operational orbit-plane drifts that show up over days; Ṁ is the
 * mean-motion perturbation due to the J2-induced effective μ.
 *
 * Inputs in TLE units (degrees, revs/day, eccentricity); outputs
 * in degrees/day.
 *
 * Reference: Vallado, "Fundamentals of Astrodynamics" 4th ed.,
 * eqs. 9-37 to 9-39.
 */
function j2SecularRatesDegPerDay({ a_km, e, incl_deg, mean_motion_revs_day }) {
    const i_rad = incl_deg * DEG;
    const cosI  = Math.cos(i_rad);
    const sinI  = Math.sin(i_rad);
    const p_km  = a_km * (1 - e * e);
    if (!Number.isFinite(p_km) || p_km <= 0) return null;
    // n0 in rad/day from mean_motion (revs/day).
    const n0_rad_day = mean_motion_revs_day * 2 * Math.PI;
    const factor = 1.5 * J2 * (RE_KM / p_km) ** 2 * n0_rad_day;
    const eta    = Math.sqrt(Math.max(0, 1 - e * e));
    return {
        raanDot_deg_day: -factor * cosI               * RAD,
        argpDot_deg_day:  0.5 * factor * (5 * cosI * cosI - 1) * RAD,
        meanAnomDot_deg_day: 0.5 * factor * eta * (3 * cosI * cosI - 1) * RAD,
        sinI, cosI,
    };
}

/**
 * Sample altitude over one orbital period using SGP4 (WASM batch
 * when available). Returns a Float32Array of altitudes (km above
 * RE) sampled at uniform tsince intervals starting from the
 * caller's epochAnchorMs.
 */
function altitudeProfileOverOrbit(tle, epochAnchorMs, samples = 60) {
    if (!Number.isFinite(tle?.period_min) || tle.period_min <= 0) return null;
    const epochJd = tleEpochToJd(tle);
    const jdAnchor = epochAnchorMs / 86400000 + 2440587.5;
    const tsBaseMin = (jdAnchor - epochJd) * MIN_PER_DAY;
    const periodMin = tle.period_min;

    const times = new Float64Array(samples);
    for (let i = 0; i < samples; i++) {
        times[i] = tsBaseMin + (i / (samples - 1)) * periodMin;
    }

    const wasm = getWasmSgp4();
    let pos = null;
    if (wasm?.propagate_batch && tle.line1 && tle.line2) {
        try {
            pos = wasm.propagate_batch(tle.line1, tle.line2, times);
        } catch (_) { pos = null; }
    }
    const out = new Float32Array(samples);
    if (pos) {
        for (let i = 0; i < samples; i++) {
            const x = pos[i * 6], y = pos[i * 6 + 1], z = pos[i * 6 + 2];
            out[i] = Math.hypot(x, y, z) - RE_KM;
        }
    } else {
        for (let i = 0; i < samples; i++) {
            const r = propagate(tle, times[i]);
            out[i] = Number.isFinite(r?.x) ? Math.hypot(r.x, r.y, r.z) - RE_KM : NaN;
        }
    }
    return out;
}

/**
 * Inline SVG altitude profile. Vertical axis spans [perigee, apogee]
 * with a small breathing room; markers call out apogee + perigee.
 */
function renderAltSpark(altitudes, perigeeKm, apogeeKm) {
    if (!altitudes || altitudes.length < 3) return '';
    const n = altitudes.length;
    let lo = Infinity, hi = -Infinity;
    for (const a of altitudes) {
        if (!Number.isFinite(a)) continue;
        if (a < lo) lo = a;
        if (a > hi) hi = a;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
    // Clamp to perigee/apogee from the TLE for a more honest axis;
    // SGP4 sampling can land slightly outside due to short-period
    // perturbations.
    if (Number.isFinite(perigeeKm)) lo = Math.min(lo, perigeeKm);
    if (Number.isFinite(apogeeKm))  hi = Math.max(hi, apogeeKm);
    const range = Math.max(hi - lo, 1);

    const W = 220, H = 44;
    const PAD = 2;
    const dx = (W - 2 * PAD) / (n - 1);
    const yOf = (a) => H - PAD - ((a - lo) / range) * (H - 2 * PAD);

    let d = '';
    let prev = false;
    for (let i = 0; i < n; i++) {
        const v = altitudes[i];
        if (!Number.isFinite(v)) { prev = false; continue; }
        const x = PAD + i * dx;
        const y = yOf(v);
        d += (prev ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
        prev = true;
    }
    return `
        <svg class="op-orbit-spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true">
            <title>Altitude over one orbit (${lo.toFixed(0)} – ${hi.toFixed(0)} km)</title>
            <path d="${d.trim()}" class="op-orbit-spark-line"/>
            <text x="${W - 4}" y="11" class="op-orbit-spark-label" text-anchor="end">apo ${hi.toFixed(0)} km</text>
            <text x="${W - 4}" y="${H - 2}" class="op-orbit-spark-label" text-anchor="end">per ${lo.toFixed(0)} km</text>
        </svg>
    `;
}

/**
 * Drag + decay block. Pulls live F10.7 / Ap from provStore (same
 * source the prop-budget panel uses) and combines them with the
 * shared King-Hele surrogate via decayWithSigma + deltaAPerDay so
 * the inspector and Decay Watch can never diverge.
 *
 * Renders three numbers:
 *   - dā/dt  (km/day, signed; negative = decaying, ≈0 for stable
 *     orbits above 1000 km)
 *   - lifetime (formatted into the most legible coarse unit)
 *   - 1σ band on lifetime (forecast spread + ±25 % B*
 *     uncertainty in quadrature)
 *
 * The active F10.7 / Ap are echoed in a one-line subscript so an
 * operator can tell at a glance whether the projection is
 * climatology or live-storm conditions.
 */
function renderDragSection(tle) {
    if (!Number.isFinite(tle?.perigee_km)) return '';

    // Live indices via provStore. Climatology defaults match the
    // Decay Watch panel so the two read identically when the SWPC
    // bridge hasn't landed yet.
    const f107Mid = provStore.get('idx.f107')?.value ?? 150;
    const apMid   = provStore.get('idx.ap')?.value   ?? 15;
    const sigF107 = provStore.get('idx.f107')?.sigma ?? 12;
    const sigAp   = provStore.get('idx.ap')?.sigma   ?? 4;

    const decay   = decayWithSigma(tle, f107Mid, sigF107, apMid, sigAp);
    const dadtDay = deltaAPerDay(tle, f107Mid, apMid);

    const lifeStr = decay?.lifetime_days != null
        ? fmtLifetime(decay.lifetime_days)
        : '—';
    const sigStr = (decay && Number.isFinite(decay.sigma_days))
        ? `±${fmtLifetime(decay.sigma_days)}`
        : '';

    // Reentry-imminent flag. The fine-grained baseLifetimeMonths
    // buckets (90-200 km) collapse lifetime smoothly toward zero
    // below ~150 km; once we're under a day the operator needs a
    // visible alarm — a small number alone is too easy to miss in
    // a panel full of small numbers.
    const lifeDays = decay?.lifetime_days ?? Infinity;
    let reentryBadge = '';
    if (Number.isFinite(lifeDays)) {
        if (lifeDays < 0.25) {
            reentryBadge = `<span class="op-orbit-reentry op-orbit-reentry--now">REENTRY · &lt; 6 h</span>`;
        } else if (lifeDays < 1) {
            reentryBadge = `<span class="op-orbit-reentry op-orbit-reentry--now">REENTRY · &lt; 1 day</span>`;
        } else if (lifeDays < 7) {
            reentryBadge = `<span class="op-orbit-reentry op-orbit-reentry--soon">REENTRY · ${Math.round(lifeDays)} d</span>`;
        } else if (lifeDays < 30) {
            reentryBadge = `<span class="op-orbit-reentry op-orbit-reentry--watch">decay watch · ${Math.round(lifeDays)} d</span>`;
        }
    }

    // dā/dt readout. For LEO under 600 km we get tens of
    // metres/day; for higher orbits we trickle into the cm/day
    // regime — switch unit so the digits stay readable.
    const ratePerDayKm = dadtDay;          // negative or 0
    const absKmDay     = Math.abs(ratePerDayKm);
    let rateStr;
    if (!Number.isFinite(ratePerDayKm) || absKmDay === 0) {
        rateStr = '— stable';
    } else if (absKmDay >= 0.1) {
        rateStr = `${ratePerDayKm.toFixed(2)} km/day`;
    } else if (absKmDay >= 0.001) {
        rateStr = `${(ratePerDayKm * 1000).toFixed(0)} m/day`;
    } else {
        rateStr = `${(ratePerDayKm * 1e5).toFixed(1)} cm/day`;
    }

    // Year framing for operators who think in horizons rather
    // than days. Empty when the model treats the orbit as
    // effectively stable.
    const ratePerYearStr = (Number.isFinite(ratePerDayKm) && absKmDay > 0)
        ? `${(ratePerDayKm * 365.25).toFixed(1)} km/yr`
        : '';

    return `
        <div class="op-orbit-rates op-orbit-drag">
            <div class="op-orbit-rate-title" title="Atmospheric drag drives semi-major axis decay; rate is the slope of the lifetime model at the current perigee.">
                Drag &amp; decay
                ${reentryBadge}
                <span class="op-orbit-rate-conds">F10.7 ${f107Mid.toFixed(0)} · Ap ${apMid.toFixed(0)}</span>
            </div>
            <div title="Instantaneous rate of change of semi-major axis at the current perigee, derived by differencing the lifetime model.">
                <span class="op-orbit-tag">dā/dt</span>${rateStr}
            </div>
            <div title="Same rate expressed annually for horizon-style framing.">
                <span class="op-orbit-tag">/yr</span>${ratePerYearStr || '—'}
            </div>
            <div title="Time until perigee re-entry, with a 1σ band combining solar-index forecast spread and ±25 % B* uncertainty in quadrature.">
                <span class="op-orbit-tag">life</span>${lifeStr}<span class="op-orbit-unit"> ${sigStr}</span>
            </div>
        </div>
    `;
}

export function mountOrbitInspector(opts = {}) {
    const {
        host,
        tracker,
        getSelectedId  = () => null,
        onSelectChange = () => () => {},
    } = opts;

    if (!host || !tracker) {
        console.warn('[orbitInspector] missing host / tracker; aborting mount');
        return { dispose() {} };
    }

    let selectedId = null;
    let altCache   = null;          // last altitude profile, keyed by selectedId
    let altCacheId = null;

    function paintEmpty(reason) {
        host.innerHTML = `<div class="op-orbit-empty">${escapeHtml(reason)}</div>`;
        altCache   = null;
        altCacheId = null;
    }

    function render() {
        if (selectedId == null) { paintEmpty('Select a satellite to inspect its orbit.'); return; }
        const sat = tracker.getSatellite?.(selectedId);
        if (!sat?.tle) { paintEmpty(`Loading TLE for #${selectedId}…`); return; }

        const tle = sat.tle;

        // Recover semi-major axis from mean motion (revs/day) via
        // Kepler's third law. tle.period_min is also available but
        // mean_motion is the raw TLE quantity, so we derive from
        // there for fewer round-trip rounding errors.
        const n0_rad_s = (tle.mean_motion * 2 * Math.PI) / 86400;
        const a_km     = (n0_rad_s > 0)
            ? Math.cbrt(MU_KM3_S2 / (n0_rad_s * n0_rad_s))
            : NaN;

        const rates = j2SecularRatesDegPerDay({
            a_km,
            e: tle.eccentricity,
            incl_deg: tle.inclination,
            mean_motion_revs_day: tle.mean_motion,
        });

        // Altitude profile — recompute when the asset changes; cheap
        // (one batch propagate) so we don't bother caching across
        // re-renders of the same asset.
        if (altCacheId !== selectedId) {
            altCache = altitudeProfileOverOrbit(tle, Date.now(), 60);
            altCacheId = selectedId;
        }
        const sparkSvg = renderAltSpark(altCache, tle.perigee_km, tle.apogee_km);

        // Group-tagged label for the badge.
        const groupBadge = sat.group
            ? `<span class="op-orbit-group">${escapeHtml(sat.group)}</span>`
            : '';

        const cell = (label, value, unit = '', tip = '') => `
            <tr title="${escapeHtml(tip)}">
                <td class="op-orbit-cell-k">${label}</td>
                <td class="op-orbit-cell-v">${value}<span class="op-orbit-unit">${unit}</span></td>
            </tr>
        `;

        host.innerHTML = `
            <div class="op-orbit-head">
                <span class="op-orbit-name" title="${escapeHtml(sat.name)}">${escapeHtml(sat.name)}</span>
                <span class="op-orbit-id">#${tle.norad_id}</span>
                ${groupBadge}
            </div>

            <table class="op-orbit-elements">
                <tbody>
                    ${cell('a',  Number.isFinite(a_km) ? a_km.toFixed(1) : '—', ' km', 'Semi-major axis (recovered from mean motion via Kepler\'s 3rd)')}
                    ${cell('e',  tle.eccentricity?.toFixed(5) ?? '—', '',       'Eccentricity')}
                    ${cell('i',  tle.inclination?.toFixed(2)  ?? '—', '°',      'Inclination')}
                    ${cell('Ω',  tle.raan?.toFixed(2)         ?? '—', '°',      'Right ascension of ascending node')}
                    ${cell('ω',  tle.arg_perigee?.toFixed(2)  ?? '—', '°',      'Argument of perigee')}
                    ${cell('M₀', tle.mean_anomaly?.toFixed(2) ?? '—', '°',      'Mean anomaly at epoch')}
                </tbody>
            </table>

            <div class="op-orbit-derived">
                <div><span class="op-orbit-tag">period</span>${tle.period_min?.toFixed(1) ?? '—'}<span class="op-orbit-unit"> min</span></div>
                <div><span class="op-orbit-tag">apogee</span>${tle.apogee_km?.toFixed(0)  ?? '—'}<span class="op-orbit-unit"> km</span></div>
                <div><span class="op-orbit-tag">perigee</span>${tle.perigee_km?.toFixed(0) ?? '—'}<span class="op-orbit-unit"> km</span></div>
            </div>

            ${sparkSvg}

            <div class="op-orbit-rates">
                <div class="op-orbit-rate-title" title="Secular drift from Earth's J2 oblateness — moves Ω, ω, M slowly over days/weeks">J2 secular drifts</div>
                ${rates ? `
                    <div><span class="op-orbit-tag">Ω̇</span>${rates.raanDot_deg_day.toFixed(3)}<span class="op-orbit-unit"> °/day</span></div>
                    <div><span class="op-orbit-tag">ω̇</span>${rates.argpDot_deg_day.toFixed(3)}<span class="op-orbit-unit"> °/day</span></div>
                    <div><span class="op-orbit-tag">Ṁ</span>${rates.meanAnomDot_deg_day.toFixed(3)}<span class="op-orbit-unit"> °/day</span></div>
                ` : `<div class="op-orbit-empty">elements out of range</div>`}
            </div>

            ${renderDragSection(tle)}

            <div class="op-orbit-caveat">
                Mean elements (TLE / Brouwer-Lyddane). Drag rate +
                lifetime use the same King-Hele-style surrogate as
                Decay Watch, modulated by live SWPC F10.7 / Ap.
            </div>
        `;
    }

    const offSel = onSelectChange((id) => {
        selectedId = id;
        render();
    });

    // SWPC indices feed the drag/decay numbers. When the bridge
    // promotes climatology to live values (or a storm rolls in) we
    // want the panel to repaint without waiting for a selection
    // change. Filter to just the fields we read so we don't repaint
    // on unrelated provStore writes.
    const offProv = provStore.subscribe?.((key) => {
        if (key === 'idx.f107' || key === 'idx.ap') render();
    });

    // Re-render when fresh TLEs arrive for the currently selected
    // sat (e.g. user just added it via the picker — the loadNorad
    // promise resolves later).
    let pollTimer = null;
    function poll() {
        if (selectedId != null) {
            const sat = tracker.getSatellite?.(selectedId);
            if (sat?.tle && (host.querySelector('.op-orbit-empty')?.textContent || '').startsWith('Loading')) {
                render();
            }
        }
        pollTimer = setTimeout(poll, 1000);
    }
    pollTimer = setTimeout(poll, 1000);

    // Initial paint.
    selectedId = getSelectedId();
    render();

    return {
        dispose() {
            offSel?.();
            offProv?.();
            if (pollTimer) clearTimeout(pollTimer);
        },
    };
}
