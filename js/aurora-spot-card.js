/**
 * aurora-spot-card.js — the multi-instance "Aurora tonight — <spot>"
 * card (SPACE_WEATHER_DASHBOARD_PLAN.md §7 "per-location aurora tonight
 * (multi-instance)", phase D2). One card per place you care about —
 * home, the dark-sky site, grandma's cabin — each giving the GO/Maybe/No
 * call for ITS location.
 *
 * Oracle discipline: the call is verdict-engine auroraVerdict over
 * magneticLatitude + the status band's deepestSunAltitude — the SAME
 * margin ≤ 5° GO the verdict card and the band's tonight cell use. Kp
 * comes from the page's #kp-val (MutationObserver, the house pattern).
 *
 * Instances: created by layout-lab's `instantiate` hook (gallery ＋Add,
 * or on boot for instance ids a saved layout carries). The location
 * choice persists per instance in the panel-config store via
 * setPanelConfigValue — the same store + event surface the ⚙ sheets
 * use. Choices: the main pin + the ppx_user_locations watch list.
 */

import { auroraVerdict, magneticLatitude } from './verdict-engine.js';
import { deepestSunAltitude } from './space-weather-status-band.js';
import { setPanelConfigValue, loadPanelConfig } from './layout-lab.js';

const PAGE = 'space-weather';

export function createAuroraSpotCard(instanceId) {
    if (typeof document === 'undefined') return null;
    const tpl = document.getElementById('aurora-spot-template');
    if (!tpl?.content?.firstElementChild) return null;
    const el = tpl.content.firstElementChild.cloneNode(true);

    const cityEl = el.querySelector('.as-city');
    const verdictEl = el.querySelector('.as-verdict');
    const detailEl = el.querySelector('.as-detail');
    const select = el.querySelector('.as-loc');

    let kp = null;
    let cfg = loadPanelConfig(PAGE)[instanceId] || null;

    // ── Location choices: main pin + the saved watch list ─────────────
    async function fillChoices() {
        try {
            const m = await import('./user-location.js');
            const opts = [];
            const pin = m.loadUserLocation();
            if (pin && Number.isFinite(pin.lat)) {
                opts.push({ ...pin, key: 'pin', label: `📍 ${pin.city || 'your pin'}` });
            }
            for (const l of m.loadLocationList()) {
                if (Number.isFinite(l?.lat)) {
                    opts.push({ ...l, key: `list:${l.lat},${l.lon}`, label: l.city || `${l.lat}, ${l.lon}` });
                }
            }
            select.innerHTML = '<option value="">— pick a spot —</option>' + opts.map((o, i) =>
                `<option value="${i}">${o.label}</option>`).join('');
            select.onchange = () => {
                const o = opts[+select.value];
                if (!o) return;
                cfg = { lat: o.lat, lon: o.lon, city: o.city || o.label };
                setPanelConfigValue(PAGE, instanceId, cfg);
                render();
            };
            // Reflect a persisted choice in the picker.
            if (cfg) {
                const i = opts.findIndex((o) =>
                    Math.abs(o.lat - cfg.lat) < 1e-6 && Math.abs(o.lon - cfg.lon) < 1e-6);
                if (i >= 0) select.value = String(i);
            }
        } catch { /* the picker degrades to the persisted choice */ }
    }
    fillChoices();
    window.addEventListener('user-location-changed', fillChoices);

    // ── The call (oracle-direct, τ = wall clock for "tonight") ────────
    function render() {
        if (!cfg || !Number.isFinite(cfg.lat)) {
            cityEl.textContent = 'pick a spot';
            verdictEl.textContent = '—';
            verdictEl.style.color = 'var(--sw-text-muted, #8b94ad)';
            detailEl.textContent = 'choose a saved location for a tonight call';
            return;
        }
        cityEl.textContent = cfg.city || `${cfg.lat.toFixed(1)}, ${cfg.lon.toFixed(1)}`;
        const v = auroraVerdict(Number.isFinite(kp) ? kp : 0,
            magneticLatitude(cfg.lat, cfg.lon), null,
            deepestSunAltitude(cfg.lat, cfg.lon, Date.now()));
        const word = v.state === 'go' ? 'GO' : v.state === 'maybe' ? 'Maybe' : 'No';
        verdictEl.textContent = word;
        verdictEl.style.color = v.state === 'go' ? 'var(--sw-status-warning, #ff7847)'
            : v.state === 'maybe' ? 'var(--sw-status-elevated, #ffd75e)'
            : 'var(--sw-status-quiet, #4fc97f)';
        detailEl.textContent = v.margin <= 0
            ? `oval overhead at Kp ${Number.isFinite(kp) ? kp : '—'}`
            : `oval ${Math.round(v.margin)}° poleward · Kp ${Number.isFinite(kp) ? kp : '—'}`;
    }

    // Kp from the page (house MutationObserver pattern).
    const kpEl = document.getElementById('kp-val');
    const readKp = () => {
        const v = parseFloat(kpEl?.textContent);
        if (Number.isFinite(v)) { kp = v; render(); }
    };
    if (kpEl) {
        new MutationObserver(readKp)
            .observe(kpEl, { childList: true, characterData: true, subtree: true });
        readKp();
    }
    window.addEventListener('sw-panel-config', (e) => {
        if (e.detail?.panel === instanceId) { cfg = e.detail.config; render(); }
    });

    render();
    return el;
}
