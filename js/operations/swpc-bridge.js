/**
 * swpc-bridge.js — Live SWPC indices into the space-weather time model.
 *
 * Instantiates the existing SpaceWeatherFeed (the same module that
 * powers space-weather.html), subscribes to its swpc-update events,
 * and feeds the live F10.7 + Ap into sw-model.js as the "anchor" the
 * time model persists / forecasts around. sw-model's driver is the single
 * writer of `idx.f107` / `idx.ap` in provStore, so every banded value
 * downstream (decay watch, prop budget, drag shell) tracks both reality
 * AND the scrubber's simTime from one place.
 *
 * Synthetic stand-ins stay registered until the first swpc-update lands,
 * after which the driver republishes the anchor as cacheState='live'. Δ
 * icons activate naturally — the first live update is the first ring-buffer
 * transition with a different value.
 */

import { SpaceWeatherFeed }   from '../swpc-feed.js';
import { TIER, planToTier }   from '../config.js';
import { setLiveAnchor }      from './sw-model.js';

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

export function startSwpcBridge() {
    const tier = getTier();
    const feed = new SpaceWeatherFeed({ tier });
    feed.start();

    function onUpdate(e) {
        const s = e.detail || {};
        const f107 = Number.isFinite(s.f107_flux) ? s.f107_flux : undefined;
        const kp   = s.kp_1min ?? s.kp;
        const ap   = kpToAp(kp);
        // Feed whatever arrived this cycle; sw-model honours partial
        // updates (F10.7 and Kp land on different cadences). The driver
        // turns this anchor into idx.f107 / idx.ap at the current simTime.
        setLiveAnchor({
            f107,
            ap: Number.isFinite(ap) ? ap : undefined,
            source: 'NOAA SWPC RTSW (F10.7 daily + Kp→Ap)',
        });
    }
    window.addEventListener('swpc-update', onUpdate);

    return () => {
        window.removeEventListener('swpc-update', onUpdate);
        feed.stop?.();
    };
}

export { kpToAp };
