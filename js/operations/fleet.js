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
import { StarlinkFleet }    from './starlink-model.js';

// Per-event debris layer ids — mutually exclusive with the composite
// 'debris' layer so the same NORAD ID isn't double-counted across the
// fleet's screener, scenario hash, and decision deck. The composite
// pulls the union of all four; the per-event layers let an operator
// isolate (or reproduce) a single fragmentation cloud — most often
// FY-1C, the largest single debris-generating event in history.
export const DEBRIS_EVENT_LAYER_IDS = Object.freeze([
    'fengyun-1c-debris',
    'cosmos-1408-debris',
    'iridium-33-debris',
    'cosmos-2251-debris',
]);

export const LAYER_CATALOG = Object.freeze([
    { id: 'stations',     label: 'Space Stations',     section: 'Missions',         on: true,  group: 'stations'     },
    { id: 'debris',       label: 'Tracked Debris (composite)', section: 'Hazards',  on: true,  group: 'debris'       },
    // Per-event debris clouds. Default-off (composite covers them) so an
    // operator opting in is explicitly choosing single-event focus. Each
    // is a real CelesTrak group, propagated via SGP4 alongside the rest
    // of the fleet — full-fidelity debris context, not a sample.
    { id: 'fengyun-1c-debris',  label: 'FY-1C ASAT (2007)',     section: 'Debris events', on: false, group: 'fengyun-1c-debris'  },
    { id: 'cosmos-1408-debris', label: 'Cosmos 1408 ASAT (2021)', section: 'Debris events', on: false, group: 'cosmos-1408-debris' },
    { id: 'iridium-33-debris',  label: 'Iridium 33 (2009)',     section: 'Debris events', on: false, group: 'iridium-33-debris'  },
    { id: 'cosmos-2251-debris', label: 'Cosmos 2251 (2009)',    section: 'Debris events', on: false, group: 'cosmos-2251-debris' },
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

        // 3D Starlink mesh fleet — first member of the "real models"
        // pipeline. Registered after the tracker tick so it reads
        // freshly propagated positions for the same simTimeMs. The
        // mesh stays hidden until the Starlink layer is toggled on;
        // when it is, we also suppress the per-sat point so the dot
        // doesn't bleed through.
        this.starlinkFleet = new StarlinkFleet(globe, this.tracker);
        globe.onTick(() => this.starlinkFleet.tick());

        // Track desired-on state separately from the catalog defaults so
        // `bootstrap()` actually fires loads. The previous version
        // pre-seeded this map with each layer's `on` field, which made
        // `setLayerOn(id, true)` short-circuit at the equality guard
        // before it could call `tracker.loadGroup()` — net result was the
        // default-on layers (stations + debris) never rendered.
        this._on        = new Map(LAYER_CATALOG.map(l => [l.id, false]));
        this._loading   = new Set();
        this._listeners = new Set();
    }

    layers() { return LAYER_CATALOG; }

    isOn(id)      { return this._on.get(id) === true; }
    isLoading(id) { return this._loading.has(id); }
    isLoaded(id)  {
        // hasGroup is true even for failed loads (we cache the failure
        // so the panel can show it). isLoaded should reflect *successful*
        // loads only; otherwise the panel renders "12 objects" when it's
        // actually 0-with-error.
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return false;
        const info = this.tracker.getGroupInfo(layer.group);
        return !!info && !info.error;
    }
    counts()      { return this.tracker.getGroupCounts(); }

    /** Returns the error message for a failed group, or null. */
    errorFor(id) {
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return null;
        const info = this.tracker.getGroupInfo(layer.group);
        return info?.error ?? null;
    }

    /** Forget a failed load so the next setLayerOn(id, true) refetches. */
    async retry(id) {
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return;
        this.tracker.forgetGroup(layer.group);
        // Force re-fetch path: pretend the layer was off, then turn back on.
        this._on.set(id, false);
        await this.setLayerOn(id, true);
    }

    /**
     * IDs of layers currently being rendered (toggled on AND loaded).
     * Used by the scenario module to bind the hash to what's actually
     * on-screen — loading state changes produce hash flips when the
     * fetch completes.
     */
    activeLayerIds() {
        return LAYER_CATALOG
            .filter(l => this.isOn(l.id) && this.isLoaded(l.id))
            .map(l => l.id);
    }

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
     *
     * Composite-vs-per-event mutual exclusion: enabling the composite
     * `debris` layer turns off any per-event debris layers (and vice
     * versa). Without this, every FY-1C / C-1408 / IR-33 / C-2251
     * fragment would render twice (once from the composite, once from
     * the per-event group), polluting the screener and the deck.
     */
    async setLayerOn(id, on) {
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return;
        const want = !!on;
        if (this._on.get(id) === want) return;

        if (want) {
            if (id === 'debris') {
                for (const evId of DEBRIS_EVENT_LAYER_IDS) {
                    if (this._on.get(evId)) await this._setLayerOnInternal(evId, false);
                }
            } else if (DEBRIS_EVENT_LAYER_IDS.includes(id)) {
                if (this._on.get('debris')) await this._setLayerOnInternal('debris', false);
            }
        }

        await this._setLayerOnInternal(id, want);
    }

    async _setLayerOnInternal(id, want) {
        const layer = LAYER_CATALOG.find(l => l.id === id);
        if (!layer) return;
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
        if (this.tracker.hasGroup(layer.group)) {
            this.tracker.setGroupVisible(layer.group, want);
        }

        // Starlink: drive the InstancedMesh renderer in lockstep with
        // the layer toggle, and suppress the underlying point so each
        // satellite has exactly one on-screen representation.
        if (id === 'starlink') {
            this.starlinkFleet.setVisible(want);
            if (this.tracker.hasGroup(layer.group)) {
                this.tracker.setGroupDotsVisible(layer.group, !want);
            }
        }

        this._notify();
    }

    /** Load the default-on layers in parallel. */
    async bootstrap() {
        const defaults = LAYER_CATALOG.filter(l => l.on);
        await Promise.all(defaults.map(l => this.setLayerOn(l.id, true)));
    }
}
