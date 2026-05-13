/**
 * hero-trails.js — Per-NORAD velocity ribbons for the hero-asset
 * registry.
 *
 * Hero objects (Envisat, ISS, Hubble, Tiangong) feel more anchored on
 * the globe when a fading trail shows the recent orbital path. Other
 * tracked satellites don't get one — at the catalog scale (30 k
 * objects) trails would render as one giant tangle. We keep the
 * treatment to the handful of named objects the user is most likely
 * to be looking at, with a per-asset colour that matches the existing
 * mesh palette where one exists.
 *
 * Each entry is gated on tracker presence: if the underlying NORAD
 * isn't in the currently-loaded catalog (e.g. the user hasn't enabled
 * the relevant layer), that trail's setVisible(false) until the
 * position appears.
 */

import { Trail } from './trail.js';

/**
 * Per-hero trail configuration. Colours pulled from the hero-mesh
 * palettes (warm gold for Envisat's solar wing, white for ISS MLI,
 * Hubble's pale blue, Tiangong's red accent) so a trail reads as
 * "the trail of that thing" before the operator has zoomed close
 * enough to identify the body.
 *
 * Add a NORAD here to give it a trail; remove to suppress.
 */
const HERO_REGISTRY = Object.freeze([
    { norad: 27386, label: 'Envisat',  color: 0xe6c060, maxSegments: 90 },
    { norad: 25544, label: 'ISS',      color: 0xffffff, maxSegments: 120, minDistance: 0.0015 },
    { norad: 20580, label: 'Hubble',   color: 0x88c8ff, maxSegments: 80 },
    { norad: 48274, label: 'Tiangong', color: 0xff8888, maxSegments: 90 },
]);

export class HeroTrails {
    /**
     * @param {object} globe   OperationsGlobe — used for the scene
     * @param {object} tracker SatelliteTracker
     * @param {object} [opts]
     */
    constructor(globe, tracker, opts = {}) {
        this._tracker  = tracker;
        this._visible  = true;
        // Reused scratch reduces per-tick allocation to zero.
        this._scratch  = { x: 0, y: 0, z: 0 };

        // Map<norad, { trail, cfg, presentLastTick }>. presentLastTick
        // is a one-frame edge tracker so we can clear() when a hero
        // disappears (layer unloaded, decayed) and restart cleanly
        // when it reappears.
        this._entries = new Map();
        for (const cfg of HERO_REGISTRY) {
            const trail = new Trail(globe.getScene(), {
                color:        cfg.color,
                maxSegments:  cfg.maxSegments ?? 80,
                minDistance:  cfg.minDistance,
                opacity:      0.85,
                headBrightness: 1.0,
                tailBrightness: 0.0,
            });
            // Start hidden — the first tick will flip visible when
            // a valid position arrives. Avoids a one-frame flash at
            // the origin before the tracker has propagated.
            trail.setVisible(false);
            this._entries.set(cfg.norad, { trail, cfg, presentLastTick: false });
        }
    }

    /**
     * Global visibility toggle (e.g. wired to a "show trails" layer
     * panel checkbox). Trails individually still gate on tracker
     * presence; this just suppresses everything when off.
     */
    setVisible(on) {
        this._visible = !!on;
        if (!this._visible) {
            for (const entry of this._entries.values()) {
                entry.trail.setVisible(false);
            }
        }
    }
    isVisible() { return this._visible; }

    /**
     * Look up which hero this NORAD is (or null). Useful if a future
     * UI wants to label the trail head with the operator-facing
     * name.
     */
    heroConfig(noradId) {
        return this._entries.get(noradId)?.cfg ?? null;
    }

    /**
     * Push the latest position for every hero. Driven from the
     * globe's tick loop so simTimeMs alignment with the rest of the
     * scene is automatic. Cheap: handful of NORAD lookups + a
     * push() per present hero. No-op when the master switch is off.
     */
    tick() {
        if (!this._visible) return;
        for (const entry of this._entries.values()) {
            const pos = this._tracker.getPositionXYZ?.(entry.cfg.norad, this._scratch);
            const valid = !!pos
                       && Number.isFinite(pos.x)
                       && !(pos.x === 0 && pos.y === 0 && pos.z === 0);
            if (!valid) {
                if (entry.presentLastTick) {
                    // Hero just left the catalog — drop the stale
                    // trail so when it comes back we don't draw a
                    // long chord from old position to new.
                    entry.trail.clear();
                    entry.trail.setVisible(false);
                }
                entry.presentLastTick = false;
                continue;
            }
            if (!entry.presentLastTick) entry.trail.setVisible(true);
            entry.trail.push(pos.x, pos.y, pos.z);
            entry.presentLastTick = true;
        }
    }

    dispose() {
        for (const entry of this._entries.values()) {
            entry.trail.dispose();
        }
        this._entries.clear();
    }
}
