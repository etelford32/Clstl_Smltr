/**
 * month-outlook.js — "Month-Ahead Outlook" dashboard panel (weeks 3–6).
 * ═══════════════════════════════════════════════════════════════════════════
 * The showcase honest-forecast layer. It fetches the slowly-varying climate
 * drivers (ENSO + MJO from /api/weather/enso-mjo; AO + NAO from the existing
 * /api/weather/teleconnections), runs the pure s2s-outlook.js engine for the
 * user's location, and renders TERCILE PROBABILITIES (below / near / above
 * normal) for temperature and precipitation, with per-driver attribution and a
 * driver-conditioned confidence.
 *
 * Lightweight by construction: the driver feeds carry no lat/lon, so the edge
 * caches one response for the whole planet; the per-location math runs in the
 * browser. Zero per-user database state.
 *
 * Honesty contract (deliberate): past ~10 days we never show a single number.
 * Confidence is the driver-conditioned expected reliability, NOT a measured
 * hit rate — live verification accrues as target weeks arrive, and that status
 * is shown plainly in the methodology disclosure.
 *
 * Usage:
 *   import { mountMonthOutlook } from './js/month-outlook.js';
 *   mountMonthOutlook({ host: document.getElementById('month-outlook') });
 */

import { loadUserLocation } from './user-location.js';
import { computeOutlook, S2S_METHOD, S2S_REFERENCE_SKILL } from './s2s-outlook.js';

const ENSO_MJO_API = '/api/weather/enso-mjo';
const TELE_API     = '/api/weather/teleconnections';
const DRIVER_TTL_MS = 3 * 3600 * 1000;   // drivers update daily; refetch ≤ 3 h

const CONF_COLOR = { elevated: '#44cc88', moderate: '#ffaa00', low: '#8899aa' };

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function mountMonthOutlook({ host } = {}) {
    if (!host) return { refresh() {}, destroy() {} };

    let drivers = null, meta = null, fetchedAt = 0, inFlight = null, destroyed = false;

    async function getDrivers() {
        if (drivers && Date.now() - fetchedAt < DRIVER_TTL_MS) return { drivers, meta };
        if (inFlight) return inFlight;
        inFlight = (async () => {
            const d = { enso: null, mjo: null, ao: null, nao: null };
            const m = { enso: 'unavailable', mjo: 'unavailable', ao: 'unavailable', nao: 'unavailable', asOf: null };
            const [em, te] = await Promise.allSettled([
                fetch(ENSO_MJO_API, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null),
                fetch(TELE_API,     { signal: AbortSignal.timeout(10_000) }).then(r => r.ok ? r.json() : null),
            ]);
            if (em.status === 'fulfilled' && em.value) {
                const v = em.value;
                if (v.enso && Number.isFinite(v.enso.oni)) { d.enso = { oni: v.enso.oni, state: v.enso.state }; m.enso = 'ok'; }
                if (v.mjo && Number.isInteger(v.mjo.phase)) { d.mjo = { phase: v.mjo.phase, amplitude: v.mjo.amplitude }; m.mjo = 'ok'; }
                if (v.as_of) m.asOf = v.as_of;
            }
            if (te.status === 'fulfilled' && te.value) {
                const v = te.value;
                if (v.ao && Number.isFinite(v.ao.current))  { d.ao  = { value: v.ao.current };  m.ao  = 'ok'; }
                if (v.nao && Number.isFinite(v.nao.current)) { d.nao = { value: v.nao.current }; m.nao = 'ok'; }
            }
            drivers = d; meta = m; fetchedAt = Date.now(); inFlight = null;
            return { drivers, meta };
        })();
        return inFlight;
    }

    function renderEmpty() {
        host.innerHTML =
            `<div style="font-size:.75rem;color:var(--muted);padding:6px 0">
                🛰️ Set your location above to see a probabilistic outlook for the next 3–6 weeks.
             </div>`;
    }

    function renderLoading() {
        host.innerHTML = `<div style="font-size:.72rem;color:var(--muted);padding:6px 0">Computing month-ahead outlook…</div>`;
    }

    function render(loc, d, m) {
        const o = computeOutlook({ lat: loc.lat, lon: loc.lon, date: new Date(), drivers: d });
        const liveDrivers = ['enso', 'mjo', 'ao', 'nao'].filter(k => m[k] === 'ok');
        const driverNames = { enso: 'ENSO', mjo: 'MJO', ao: 'AO', nao: 'NAO' };

        host.innerHTML = `
            <div style="font-size:.62rem;color:var(--muted);margin-bottom:8px">
                ${esc(loc.city || `${loc.lat.toFixed(1)}, ${loc.lon.toFixed(1)}`)} · ${esc(o.region.name)} · ${esc(o.season)}
                ${m.asOf ? ` · drivers as of ${esc(m.asOf)}` : ''}
            </div>
            <div style="font-size:.66rem;color:#8aa;line-height:1.5;background:rgba(80,140,200,.07);border:1px solid var(--border);border-radius:6px;padding:7px 9px;margin-bottom:12px">
                Beyond ~10 days, specific weather can't be pinned down. This shows how today's
                climate drivers shift the <strong>odds</strong> of a below-, near-, or above-normal
                fortnight — not a forecast of particular storms.
            </div>
            ${!o.driversAvailable ? `
            <div style="font-size:.66rem;color:#caa;margin-bottom:10px">
                ⚠ Climate-driver feeds are temporarily unavailable — showing the climatological
                baseline (33 / 33 / 33). Check back shortly.
            </div>` : ''}
            ${o.windows.map(windowBlock).join('')}
            ${o.driversAvailable ? driversBlock(o.drivers) : ''}
            ${methodologyBlock(liveDrivers.map(k => driverNames[k]))}
        `;
    }

    function windowBlock(w) {
        const cc = CONF_COLOR[w.confidence] || CONF_COLOR.low;
        return `
        <div style="margin-bottom:14px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
                <span style="font-size:.82rem;font-weight:700;color:#e8f4ff">${w.label}
                    <span style="font-size:.55rem;font-weight:400;color:#667"> · days ${w.leadDays[0]}–${w.leadDays[1]}</span>
                </span>
                <span title="Driver-conditioned confidence — higher when drivers are strong and aligned. Not a guarantee."
                      style="font-size:.54rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:10px;color:${cc};background:${cc}1a;border:1px solid ${cc}40">
                    ${w.confidence} confidence
                </span>
            </div>
            <div style="font-size:.62rem;color:#8899aa;margin-bottom:3px">🌡️ Temperature · <span style="color:#cdd">${leanText(w.tempLean, w.tempProb, 'temp')}</span></div>
            ${tercileBar(w.tempPct, 'temp')}
            ${labelsRow('temp', w.tempLean)}
            <div style="font-size:.62rem;color:#8899aa;margin:9px 0 3px">🌧️ Precipitation · <span style="color:#cdd">${leanText(w.precipLean, w.precipProb, 'precip')}</span></div>
            ${tercileBar(w.precipPct, 'precip')}
            ${labelsRow('precip', w.precipLean)}
        </div>`;
    }

    function tercileBar(pct, kind) {
        const col = kind === 'temp'
            ? { below: '#5aa9e6', near: '#8899aa', above: '#ff9f43' }
            : { below: '#d4a373', near: '#8899aa', above: '#4d96d9' };
        const word = kind === 'temp'
            ? { below: 'cooler', near: 'near-normal', above: 'warmer' }
            : { below: 'drier', near: 'near-normal', above: 'wetter' };
        const seg = k => {
            const w = pct[k];
            return `<div title="${w}% chance ${word[k]}" style="width:${w}%;display:flex;align-items:center;justify-content:center;background:${col[k]};color:#0a0e14;font-weight:700;font-size:.56rem;overflow:hidden;white-space:nowrap">${w >= 16 ? w + '%' : ''}</div>`;
        };
        return `<div style="display:flex;height:18px;border-radius:4px;overflow:hidden;border:1px solid var(--border)">${seg('below')}${seg('near')}${seg('above')}</div>`;
    }

    function labelsRow(kind, lean) {
        const L = kind === 'temp' ? ['Cooler', 'Near', 'Warmer'] : ['Drier', 'Near', 'Wetter'];
        const keys = ['below', 'near', 'above'];
        return `<div style="display:flex;font-size:.5rem;color:#667;margin-top:2px">` +
            keys.map((k, i) =>
                `<div style="flex:1;text-align:${i === 0 ? 'left' : i === 2 ? 'right' : 'center'};${lean === k ? 'color:#aab;font-weight:700' : ''}">${L[i]}</div>`
            ).join('') + `</div>`;
    }

    function leanText(lean, prob, kind) {
        if (lean === 'near') return `Near-normal favored (${prob}%)`;
        const word = kind === 'temp' ? (lean === 'above' ? 'warmer' : 'cooler')
                                     : (lean === 'above' ? 'wetter' : 'drier');
        return `Leans ${word} · ${prob}% ${lean === 'above' ? 'above' : 'below'} normal`;
    }

    function driversBlock(ds) {
        if (!ds.length) return '';
        const icon = { enso: '🌊', mjo: '🌀', ao: '🧭', nao: '🧭' };
        const chips = ds.map(d => {
            const c = d.tempContrib > 0.02 ? '#ff9f43' : d.tempContrib < -0.02 ? '#5aa9e6' : '#8899aa';
            return `<span title="${esc(d.note)}" style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:11px;font-size:.6rem;font-weight:600;background:${c}1a;color:${c};border:1px solid ${c}40">
                ${icon[d.id] || '•'} ${esc(d.name)} ${esc(d.state)}</span>`;
        }).join('');
        return `
        <div style="margin-top:4px">
            <div style="font-size:.6rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:6px">Why — active drivers</div>
            <div style="display:flex;flex-wrap:wrap;gap:6px">${chips}</div>
        </div>`;
    }

    function methodologyBlock(liveNames) {
        return `
        <details style="margin-top:12px;font-size:.64rem;color:#8899aa">
            <summary style="cursor:pointer;color:var(--accent2)">How this works &amp; verification</summary>
            <div style="padding:8px 2px;line-height:1.55">
                <p style="margin:0 0 6px">${esc(S2S_METHOD)}</p>
                <p style="margin:0 0 6px">${esc(S2S_REFERENCE_SKILL)}</p>
                <p style="margin:0;color:#778">
                    Live drivers used: ${liveNames.length ? esc(liveNames.join(' · ')) : 'none available right now'}.
                    Verification at your location: <strong>accruing</strong> — each outlook is scored against
                    what actually happens once the target weeks arrive.
                </p>
            </div>
        </details>`;
    }

    async function refresh() {
        if (destroyed) return;
        const loc = loadUserLocation();
        if (!loc || loc.lat == null || loc.lon == null) { renderEmpty(); return; }
        if (!drivers) renderLoading();
        try {
            const { drivers: d, meta: m } = await getDrivers();
            if (destroyed) return;
            const loc2 = loadUserLocation();
            if (loc2?.lat != null) render(loc2, d, m);
        } catch (e) {
            console.warn('[month-outlook] failed:', e.message);
            // Still show the climatological baseline rather than a dead panel.
            const loc2 = loadUserLocation();
            if (loc2?.lat != null) render(loc2, { enso: null, mjo: null, ao: null, nao: null },
                { enso: 'unavailable', mjo: 'unavailable', ao: 'unavailable', nao: 'unavailable', asOf: null });
        }
    }

    function onLocationChanged() { refresh(); }
    window.addEventListener('user-location-changed', onLocationChanged);

    function destroy() {
        destroyed = true;
        window.removeEventListener('user-location-changed', onLocationChanged);
    }

    refresh();
    return { refresh, destroy };
}
