/**
 * fleet.js — Constellation + debris loader for the Operations console.
 *
 * Wraps SatelliteTracker (the existing pipeline that powers
 * satellites.html) and exposes:
 *   - a curated layer catalog (constellations + debris + recently
 *     launched), each backed by a CelesTrak group
 *   - lazy load: groups fetch on first toggle-on, then visibility
 *     toggles are free
 *   - a change bus so the layer panel can reflect counts and loading
 *     state as fetches resolve
 *   - bootstrap() to load the default-on subset at boot
 *
 * Tracker propagation is wired through the globe's render loop in the
 * constructor — fleet doesn't own a rAF.
 *
 * Default-on subset is intentionally small (stations + debris) so the
 * open-beta page paints fast over a cellular link. Heavier
 * constellations (Starlink ~6k, GNSS ~120) load on user demand.
 */

import { SatelliteTracker } from '../satellite-tracker.js';

export const LAYER_CATALOG = Object.freeze([
    { id: 'stations',     label: 'Space Stations',     section: 'Missions',         on: true,  group: 'stations'     },
    { id: 'debris',       label: 'Tracked Debris',     section: 'Hazards',          on: true,  group: 'debris'       },
    { id: 'starlink',     label: 'Starlink',           section: 'Mega-constellations', on: false, group: 'starlink'  },
    { id: 'oneweb',       label: 'OneWeb',             section: 'Mega-constellations', on: false, group: 'oneweb'    },
    { id: 'iridium',      label: 'Iridium',            section: 'Mega-constellations', on: false, group: 'iridium'   },
    { id: 'gps-ops',      label: 'GPS',                section: 'GNSS',             on: false, group: 'gps-ops'      },
    { id: 'galileo',      label: 'Galileo',            section: 'GNSS',             on: false, group: 'galileo'      },
    { id: 'beidou',       label: 'BeiDou',             section: 'GNSS',             on: false, group: 'beidou'       },
    { id: 'glonass',      label: 'GLONASS',            section: 'GNSS',             on: false, group: 'glonass'      },
    { id: 'last-30-days', label: 'Recently launched',  section: 'Hazards',          on: false, group: 'last-30-days' },
]);

export class OperationsFleet {
    constructor(globe) {
        this.globe = globe;
        this.tracker = new SatelliteTracker(globe.getScene(), globe.getEarthRadius(), {
            maxSatellites: 50000,
            showOrbits: true,
        });

        // Drive propagation off the globe's render loop. Reading
        // simTimeMs each frame keeps positions deterministic with the
        // bus regardless of mode (live / scrub / replay).
        globe.onTick((simTimeMs) => this.tracker.tick(simTimeMs));

        this._on        = new Map(LAYER_CATALOG.map(l => [l.id, l.on]));
        this._loading   = new Set();
        this._listeners = new Set();
    }

    layers() { return LAYER_CATALOG; }

    isOn(id)      { return this._on.get(id) === true; }
    isLoading(id) { return this._loading.has(id); }
    isLoaded(id)  { return this.tracker.hasGroup(id); }
    counts()      { return this.tracker.getGroupCounts(); }

    onChange(fn) {
        this._listeners.add(fn);
        try { fn(); } catch (_) {}
        return () => this._listeners.delete(fn);
    }

    _notify() {
        for (const fn of this._listeners) {
            try { fn(); } catch (_) {}
        }
    }

    /**
     * Toggle a layer on/off. First flip-on triggers a fetch; subsequent
     * toggles are pure visibility flips on the tracker.
     */
    async setLayerOn(id, on) {
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return;
        const want = !!on;
        if (this._on.get(id) === want) return;
        this._on.set(id, want);

        if (want && !this.tracker.hasGroup(layer.group) && !this._loading.has(id)) {
            this._loading.add(id);
            this._notify();
            try {
                await this.tracker.loadGroup(layer.group);
            } finally {
                this._loading.delete(id);
            }
        }
        // hasGroup() may still be false if the load failed — guard.
        if (this.tracker.hasGroup(layer.group)) {
            this.tracker.setGroupVisible(layer.group, want);
        }
        this._notify();
    }

    /** Load the default-on layers in parallel. */
    async bootstrap() {
        const defaults = LAYER_CATALOG.filter(l => l.on);
        await Promise.all(defaults.map(l => this.setLayerOn(l.id, true)));
    }
}
