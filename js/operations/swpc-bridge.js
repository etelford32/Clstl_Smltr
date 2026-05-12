/**
 * swpc-bridge.js — Live SWPC indices into the provenance store.
 *
 * Instantiates the existing SpaceWeatherFeed (the same module that
 * powers space-weather.html), subscribes to its swpc-update events,
 * and re-publishes F10.7 + Ap into provStore so every banded value
 * downstream (decay watch, prop budget, drag analysis) updates in
 * lockstep with reality.
 *
 * Synthetic stand-ins from step 7 stay registered until the first
 * swpc-update lands, after which this module overwrites them with
 * cacheState='live'. Δ icons activate naturally — first live update
 * is the first ring-buffer transition with a different value.
 */

import { SpaceWeatherFeed }   from '../swpc-feed.js';
import { TIER, planToTier }   from '../config.js';
import { provStore }          from './provenance.js';

// Standard NOAA Kp → Ap conversion table.
const KP_TO_AP = Object.freeze([
    0,    2,    3,    4,    5,    6,    7,    9,   12,   15,
    18,   22,   27,   32,   39,   48,   56,   67,   80,   94,
    111, 132,  154,  179,  207,  236,  300,  400,
]);

function kpToAp(kp) {
    if (kp == null || !Number.isFinite(kp)) return null;
    const idx = Math.max(0, Math.min(KP_TO_AP.length - 1, Math.round(kp * 3)));
    return KP_TO_AP[idx];
}

function getTier() {
    try {
        const raw = localStorage.getItem('pp_auth');
        if (!raw) return TIER.FREE;
        const a = JSON.parse(raw);
        if (!a?.signedIn) return TIER.FREE;
        return planToTier(a.plan, a.role);
    } catch { return TIER.FREE; }
}

function publishF107(state) {
    if (state.f107_flux == null) return;
    provStore.set('idx.f107', {
        value: state.f107_flux,
        unit: 'SFU',
        sigma: 12,                          // typical NOAA short-horizon spread
        source: 'NOAA SWPC F10.7 daily product',
        model:  'NOAA F10.7',
        cacheState: 'live',
        fetchedAt: new Date().toISOString(),
        validAt:   new Date().toISOString(),
        description:
            'Solar 10.7 cm radio flux. Direct driver of thermospheric heating: ' +
            'higher F10.7 → denser air at LEO altitudes → more drag on every satellite.',
    });
}

function publishAp(state) {
    const kp = state.kp_1min ?? state.kp;
    if (kp == null) return;
    const ap = kpToAp(kp);
    if (ap == null) return;
    provStore.set('idx.ap', {
        value: ap,
        unit: '',
        sigma: 6,
        source: 'NOAA SWPC Kp 1-minute → Ap',
        model:  'NOAA Kp + standard Kp→Ap table',
        cacheState: 'live',
        fetchedAt: new Date().toISOString(),
        validAt:   new Date().toISOString(),
        description:
            'Daily geomagnetic Ap (here approximated from live Kp via the ' +
            'standard NOAA mapping). Above 27 = G1+ storm; above 50 = G2+. ' +
            'Storm activity puffs the thermosphere outward and steps drag up by 20–40%.',
    });
}

export function startSwpcBridge() {
    const tier = getTier();
    const feed = new SpaceWeatherFeed({ tier });
    feed.start();

    function onUpdate(e) {
        const s = e.detail || {};
        publishF107(s);
        publishAp(s);
    }
    window.addEventListener('swpc-update', onUpdate);

    return () => {
        window.removeEventListener('swpc-update', onUpdate);
        feed.stop?.();
    };
}

export { kpToAp };
