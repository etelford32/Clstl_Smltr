/**
 * js/farside/farside-alerts.js — Phase 4: "region rotating into view" trigger.
 *
 * Extends the existing alert surface WITHOUT modifying js/alert-engine.js (which
 * carries load-bearing dispatch logic). We emit the same `user-alert` window
 * CustomEvent the engine uses, so the shared bell/toast UI renders far-side
 * alerts with zero changes elsewhere. When a `notify_region_emergence` toggle
 * is added to user_profiles (Phase 4+ migration), the engine can adopt this
 * rule wholesale — the alert shape already matches its convention.
 */

import { ALERT } from './farside-config.js';

/**
 * Build alert objects for tracks rotating into view inside the lead window.
 * Pure — returns the alerts; dispatch is a separate, opt-in call.
 * @param {object[]} watchList  from farSideWatchList()
 * @returns {object[]}
 */
export function buildEmergenceAlerts(watchList) {
    const out = [];
    for (const t of watchList) {
        if (t.etaDays > ALERT.leadDaysMax) continue;
        if (t.latestStrength < ALERT.minStrengthForAlert) continue;
        const days = t.etaDays;
        const when = days < 1 ? 'within 24 h' : `in ~${days.toFixed(1)} days`;
        const sev = t.strong ? 'warning' : 'info';
        out.push({
            id: `farside_${t.id}`,
            _key: ALERT.notifyKey,
            severity: sev,
            title: t.strong
                ? 'Strong region rotating into view'
                : 'Region rotating into view',
            body: `A ${t.strong ? 'strong ' : ''}far-side signature at Carrington `
                + `L${t.lon.toFixed(0)}°, lat ${t.lat.toFixed(0)}° is forecast to cross `
                + `the east limb ${when} (±${t.etaBandDays.toFixed(1)} d). `
                + `Integrated strength ${t.latestStrength.toFixed(2)}, trend `
                + `${t.trend >= 0 ? '+' : ''}${t.trend.toFixed(2)}/frame.`
                + (t.validationCase ? ` Matches validation case: ${t.validationCase.label}.` : ''),
            source: 'far-side-watch',
            etaDays: days,
            emergenceUTC: t.emergenceUTC,
            ts: Date.now(),
        });
    }
    return out;
}

/**
 * Dispatch emergence alerts on the shared `user-alert` channel. De-dupes within
 * a session so a 30-min repaint loop doesn't spam the bell.
 */
const _seen = new Set();
export function dispatchEmergenceAlerts(watchList, { force = false } = {}) {
    const alerts = buildEmergenceAlerts(watchList);
    for (const a of alerts) {
        if (!force && _seen.has(a.id)) continue;
        _seen.add(a.id);
        window.dispatchEvent(new CustomEvent('user-alert', { detail: a }));
    }
    return alerts;
}
