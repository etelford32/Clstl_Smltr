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

import { SatelliteTracker }                from '../satellite-tracker.js';
import { StarlinkFleet }                   from './starlink-model.js';
import { createSL16Fleet, createSL8Fleet } from './rocket-body-model.js';
import { EnvisatModel }                    from './envisat-model.js';
import { createIssModel }                     from './iss-model.js';
import { createHubbleModel, HUBBLE_NORAD_ID } from './hubble-model.js';
import { createTiangongModel }                from './tiangong-model.js';

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
    // Large intact rocket-body debris. Statistically-most-concerning
    // class in LEO (McKnight et al.) — kept separate from the
    // composite/per-event debris layers because these are individual
    // ~9 t objects, not fragmentation clouds, and they get a 3D model
    // instead of a dot.
    { id: 'sl-16-rb',     label: 'SL-16 / Zenit-2 R/B', section: 'Large debris (3D)', on: false, group: 'sl-16-rb'    },
    // SL-8 / Cosmos-3M second stage. ~290 of these in the catalog
    // — far more numerous than SL-16, dominates the "objects per
    // shell" count between 700–1000 km. Rendered with a slow per-
    // instance tumble to communicate that most are in uncontrolled
    // attitude states.
    { id: 'sl-8-rb',      label: 'SL-8 / Cosmos-3M R/B', section: 'Large debris (3D)', on: false, group: 'sl-8-rb'     },
    // Envisat — single-instance hero asset. Largest defunct Earth-
    // observation satellite, tumbling silently since 2012. Rendered
    // with a dedicated Mesh (single object, no instancing) so the
    // bus + ASAR + gold solar wing silhouette reads on close zoom.
    { id: 'envisat',      label: 'Envisat (defunct)',   section: 'Large debris (3D)', on: false, group: 'envisat'     },
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

        // SL-16 / Zenit-2 rocket-body fleet — phase 2 of the model
        // pipeline. ~9-tonne upper stages clustered around 800–900 km
        // get a cylinder + nozzle silhouette instead of a generic dot.
        // Stable (no tumble): canonical gravity-gradient pose.
        this.sl16Fleet = createSL16Fleet(globe, this.tracker);
        globe.onTick((simTimeMs) => this.sl16Fleet.tick(simTimeMs));

        // SL-8 / Cosmos-3M rocket-body fleet — phase 4. Same instanced
        // pipeline as SL-16 but with a stubbier cylinder, smaller
        // nozzle, dark paint band, and a slow per-instance tumble
        // around the cylinder long axis (phase seeded by NORAD ID so
        // neighbours don't move in lockstep).
        this.sl8Fleet = createSL8Fleet(globe, this.tracker);
        globe.onTick((simTimeMs) => this.sl8Fleet.tick(simTimeMs));

        // Envisat — single-mesh hero asset (NORAD 27386). Position
        // tracked via the same SGP4 pipeline; orientation is LVLH +
        // a slow tumble around the local zenith to convey the post-
        // 2012 uncontrolled attitude.
        this.envisatModel = new EnvisatModel(globe, this.tracker);
        globe.onTick((simTimeMs) => this.envisatModel.tick(simTimeMs));

        // ISS / Hubble / Tiangong — actively attitude-controlled hero
        // meshes. Each renders only when its NORAD is in the
        // tracker (self-gating on getPositionXYZ presence), so no
        // dedicated layer toggle is needed: ISS + Tiangong come for
        // free with the default-on `stations` layer, and Hubble is
        // loaded on demand below.
        this.issModel      = createIssModel(globe, this.tracker);
        this.hubbleModel   = createHubbleModel(globe, this.tracker);
        this.tiangongModel = createTiangongModel(globe, this.tracker);
        // All three start visible — the mesh self-hides until the
        // tracker has a position. No flash at origin because the
        // matrix update only fires after a valid getPositionXYZ.
        this.issModel.setVisible(true);
        this.hubbleModel.setVisible(true);
        this.tiangongModel.setVisible(true);
        globe.onTick((simTimeMs) => {
            this.issModel.tick(simTimeMs);
            this.hubbleModel.tick(simTimeMs);
            this.tiangongModel.tick(simTimeMs);
        });

        // Hubble isn't in any default-on group (`stations` covers ISS
        // + Tiangong but not Hubble; CelesTrak's `science` group
        // isn't a layer in this console). Pull it in once so the
        // mesh has a position to track without forcing the user to
        // know which layer holds Hubble's TLE.
        const hubbleLoad = this.tracker.loadNorad?.(HUBBLE_NORAD_ID);
        hubbleLoad?.catch?.(err =>
            console.debug('[fleet] Hubble TLE load failed:', err?.message));

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

        // SL-16 R/B: same dual-toggle pattern as Starlink.
        if (id === 'sl-16-rb') {
            this.sl16Fleet.setVisible(want);
            if (this.tracker.hasGroup(layer.group)) {
                this.tracker.setGroupDotsVisible(layer.group, !want);
            }
        }

        // SL-8 R/B: same dual-toggle pattern.
        if (id === 'sl-8-rb') {
            this.sl8Fleet.setVisible(want);
            if (this.tracker.hasGroup(layer.group)) {
                this.tracker.setGroupDotsVisible(layer.group, !want);
            }
        }

        // Envisat: same dual-toggle pattern. The mesh handles its own
        // "wait for TLE to land" gating inside tick(), so flipping
        // setVisible(true) before the load resolves is safe — the
        // mesh stays hidden until a propagated position arrives.
        if (id === 'envisat') {
            this.envisatModel.setVisible(want);
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
