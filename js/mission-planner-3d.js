/**
 * mission-planner-3d.js — Visual mission-planner simulator with patched-conic
 * trajectories.
 *
 * Two scenes share a renderer + canvas:
 *
 *   geoScene   Earth-centered. 1 unit = 1 R⊕. Renders Earth, atmosphere,
 *              starfield, launch sites, near-Earth payloads (LEO/SSO/MEO/
 *              GEO), and the full lunar-transfer trajectory: parking
 *              orbit → transfer ellipse → lunar SOI → captured lunar orbit.
 *
 *   helioScene Sun-centered. 1 unit = AU_SCALE units. Renders the Sun,
 *              the inner-planet orbit rings, planets at live ephemeris
 *              positions, and the heliocentric Hohmann arc for Mars
 *              transfers, with proper Kepler-equation timing.
 *
 * The active mode is a string ('geo' | 'helio') and switches automatically
 * whenever the user launches a mission whose target lives in the other
 * frame (Mars ⇒ helio, Moon and lower ⇒ geo). Manual override exposed via
 * `setMode()`.
 *
 * All trajectory math comes from `mission-planner-trajectory.js`; this
 * file deals only with rendering + animation.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
    jdNow, moonGeocentric, earthHeliocentric, marsHeliocentric,
    mercuryHeliocentric, venusHeliocentric,
    jupiterHeliocentric, saturnHeliocentric,
    uranusHeliocentric,  neptuneHeliocentric,
} from './horizons.js';
import {
    KM_PER_AU, R_EARTH, R_MOON, R_MARS, SOI_MOON, SOI_MARS, SECONDS_PER_DAY,
    R_EARTH_HELIO, R_MARS_HELIO,
    planLunarTransfer, planLunarLambert,
    planMarsTransfer, planMarsLambert,
    planMarsToEarthLambert, planMoonToMarsLambert, planMoonToEarthLambert,
    planEarthToOuterLambert,
    findLunarLaunchWindow, findMarsLaunchWindow, porkchopMars, porkchop,
    planTour, optimizeTour, TOUR_PRESETS,
    INSERTION_LABELS, PLANET_DISPLAY,
    flybyAssessment, flybyMaxTurnAngle, flybyPeriapsisForTurn,
    hohmannPositionAt,
} from './mission-planner-trajectory.js';
import { sampleKeplerArc } from './mission-planner-lambert.js';
import { EarthSimBridge } from './earth-sim-bridge.js';
import {
    EARTH_VERT, EARTH_FRAG,
    createEarthUniforms, loadEarthTextures,
} from './earth-skin.js';
import { makeOrreryPlanet, updateOrreryPlanet } from './orrery-skins.js';
import { PerfProfiler } from './perf-profiler.js';

// ── Scene scales ────────────────────────────────────────────────────────────
// Unified scene: 1 unit = 1 R⊕ (≈ 6378 km). Earth orbits Sun at ~23 456 R⊕
// (= 1 AU). All bodies, trajectories, and labels live in one scene at this
// scale; the renderer uses logarithmicDepthBuffer to span the 1 → 200 000
// unit dynamic range without z-fighting.
const GEO_UNIT_KM     = R_EARTH;
const KM_TO_SCENE     = 1 / GEO_UNIT_KM;            // km → scene units
const AU_TO_SCENE     = KM_PER_AU * KM_TO_SCENE;    // ≈ 23 456 R⊕ per AU
// Backward-compat alias: legacy code multiplies dist_AU by this to land in
// scene units. Kept so trajectory rendering doesn't need a sweeping rename.
const HELIO_UNIT_AU   = AU_TO_SCENE;
const MOON_R_SCENE    = R_MOON / GEO_UNIT_KM;
const SOI_MOON_SCENE  = SOI_MOON / GEO_UNIT_KM;

// ── Launch sites ────────────────────────────────────────────────────────────
export const LAUNCH_SITES = [
    { id: 'ksc',         name: 'Kennedy SC (USA)',       lat: 28.573, lon: -80.649 },
    { id: 'baikonur',    name: 'Baikonur (KAZ)',         lat: 45.965, lon:  63.305 },
    { id: 'kourou',      name: 'Kourou (FRA)',           lat:  5.236, lon: -52.768 },
    { id: 'starbase',    name: 'Starbase (USA)',         lat: 25.997, lon: -97.155 },
    { id: 'wenchang',    name: 'Wenchang (CHN)',         lat: 19.614, lon: 110.951 },
    { id: 'vandy',       name: 'Vandenberg (USA)',       lat: 34.742, lon:-120.572 },
    { id: 'tanegashima', name: 'Tanegashima (JPN)',      lat: 30.400, lon: 130.969 },
    { id: 'sriharikota', name: 'Sriharikota (IND)',      lat: 13.720, lon:  80.230 },
    { id: 'plesetsk',    name: 'Plesetsk (RUS)',         lat: 62.957, lon:  40.583 },
];

// ── Weather statuses — drives the colored ring on each pad marker and the
//     Launch button gating in the UI. The actual weather data is supplied
//     by an external feed via setPadWeather(); the planner renders whatever
//     it's told. Status semantics:
//
//       go        — clear conditions, launch is unconstrained
//       caution   — marginal (high winds, lightning nearby) — proceed with care
//       scrub     — outside flight rules (storm, freezing, etc.) — blocks launch
//       unknown   — no weather data (default, neutral grey)
//
//     The Launch button gating in mission-planner.html consults
//     getPadWeather(currentBody, currentPadId).status before allowing a
//     launch; 'scrub' disables the button, 'caution' shows a warning,
//     'go' clears it. The visual ring color matches.
export const WEATHER_STATUSES = ['go', 'caution', 'scrub', 'unknown'];
export const WEATHER_COLORS = {
    go:      0x66ff77,
    caution: 0xffcc44,
    scrub:   0xff5544,
    unknown: 0x778899,
};
const WEATHER_RING_OPACITY = {
    go:      0.85,
    caution: 0.95,
    scrub:   1.00,
    unknown: 0.30,         // subtle so empty data doesn't shout at users
};

// ── Mars surface bases — anchored to real landed-mission and proposed-
//     outpost coordinates so the colony domes sit at recognisable locations
//     (Olympus Mons / Jezero / Gale / Utopia Planitia). ─────────────────────
export const MARS_BIOMES = [
    { id: 'olympia', name: 'Olympia Base',     lat:  18.65, lon: 226.20 },  // ~ Olympus Mons summit
    { id: 'jezero',  name: 'Jezero Outpost',   lat:  18.44, lon:  77.45 },  // Mars 2020 / Perseverance
    { id: 'gale',    name: 'Gale Crater Base', lat:  -5.40, lon: 137.81 },  // MSL / Curiosity
    { id: 'utopia',  name: 'Utopia Planitia',  lat:  49.70, lon: 117.50 },  // Viking 2 / Tianwen-1 area
];

// ── Moon surface bases — Apollo + Artemis-region coordinates. ─────────────
export const MOON_BASES = [
    { id: 'tranquility', name: 'Tranquility Base', lat:   0.674, lon:  23.473 },  // Apollo 11
    { id: 'shackleton',  name: 'Shackleton Stn',   lat: -89.660, lon:   0.000 },  // Lunar South Pole / Artemis
    { id: 'imbrium',     name: 'Mare Imbrium',     lat:  32.800, lon: -15.600 },  // Apollo 15 / proposed outpost
    { id: 'schrodinger', name: 'Schrödinger Bsn',  lat: -75.000, lon: 132.400 },  // Far-side proposal
];

// ── Origin → destination route catalogue. The launcher reads this list to
//     decide which trajectory function to call for a given (origin,
//     destination) pair. `body` keys: 'earth' | 'moon' | 'mars'. ───────────
export const MISSION_ROUTES = [
    // Earth-centric (existing)
    { from: 'earth', to: 'leo',     label: 'Earth → LEO',          frame: 'geo'   },
    { from: 'earth', to: 'sso',     label: 'Earth → SSO',          frame: 'geo'   },
    { from: 'earth', to: 'meo',     label: 'Earth → MEO (GPS)',    frame: 'geo'   },
    { from: 'earth', to: 'geo',     label: 'Earth → GEO',          frame: 'geo'   },
    { from: 'earth', to: 'moon',    label: 'Earth → Moon',         frame: 'geo'   },
    { from: 'earth', to: 'mars',    label: 'Earth → Mars',         frame: 'helio' },
    { from: 'earth', to: 'jupiter', label: 'Earth → Jupiter',      frame: 'helio' },
    { from: 'earth', to: 'saturn',  label: 'Earth → Saturn',       frame: 'helio' },
    { from: 'earth', to: 'uranus',  label: 'Earth → Uranus',       frame: 'helio' },
    { from: 'earth', to: 'neptune', label: 'Earth → Neptune',      frame: 'helio' },
    // Cross-body returns
    { from: 'mars',  to: 'earth',   label: 'Mars → Earth',         frame: 'helio' },
    { from: 'moon',  to: 'mars',    label: 'Moon → Mars',          frame: 'helio' },
    { from: 'moon',  to: 'earth',   label: 'Moon → Earth',         frame: 'geo'   },
];

export const TARGET_ORBITS = [
    { id: 'leo',  name: 'LEO · 400 km',           alt_km:    400,                         frame: 'geo' },
    { id: 'sso',  name: 'SSO · 600 km',           alt_km:    600, inc_deg: 97.8,          frame: 'geo' },
    { id: 'meo',  name: 'MEO · 20 200 km (GPS)',  alt_km:  20200, inc_deg: 55,            frame: 'geo' },
    { id: 'geo',  name: 'GEO · 35 786 km',        alt_km:  35786, inc_deg: 0,             frame: 'geo' },
    { id: 'moon', name: 'Lunar transfer (TLI)',   alt_km: 384400,                         frame: 'geo',   isTransfer: 'moon' },
    { id: 'mars',    name: 'Mars transfer (TMI)',     alt_km:    78340000,                  frame: 'helio', isTransfer: 'mars'    },
    { id: 'jupiter', name: 'Jupiter (Lambert · ~3 yr)',alt_km:   628000000,                  frame: 'helio', isTransfer: 'jupiter' },
    { id: 'saturn',  name: 'Saturn  (Lambert · ~6 yr)',alt_km:  1280000000,                  frame: 'helio', isTransfer: 'saturn'  },
    { id: 'uranus',  name: 'Uranus  (Lambert · ~16 yr)',alt_km: 2720000000,                  frame: 'helio', isTransfer: 'uranus'  },
    { id: 'neptune', name: 'Neptune (Lambert · ~31 yr)',alt_km: 4350000000,                  frame: 'helio', isTransfer: 'neptune' },
];

const DEG = Math.PI / 180;
const EARTH_OBLQ_RAD = 23.4393 * DEG;
// Visual placement of the Sun in the Earth-centered scene. The real Sun is
// ~23 455 R⊕ away which would punch through the camera's far plane and look
// like a dot anyway. We park it at a fixed scene distance along the live
// Earth→Sun direction so the day/night terminator and the on-screen Sun
// stay co-located.
const GEO_SUN_DIST   = 220;
const GEO_SUN_RADIUS = 6.0;

// ── Math helpers ────────────────────────────────────────────────────────────
function latLonToVec3(latDeg, lonDeg, r = 1) {
    const phi    = latDeg * DEG;
    const lambda = lonDeg * DEG;
    return new THREE.Vector3(
        r * Math.cos(phi) * Math.cos(lambda),
        r * Math.sin(phi),
        -r * Math.cos(phi) * Math.sin(lambda),
    );
}

// Convert ecliptic (lon_rad, lat_rad, dist_units) → THREE.Vector3 in our scene
// convention (+Y = ecliptic normal, ecliptic in XZ plane).
function eclipticToVec3(lon_rad, lat_rad, r) {
    const cl = Math.cos(lat_rad);
    return new THREE.Vector3(
        r * cl * Math.cos(lon_rad),
        r * Math.sin(lat_rad),
       -r * cl * Math.sin(lon_rad),
    );
}

function easeInOutCubic(t) { return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t + 2, 3)/2; }

// ── Public init ─────────────────────────────────────────────────────────────
export function initMissionPlanner({ container, onEvent } = {}) {
    if (!container) throw new Error('initMissionPlanner: container required');

    const w = () => container.clientWidth  || 800;
    const h = () => container.clientHeight || 520;

    // Shared renderer with logarithmic depth buffer so we can span Earth-
    // surface scale (~1 unit) and full heliocentric scale (~150 000 units)
    // in one scene without z-fighting.
    const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w(), h());
    container.appendChild(renderer.domElement);

    // Frame-section profiler — wraps the tick so the host page can surface
    // FPS / frame-ms / draw stats on demand. Disabled by default so the
    // measure() wrappers no-op until the HUD is shown (Shift+P from the host).
    const prof = new PerfProfiler();
    prof.enable(false);

    // ── Unified world scene ─────────────────────────────────────────────────
    // One Scene + Camera + OrbitControls. `world.earthSystem` is a Group
    // parked at Earth's heliocentric scene position each frame; everything
    // Earth-relative (atmosphere, launch sites, lunar mesh, near-Earth
    // payloads, lunar trajectories) hangs off it so it rides Earth as it
    // orbits the Sun. Heliocentric content (Sun, Mars/Venus/Mercury, helio
    // Lambert arcs, orbit rings) lives in scene root.
    const world = buildWorldScene(renderer, w(), h());

    // Legacy view aliases — they let existing launch helpers keep using
    // `geo.scene.add(...)` / `hel.scene.add(...)` semantics. `geo.scene`
    // points at the moving earthSystem group; `hel.scene` is the scene
    // root. Camera/controls are shared.
    const geo = {
        scene:        world.earthSystem,    // Earth-relative content goes here
        camera:       world.camera,
        controls:     world.controls,
        earth:        world.earth,
        earthTilt:    world.earthTilt,
        earthSkinU:   world.earthSkinU,
        atmo:         world.atmo,
        moon:         world.moon,
    };
    const hel = {
        scene:        world.scene,           // Heliocentric content goes here
        camera:       world.camera,
        controls:     world.controls,
        sun:          world.sun,
        sunGlow:      world.sunGlow,
        flare:        world.flare,
        // hel.earth being the earthSystem group means the helio update loop's
        // `hel.earth.position.copy(...)` repositions the entire Earth System.
        earth:        world.earthSystem,
        mercury:      world.planets.mercury.group,
        venus:        world.planets.venus.group,
        mars:         world.planets.mars.group,
        jupiter:      world.planets.jupiter.group,
        saturn:       world.planets.saturn.group,
        uranus:       world.planets.uranus.group,
        neptune:      world.planets.neptune.group,
        planets:      world.planets,
    };

    // ── State ───────────────────────────────────────────────────────────────
    const state = {
        site:       LAUNCH_SITES[0],
        target:     TARGET_ORBITS[0],
        // `mode` retained for legacy callers but ignored by the renderer —
        // the scene is unified. Setting it now drives the focus preset.
        mode:       'geo',
        rockets:    [],   // active ascent vehicles (Earth-relative)
        payloads:   [],   // deployed near-Earth orbiters
        lunarMissions: [],// active lunar transfers (Earth-relative)
        marsMissions:  [],// active heliocentric Lambert cruises
        tours:         [],// active multi-leg tours
        clock:      new THREE.Clock(),
        elapsed:    0,
        timeScale:  1,
        // Days-per-second of "compressed" simulation time used for the
        // helio + lunar trajectories. Lunar TOF ≈ 5d → ~5s of wall time
        // at 1× when simDays = 1; Mars TOF ≈ 259d → ~26s wall at 10×.
        simDaysPerSec: 1,
        // Live ephemeris JD that drives planet positions.
        scenarioJD: jdNow(),
        // Deterministic JD-anchored time base. Each frame we compute
        //   elapsed    = anchor.elapsed     + (wall_now − anchor.wall) · timeScale
        //   scenarioJD = anchor.scenarioJD  + (wall_now − anchor.wall) · timeScale · simDaysPerSec
        // so framerate hiccups, tab throttling, and pause/resume don't drift
        // the propagation. Re-anchored when timeScale, simDaysPerSec, or
        // scenarioJD are externally mutated.
        simAnchor: null,
        // Auto-frame on launch — when true, a launch automatically chases
        // the new spacecraft via followMission(). Toggleable from the UI.
        autoFrame:  true,
        // Auto-incrementing mission ID so the UI can address a specific
        // mission (telemetry panel, "follow this one" actions). All five
        // mission collections (rockets, payloads, lunar, mars, tours)
        // pull from this counter so IDs are unique across kinds.
        nextMissionId: 1,
        // Simulation window — start/end JD bounds for the scenario clock.
        // The tick clamps scenarioJD inside [startJD, endJD]; reaching
        // either edge with a non-zero rate auto-pauses (timeScale → 0)
        // and emits an 'mp:sim-bound' CustomEvent so the host UI can
        // surface a "reached end of window" affordance. Defaults span
        // ±180 days around the spawn-time JD. setSimBounds(s,e) replaces
        // both; null on either side disables that side's clamp.
        simStartJD:  jdNow() - 180,
        simEndJD:    jdNow() + 180,
        simBoundHit: null,            // 'start' | 'end' | null (last edge hit)
    };
    function _resetSimAnchor() { state.simAnchor = null; }
    function _emitSimBound(edge) {
        try {
            window.dispatchEvent(new CustomEvent('mp:sim-bound', {
                detail: { edge, jd: state.scenarioJD },
            }));
        } catch (_) { /* SSR / non-browser host */ }
    }

    // Surface markers — parented to the spinning Earth so labels stay pinned
    // to real lat/lon as the planet rotates. Each site gets a small base
    // disk + glowing dot + canvas-sprite label naming the actual pad.
    // We also keep a Map so flyToPad can look up the marker's live world
    // position (which moves with both the planet's heliocentric drift and
    // its diurnal rotation). Mars / Moon biome markers are constructed in
    // buildWorldScene and surfaced via world.marsBiomeMarkers / .moonBaseMarkers.
    const padMarkers = new Map();   // key: `${body}:${id}` → Object3D
    for (const s of LAUNCH_SITES) {
        padMarkers.set(`earth:${s.id}`, addLaunchSiteMarker(geo.earth, s));
    }
    for (const id in world.marsBiomeMarkers) {
        padMarkers.set(`mars:${id}`, world.marsBiomeMarkers[id]);
    }
    for (const id in world.moonBaseMarkers) {
        padMarkers.set(`moon:${id}`, world.moonBaseMarkers[id]);
    }

    // ── Pad weather state ─────────────────────────────────────────────────
    // Each pad starts with status='unknown' so the visual ring renders
    // (subtly grey) before the upcoming weather feed populates real data.
    // setPadWeather(body, padId, status, message?) is the single public
    // entry point; it updates the ring color, stores the record, and
    // emits a 'pad-weather' event so the UI can re-evaluate the Launch
    // button state. Records carry a millisecond timestamp so consumers
    // can show staleness ("data 12 min old").
    const padWeather = new Map();
    for (const key of padMarkers.keys()) {
        padWeather.set(key, { status: 'unknown', message: '', lookahead: null, updated_at: Date.now() });
    }
    /**
     * Update one pad's weather record. The optional `opts.lookahead` carries
     * a forecast change-point (next status flip in the next 24 h) so the UI
     * can surface "GO window opens in 3h" / "scrub by T+5h" hints near the
     * Launch button. Shape:
     *   { next_status, next_message, hours_until, time_iso }
     */
    function setPadWeather(body, padId, status, message = '', opts = {}) {
        const key = `${body}:${padId}`;
        const marker = padMarkers.get(key);
        if (!marker) return false;
        const s = WEATHER_STATUSES.includes(status) ? status : 'unknown';
        const rec = {
            status:     s,
            message,
            lookahead:  opts.lookahead || null,
            updated_at: Date.now(),
        };
        padWeather.set(key, rec);
        applyMarkerWeather(marker, s);
        onEvent?.({ type: 'pad-weather', body, padId, ...rec });
        return true;
    }
    function getPadWeather(body, padId) {
        return padWeather.get(`${body}:${padId}`)
            || { status: 'unknown', message: '', lookahead: null, updated_at: 0 };
    }
    function listPadWeather() {
        // Snapshot for the UI to render a "weather report" panel later.
        const out = [];
        for (const [key, rec] of padWeather.entries()) {
            const [body, padId] = key.split(':');
            out.push({ body, padId, ...rec });
        }
        return out;
    }

    // ── Lightning + convective radar overlays ─────────────────────────────
    // Both layers are parented to the spinning Earth mesh so they ride
    // axial tilt + diurnal rotation and stay pinned to real lat/lon. The
    // outer feed module polls /api/lightning/strikes per pad and
    // /api/nws/convective globally, then pushes the data here via
    // setLightningStrikes() / setConvectiveAlerts(). The planner just
    // renders — no fetch logic in this module.
    //
    // Visibility is toggleable via setRadarOverlay(on); when off, the
    // overlay groups are detached from the scene entirely (cheaper than
    // hiding 100+ sprites individually). Default off so a fresh user
    // doesn't see a wall of red dots over Florida and wonder what's
    // going on — they opt in via the ⚡ Radar button.
    const radarState = {
        on:           false,
        strikesGroup: new THREE.Group(),
        alertsGroup:  new THREE.Group(),
        // Last data we were given, so toggling on re-renders with the
        // current state instead of waiting for the next feed tick.
        lastStrikes:  [],
        lastAlerts:   null,
    };
    radarState.strikesGroup.visible = false;
    radarState.alertsGroup.visible  = false;
    geo.earth.add(radarState.strikesGroup);
    geo.earth.add(radarState.alertsGroup);

    function setRadarOverlay(on) {
        radarState.on = !!on;
        radarState.strikesGroup.visible = radarState.on;
        radarState.alertsGroup.visible  = radarState.on;
        // If turning on and we have stale data, re-emit so positions
        // refresh and the scene reflects what the feed last saw.
        if (radarState.on) {
            if (radarState.lastStrikes.length) _renderStrikes(radarState.lastStrikes);
            if (radarState.lastAlerts)         _renderAlerts(radarState.lastAlerts);
        }
        return radarState.on;
    }
    function getRadarOverlay() { return radarState.on; }

    function setLightningStrikes(strikes) {
        radarState.lastStrikes = Array.isArray(strikes) ? strikes : [];
        if (radarState.on) _renderStrikes(radarState.lastStrikes);
    }
    function _renderStrikes(strikes) {
        // Drop the previous frame's sprites. Sprites are cheap; rebuild
        // each tick rather than diffing, since strike sets churn fast
        // (1 min cache window) and N is small (typically < 200).
        while (radarState.strikesGroup.children.length) {
            const c = radarState.strikesGroup.children[0];
            radarState.strikesGroup.remove(c);
            // Sprite material's map texture is shared across instances
            // (same gradient), so disposing per-sprite would orphan it
            // for the remaining sprites. Just drop the node refs and let
            // GC handle them; THREE shares the texture.
        }
        for (const s of strikes) {
            if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
            const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
                map:        _radarStrikeTexture(),
                color:      0xffaa44,
                transparent: true,
                // Older strikes fade. age_min comes from the proxy in
                // 0.1-min precision; clamp 0..60 then map to 0.85..0.15.
                opacity:    0.85 - 0.7 * Math.min(1, Math.max(0, (s.age_min ?? 0) / 60)),
                blending:   THREE.AdditiveBlending,
                depthWrite: false,
                depthTest:  true,
            }));
            sprite.scale.set(0.05, 0.05, 1);
            sprite.position.copy(latLonToVec3(s.lat, s.lon, 1.005));
            radarState.strikesGroup.add(sprite);
        }
    }
    let _radarStrikeTex = null;
    function _radarStrikeTexture() {
        // Shared across every strike sprite — one canvas allocation,
        // one GPU upload. The gradient's tint comes from the sprite
        // material's `color` field, so a single white-ish texture is
        // enough for any future color scheme (warning vs watch).
        if (_radarStrikeTex) return _radarStrikeTex;
        _radarStrikeTex = makeRadialGradientTexture(0xffffff, 0);
        return _radarStrikeTex;
    }

    function setConvectiveAlerts(geojson) {
        radarState.lastAlerts = geojson || null;
        if (radarState.on) _renderAlerts(radarState.lastAlerts);
    }
    function _renderAlerts(geojson) {
        // Drop previous polylines + dispose their geometries. Lines hold
        // BufferGeometry that we *do* want to free since each alert
        // renders a unique outline.
        while (radarState.alertsGroup.children.length) {
            const c = radarState.alertsGroup.children[0];
            radarState.alertsGroup.remove(c);
            c.geometry?.dispose?.();
            c.material?.dispose?.();
        }
        const features = geojson?.features || [];
        for (const f of features) {
            const event = f?.properties?.event || '';
            // Warning > Watch — warnings are imminent, watches are
            // "conditions favorable". Color-grade so the user can read
            // the severity at a glance.
            const isWarning = /Warning/i.test(event);
            const color = isWarning ? 0xff5544 : 0xffaa44;
            const opacity = isWarning ? 0.85 : 0.55;
            const polys = _extractPolygons(f.geometry);
            for (const ring of polys) {
                if (ring.length < 2) continue;
                const points = ring.map(([lon, lat]) => latLonToVec3(lat, lon, 1.003));
                const geom = new THREE.BufferGeometry().setFromPoints(points);
                const line = new THREE.Line(geom, new THREE.LineBasicMaterial({
                    color, transparent: true, opacity,
                    depthTest: true, depthWrite: false,
                }));
                radarState.alertsGroup.add(line);
            }
        }
    }
    function _extractPolygons(g) {
        // Flatten Polygon / MultiPolygon into a list of rings (each ring
        // is an array of [lon, lat] vertices). GeoJSON nests up to 4 deep
        // for MultiPolygon: [polygons[ rings[ vertices[lon,lat] ] ] ].
        if (!g) return [];
        if (g.type === 'Polygon')      return g.coordinates || [];
        if (g.type === 'MultiPolygon') return (g.coordinates || []).flat();
        return [];
    }

    // ── Focus presets (mode toggle replaced) ────────────────────────────────
    // setMode just records the geo/helio frame for legacy code paths. The
    // renderer doesn't switch scenes anymore, and we deliberately DO NOT
    // retarget the camera here — auto-flipping the framing on every launch
    // was disorienting (e.g. firing a Mars mission would yank the user from
    // Earth to a Sun view). The user now has explicit Focus buttons + the
    // Fly-to-pad control to pick where the camera lives.
    function setMode(mode) {
        if (mode !== 'geo' && mode !== 'helio') return;
        state.mode = mode;
        onEvent?.({ type: 'mode', mode });
    }

    // ── Auto-frame on launch ─────────────────────────────────────────────
    // Each launch* helper calls autoFrame(mission) right after the mission
    // is pushed to its state collection. When state.autoFrame is enabled
    // (default true), we delay 500 ms so the user sees the rocket lift off
    // from the pad before the camera takes over and chases the spacecraft.
    // Disabling the toggle keeps the camera wherever the user pointed it.
    function autoFrame(mission) {
        if (!state.autoFrame) return;
        if (!mission) return;
        setTimeout(() => {
            // Re-check that the mission is still active when the timeout
            // fires — the user may have hit Clear All in the meantime.
            const stillActive =
                state.rockets.includes(mission)        ||
                state.payloads.includes(mission)       ||
                state.lunarMissions.includes(mission)  ||
                state.marsMissions.includes(mission)   ||
                state.tours.includes(mission);
            if (!stillActive) return;
            followMission(mission);
        }, 500);
    }
    function setAutoFrame(on) { state.autoFrame = !!on; }
    function getAutoFrame()    { return state.autoFrame; }

    // ── Mission telemetry ────────────────────────────────────────────────
    // listActiveMissions() snapshots every active mission across all five
    // collections. getMissionDetail(id) returns a frame-fresh telemetry
    // record for one mission: phase, progress, distance to target, plan
    // summary. The UI calls getMissionDetail() each tick for the followed
    // mission to drive the live HUD card.
    function _allMissions() {
        return [
            ...state.rockets,
            ...state.payloads,
            ...state.lunarMissions,
            ...state.marsMissions,
            ...state.tours,
        ];
    }
    function listActiveMissions() {
        return _allMissions().map(m => ({
            id:          m.id,
            kind:        m.kind || 'mission',
            payloadName: m.payloadName,
            phase:       m.phase || (m.target && m.mesh ? 'orbit' : ''),
            startedAt:   m.startedAt || 0,
            durSec:      m.durSec || m.totalDur || null,
        }));
    }
    function getMissionDetail(id) {
        let m = _allMissions().find(x => x.id === id);
        if (!m) return null;
        // Once an ascent rocket has deployed, the actual moving body is
        // the payload (rocket mesh goes static at orbit insertion). Both
        // share an id; prefer the payload so the HUD + chase cam track
        // the orbiting craft instead of the parked booster.
        if (m.kind === 'near' && m.phase === 'deployed') {
            const payload = state.payloads.find(p => p.id === id);
            if (payload) m = payload;
        }
        const elapsed = state.elapsed - (m.startedAt || 0);
        const dur     = m.durSec ?? m.totalDur ?? null;
        const progress = dur ? Math.min(1, Math.max(0, elapsed / dur)) : null;

        // Spacecraft world position (covers all kinds: ascent rocket has
        // .group, lunar/mars/tour have .craft, deployed payload has .mesh).
        const obj = m.craft || m.group || m.mesh;
        const pos = new THREE.Vector3();
        if (obj) obj.getWorldPosition(pos);

        // Distance to target body in scene units (1 unit = R⊕). Best-
        // effort heuristics by mission kind so the HUD has a meaningful
        // "to target" readout.
        let targetName = null, distance_units = null;
        if (m.kind === 'lunar' && m.phase !== 'arrived') {
            const moon = new THREE.Vector3();
            world.moon.getWorldPosition(moon);
            distance_units = pos.distanceTo(moon);
            targetName = 'Moon';
        } else if (m.kind === 'mars') {
            distance_units = pos.distanceTo(hel.mars.position);
            targetName = 'Mars';
        } else if (m.kind === 'moon-to-earth' || m.kind === 'mars-to-earth') {
            distance_units = pos.distanceTo(world.earthSystem.position);
            targetName = 'Earth';
        } else if (m.kind === 'earth-to-jupiter' || m.kind === 'moon-to-mars'
                || m.kind === 'earth-to-saturn'  || m.kind === 'earth-to-uranus'
                || m.kind === 'earth-to-neptune') {
            // Helio cruise to outer body — find the planet group.
            const target = m.kind.split('-to-')[1];
            if (hel.planets[target]) {
                distance_units = pos.distanceTo(hel.planets[target].group.position);
                targetName = target.charAt(0).toUpperCase() + target.slice(1);
            }
        } else if (m.kind === 'near' || m.kind === 'payload') {
            // Altitude above Earth surface (Earth-relative position).
            const earthCenter = world.earthSystem.position;
            const alt_units = pos.distanceTo(earthCenter) - 1.0;   // R⊕ units
            distance_units = alt_units;
            targetName = 'Earth (altitude)';
        }

        return {
            id:           m.id,
            kind:         m.kind || 'mission',
            payloadName:  m.payloadName,
            phase:        m.phase || '',
            elapsed_s:    Math.max(0, elapsed),
            duration_s:   dur,
            progress,
            distance_units,
            targetName,
            // Plan summary (Δv / TOF / etc.) — present for trajectory missions.
            plan:         m.plan || null,
            // Origin pad (if known).
            originId:     m.site?.id || null,
        };
    }

    // ── Skip-to-next-event time-warp ─────────────────────────────────────
    // Find the soonest mission "phase transition" or arrival across every
    // active mission, then advance state.elapsed (which drives mission
    // animation interpolation) and state.scenarioJD (which drives planet
    // ephemerides) so all bodies + spacecraft jump to that moment in one
    // step. Trail polylines will skip the intermediate samples — that's
    // expected; the static trajectory arcs (Lambert / Hohmann polylines)
    // remain fully drawn so the path stays visible.
    function _nextEventTime() {
        let next = Infinity;
        let label = null;
        for (const r of state.rockets) {
            if (r.phase === 'ascent') {
                const t = r.startedAt + r.ascentDur;
                if (t > state.elapsed && t < next) { next = t; label = `${r.payloadName} deploys`; }
            }
        }
        for (const m of state.lunarMissions) {
            if (m.phase === 'ascent') {
                const t = m.startedAt + m.ascentDur;
                if (t > state.elapsed && t < next) { next = t; label = `${m.payloadName} TLI`; }
            }
            if (m.phase === 'transfer' && m.transferStart != null) {
                const t = m.transferStart + m.durSec;
                if (t > state.elapsed && t < next) { next = t; label = `${m.payloadName} captures`; }
            }
        }
        for (const m of state.marsMissions) {
            if (m.phase === 'cruise') {
                const t = m.startedAt + m.durSec;
                if (t > state.elapsed && t < next) { next = t; label = `${m.payloadName} arrives`; }
            }
        }
        for (const m of state.tours) {
            if (m.phase === 'cruise') {
                const t = m.startedAt + m.totalDur;
                if (t > state.elapsed && t < next) { next = t; label = `${m.payloadName} tour ends`; }
            }
        }
        if (!isFinite(next)) return null;
        return { time: next, label };
    }
    function getNextEvent() {
        const ev = _nextEventTime();
        if (!ev) return null;
        return {
            label:     ev.label,
            in_seconds: ev.time - state.elapsed,
        };
    }
    function skipToNextEvent() {
        const ev = _nextEventTime();
        if (!ev) return null;
        // Add a tiny epsilon so the interpolation actually crosses the
        // phase boundary (e.g. ascent → deployed) rather than landing
        // right at u=1.0 which the loop treats as "still ascending".
        const dt = (ev.time - state.elapsed) + 0.001;
        if (dt <= 0) return null;
        state.elapsed   += dt;
        state.scenarioJD += dt * state.simDaysPerSec;
        // One synchronous tick so positions, trails, and phase
        // transitions catch up before the next render frame.
        updateEarthSystem(0);
        updateHelio(0);
        return { advanced_seconds: dt, label: ev.label };
    }

    // ── Public API: launch ──────────────────────────────────────────────────
    // Dispatches by (origin body, destination key). Two call forms accepted:
    //
    //   • Legacy: { siteId, targetId, ... }            — origin is implicit
    //                                                    Earth, target keyed
    //                                                    on TARGET_ORBITS.id
    //   • New:    { originBody, originId,              — explicit origin pad
    //              destinationBody, destinationId, ... } on Earth/Moon/Mars
    //
    // The dispatcher resolves origin → pad object, then matches MISSION_ROUTES
    // to pick a trajectory function (planMarsLambert, planMarsToEarthLambert,
    // planMoonToMarsLambert, planMoonToEarthLambert, etc.).
    function launch({
        siteId, targetId,
        originBody, originId, destinationBody, destinationId,
        payloadName     = 'PayloadSat-1',
        windowJD        = null,
        arriveJD        = null,
        parking_inc_deg = null,
        lunar_tof_d     = null,
        force           = false,         // bypass weather scrub gate (programmatic / overrides)
    }) {
        // Legacy single-origin form: Earth surface → TARGET_ORBITS entry.
        if (siteId !== undefined && originBody === undefined) {
            originBody     = 'earth';
            originId       = siteId;
            destinationBody = null;
            destinationId  = targetId;
        }

        const origin = resolveOrigin(originBody, originId);
        if (!origin) throw new Error(`launch: unknown origin ${originBody}/${originId}`);

        // Weather gate — refuse to launch off a scrubbed pad unless the
        // caller passed `force: true`. The HTML UI already disables the
        // Launch button on scrub, but defense-in-depth: programmatic
        // calls + tests + future scripted scenarios all flow through here.
        const wx = getPadWeather(originBody || 'earth', origin.pad.id);
        if (wx.status === 'scrub' && !force) {
            onEvent?.({
                type: 'launch-scrubbed',
                site: origin.pad, body: originBody || 'earth',
                weather: wx, payloadName,
            });
            return null;
        }
        state.site = origin.pad;

        // For Earth-origin keep legacy targetId semantics (LEO/GEO/etc.).
        if (originBody === 'earth') {
            const target = TARGET_ORBITS.find(t => t.id === destinationId) || state.target;
            state.target = target;
            if (target.frame !== state.mode) setMode(target.frame);

            if (target.id === 'moon') {
                return launchLunar({ site: origin.pad, target, payloadName, windowJD, parking_inc_deg, lunar_tof_d });
            }
            if (target.id === 'mars') {
                return launchMars({ site: origin.pad, target, payloadName, windowJD, arriveJD, parking_inc_deg });
            }
            if (['jupiter','saturn','uranus','neptune'].includes(target.id)) {
                return launchOuterPlanet({
                    site: origin.pad, target, payloadName, windowJD, arriveJD, parking_inc_deg,
                });
            }
            return launchNearEarth({ site: origin.pad, target, payloadName });
        }

        // New cross-body routes. destinationBody must be supplied.
        const routeKey = `${originBody}->${destinationBody}`;
        if (routeKey === 'mars->earth') {
            if (state.mode !== 'helio') setMode('helio');
            return launchMarsToEarth({ origin, payloadName, windowJD, arriveJD });
        }
        if (routeKey === 'moon->mars') {
            if (state.mode !== 'helio') setMode('helio');
            return launchMoonToMars({ origin, payloadName, windowJD, arriveJD });
        }
        if (routeKey === 'moon->earth') {
            if (state.mode !== 'geo') setMode('geo');
            return launchMoonToEarth({ origin, payloadName, windowJD, lunar_tof_d });
        }
        throw new Error(`launch: unsupported route ${routeKey}`);
    }

    function resolveOrigin(body, id) {
        if (body === 'earth' || body === undefined) {
            const pad = LAUNCH_SITES.find(s => s.id === id) || LAUNCH_SITES[0];
            return { body: 'earth', pad };
        }
        if (body === 'moon') {
            const pad = MOON_BASES.find(b => b.id === id) || MOON_BASES[0];
            return { body: 'moon', pad };
        }
        if (body === 'mars') {
            const pad = MARS_BIOMES.find(b => b.id === id) || MARS_BIOMES[0];
            return { body: 'mars', pad };
        }
        return null;
    }

    // ── Near-Earth launch (LEO/SSO/MEO/GEO) — geo frame ─────────────────────
    function launchNearEarth({ site, target, payloadName }) {
        const startPos = latLonToVec3(site.lat, site.lon, 1.0);
        const inc      = (target.inc_deg ?? Math.abs(site.lat));
        const altScene = (target.alt_km / GEO_UNIT_KM);
        const rOrbit   = 1 + altScene;

        const ascNode  = new THREE.Vector3(startPos.x, 0, startPos.z).normalize();
        const eastAxis = ascNode.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
        const planeNormal = new THREE.Vector3(0, 1, 0)
            .applyAxisAngle(eastAxis, inc * DEG).normalize();

        const rocket = makeRocket(geo.scene);
        const trail  = makeTrail(geo.scene, 600, 0xffaa33, 0.85);

        const r = {
            id: state.nextMissionId++,
            kind: 'near', group: rocket, ...trail,
            site, target, payloadName,
            startPos, ascNode, planeNormal, rOrbit, inc,
            startedAt: state.elapsed, ascentDur: 6.0,
            phase: 'ascent',
        };
        state.rockets.push(r);
        autoFrame(r);
        onEvent?.({ type: 'launched', site, target, payloadName });
        return r;
    }

    // ── Lunar transfer (geo frame, real patched conic) ──────────────────────
    // If lunar_tof_d is supplied, use the Lambert solver (Apollo-fast = 3 d,
    // Hohmann ≈ 5.4 d, lazy = 7 d). Otherwise default to Hohmann.
    function launchLunar({ site, target, payloadName, windowJD, parking_inc_deg, lunar_tof_d }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const inc       = parking_inc_deg ?? Math.abs(site.lat);
        const useLambert = lunar_tof_d != null;
        const plan = useLambert
            ? planLunarLambert({ jd_depart, tof_d: lunar_tof_d, parking_inc_deg: inc })
            : planLunarTransfer({ jd_depart });

        // Geometry: place the transfer in the Earth-Moon orbital plane. For
        // Hohmann we use the apoapsis direction; for Lambert we use the
        // pre-sampled polyline (which already captures the real geometry).
        let moonArrKm;
        if (useLambert) {
            moonArrKm = plan.r2;
        } else {
            const m = plan.moon_at_arrival;
            const c = Math.cos(m.lat_rad);
            moonArrKm = [
                m.dist_km * c * Math.cos(m.lon_rad),
                m.dist_km * c * Math.sin(m.lon_rad),
                m.dist_km * Math.sin(m.lat_rad),
            ];
        }
        const moonArrPos = new THREE.Vector3(
            moonArrKm[0]/GEO_UNIT_KM,  moonArrKm[2]/GEO_UNIT_KM,  -moonArrKm[1]/GEO_UNIT_KM,
        );
        const apoDir   = moonArrPos.clone().normalize();
        const periDir  = apoDir.clone().multiplyScalar(-1);
        const planeNormal = new THREE.Vector3(0, 1, 0);
        const inPlaneSide = planeNormal.clone().cross(periDir).normalize();

        // Parking orbit ring at periapsis direction (only meaningful for Hohmann).
        const r_park_scene = plan.r_park_km / GEO_UNIT_KM;
        const parkRing = makeOrbitRingFromBasis(
            r_park_scene, periDir, inPlaneSide, 0xffcc66, 0.55,
        );
        geo.scene.add(parkRing);

        // Transfer arc — Hohmann ellipse OR Lambert polyline.
        let ellLine, arcPos = null, N_arc = 0;
        if (useLambert) {
            const samples_km = plan.sample();
            N_arc = samples_km.length;
            arcPos = new Float32Array(N_arc * 3);
            for (let i = 0; i < N_arc; i++) {
                const r = samples_km[i];
                // ecliptic km → scene units (1 R⊕), with horizons.js axis
                // convention (x,y,z)_ecl → scene (x, z, -y).
                arcPos[i*3+0] =  r[0] / GEO_UNIT_KM;
                arcPos[i*3+1] =  r[2] / GEO_UNIT_KM;
                arcPos[i*3+2] = -r[1] / GEO_UNIT_KM;
            }
            const arcGeom = new THREE.BufferGeometry();
            arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
            ellLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
                color: 0x66ddff, transparent: true, opacity: 0.9,
            }));
        } else {
            ellLine = makeEllipseFromBasis(
                plan.ellipse.a_km / GEO_UNIT_KM, plan.ellipse.e,
                periDir, inPlaneSide,
                0x66ddff, 0.85, /* dashed */ true,
            );
        }
        geo.scene.add(ellLine);

        // Lunar SOI sphere (wireframe at arrival point).
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(SOI_MOON_SCENE, 24, 16),
            new THREE.MeshBasicMaterial({
                color: 0x66ffaa, wireframe: true, transparent: true, opacity: 0.18,
            }),
        );
        soiMesh.position.copy(apoDir.clone().multiplyScalar(moonArrPos.length()));
        geo.scene.add(soiMesh);

        // Spacecraft + trail.
        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.04, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        geo.scene.add(craft);
        const trail = makeTrail(geo.scene, 800, 0x66ddff, 0.7);

        const m = {
            id: state.nextMissionId++,
            kind: 'lunar',
            plan,
            craft, ellLine, parkRing, soiMesh,
            ...trail,
            periDir, inPlaneSide, apoDir, planeNormal,
            startedAt:  state.elapsed,
            // Compress TOF: real 3-7 days → 6-10 s of wall time at 1×.
            durSec:     useLambert ? Math.max(5, plan.tof_d * 1.6) : 8,
            phase:      'ascent',
            ascentDur:  3,
            payloadName,
            site, target,
            captureRing: null,   // built when we cross SOI
            crashCheck:  false,
            // Lambert polyline (if present, used instead of Hohmann ellipse for motion)
            arcPos, N_arc,
        };
        state.lunarMissions.push(m);
        autoFrame(m);

        onEvent?.({ type: 'launched-lunar', site, target, payloadName, plan });
        return m;
    }

    // ── Mars transfer (helio frame, Lambert solver) ─────────────────────────
    function launchMars({ site, target, payloadName, windowJD, arriveJD, parking_inc_deg }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        // Default arrival = depart + Hohmann TOF (~258 d). Caller normally
        // supplies arriveJD from a pork-chop pick.
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const inc       = parking_inc_deg ?? Math.abs(site.lat);

        const plan = planMarsLambert({
            jd_depart, jd_arrive,
            parking_inc_deg: inc,
        });

        // Sample the actual Lambert arc in heliocentric km, then project to
        // scene units. This replaces the Hohmann ellipse stand-in — the
        // rendered curve is the trajectory the spacecraft actually flies.
        const samples_km = plan.sample();
        const N = samples_km.length;
        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const arcGeom = new THREE.BufferGeometry();
        const arcPos  = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            // ecliptic +Z → scene +Y? horizons.js puts ecliptic in (x,y) with
            // +z = ecliptic normal. Our scene puts ecliptic in (x,z) with
            // +y = normal. Map (x, y, z)_ecl → (x, z, -y)_scene.
            arcPos[i*3+0] =  r[0] * auMul;
            arcPos[i*3+1] =  r[2] * auMul;
            arcPos[i*3+2] = -r[1] * auMul;
        }
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: 0xff8855, transparent: true, opacity: 0.85,
        }));
        hel.scene.add(arcLine);

        // Mars SOI sphere at arrival point (last sample).
        const soiScene = SOI_MARS * auMul;
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(soiScene, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0xff7755, wireframe: true,
                transparent: true, opacity: 0.25 }),
        );
        soiMesh.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
        hel.scene.add(soiMesh);

        // Spacecraft + trail.
        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1200, 0xff8855, 0.7);

        const m = {
            id: state.nextMissionId++,
            kind: 'mars',
            plan, arcPos, N,
            craft, arcLine, soiMesh,
            ...trail,
            startedAt: state.elapsed,
            // Wall-clock time scales with TOF: 30 s for a 260-day Hohmann.
            durSec:    Math.max(8, plan.tof_d * (30 / 260)),
            phase:     'cruise',
            payloadName, site, target,
        };
        state.marsMissions.push(m);
        autoFrame(m);

        // TMI burn flash at Earth's helio position at departure.
        spawnBurnFlash(hel.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0xffcc66, 800, 1.4);

        onEvent?.({ type: 'launched-mars', site, target, payloadName, plan });
        return m;
    }

    // ── Generic helio Lambert launcher ──────────────────────────────────────
    // Mars→Earth and Moon→Mars share the exact same animation needs as
    // launchMars: sample the Lambert arc into helio scene units, drop a
    // spacecraft at sample 0, walk it to sample N-1 over a TOF-scaled wall
    // duration. The only differences are the kind tag, the SOI body at
    // arrival, and the trail / arc colors. We reuse state.marsMissions as
    // the storage list because the tick loop already animates anything
    // there with phase==='cruise'.
    function _launchHelioLambert({ plan, kind, payloadName, arrival_soi_km, arc_color, trail_color, route_label }) {
        const samples_km = plan.sample();
        const N = samples_km.length;
        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const arcPos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            arcPos[i*3+0] =  r[0] * auMul;
            arcPos[i*3+1] =  r[2] * auMul;
            arcPos[i*3+2] = -r[1] * auMul;
        }
        const arcGeom = new THREE.BufferGeometry();
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: arc_color, transparent: true, opacity: 0.85,
        }));
        hel.scene.add(arcLine);

        const soiScene = arrival_soi_km * auMul;
        const soiMesh = new THREE.Mesh(
            new THREE.SphereGeometry(soiScene, 16, 12),
            new THREE.MeshBasicMaterial({ color: arc_color, wireframe: true,
                transparent: true, opacity: 0.25 }),
        );
        soiMesh.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
        hel.scene.add(soiMesh);

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.05, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffeecc }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1200, trail_color, 0.7);

        const m = {
            id: state.nextMissionId++,
            kind,
            plan, arcPos, N,
            craft, arcLine, soiMesh,
            ...trail,
            startedAt: state.elapsed,
            durSec: Math.max(8, plan.tof_d * (30 / 260)),
            phase:  'cruise',
            payloadName,
        };
        state.marsMissions.push(m);
        autoFrame(m);

        spawnBurnFlash(hel.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0xffcc66, 800, 1.4);

        onEvent?.({ type: 'launched-helio', kind, route: route_label, payloadName, plan });
        return m;
    }

    // ── Mars → Earth (helio Lambert) ────────────────────────────────────────
    function launchMarsToEarth({ origin, payloadName, windowJD, arriveJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const plan = planMarsToEarthLambert({ jd_depart, jd_arrive });
        return _launchHelioLambert({
            plan, kind: 'mars-to-earth', payloadName,
            arrival_soi_km: 924000,           // SOI of Earth
            arc_color: 0x66ccff, trail_color: 0x66aaff,
            route_label: `${origin.pad.name} → Earth`,
        });
    }

    // ── Earth → outer planet (Jupiter / Saturn / Uranus / Neptune) ─────────
    // Heliocentric Lambert from Earth at depart JD to the target planet at
    // arrival JD. Default arrival is one Hohmann TOF after depart, set by
    // planEarthToOuterLambert. Reuses the helio cruise animation pipeline
    // via _launchHelioLambert; per-target SOI mesh + arc tint give each
    // mission a recognisable colour.
    const _OUTER_PLANET_LOOK = {
        jupiter: { color: 0xd4a060, soi: 48200000, label: 'Jupiter' },
        saturn:  { color: 0xd9c97a, soi: 54400000, label: 'Saturn'  },
        uranus:  { color: 0x9fd6e0, soi: 51700000, label: 'Uranus'  },
        neptune: { color: 0x4f7adb, soi: 86700000, label: 'Neptune' },
    };
    function launchOuterPlanet({ site, target, payloadName, windowJD, arriveJD, parking_inc_deg }) {
        const planetKey = target.id;
        const look = _OUTER_PLANET_LOOK[planetKey];
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const plan = planEarthToOuterLambert({
            planet: planetKey,
            jd_depart,
            jd_arrive: arriveJD,                  // null → Hohmann default
            parking_inc_deg: parking_inc_deg ?? Math.abs(site.lat),
        });
        return _launchHelioLambert({
            plan, kind: `earth-to-${planetKey}`, payloadName,
            arrival_soi_km: look.soi,
            arc_color: look.color, trail_color: look.color,
            route_label: `${site.name} → ${look.label}`,
        });
    }

    // ── Moon → Mars (helio Lambert from Moon's heliocentric position) ───────
    function launchMoonToMars({ origin, payloadName, windowJD, arriveJD }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const jd_arrive = arriveJD ?? (jd_depart + 258);
        const plan = planMoonToMarsLambert({ jd_depart, jd_arrive });
        return _launchHelioLambert({
            plan, kind: 'moon-to-mars', payloadName,
            arrival_soi_km: SOI_MARS,
            arc_color: 0xff99cc, trail_color: 0xff77bb,
            route_label: `${origin.pad.name} → Mars`,
        });
    }

    // ── Moon → Earth (geocentric Lambert) ───────────────────────────────────
    // Lives in the geo frame; spacecraft starts at the Moon's geocentric
    // position and arcs back into a low Earth parking orbit. Mission shape
    // matches the existing lunarMissions list so the geo tick walks it.
    function launchMoonToEarth({ origin, payloadName, windowJD, lunar_tof_d }) {
        const jd_depart = windowJD ?? state.scenarioJD ?? jdNow();
        const tof_d     = lunar_tof_d ?? 4.5;
        const plan = planMoonToEarthLambert({ jd_depart, tof_d });

        const samples_km = plan.sample();
        const N = samples_km.length;
        const arcPos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const r = samples_km[i];
            arcPos[i*3+0] =  r[0] / GEO_UNIT_KM;
            arcPos[i*3+1] =  r[2] / GEO_UNIT_KM;
            arcPos[i*3+2] = -r[1] / GEO_UNIT_KM;
        }
        const arcGeom = new THREE.BufferGeometry();
        arcGeom.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
        const arcLine = new THREE.Line(arcGeom, new THREE.LineBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.85,
        }));
        geo.scene.add(arcLine);

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.04, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0x66ddff }),
        );
        geo.scene.add(craft);
        const trail = makeTrail(geo.scene, 800, 0x66ddff, 0.7);

        const m = {
            id: state.nextMissionId++,
            kind: 'moon-to-earth',
            plan, arcPos, N_arc: N,
            craft, arcLine, ellLine: null, parkRing: null, soiMesh: null, captureRing: null,
            ...trail,
            startedAt: state.elapsed,
            transferStart: state.elapsed,    // skip ascent phase entirely
            durSec: Math.max(8, plan.tof_d * 6),
            phase: 'transfer',
            payloadName,
            site: origin.pad,
            target: { id: 'earth-return', name: 'Earth (LEO return)', frame: 'geo' },
        };
        state.lunarMissions.push(m);
        autoFrame(m);

        spawnBurnFlash(geo.scene,
            new THREE.Vector3(arcPos[0], arcPos[1], arcPos[2]),
            0x66ddff, 800, 1.2);

        onEvent?.({ type: 'launched-lunar-return', payloadName, plan, route: `${origin.pad.name} → Earth` });
        return m;
    }

    // ── Tour (multi-leg Lambert chain, helio frame) ─────────────────────────
    // Renders each leg as its own polyline (color-coded by leg index) and
    // walks the spacecraft through the legs sequentially. Planet markers at
    // each encounter pulse briefly to show the flyby moment.
    function launchTour({ plan, payloadName = 'Tour-1' }) {
        if (state.mode !== 'helio') setMode('helio');

        const auMul = HELIO_UNIT_AU / KM_PER_AU;
        const LEG_COLORS = [0x66ccff, 0x66ffaa, 0xff8855, 0xffcc66, 0xff66cc];

        const legGeoms = [];
        for (let i = 0; i < plan.legs.length; i++) {
            const leg = plan.legs[i];
            const samples_km = leg.sample();
            const N = samples_km.length;
            const arcPos = new Float32Array(N * 3);
            for (let k = 0; k < N; k++) {
                const r = samples_km[k];
                arcPos[k*3+0] =  r[0] * auMul;
                arcPos[k*3+1] =  r[2] * auMul;
                arcPos[k*3+2] = -r[1] * auMul;
            }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(arcPos, 3));
            const line = new THREE.Line(g, new THREE.LineBasicMaterial({
                color: LEG_COLORS[i % LEG_COLORS.length],
                transparent: true, opacity: 0.9,
            }));
            hel.scene.add(line);

            // Encounter markers — color/size encode flyby physics:
            //   • intermediate body with ballistic flyby   → cyan, large radius
            //   • intermediate body with powered flyby     → orange, small (tight)
            //   • final body (capture)                     → green, large
            const isFinal = i === plan.legs.length - 1;
            const f = leg.flyby_at_arrival;
            let mColor, mSize;
            if (isFinal) {
                mColor = 0x66ffaa; mSize = 0.16;
            } else if (f && f.ballistic) {
                mColor = 0x66ddff;
                // Bigger sphere = "looser" (higher) flyby altitude
                mSize = 0.08 + 0.06 * Math.min(1, f.altitude_km / 20000);
            } else {
                mColor = 0xff8855;
                mSize = 0.10;
            }
            const marker = new THREE.Mesh(
                new THREE.SphereGeometry(mSize, 16, 12),
                new THREE.MeshBasicMaterial({
                    color: mColor, wireframe: true,
                    transparent: true, opacity: 0.65,
                }),
            );
            marker.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
            hel.scene.add(marker);

            // ── B-plane visualization (only for intermediate flybys) ──────
            // Built once at launch using the data from flybyAssessment, sits
            // at the body marker for the whole mission (later: hide unless
            // the user is near that body in the timeline).
            let bPlaneViz = null;
            if (!isFinal && f && f.b_plane) {
                // Outgoing v∞ direction (helio frame) for asymptote-out line
                const v_out_helio = plan.legs[i+1].v_inf_depart_vec;
                const m_out = Math.hypot(v_out_helio[0], v_out_helio[1], v_out_helio[2]);
                const v_out_unit = [v_out_helio[0]/m_out, v_out_helio[1]/m_out, v_out_helio[2]/m_out];
                bPlaneViz = buildBPlaneViz(f, v_out_unit, 0.28);
                bPlaneViz.position.set(arcPos[(N-1)*3+0], arcPos[(N-1)*3+1], arcPos[(N-1)*3+2]);
                hel.scene.add(bPlaneViz);
            }

            legGeoms.push({ line, arcPos, N, marker, bPlaneViz, leg });
        }

        const craft = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 12, 8),
            new THREE.MeshBasicMaterial({ color: 0xffffff }),
        );
        hel.scene.add(craft);
        const trail = makeTrail(hel.scene, 1500, 0xffeecc, 0.7);

        // Burn flash at the start of the tour (TMI from Earth).
        spawnBurnFlash(hel.scene,
            new THREE.Vector3(legGeoms[0].arcPos[0], legGeoms[0].arcPos[1], legGeoms[0].arcPos[2]),
            0xffcc66, 800, 1.4);

        // Wall-clock seconds for the entire tour at 1× timeScale.
        const totalDur = Math.max(15, plan.tof_total_d * (45 / 800));   // ~45 s for an 800-d tour

        const m = {
            id: state.nextMissionId++,
            kind: 'tour',
            plan, legGeoms, craft, ...trail,
            startedAt: state.elapsed,
            totalDur,
            // tours don't carry a `durSec`; mirror it for the unified
            // mission-event scanner used by skipToNextEvent.
            durSec: totalDur,
            phase: 'cruise',
            payloadName,
            currentLeg: 0,
        };
        state.tours.push(m);
        autoFrame(m);

        onEvent?.({ type: 'launched-tour', payloadName, plan });
        return m;
    }

    // ── Update loop ─────────────────────────────────────────────────────────
    // Single unified tick: drive Earth's heliocentric position (which moves
    // the entire earthSystem group), update Earth-relative animations,
    // update heliocentric planet positions + cruise spacecraft, then render
    // the one scene through the one camera.
    function tick() {
        // ── Deterministic JD-anchored time base ──────────────────────────────
        // Replaces `clock.getDelta() * timeScale` accumulation with an anchor
        // (wall_ms, elapsed, scenarioJD, timeScale, simDaysPerSec) that is
        // re-evaluated on every frame as a closed-form function of wall-clock.
        // Pausing (timeScale=0), framerate hiccups, and tab-throttling no
        // longer drift the propagation; scrubbing re-anchors automatically.
        const _wallNow = performance.now();
        if (!state.simAnchor ||
            state.simAnchor.timeScale     !== state.timeScale ||
            state.simAnchor.simDaysPerSec !== state.simDaysPerSec) {
            state.simAnchor = {
                wallMs:        _wallNow,
                elapsed:       state.elapsed,
                scenarioJD:    state.scenarioJD,
                timeScale:     state.timeScale,
                simDaysPerSec: state.simDaysPerSec,
            };
            // Reset the THREE.Clock so its getDelta() accumulator doesn't
            // surface elsewhere (kept as a fall-back for legacy callers).
            state.clock.getDelta();
        }
        const dWall    = (_wallNow - state.simAnchor.wallMs) / 1000;
        const newElapsed = state.simAnchor.elapsed + dWall * state.simAnchor.timeScale;
        const dt         = Math.max(0, newElapsed - state.elapsed);  // monotonic frame slice
        state.elapsed    = newElapsed;
        state.scenarioJD = state.simAnchor.scenarioJD + dWall * state.simAnchor.timeScale * state.simAnchor.simDaysPerSec;

        // Sim-window clamp. When scenarioJD walks past either bound at a
        // non-zero rate we pin it to the edge, kill timeScale, and emit a
        // single 'mp:sim-bound' so the host UI can flash a "reached end"
        // chip. simBoundHit is cleared the next time the user changes the
        // bounds, scrubs back inside, or unpauses with rate>0.
        const _rate = state.timeScale * state.simDaysPerSec;
        if (_rate !== 0 && Number.isFinite(state.simStartJD) && state.scenarioJD < state.simStartJD) {
            state.scenarioJD = state.simStartJD;
            if (state.simBoundHit !== 'start') {
                state.simBoundHit = 'start';
                _emitSimBound('start');
            }
            state.timeScale = 0;
            _resetSimAnchor();
        } else if (_rate !== 0 && Number.isFinite(state.simEndJD) && state.scenarioJD > state.simEndJD) {
            state.scenarioJD = state.simEndJD;
            if (state.simBoundHit !== 'end') {
                state.simBoundHit = 'end';
                _emitSimBound('end');
            }
            state.timeScale = 0;
            _resetSimAnchor();
        }

        prof.frameStart();
        prof.measure('earth',  () => updateEarthSystem(dt));   // earthSystem heliocentric pos + Earth-frame anims
        prof.measure('helio',  () => updateHelio(dt));          // Sun spin + Mercury/Venus/Mars + helio cruises
        // Off-thread Earth-system ground truth: the worker propagates Moon /
        // Phobos / Deimos / Earth heliocentric in deterministic Keplerian form
        // and emits an FNV-1a hash per reply. The simSpeed argument is "sim
        // seconds per real second" — here, timeScale × simDaysPerSec × 86400.
        const simSpdSecPerSec = state.simAnchor.timeScale * state.simAnchor.simDaysPerSec * 86400;
        prof.measure('bridge', () => {
            earthBridge.maintain(state.scenarioJD, simSpdSecPerSec);
            _updateEarthBridgeResidual();
        });
        // Camera animation + body-follow translation must run AFTER body
        // positions update so the rig is locked to current world coords.
        prof.measure('camera', () => {
            updateCameraSystem();
            world.controls.update();
        });
        prof.measure('render', () => renderer.render(world.scene, world.camera));
        prof.frameEnd(renderer.info);

        requestAnimationFrame(tick);
    }

    function updateEarthSystem(dt) {
        // Earth rotation (cosmetic — slow enough that pinned launch sites
        // don't whip around the globe between frames).
        geo.earth.rotation.y += dt * 0.04;

        // Park the entire Earth system at Earth's heliocentric scene
        // position. Everything inside earthSystem (atmosphere, launch
        // sites, Moon, near-Earth payloads, lunar trajectories) rides
        // along automatically.
        const eVec = earthHeliocentric(state.scenarioJD);
        world.earthSystem.position.copy(eclipticToVec3(
            eVec.lon_rad, eVec.lat_rad, eVec.dist_AU * AU_TO_SCENE,
        ));

        // Sun direction in WORLD space: the real Sun is at scene origin,
        // so the unit vector from Earth → Sun is just -earthSystem.position
        // normalized. Drives the EarthSkin shader's day/night terminator.
        if (geo.earthSkinU?.u_sun_dir) {
            const sunDir = world.earthSystem.position.clone().multiplyScalar(-1).normalize();
            geo.earthSkinU.u_sun_dir.value.copy(sunDir);
            geo.earthSkinU.u_time.value = state.elapsed;
        }

        // Live Moon position from ephemeris (slowed): drift the moon along
        // its real angular rate, anchored to scenarioJD. Position is in
        // earthSystem-local coordinates (Earth at origin of that group).
        const moonNow = moonGeocentric(state.scenarioJD);
        geo.moon.position.copy(eclipticToVec3(
            moonNow.lon_rad, moonNow.lat_rad,
            moonNow.dist_km / GEO_UNIT_KM,
        ));

        // ── Near-Earth ascent rockets ───────────────────────────────────────
        for (const r of state.rockets) {
            if (r.phase !== 'ascent') continue;
            const t = state.elapsed - r.startedAt;
            const u = Math.min(1, t / r.ascentDur);
            const radius = 1 + (r.rOrbit - 1) * easeInOutCubic(u);
            const dir = r.ascNode.clone().applyAxisAngle(r.planeNormal, u * Math.PI/2 * 0.85);
            const pos = dir.multiplyScalar(radius);
            r.group.position.copy(pos);
            const up = pos.clone().normalize();
            const tangent = r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2 + 0.001).sub(
                r.ascNode.clone().applyAxisAngle(r.planeNormal, u*Math.PI/2)
            ).normalize();
            r.group.lookAt(pos.clone().add(tangent.add(up.multiplyScalar(0.4))));
            r.group.rotateX(Math.PI/2);
            pushTrail(r, pos);
            if (u >= 1) {
                r.phase = 'deployed';
                deployNearEarthPayload(r);
            }
        }

        // ── Near-Earth deployed payloads ────────────────────────────────────
        for (const p of state.payloads) {
            p.theta += dt * p.omega;
            const dir = p.ascNode.clone().applyAxisAngle(p.planeNormal, p.theta);
            p.mesh.position.copy(dir.multiplyScalar(p.r));
            pushOrbitTrail(p);
        }

        // ── Lunar missions ──────────────────────────────────────────────────
        for (const m of state.lunarMissions) {
            const t = state.elapsed - m.startedAt;

            if (m.phase === 'ascent') {
                // Quick visual ascent from launch site to the parking orbit
                // periapsis (which sits along periDir at r_park_scene).
                const u = Math.min(1, t / m.ascentDur);
                const start = latLonToVec3(m.site.lat, m.site.lon, 1.0);
                const end   = m.periDir.clone().multiplyScalar(m.plan.r_park_km / GEO_UNIT_KM);
                const pos   = start.clone().lerp(end, easeInOutCubic(u));
                m.craft.position.copy(pos);
                pushTrail(m, pos);
                if (u >= 1) {
                    m.phase = 'transfer';
                    m.transferStart = state.elapsed;
                    spawnBurnFlash(geo.scene, pos.clone(), 0xffcc66, 700, 0.8);
                }
                continue;
            }

            if (m.phase === 'transfer') {
                const u = Math.min(1, (state.elapsed - m.transferStart) / m.durSec);
                let pos;
                if (m.arcPos) {
                    // Lambert polyline: linear interp between samples.
                    const fi = u * (m.N_arc - 1);
                    const i0 = Math.floor(fi), i1 = Math.min(m.N_arc - 1, i0 + 1);
                    const t  = fi - i0;
                    const ax = m.arcPos;
                    pos = new THREE.Vector3(
                        ax[i0*3+0]*(1-t) + ax[i1*3+0]*t,
                        ax[i0*3+1]*(1-t) + ax[i1*3+1]*t,
                        ax[i0*3+2]*(1-t) + ax[i1*3+2]*t,
                    );
                } else {
                    const a_scene = m.plan.ellipse.a_km / GEO_UNIT_KM;
                    const e       = m.plan.ellipse.e;
                    const p2d     = hohmannPositionAt(u, a_scene, e);
                    pos = m.periDir.clone().multiplyScalar(p2d.x)
                        .add(m.inPlaneSide.clone().multiplyScalar(p2d.y));
                }
                m.craft.position.copy(pos);
                pushTrail(m, pos);

                // Detect SOI entry — only meaningful for outbound lunar
                // missions. Moon→Earth returns have no Moon-SOI mesh.
                if (m.soiMesh) {
                    const distToMoon = pos.distanceTo(m.soiMesh.position);
                    if (distToMoon <= SOI_MOON_SCENE && !m.captureRing) {
                        captureLunar(m);
                    }
                }

                if (u >= 1) {
                    if (m.kind === 'moon-to-earth') {
                        m.phase = 'arrived';
                        spawnBurnFlash(geo.scene, pos.clone(), 0x66ffaa, 1000, 1.4);
                        onEvent?.({ type: 'lunar-return-arrived', payloadName: m.payloadName, plan: m.plan });
                    } else {
                        m.phase = 'captured';
                        if (!m.captureRing) captureLunar(m);
                    }
                }
                continue;
            }

            if (m.phase === 'captured') {
                // Spacecraft circulates around the (moving) Moon at r_capt.
                m.captureTheta = (m.captureTheta || 0) + dt * (m.captureOmega || 1.2);
                const local = m.capturePeri.clone()
                    .applyAxisAngle(m.planeNormal, m.captureTheta)
                    .multiplyScalar(m.plan.r_capt_km / GEO_UNIT_KM);
                m.craft.position.copy(geo.moon.position.clone().add(local));
                // Move the capture ring to follow the Moon.
                m.captureRing.position.copy(geo.moon.position);
            }
        }
    }

    // ── Camera-distance LOD for visible bodies ──────────────────────────────
    // Each planet's mesh is built at its real radius (Mercury 0.382, Venus
    // 0.949, Earth 1.0, Mars 0.531 R⊕). Up close that's correct: Mars
    // really is half the size of Earth, Mercury is a third. From AU-scale
    // distance those meshes would be sub-pixel, so we uniformly scale each
    // body up to maintain a minimum on-screen angular size (~12 mrad ≈
    // 0.7°, roughly 12 px on a 1080p viewport). Below the crossover
    // distance the scale is exactly 1 — no pop, just a smooth transition
    // when the camera passes through ≈ realRadius / minAngular.
    //
    // Earth is scaled via earthTilt so the Moon (sibling in earthSystem)
    // and the lunar orbit ring stay at their real heliocentric offsets.
    // Moon stays at real size and relies on its halo sprite at distance.
    const MIN_ANGULAR  = 0.012;
    // Cap the upscale so that flying out to Neptune (~30 AU) doesn't inflate
    // a 0.5 R⊕ Mars to span the entire inner solar system. Beyond the cap
    // bodies dim into halos / sub-pixel dots, which is fine — at that range
    // the relevant frame is the outer planets anyway.
    const MAX_LOD_SCALE = 2000;
    const _camWorld    = new THREE.Vector3();
    const _bodyWorld   = new THREE.Vector3();
    function lodScale(distance, realRadius) {
        const angular = realRadius / Math.max(1e-3, distance);
        if (angular >= MIN_ANGULAR) return 1.0;
        return Math.min(MAX_LOD_SCALE, MIN_ANGULAR / angular);
    }
    function applyPlanetLOD() {
        world.camera.getWorldPosition(_camWorld);

        // All planet groups (inner + outer). Each handle exposes realRadius
        // (set in buildWorldScene) — no special-casing per body.
        for (const key of ['mercury','venus','mars','jupiter','saturn','uranus','neptune']) {
            const handle = hel.planets[key];
            handle.group.getWorldPosition(_bodyWorld);
            handle.group.scale.setScalar(
                lodScale(_camWorld.distanceTo(_bodyWorld), handle.realRadius));
        }

        // Earth (scale earthTilt only — keeps Moon on its real orbit)
        world.earthSystem.getWorldPosition(_bodyWorld);
        world.earthTilt.scale.setScalar(
            lodScale(_camWorld.distanceTo(_bodyWorld), 1.0));
    }

    function captureLunar(m) {
        m.captureRing = makeOrbitRingFromBasis(
            m.plan.r_capt_km / GEO_UNIT_KM,
            new THREE.Vector3(1, 0, 0),
            new THREE.Vector3(0, 0, 1),
            0xffeecc, 0.85,
        );
        spawnBurnFlash(geo.scene, geo.moon.position.clone(), 0x66ffaa, 900, 0.6);
        m.captureRing.position.copy(geo.moon.position);
        geo.scene.add(m.captureRing);
        m.capturePeri    = new THREE.Vector3(1, 0, 0);
        m.captureTheta   = 0;
        // visual angular speed (rad/sec at 1× timeScale): pick something snappy
        m.captureOmega   = 1.6;
        onEvent?.({
            type: 'lunar-captured',
            payloadName: m.payloadName,
            plan: m.plan,
        });
    }

    function updateHelio(dt) {
        // Sun spin (purely cosmetic).
        hel.sun.rotation.y += dt * 0.04;

        // Update planet positions from live ephemeris at scenarioJD.
        // (Earth's position is handled by updateEarthSystem, which moves
        // the parented earthSystem group; that's why we don't update
        // hel.earth here.)
        const planetEphem = [
            [hel.mercury, mercuryHeliocentric(state.scenarioJD)],
            [hel.venus,   venusHeliocentric  (state.scenarioJD)],
            [hel.mars,    marsHeliocentric   (state.scenarioJD)],
            [hel.jupiter, jupiterHeliocentric(state.scenarioJD)],
            [hel.saturn,  saturnHeliocentric (state.scenarioJD)],
            [hel.uranus,  uranusHeliocentric (state.scenarioJD)],
            [hel.neptune, neptuneHeliocentric(state.scenarioJD)],
        ];
        for (const [group, eph] of planetEphem) {
            group.position.copy(eclipticToVec3(eph.lon_rad, eph.lat_rad, eph.dist_AU * AU_TO_SCENE));
        }

        // Drive procedural-skin axial rotation + sun-direction lighting so
        // the lit hemisphere always faces the (origin) Sun. Done after
        // position updates because updateOrreryPlanet uses planet.group's
        // current position to compute uSunDir.
        if (hel.planets) {
            const sunPos = new THREE.Vector3(0, 0, 0);
            for (const key of ['mercury','venus','mars','jupiter','saturn','uranus','neptune']) {
                updateOrreryPlanet(hel.planets[key], state.scenarioJD, sunPos);
            }
            applyPlanetLOD();
        }

        // Mars missions — spacecraft walks the pre-sampled Lambert arc.
        // Linear interpolation between samples is fine because the arc was
        // sampled at uniform t (Kepler-equation timing). Could be upgraded
        // to a true Catmull-Rom spline if the arc ever looked jaggy.
        for (const m of state.marsMissions) {
            if (m.phase !== 'cruise') continue;
            const u   = Math.min(1, (state.elapsed - m.startedAt) / m.durSec);
            const fi  = u * (m.N - 1);
            const i0  = Math.floor(fi);
            const i1  = Math.min(m.N - 1, i0 + 1);
            const t   = fi - i0;
            const ax  = m.arcPos;
            m.craft.position.set(
                ax[i0*3+0] * (1-t) + ax[i1*3+0] * t,
                ax[i0*3+1] * (1-t) + ax[i1*3+1] * t,
                ax[i0*3+2] * (1-t) + ax[i1*3+2] * t,
            );
            pushTrail(m, m.craft.position);
            if (u >= 1) {
                m.phase = 'arrived';
                spawnBurnFlash(hel.scene, m.craft.position.clone(), 0x66ffaa, 1100, 1.6);
                // Per-kind arrival event so the UI log reads correctly.
                const arrivalEvents = {
                    'mars':            'mars-captured',
                    'mars-to-earth':   'earth-captured',
                    'moon-to-mars':    'mars-captured',
                    'earth-to-jupiter':'jupiter-captured',
                    'earth-to-saturn': 'saturn-captured',
                    'earth-to-uranus': 'uranus-captured',
                    'earth-to-neptune':'neptune-captured',
                };
                onEvent?.({
                    type: arrivalEvents[m.kind] || 'helio-arrived',
                    payloadName: m.payloadName, plan: m.plan,
                });
            }
        }

        // Tour spacecraft — sequential walk through legs. Each leg gets a
        // fraction of total wall-clock time proportional to its TOF.
        for (const t of state.tours) {
            if (t.phase !== 'cruise') continue;
            const u = Math.min(1, (state.elapsed - t.startedAt) / t.totalDur);

            // Find current leg by accumulating TOF fractions.
            const totalTof = t.plan.tof_total_d;
            const sTotal = u * totalTof;
            let acc = 0, legIdx = 0;
            for (let i = 0; i < t.legGeoms.length; i++) {
                const tofI = t.legGeoms[i].leg.tof_d;
                if (sTotal <= acc + tofI) { legIdx = i; break; }
                acc += tofI;
                legIdx = i + 1;
            }
            if (legIdx >= t.legGeoms.length) {
                t.phase = 'arrived';
                // Final capture flash at the last body.
                const last = t.legGeoms[t.legGeoms.length - 1];
                spawnBurnFlash(hel.scene, new THREE.Vector3(
                    last.arcPos[(last.N-1)*3+0], last.arcPos[(last.N-1)*3+1], last.arcPos[(last.N-1)*3+2],
                ), 0x66ffaa, 1100, 1.6);
                onEvent?.({ type: 'tour-arrived', payloadName: t.payloadName, plan: t.plan });
                continue;
            }

            // Notify on leg transitions.
            if (legIdx !== t.currentLeg) {
                t.currentLeg = legIdx;
                // Flyby flash at the body the spacecraft just crossed.
                if (legIdx > 0) {
                    const prev = t.legGeoms[legIdx - 1];
                    const f = prev.leg.flyby_at_arrival;
                    const flashColor = f && f.ballistic ? 0x66ddff : 0xff8855;
                    spawnBurnFlash(hel.scene, new THREE.Vector3(
                        prev.arcPos[(prev.N-1)*3+0], prev.arcPos[(prev.N-1)*3+1], prev.arcPos[(prev.N-1)*3+2],
                    ), flashColor, 900, f && f.ballistic ? 1.0 : 1.4);
                }
                onEvent?.({
                    type: 'tour-leg', payloadName: t.payloadName,
                    legIndex: legIdx,
                    leg: t.legGeoms[legIdx].leg,
                    tour: t.plan,
                });
            }

            const leg = t.legGeoms[legIdx];
            const uLeg = (sTotal - acc) / leg.leg.tof_d;
            const fi = Math.min(1, uLeg) * (leg.N - 1);
            const i0 = Math.floor(fi), i1 = Math.min(leg.N - 1, i0 + 1);
            const tau = fi - i0;
            const ax = leg.arcPos;
            t.craft.position.set(
                ax[i0*3+0]*(1-tau) + ax[i1*3+0]*tau,
                ax[i0*3+1]*(1-tau) + ax[i1*3+1]*tau,
                ax[i0*3+2]*(1-tau) + ax[i1*3+2]*tau,
            );
            pushTrail(t, t.craft.position);
        }
    }

    function deployNearEarthPayload(r) {
        const p = new THREE.Mesh(
            new THREE.SphereGeometry(0.025, 16, 12),
            new THREE.MeshBasicMaterial({ color: 0x66ffaa }),
        );
        geo.scene.add(p);
        const ring = makeOrbitRingFromBasis(
            r.rOrbit, r.ascNode,
            r.ascNode.clone().applyAxisAngle(r.planeNormal, Math.PI/2),
            0x66ffaa, 0.4,
        );
        geo.scene.add(ring);
        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(400*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
            color: 0x66ffaa, transparent: true, opacity: 0.6,
        }));
        geo.scene.add(trail);

        const r_km = r.target.alt_km + R_EARTH;
        const period_s = 2 * Math.PI * Math.sqrt(Math.pow(r_km, 3) / 398600.4418);
        const visualPeriod = Math.max(4, Math.min(45, period_s / 900));
        const omega = (2 * Math.PI) / visualPeriod;

        // Inherit the rocket's mission id so the deploy doesn't fragment
        // the telemetry — the rocket and its payload are the same mission
        // from the user's perspective.
        state.payloads.push({
            id: r.id,
            kind: 'payload',
            mesh: p, ring,
            trail, trailGeom, trailIndex: 0,
            r: r.rOrbit, theta: 0, omega,
            ascNode: r.ascNode.clone(),
            planeNormal: r.planeNormal.clone(),
            payloadName: r.payloadName,
            target: r.target,
            startedAt: state.elapsed,
        });

        onEvent?.({
            type: 'deployed',
            payloadName: r.payloadName,
            target: r.target,
            orbit: {
                alt_km: r.target.alt_km,
                inc_deg: r.inc,
                period_min: period_s / 60,
                v_circ_kms: Math.sqrt(398600.4418 / r_km),
            },
        });
    }

    // ── Trail helpers (shared) ──────────────────────────────────────────────
    function makeTrail(scene, capacity, color, opacity) {
        const trailGeom = new THREE.BufferGeometry();
        trailGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity*3), 3));
        trailGeom.setDrawRange(0, 0);
        const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
            color, transparent: true, opacity,
        }));
        scene.add(trail);
        return { trail, trailGeom, trailIndex: 0, trailCap: capacity };
    }

    function pushTrail(obj, pos) {
        const i = obj.trailIndex;
        if (i >= obj.trailCap) return;
        const arr = obj.trailGeom.attributes.position.array;
        arr[i*3+0] = pos.x; arr[i*3+1] = pos.y; arr[i*3+2] = pos.z;
        obj.trailIndex = i + 1;
        obj.trailGeom.setDrawRange(0, obj.trailIndex);
        obj.trailGeom.attributes.position.needsUpdate = true;
    }

    function pushOrbitTrail(p) {
        const N = p.trailGeom.attributes.position.array.length / 3;
        const i = p.trailIndex % N;
        const arr = p.trailGeom.attributes.position.array;
        arr[i*3+0] = p.mesh.position.x;
        arr[i*3+1] = p.mesh.position.y;
        arr[i*3+2] = p.mesh.position.z;
        p.trailIndex++;
        p.trailGeom.setDrawRange(0, Math.min(p.trailIndex, N));
        p.trailGeom.attributes.position.needsUpdate = true;
    }

    // ── Resize ──────────────────────────────────────────────────────────────
    const ro = new ResizeObserver(() => {
        const cw = w(), ch = h();
        renderer.setSize(cw, ch);
        world.camera.aspect = cw / ch; world.camera.updateProjectionMatrix();
    });
    ro.observe(container);

    // ── Earth-system off-thread propagator ──────────────────────────────────
    // Bridges to js/earth-sim-worker.js, which propagates Moon, Phobos,
    // Deimos, and Earth heliocentric in deterministic Keplerian form and
    // returns a transferable Float32Array buffer plus an FNV-1a hash. We
    // surface the latest hash + window + residual to the host page (mission-
    // planner.html) for ground-truth verification.
    const earthBridge = new EarthSimBridge();
    const earthBridgeStatus = {
        ready:   false,
        status:  'spawning…',
        hash:    null,
        window_s:null,
        dt_s:    null,
        count:   null,
        residualKm: NaN,
        // The planner's on-screen Moon comes from Meeus chapter 47
        // (moonGeocentric) — geocentric ecliptic spherical coords. The worker
        // emits parent-equatorial Cartesian km from Keplerian elements. The
        // residual is therefore the cross-model disagreement at the same JD
        // (~thousands of km is normal); a *change* in the residual at fixed
        // JD between page-loads would indicate a determinism failure.
        residualSrc: 'meeus_vs_kepler',
    };
    earthBridge.onUpdate = (s) => {
        earthBridgeStatus.ready    = true;
        earthBridgeStatus.status   = `live · ${s.count} samples`;
        earthBridgeStatus.hash     = s.hash;
        earthBridgeStatus.dt_s     = s.dt_s;
        earthBridgeStatus.count    = s.count;
        earthBridgeStatus.window_s = s.dt_s * (s.count - 1);
    };
    earthBridge.onError = (err) => {
        earthBridgeStatus.status = 'unavailable';
        // eslint-disable-next-line no-console
        console.warn('[mission-planner-3d] earth-sim worker unavailable:', err);
    };

    function _updateEarthBridgeResidual() {
        const truth = earthBridge.sample(state.scenarioJD);
        if (!truth) return;
        // Convert Meeus geocentric ecliptic (lon, lat, dist_km) to a Cartesian
        // vector in km. The worker's parent-equatorial frame is rotated from
        // the ecliptic by Earth's obliquity (≈23.44°); we apply the inverse
        // here so both vectors live in the *same* frame before subtraction.
        const m  = moonGeocentric(state.scenarioJD);
        const cl = Math.cos(m.lat_rad);
        const ex = m.dist_km * cl * Math.cos(m.lon_rad);
        const ey = m.dist_km * cl * Math.sin(m.lon_rad);
        const ez = m.dist_km * Math.sin(m.lat_rad);
        // Rotate ecliptic → Earth equator about the X axis by +obliquity.
        const obliq = 23.4393 * Math.PI / 180;
        const cT = Math.cos(obliq), sT = Math.sin(obliq);
        const eqx = ex;
        const eqy = ey * cT + ez * sT;
        const eqz = -ey * sT + ez * cT;
        const dx = truth.moon[0] - eqx;
        const dy = truth.moon[1] - eqy;
        const dz = truth.moon[2] - eqz;
        earthBridgeStatus.residualKm = Math.hypot(dx, dy, dz);
    }

    // ── Camera follow + animated transitions ────────────────────────────
    // The previous one-shot focus presets snapped the camera to a body's
    // position at click time — but every body except the Sun is moving
    // (Earth orbits the Sun once a year in scene coords, the Moon orbits
    // Earth, Mars drifts heliocentrically). So the framing was lost
    // within a few seconds of clicking. The new system:
    //
    //   1. flyCameraTo() animates the camera + OrbitControls target along
    //      a cubic ease toward an offset relative to the body. Because the
    //      offset is re-evaluated against the body's current world position
    //      each frame, the animation lands cleanly even while the body
    //      drifts.
    //   2. After the animation, follow.getter is set to the body's
    //      world-position function. Each subsequent frame, both the
    //      camera and the OrbitControls target are translated by the
    //      body's per-frame delta. The user can still orbit / zoom freely
    //      because their input modifies the offset relative to the target.
    //   3. minDistance / maxDistance are updated to match the body so the
    //      user can zoom close to small bodies (Moon at 0.27 R⊕, Mars at
    //      0.53 R⊕) without OrbitControls clamping them out.
    const followState = {
        getter: null,                          // () → THREE.Vector3 (body's world pos)
        lastPos: new THREE.Vector3(),
        anim:    null,                         // active animation (see flyCameraTo)
        name:    'earth',                      // current focus label, drives HUD readout
        // The most recent body-tracking getter, retained even when the user
        // drops into 'free' mode, so a subsequent Lock can re-engage the same
        // focus without re-animating. Cleared explicitly via setFreeCam(true).
        lastGetter: null,
        lastName:   'earth',
    };

    function flyCameraTo({
        getTargetPos,                          // () → Vector3 of body to focus
        offset,                                // Vector3 from body to camera
        dur     = 0.85,                        // seconds
        minDist = null,                        // OrbitControls clamp post-animation
        maxDist = null,
        follow  = true,                        // track body after animation completes
        name    = null,                        // focus label (HUD)
    }) {
        if (name) followState.name = name;
        followState.anim = {
            fromPos:    world.camera.position.clone(),
            fromTarget: world.controls.target.clone(),
            getTargetPos,
            offset:     offset.clone(),
            t0:         performance.now() / 1000,
            dur,
            minDist, maxDist, follow,
        };
    }

    function updateCameraSystem() {
        const a = followState.anim;
        if (a) {
            // First tick: relax the OrbitControls distance clamp so the
            // lerped camera position isn't snapped back when crossing
            // body-radius boundaries (e.g., flying from Earth orbit to
            // Mars hover, where the per-body minDistance differs).
            if (!a.clampRelaxed) {
                a.savedMin = world.controls.minDistance;
                a.savedMax = world.controls.maxDistance;
                world.controls.minDistance = 1e-3;
                world.controls.maxDistance = HELIO_MAX;
                a.clampRelaxed = true;
            }
            const t = (performance.now() / 1000 - a.t0) / a.dur;
            const u = Math.min(1, Math.max(0, t));
            const e = easeInOutCubic(u);
            const curTarget = a.getTargetPos();
            const curCam    = curTarget.clone().add(a.offset);
            world.camera.position.lerpVectors(a.fromPos, curCam, e);
            world.controls.target.lerpVectors(a.fromTarget, curTarget, e);
            if (u >= 1) {
                world.controls.minDistance = a.minDist != null ? a.minDist : a.savedMin;
                world.controls.maxDistance = a.maxDist != null ? a.maxDist : a.savedMax;
                if (a.follow) {
                    followState.getter      = a.getTargetPos;
                    followState.lastGetter  = a.getTargetPos;
                    followState.lastName    = followState.name;
                    followState.lastPos.copy(curTarget);
                } else {
                    followState.getter = null;
                }
                followState.anim = null;
            }
            return;
        }
        if (followState.getter) {
            const cur = followState.getter();
            const dx = cur.x - followState.lastPos.x;
            const dy = cur.y - followState.lastPos.y;
            const dz = cur.z - followState.lastPos.z;
            if (dx*dx + dy*dy + dz*dz > 1e-12) {
                world.camera.position.x += dx;
                world.camera.position.y += dy;
                world.camera.position.z += dz;
                world.controls.target.x  += dx;
                world.controls.target.y  += dy;
                world.controls.target.z  += dz;
                followState.lastPos.copy(cur);
            }
        }
    }

    // Place the camera on the SUN-LIT side of the body. dirToSun = -bodyPos
    // normalized (since the Sun sits at scene origin). The lit hemisphere
    // faces the Sun, so we want the camera between the Sun and the body
    // (with a slight upward + sideways offset for a 3/4 view).
    function sunLitOffset(bodyPos, distance) {
        const sunward = bodyPos.clone();
        if (sunward.lengthSq() < 1e-6) sunward.set(-1, 0, 0);
        sunward.normalize().multiplyScalar(-1);                 // body → Sun
        // Sideways perpendicular to sunward and ecliptic up.
        const side = new THREE.Vector3(0, 1, 0).cross(sunward);
        if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
        side.normalize();
        // Mix: 60% toward Sun, 50% sideways, 35% above ecliptic.
        return sunward.multiplyScalar(distance * 0.6)
            .add(side.multiplyScalar(distance * 0.5))
            .add(new THREE.Vector3(0, distance * 0.4, 0));
    }

    // Focus presets — these now drive flyCameraTo so transitions are smooth
    // and bodies stay framed as they drift. minDistance is set per-body so
    // the user can fly close to small bodies (Moon 0.27 R⊕, Mars 0.53 R⊕).
    const SUN_MIN  = 80;
    const HELIO_MAX = 50.0 * AU_TO_SCENE;

    function focusEarth() {
        const getEarth = () => world.earthSystem.position.clone();
        flyCameraTo({
            getTargetPos: getEarth,
            offset:       sunLitOffset(getEarth(), 5.5),
            minDist:      1.05,
            maxDist:      HELIO_MAX,
            name:         'earth',
        });
    }
    function focusMoon() {
        const getMoon = () => {
            const v = new THREE.Vector3();
            world.moon.getWorldPosition(v);
            return v;
        };
        const earthPos = world.earthSystem.position;
        const sunward = earthPos.clone();
        if (sunward.lengthSq() < 1e-6) sunward.set(-1, 0, 0);
        sunward.normalize().multiplyScalar(-1);
        const offset = sunward.multiplyScalar(0.6)
            .add(new THREE.Vector3(0, 0.45, 0))
            .normalize().multiplyScalar(MOON_R_SCENE * 8);
        flyCameraTo({
            getTargetPos: getMoon,
            offset,
            minDist:      MOON_R_SCENE * 1.15,
            maxDist:      HELIO_MAX,
            name:         'moon',
        });
    }
    function focusMars()    { _focusPlanet(hel.mars,    hel.planets.mars.realRadius,    'mars'); }
    function focusMercury() { _focusPlanet(hel.mercury, hel.planets.mercury.realRadius, 'mercury'); }
    function focusVenus()   { _focusPlanet(hel.venus,   hel.planets.venus.realRadius,   'venus'); }
    function focusJupiter() { _focusPlanet(hel.jupiter, hel.planets.jupiter.realRadius, 'jupiter'); }
    function focusSaturn()  { _focusPlanet(hel.saturn,  hel.planets.saturn.realRadius,  'saturn'); }
    function focusUranus()  { _focusPlanet(hel.uranus,  hel.planets.uranus.realRadius,  'uranus'); }
    function focusNeptune() { _focusPlanet(hel.neptune, hel.planets.neptune.realRadius, 'neptune'); }
    function _focusPlanet(group, realR, name) {
        const distance = realR * 6;             // pull back to fit body + halo
        const minDist  = realR * 1.05;
        flyCameraTo({
            getTargetPos: () => group.position.clone(),
            offset:       sunLitOffset(group.position, distance),
            minDist,
            maxDist:      HELIO_MAX,
            name,
        });
    }
    function focusSun() {
        flyCameraTo({
            getTargetPos: () => new THREE.Vector3(0, 0, 0),
            offset:       new THREE.Vector3(0, 0.5 * AU_TO_SCENE, 1.0 * AU_TO_SCENE),
            minDist:      SUN_MIN,
            maxDist:      HELIO_MAX,
            follow:       false,
            name:         'sun',
        });
    }
    function focusSystem() {
        flyCameraTo({
            getTargetPos: () => new THREE.Vector3(0, 0, 0),
            offset:       new THREE.Vector3(0, 1.5 * AU_TO_SCENE, 2.5 * AU_TO_SCENE),
            minDist:      SUN_MIN,
            maxDist:      HELIO_MAX,
            follow:       false,
            name:         'system',
        });
    }
    function focusOuterSystem() {
        flyCameraTo({
            getTargetPos: () => new THREE.Vector3(0, 0, 0),
            offset:       new THREE.Vector3(0, 22 * AU_TO_SCENE, 38 * AU_TO_SCENE),
            minDist:      SUN_MIN,
            maxDist:      HELIO_MAX,
            follow:       false,
            name:         'outer',
        });
    }

    // ── Follow an active mission (chase camera) ─────────────────────────
    // Picks the most-recently-launched active spacecraft (or one passed
    // explicitly) and tracks its world position. Useful while watching an
    // ascent rocket leave the pad, a lunar transfer cross to the Moon, or
    // a Mars cruise sweep through a Lambert arc. Distance is set small so
    // the spacecraft stays visible as a discrete object rather than a dot.
    //
    // Returns the followed mission object (with .payloadName, .kind) so
    // the UI can show "Following: <name>", or null if no active missions.
    function pickActiveMission() {
        const allActive = [
            ...state.rockets      .filter(r => r.phase === 'ascent'),
            ...state.lunarMissions.filter(m => m.phase !== 'arrived'),
            ...state.marsMissions .filter(m => m.phase !== 'arrived'),
            ...state.tours        .filter(t => t.phase !== 'arrived'),
            ...state.payloads,    // deployed orbiters keep cycling
        ];
        if (!allActive.length) return null;
        // Most recent first.
        allActive.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
        return allActive[0];
    }
    function followMission(mission) {
        const m = mission || pickActiveMission();
        if (!m) return null;
        const id = m.id;
        // Track by mission ID rather than caching an Object3D — that way
        // when an ascent rocket deploys its payload, the chase cam auto-
        // redirects to the orbiting craft instead of staring at the
        // parked booster.
        const resolveObj = () => {
            const payload = state.payloads.find(p => p.id === id);
            if (payload) return payload.mesh || payload.craft || payload.group;
            const cur = _allMissions().find(x => x.id === id);
            return cur ? (cur.craft || cur.group || cur.mesh) : null;
        };
        // Chase from above + sideways at a fixed 3 R⊕ box: small enough
        // for an Earth-relative ascent to fill the frame, big enough on
        // a heliocentric arc to keep the trail visible.
        const offset = new THREE.Vector3(2.0, 1.5, 2.0);
        flyCameraTo({
            getTargetPos: () => {
                const obj = resolveObj();
                const v = new THREE.Vector3();
                if (obj) obj.getWorldPosition(v);
                return v;
            },
            offset,
            minDist: 0.05,        // ≈ 320 km when zooming in
            maxDist: HELIO_MAX,
            name:    'mission',
        });
        return m;
    }

    // ── Generic "fly to body by name" — used by click-to-focus and the
    //     keyboard shortcuts. Routes to the appropriate focus function. ──
    function flyToBody(name) {
        switch (name) {
            case 'sun':      focusSun();          return;
            case 'mercury':  focusMercury();      return;
            case 'venus':    focusVenus();        return;
            case 'earth':    focusEarth();        return;
            case 'moon':     focusMoon();         return;
            case 'mars':     focusMars();         return;
            case 'jupiter':  focusJupiter();      return;
            case 'saturn':   focusSaturn();       return;
            case 'uranus':   focusUranus();       return;
            case 'neptune':  focusNeptune();      return;
            case 'system':   focusSystem();       return;
            case 'outer':    focusOuterSystem();  return;
        }
    }

    // ── Click-to-focus on planets / Sun ─────────────────────────────────
    // A click on the canvas fires a raycaster from the camera through the
    // pixel and intersects against every focusable body. Walking up the
    // parent chain of the closest hit lets us figure out which body was
    // clicked even though planets are nested groups (group → surface →
    // mesh). Resolved name is then routed through flyToBody so all entry
    // points (UI buttons, keyboard, click) share one camera pipeline.
    const focusables = [
        { obj: world.sun,            name: 'sun'     },
        { obj: world.earthSystem,    name: 'earth'   },
        { obj: world.moon,           name: 'moon'    },
        { obj: world.planets.mercury.group, name: 'mercury' },
        { obj: world.planets.venus.group,   name: 'venus'   },
        { obj: world.planets.mars.group,    name: 'mars'    },
        { obj: world.planets.jupiter.group, name: 'jupiter' },
        { obj: world.planets.saturn.group,  name: 'saturn'  },
        { obj: world.planets.uranus.group,  name: 'uranus'  },
        { obj: world.planets.neptune.group, name: 'neptune' },
    ];
    const _raycaster = new THREE.Raycaster();
    const _mouse     = new THREE.Vector2();
    let   _mouseDown = null;
    renderer.domElement.addEventListener('pointerdown', (ev) => {
        // Track press position so a click that's actually a drag (orbit)
        // doesn't accidentally trigger a focus change.
        _mouseDown = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    });
    renderer.domElement.addEventListener('pointerup', (ev) => {
        if (!_mouseDown) return;
        const dx = ev.clientX - _mouseDown.x;
        const dy = ev.clientY - _mouseDown.y;
        const dt = performance.now() - _mouseDown.t;
        _mouseDown = null;
        if (dx*dx + dy*dy > 25 || dt > 400) return;   // drag, not click
        const rect = renderer.domElement.getBoundingClientRect();
        _mouse.x =  ((ev.clientX - rect.left) / rect.width)  * 2 - 1;
        _mouse.y = -((ev.clientY - rect.top)  / rect.height) * 2 + 1;
        _raycaster.setFromCamera(_mouse, world.camera);
        const objs = focusables.map(f => f.obj);
        const hits = _raycaster.intersectObjects(objs, true);
        if (!hits.length) return;
        // Walk parent chain to find which top-level focusable owns the hit.
        let node = hits[0].object;
        while (node) {
            const f = focusables.find(f => f.obj === node);
            if (f) {
                flyToBody(f.name);
                onEvent?.({ type: 'focus', target: f.name });
                return;
            }
            node = node.parent;
        }
    });

    // ── Public state for the UI: name + live distance of the focused body
    //     so the HUD can render a "Focused: Mars (1.42 AU)" indicator. The
    //     distance is camera-to-target, computed live so the readout
    //     ticks down as the user zooms in. ────────────────────────────────
    function getFocusInfo() {
        const target = followState.getter ? followState.getter() : world.controls.target;
        return {
            name:           followState.name,
            distance_units: world.camera.position.distanceTo(target),
        };
    }

    // ── Fly to a specific launch pad on its parent body ─────────────────
    // The camera follows the BODY CENTER (not the rotating pad) at a close
    // hover-distance, with the initial radial offset chosen so the pad is
    // centered in the frame at arrival. As the planet spins, the pad
    // sweeps past the view (this feels right — like watching a launch site
    // turn around the limb), and the body's heliocentric drift is handled
    // by the follow translation. We don't track the pad's per-frame
    // rotation because rotating the camera with the planet would make the
    // surface look static and the framing disorienting at close zoom.
    function flyToPad(body, padId) {
        const key = `${body}:${padId}`;
        const marker = padMarkers.get(key);
        if (!marker) return;
        let radius, getCenter;
        if (body === 'earth') {
            radius    = 1.0;
            getCenter = () => world.earthSystem.position.clone();
        } else if (body === 'moon') {
            radius    = MOON_R_SCENE;
            getCenter = () => {
                const v = new THREE.Vector3();
                world.moon.getWorldPosition(v);
                return v;
            };
        } else if (body === 'mars') {
            radius    = hel.planets.mars.realRadius;
            getCenter = () => hel.mars.position.clone();
        } else {
            return;
        }
        // Distance from body center: surface is at `radius`, hover above
        // surface at radius * 1.6 (so ~60% of body radius above ground —
        // close enough to read the pad, far enough to see context).
        const distance = radius * 1.6;
        const minDist  = radius * 1.02;
        // Direction from body center through the pad, at this instant.
        const padWorld = new THREE.Vector3();
        marker.getWorldPosition(padWorld);
        const radialOut = padWorld.clone().sub(getCenter());
        if (radialOut.lengthSq() < 1e-9) radialOut.set(0, 1, 0);
        radialOut.normalize();
        // Add a slight upward tilt so we look down at the surface, not
        // straight at the limb.
        const offset = radialOut.multiplyScalar(distance)
            .add(new THREE.Vector3(0, radius * 0.3, 0));
        flyCameraTo({
            getTargetPos: getCenter,
            offset,
            minDist,
            maxDist: HELIO_MAX,
            name:    body,         // pad's parent body drives HUD label
        });
    }

    // Seed initial body positions (zero-dt update so earthSystem.position
    // reflects today's heliocentric Earth before first render). The
    // initial framing is set directly (no animation) so the user lands on
    // Earth instantly when the page loads.
    updateEarthSystem(0);
    updateHelio(0);
    {
        const eP = world.earthSystem.position;
        const offset = sunLitOffset(eP, 5.5);
        world.controls.target.copy(eP);
        world.camera.position.copy(eP).add(offset);
        world.controls.minDistance = 1.05;
        world.controls.maxDistance = HELIO_MAX;
        followState.getter     = () => world.earthSystem.position.clone();
        followState.lastGetter = followState.getter;
        followState.lastName   = 'earth';
        followState.lastPos.copy(eP);
    }

    // ── Camera mode (free / lock) ────────────────────────────────────────────
    // 'lock' (default): followState.getter is set, so the camera tracks the
    //                   most recently focused body and the user can orbit /
    //                   zoom freely around it.
    // 'free':           getter is nulled — OrbitControls operates on a static
    //                   target wherever the user last left it.
    //
    // Toggling Free → Lock re-uses `followState.lastGetter` (the most recent
    // body-tracking function), seeding `lastPos` to the body's current world
    // position so the first follow frame is jitter-free.
    function setFreeCam(forget = false) {
        followState.getter = null;
        if (forget) {
            followState.lastGetter = null;
            followState.lastName   = null;
        }
    }
    function lockCurrentFocus() {
        const g = followState.lastGetter;
        if (!g) return false;
        followState.getter = g;
        followState.lastPos.copy(g());
        if (followState.lastName) followState.name = followState.lastName;
        return true;
    }
    function getCameraMode() {
        return followState.getter ? 'lock' : 'free';
    }

    requestAnimationFrame(tick);

    return {
        launch,
        setMode,
        getMode: () => state.mode,
        setTimeScale: (x) => {
            state.timeScale = Math.max(0, Math.min(50, x));
            _resetSimAnchor();
        },
        getTimeScale: () => state.timeScale,
        setSimDaysPerSec: (x) => {
            state.simDaysPerSec = Math.max(0, x);
            _resetSimAnchor();
        },
        clear: () => clearAll(state, geo, hel),
        focusEarth,
        focusMoon,
        focusMars,
        focusMercury,
        focusVenus,
        focusJupiter,
        focusSaturn,
        focusUranus,
        focusNeptune,
        focusSun,
        focusSystem,
        focusOuterSystem,
        flyToBody,
        flyToPad,
        followMission,
        getFocusInfo,
        // Auto-frame on launch (default ON) — chase the new spacecraft.
        setAutoFrame,
        getAutoFrame,
        // Mission telemetry — the UI calls these every tick to drive the
        // live "Active Mission" HUD card.
        listActiveMissions,
        getMissionDetail,
        // Time-warp: jump to the next mission arrival / phase transition.
        getNextEvent,
        skipToNextEvent,
        // Pad weather scaffold — colored ring on each pad marker, Launch
        // button gating, "wait for window" surfacing. Live data lands later.
        setPadWeather,
        getPadWeather,
        listPadWeather,
        WEATHER_STATUSES,
        WEATHER_COLORS,
        // Lightning + convective radar overlays. The feed module pushes
        // strikes / NWS alerts here; the planner just renders them on
        // the spinning Earth mesh. Toggle visibility via setRadarOverlay.
        setLightningStrikes,
        setConvectiveAlerts,
        setRadarOverlay,
        getRadarOverlay,
        getStats: () => ({
            rockets:        state.rockets.length,
            payloads:       state.payloads.length,
            lunarMissions:  state.lunarMissions.length,
            marsMissions:   state.marsMissions.length,
            tours:          state.tours.length,
        }),
        getScenarioJD: () => state.scenarioJD,
        setScenarioJD: (jd) => {
            // Clamp manual jumps inside the sim window so the user can't
            // jam the clock past the end-of-window guard.
            let clamped = jd;
            if (Number.isFinite(state.simStartJD)) clamped = Math.max(state.simStartJD, clamped);
            if (Number.isFinite(state.simEndJD))   clamped = Math.min(state.simEndJD,   clamped);
            state.scenarioJD = clamped;
            // Scrubbing back inside the window clears the bound-flag so a
            // subsequent edge-hit re-fires the toast.
            state.simBoundHit = null;
            _resetSimAnchor();
        },
        // Sim window — start/end JD bounds for the scenario clock. Either
        // value may be null to disable that side's clamp. The current
        // scenarioJD is re-clamped inside the new bounds.
        setSimBounds: (startJD, endJD) => {
            state.simStartJD = Number.isFinite(startJD) ? startJD : null;
            state.simEndJD   = Number.isFinite(endJD)   ? endJD   : null;
            if (Number.isFinite(state.simStartJD) && state.scenarioJD < state.simStartJD) {
                state.scenarioJD = state.simStartJD;
            }
            if (Number.isFinite(state.simEndJD) && state.scenarioJD > state.simEndJD) {
                state.scenarioJD = state.simEndJD;
            }
            state.simBoundHit = null;
            _resetSimAnchor();
        },
        getSimBounds: () => ({
            startJD: state.simStartJD,
            endJD:   state.simEndJD,
            hit:     state.simBoundHit,
        }),
        // Camera mode — free / lock. Lock re-engages tracking on the most
        // recently focused body without re-animating; free leaves the camera
        // static at its current target. The focus presets (focusEarth, etc.)
        // implicitly set lock.
        setFreeCam,
        lockCurrentFocus,
        getCameraMode,
        // Earth-system off-thread propagator status — surfaced to the host
        // page for ground-truth verification (worker hash + residual readout).
        getEarthBridgeStatus: () => ({
            ready:      earthBridgeStatus.ready,
            status:     earthBridgeStatus.status,
            hash:       earthBridgeStatus.hash,
            window_s:   earthBridgeStatus.window_s,
            dt_s:       earthBridgeStatus.dt_s,
            count:      earthBridgeStatus.count,
            residualKm: earthBridgeStatus.residualKm,
            residualSrc: earthBridgeStatus.residualSrc,
        }),
        // Trajectory planners — also useful from the UI for read-only previews.
        planLunar:        planLunarTransfer,
        planLunarLambert,
        planMars:         planMarsTransfer,
        planMarsLambert,
        planMarsToEarthLambert,
        planMoonToMarsLambert,
        planMoonToEarthLambert,
        planEarthToOuterLambert,
        findLunarWindow:  findLunarLaunchWindow,
        findMarsWindow:   findMarsLaunchWindow,
        porkchopMars,
        porkchop,
        // Per-target labels (insertion abbreviations + symbol/name) — used
        // by the HTML log + plan readout for consistent wording.
        INSERTION_LABELS, PLANET_DISPLAY,
        // Tour planning
        planTour, optimizeTour, TOUR_PRESETS,
        launchTour: (opts) => launchTour(opts),
        // Gravity-assist primitives (exposed for didactic UI uses)
        flybyAssessment, flybyMaxTurnAngle, flybyPeriapsisForTurn,
        // Frame profiler — host page toggles this on for the on-screen perf
        // HUD. While disabled, the measure() wrappers in the tick are no-ops.
        setPerfEnabled: (v) => prof.enable(v),
        isPerfEnabled:  () => prof.enabled,
        getPerfSnapshot: () => prof.snapshot(),
    };
}

// ── Unified scene builder ───────────────────────────────────────────────────
// Single Scene with: Sun at origin, inner-planet orrery groups at their
// heliocentric positions (Mercury / Venus / Mars), and an `earthSystem`
// Group that is parked at Earth's heliocentric scene position each frame.
// Inside earthSystem live the textured Earth, atmosphere, Moon, and all
// Earth-relative trajectories. The renderer's logarithmic depth buffer
// lets the camera roam from 1.4 R⊕ (just outside Earth) to ~200 000 R⊕
// (well past Saturn's orbit) without z-fighting.
function buildWorldScene(renderer, w, h) {
    const scene  = new THREE.Scene();
    scene.background = new THREE.Color(0x02010a);

    const camera = new THREE.PerspectiveCamera(45, w/h, 0.05, 1e8);
    camera.position.set(3.5, 2.4, 4.6);    // overridden by initial focusEarth

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.minDistance = 1.4;
    controls.maxDistance = 35.0 * AU_TO_SCENE;    // past Neptune (~30 AU)

    scene.add(new THREE.AmbientLight(0x303048, 0.45));
    // Starfield must enclose the whole solar system, including Neptune
    // at 30 AU; bump the radius so the user never flies past the stars.
    addStarfield(scene, 3200, 50 * AU_TO_SCENE);

    // ── Sun: photosphere + corona shells + lens flare + PointLight ─────────
    const SUN_R = 70;  // ~64% of real Sun radius (109 R⊕); plenty visible
    const sun = new THREE.Mesh(
        new THREE.SphereGeometry(SUN_R, 32, 24),
        new THREE.MeshBasicMaterial({ color: 0xfff0c8 }),
    );
    scene.add(sun);
    const sunGlow = new THREE.Group();
    for (const [scl, op, col] of [
        [1.30, 0.45, 0xffd06c],
        [1.85, 0.22, 0xffa040],
        [3.00, 0.10, 0xff7022],
        [5.50, 0.04, 0xcc5511],
    ]) {
        sunGlow.add(new THREE.Mesh(
            new THREE.SphereGeometry(SUN_R * scl, 32, 24),
            new THREE.MeshBasicMaterial({
                color: col, transparent: true, opacity: op,
                side: THREE.BackSide, blending: THREE.AdditiveBlending,
                depthWrite: false,
            }),
        ));
    }
    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffe09a, 0.55),
        transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
    }));
    flare.scale.set(SUN_R * 8, SUN_R * 8, 1);
    sunGlow.add(flare);
    scene.add(sunGlow);
    // Single PointLight at Sun origin lights every body in the scene.
    const sunLight = new THREE.PointLight(0xffeec8, 1.6, 0, 0);
    scene.add(sunLight);

    const sunLabel = makeBodyLabel('Sun', '#ffe', 1.4);
    sunLabel.position.set(0, SUN_R * 1.6, 0);
    scene.add(sunLabel);

    // ── Heliocentric orbit rings (Mercury through Neptune) ─────────────────
    const orbits = [
        { r:  0.387 * AU_TO_SCENE, color: 0x886655 },   // Mercury
        { r:  0.723 * AU_TO_SCENE, color: 0xc8b88a },   // Venus
        { r:  1.000 * AU_TO_SCENE, color: 0x4488cc },   // Earth
        { r:  1.524 * AU_TO_SCENE, color: 0xc05530 },   // Mars
        { r:  5.203 * AU_TO_SCENE, color: 0xd4a060 },   // Jupiter
        { r:  9.537 * AU_TO_SCENE, color: 0xd9c97a },   // Saturn
        { r: 19.191 * AU_TO_SCENE, color: 0x9fd6e0 },   // Uranus
        { r: 30.069 * AU_TO_SCENE, color: 0x4f7adb },   // Neptune
    ];
    for (const o of orbits) scene.add(makeRingLine(o.r, o.color, 0.6));

    // ── Planets via procedural orrery skins ────────────────────────────────
    // Bodies are built at their REAL radii so that flying close (e.g.,
    // Olympia Base on Mars or a Saturn-ring grazer) shows correct relative
    // scale. From AU-scale viewing distance the meshes would be sub-pixel,
    // so the unified tick scales them up uniformly via applyPlanetLOD() to
    // maintain a minimum on-screen angular size. Stylised surface decals
    // (landing pads, beacons, Saturn's rings) scale with each planet group
    // so they read at every zoom.
    //
    // Real radii in R⊕ (R_EARTH = 6378.137 km):
    //   Mercury 2439.7  / 6378 = 0.382       Jupiter 69911 / 6378 = 10.96
    //   Venus   6051.8  / 6378 = 0.949       Saturn  58232 / 6378 =  9.13
    //   Mars    3389.5  / 6378 = 0.531       Uranus  25362 / 6378 =  3.98
    //                                        Neptune 24622 / 6378 =  3.86
    const MERCURY_R = 2439.7  / R_EARTH;
    const VENUS_R   = 6051.8  / R_EARTH;
    const MARS_R    = R_MARS  / R_EARTH;
    const JUPITER_R = 69911   / R_EARTH;
    const SATURN_R  = 58232   / R_EARTH;
    const URANUS_R  = 25362   / R_EARTH;
    const NEPTUNE_R = 24622   / R_EARTH;
    const mercuryP = makeOrreryPlanet('mercury', MERCURY_R, 0xaa9988);
    const venusP   = makeOrreryPlanet('venus',   VENUS_R,   0xffeebb);
    const marsP    = makeOrreryPlanet('mars',    MARS_R,    0xffaa77);
    const jupiterP = makeOrreryPlanet('jupiter', JUPITER_R, 0xd4a060);
    const saturnP  = makeOrreryPlanet('saturn',  SATURN_R,  0xd9c97a);
    const uranusP  = makeOrreryPlanet('uranus',  URANUS_R,  0x9fd6e0);
    const neptuneP = makeOrreryPlanet('neptune', NEPTUNE_R, 0x4f7adb);
    scene.add(
        mercuryP.group, venusP.group, marsP.group,
        jupiterP.group, saturnP.group, uranusP.group, neptuneP.group,
    );

    // Mars surface bases (Olympia Base, Jezero, Gale, Utopia) ride the
    // spinning Mars surface. Capture each marker group so flyToPad can
    // resolve a pad's live world position later.
    const marsBiomeMarkers = {};
    for (const biome of MARS_BIOMES) {
        marsBiomeMarkers[biome.id] = addMarsBiome(marsP.surface, MARS_R, biome);
    }

    const mercuryLabel = makeBodyLabel('Mercury', '#bba', 1.4);
    const venusLabel   = makeBodyLabel('Venus',   '#fec', 1.6);
    const marsLabel    = makeBodyLabel('Mars',    '#f96', 1.6);
    const jupiterLabel = makeBodyLabel('Jupiter', '#fda', 1.8);
    const saturnLabel  = makeBodyLabel('Saturn',  '#fec', 1.8);
    const uranusLabel  = makeBodyLabel('Uranus',  '#9fe', 1.6);
    const neptuneLabel = makeBodyLabel('Neptune', '#7af', 1.6);
    mercuryP.group.add(mercuryLabel); mercuryLabel.position.set(0, MERCURY_R * 1.8, 0);
    venusP.group.add(venusLabel);     venusLabel.position.set(0,  VENUS_R   * 1.8, 0);
    marsP.group.add(marsLabel);       marsLabel.position.set(0,   MARS_R    * 1.8, 0);
    jupiterP.group.add(jupiterLabel); jupiterLabel.position.set(0, JUPITER_R * 1.4, 0);
    saturnP.group.add(saturnLabel);   saturnLabel.position.set(0,  SATURN_R  * 2.6, 0);
    uranusP.group.add(uranusLabel);   uranusLabel.position.set(0,  URANUS_R  * 1.8, 0);
    neptuneP.group.add(neptuneLabel); neptuneLabel.position.set(0, NEPTUNE_R * 1.8, 0);

    // ── Earth System group (parented to scene root, repositioned each frame
    //     to Earth's heliocentric position by updateEarthSystem). ───────────
    const earthSystem = new THREE.Group();
    scene.add(earthSystem);

    const earthTilt = new THREE.Group();
    earthTilt.rotation.x = EARTH_OBLQ_RAD;
    earthSystem.add(earthTilt);

    const earthSkinU = createEarthUniforms(new THREE.Vector3(1, 0, 0));
    earthSkinU.u_aurora_on.value     = 0;
    earthSkinU.u_city_lights.value   = 1;
    earthSkinU.u_weather_on.value    = 0;
    earthSkinU.u_bump_strength.value = 0.8;
    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(1, 64, 48),
        new THREE.ShaderMaterial({
            vertexShader:   EARTH_VERT,
            fragmentShader: EARTH_FRAG,
            uniforms:       earthSkinU,
        }),
    );
    earthTilt.add(earth);
    loadEarthTextures(earthSkinU, null);

    const grid = new THREE.LineSegments(
        new THREE.WireframeGeometry(new THREE.SphereGeometry(1.002, 18, 12)),
        new THREE.LineBasicMaterial({ color: 0x335577, transparent: true, opacity: 0.12 }),
    );
    earth.add(grid);

    const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(1.045, 48, 32),
        new THREE.MeshBasicMaterial({
            color: 0x66aaff, transparent: true, opacity: 0.18,
            side: THREE.BackSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    earthTilt.add(atmo);

    // Halo billboard so Earth is visible from heliocentric distances.
    // sizeAttenuation:false keeps it at a constant ~5% screen-height size
    // regardless of camera zoom, so it doesn't overwhelm close-ups (where
    // the LOD-scaled Earth mesh + atmosphere dominate). depthTest stays on
    // so the halo sits behind the Earth mesh when the camera is close.
    const earthHalo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0x66aaff, 0),
        transparent: true, opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
    }));
    earthHalo.scale.set(0.05, 0.05, 1);
    earthSystem.add(earthHalo);

    const moon = new THREE.Mesh(
        new THREE.SphereGeometry(MOON_R_SCENE, 32, 24),
        new THREE.MeshPhongMaterial({ color: 0xb8b8b8, emissive: 0x333333 }),
    );
    earthSystem.add(moon);

    const moonBaseMarkers = {};
    for (const base of MOON_BASES) {
        moonBaseMarkers[base.id] = addMoonBiome(moon, MOON_R_SCENE, base);
    }

    const moonHalo = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xc0c0c8, 0),
        transparent: true, opacity: 0.45,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false,
    }));
    moonHalo.scale.set(0.025, 0.025, 1);
    moon.add(moonHalo);

    // Lunar mean-orbit ring (visual reference, equatorial).
    const moonRingMean = makeRingLine(384400 / R_EARTH, 0x444466, 0.35);
    earthSystem.add(moonRingMean);

    const earthLabel = makeBodyLabel('Earth', '#9cf', 1.6);
    earthLabel.position.set(0, 1.6, 0);
    earth.add(earthLabel);
    const moonLabel = makeBodyLabel('Moon', '#cdd');
    moonLabel.position.set(0, MOON_R_SCENE * 4, 0);
    moon.add(moonLabel);

    // Annotate each planet handle with its real radius so the LOD pass
    // can scale uniformly when the camera is far. Stored alongside the
    // existing {group, surface, uniforms, spin} so the orrery helpers
    // don't care.
    mercuryP.realRadius = MERCURY_R;
    venusP.realRadius   = VENUS_R;
    marsP.realRadius    = MARS_R;
    jupiterP.realRadius = JUPITER_R;
    saturnP.realRadius  = SATURN_R;
    uranusP.realRadius  = URANUS_R;
    neptuneP.realRadius = NEPTUNE_R;

    return {
        scene, camera, controls,
        earthSystem, earth, earthTilt, earthSkinU,
        grid, atmo, moon, earthHalo, moonHalo,
        sun, sunGlow, flare, sunLight,
        planets: {
            mercury: mercuryP, venus:   venusP,   mars:    marsP,
            jupiter: jupiterP, saturn:  saturnP,  uranus:  uranusP, neptune: neptuneP,
        },
        marsBiomeMarkers, moonBaseMarkers,
    };
}

// ── Visual-enhancement primitives ───────────────────────────────────────────

function makeRadialGradientTexture(rgbHex, edgeAlpha = 0) {
    const N = 128;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    const r = (rgbHex >> 16) & 0xff, g = (rgbHex >> 8) & 0xff, b = rgbHex & 0xff;
    const grad = ctx.createRadialGradient(N/2, N/2, 0, N/2, N/2, N/2);
    grad.addColorStop(0,    `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.4,  `rgba(${r},${g},${b},0.6)`);
    grad.addColorStop(1,    `rgba(${r},${g},${b},${edgeAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, N, N);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    return tex;
}

function makeBodyLabel(text, cssColor = '#ccddff', sizeMul = 1) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 32px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(text, 130, 34);
    ctx.fillStyle = cssColor;
    ctx.fillText(text, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.needsUpdate = true;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(0.42 * sizeMul, 0.105 * sizeMul, 1);
    return sprite;
}

/**
 * Procedural ring texture (white, with a soft outer glow). Used by the
 * pad-weather sprite so a single texture can be tinted to any status
 * color via SpriteMaterial.color. Cached at module scope so we share the
 * same GPU texture across every pad in the scene.
 */
let _weatherRingTexture = null;
function makeWeatherRingTexture() {
    if (_weatherRingTexture) return _weatherRingTexture;
    const N = 128;
    const c = document.createElement('canvas');
    c.width = c.height = N;
    const ctx = c.getContext('2d');
    // Soft outer glow (drawn first, behind the crisp ring).
    ctx.shadowColor = 'rgba(255,255,255,0.55)';
    ctx.shadowBlur  = 14;
    ctx.lineWidth   = 10;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(N/2, N/2, N * 0.40, 0, Math.PI * 2);
    ctx.stroke();
    // Crisp inner ring on top.
    ctx.shadowBlur  = 0;
    ctx.lineWidth   = 6;
    ctx.beginPath();
    ctx.arc(N/2, N/2, N * 0.40, 0, Math.PI * 2);
    ctx.stroke();
    _weatherRingTexture = new THREE.CanvasTexture(c);
    _weatherRingTexture.needsUpdate = true;
    return _weatherRingTexture;
}

/**
 * Camera-facing weather indicator that sits next to a pad marker. Color +
 * opacity track the pad's current weather status (go / caution / scrub /
 * unknown). depthTest is on so the ring properly occludes behind the
 * planet limb when on the far side, depthWrite off so the ring doesn't
 * occlude other transparent additive layers.
 */
function makeWeatherSprite(scale) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map:        makeWeatherRingTexture(),
        color:      WEATHER_COLORS.unknown,
        transparent: true,
        opacity:    WEATHER_RING_OPACITY.unknown,
        blending:   THREE.AdditiveBlending,
        depthWrite: false,
    }));
    sprite.scale.set(scale, scale, 1);
    sprite.userData.kind = 'pad-weather';
    return sprite;
}

/**
 * Update a marker's weather ring to a new status. Tints the sprite color
 * and opacity to match the WEATHER_COLORS / WEATHER_RING_OPACITY tables.
 * The marker group must have userData.weatherSprite set at construction
 * (every pad marker function does this).
 */
function applyMarkerWeather(markerGroup, status) {
    const s = WEATHER_STATUSES.includes(status) ? status : 'unknown';
    const sprite = markerGroup?.userData?.weatherSprite;
    if (!sprite) return;
    sprite.material.color.setHex(WEATHER_COLORS[s]);
    sprite.material.opacity = WEATHER_RING_OPACITY[s];
    sprite.material.needsUpdate = true;
}

/**
 * Plant a launch-site marker on the rotating Earth mesh.
 *
 * Renders a glowing orange dot tipped slightly off the surface, an additive
 * radial flare so it pops against night-side cities, and a canvas-sprite
 * label with the pad's name floating just outside the atmosphere shell.
 * The marker is parented to the Earth mesh, so it follows the planet's
 * axial tilt + diurnal spin and stays pinned to real lat/lon.
 */
function addLaunchSiteMarker(earthMesh, site) {
    const surface = latLonToVec3(site.lat, site.lon, 1.0);
    const up      = surface.clone().normalize();

    // Group all marker elements so callers can grab a single Object3D
    // reference (used by flyToPad for current world position).
    const group = new THREE.Group();

    // Small thin post connects the surface to the dot — sells the "this
    // pad is here" idea against the textured globe.
    const postLen = 0.06;
    const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.004, 0.004, postLen, 6),
        new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85 }),
    );
    post.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
    post.position.copy(up.clone().multiplyScalar(1.0 + postLen * 0.5));
    group.add(post);

    const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffaa33 }),
    );
    dot.position.copy(up.clone().multiplyScalar(1.0 + postLen));
    group.add(dot);

    const flare = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffd07a, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    flare.position.copy(dot.position);
    flare.scale.set(0.13, 0.13, 1);
    group.add(flare);

    const label = makeBodyLabel(siteShortName(site), '#ffd6a0', 0.7);
    label.position.copy(up.clone().multiplyScalar(1.0 + postLen + 0.10));
    group.add(label);

    // Weather ring — sits a hair above the dot, default unknown/grey. The
    // mission-planner UI calls setPadWeather(...) to retint to go / caution
    // / scrub once the upcoming weather feed is wired up.
    const weather = makeWeatherSprite(0.085);
    weather.position.copy(up.clone().multiplyScalar(1.0 + postLen + 0.02));
    group.add(weather);
    group.userData.weatherSprite = weather;

    earthMesh.add(group);
    return group;
}

function siteShortName(site) {
    // Strip trailing country/agency tag like " (USA)" so the on-globe
    // label stays readable.
    return site.name.replace(/\s*\([^)]+\)\s*$/, '').trim();
}

/**
 * Plant a stylized colony "biome" on the Mars surface mesh.
 *
 * Visual stack:
 *   • Reddish landing pad (CircleGeometry) flush with the surface
 *   • Glowing orange pad ring (RingGeometry) so the site reads from orbit
 *   • Translucent habitat dome (open hemisphere, MeshPhong with emissive)
 *   • Small communications spire (slim cone) topped by a beacon sprite
 *   • Canvas-sprite name label floating above the dome
 *
 * Parented to the planet's spinning surface mesh, so the whole colony
 * inherits axial tilt + diurnal spin and stays pinned to its lat/lon.
 */
function addMarsBiome(marsSurface, planetRadius, biome) {
    const surfacePoint = latLonToVec3(biome.lat, biome.lon, planetRadius);
    const up           = surfacePoint.clone().normalize();

    const group = new THREE.Group();
    group.position.copy(surfacePoint);
    // Re-orient so the group's local +Y points along the local surface
    // normal — keeps the dome upright on the curved planet.
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    // Landing pad — flat reddish disc just above the regolith.
    const padR = planetRadius * 0.18;
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padR, 28),
        new THREE.MeshBasicMaterial({
            color: 0x553322, transparent: true, opacity: 0.95,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = planetRadius * 0.001;
    group.add(pad);

    // Glowing pad ring — additive so it pops on the night side.
    const padRing = new THREE.Mesh(
        new THREE.RingGeometry(padR, padR * 1.12, 36),
        new THREE.MeshBasicMaterial({
            color: 0xffaa44, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    padRing.rotation.x = -Math.PI / 2;
    padRing.position.y = planetRadius * 0.0015;
    group.add(padRing);

    // Habitat dome — open hemisphere so it reads as a structure even at
    // 1 px on screen. Slight emissive so it's visible against the night
    // side without needing extra lighting.
    const domeR = planetRadius * 0.10;
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(domeR, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhongMaterial({
            color: 0xddeeff, emissive: 0x113355, emissiveIntensity: 0.45,
            transparent: true, opacity: 0.55, shininess: 90,
            side: THREE.DoubleSide,
        }),
    );
    dome.position.y = planetRadius * 0.002;
    group.add(dome);

    // Comms spire + beacon sprite for visibility from orbit.
    const spire = new THREE.Mesh(
        new THREE.ConeGeometry(planetRadius * 0.006, planetRadius * 0.16, 6),
        new THREE.MeshBasicMaterial({ color: 0xeeccaa }),
    );
    spire.position.y = planetRadius * 0.18;
    group.add(spire);

    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0xffcc66, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    beacon.scale.set(planetRadius * 0.55, planetRadius * 0.55, 1);
    beacon.position.y = planetRadius * 0.27;
    group.add(beacon);

    // Name label
    const label = makeBodyLabel(biome.name, '#ffaa66', 0.7);
    label.position.y = planetRadius * 0.48;
    group.add(label);

    // Weather ring (camera-facing) above the colony, sized so it's
    // readable from orbit without overwhelming the dome at close zoom.
    const weather = makeWeatherSprite(planetRadius * 0.55);
    weather.position.y = planetRadius * 0.72;
    group.add(weather);
    group.userData.weatherSprite = weather;

    marsSurface.add(group);
    return group;
}

/**
 * Plant a lunar base on the Moon mesh in the geo scene. Same pattern as
 * addMarsBiome but greyscale so it reads against the lunar regolith. The
 * base is intentionally small in scene units (Moon is MOON_R_SCENE ≈ 0.27
 * units) so its sprite label is the part that actually reads from orbit.
 */
function addMoonBiome(moonMesh, planetRadius, base) {
    const surfacePoint = latLonToVec3(base.lat, base.lon, planetRadius);
    const up           = surfacePoint.clone().normalize();

    const group = new THREE.Group();
    group.position.copy(surfacePoint);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

    const padR = planetRadius * 0.13;

    // Reflective metallic landing pad.
    const pad = new THREE.Mesh(
        new THREE.CircleGeometry(padR, 24),
        new THREE.MeshBasicMaterial({
            color: 0x556677, transparent: true, opacity: 0.9,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = planetRadius * 0.001;
    group.add(pad);

    // Cyan additive ring — calls out the base on the dark lunar surface.
    const padRing = new THREE.Mesh(
        new THREE.RingGeometry(padR, padR * 1.15, 32),
        new THREE.MeshBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.85,
            side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
            depthWrite: false,
        }),
    );
    padRing.rotation.x = -Math.PI / 2;
    padRing.position.y = planetRadius * 0.0015;
    group.add(padRing);

    // Hab dome — translucent grey-blue.
    const dome = new THREE.Mesh(
        new THREE.SphereGeometry(planetRadius * 0.085, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshPhongMaterial({
            color: 0xbbcce0, emissive: 0x223344, emissiveIntensity: 0.5,
            transparent: true, opacity: 0.55, shininess: 100,
            side: THREE.DoubleSide,
        }),
    );
    dome.position.y = planetRadius * 0.001;
    group.add(dome);

    // Beacon for orbital visibility.
    const beacon = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(0x88ddff, 0),
        transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    beacon.scale.set(planetRadius * 0.7, planetRadius * 0.7, 1);
    beacon.position.y = planetRadius * 0.20;
    group.add(beacon);

    const label = makeBodyLabel(base.name, '#88ddff', 0.7);
    label.position.y = planetRadius * 0.55;
    group.add(label);

    // Weather ring — same scaffold as Mars/Earth pads. Lunar "weather"
    // is more about plasma / micrometeoroid environment + sun angle on
    // permanently-shadowed regions; the API doesn't care, it just takes
    // a status string from the future feed.
    const weather = makeWeatherSprite(planetRadius * 0.85);
    weather.position.y = planetRadius * 0.85;
    group.add(weather);
    group.userData.weatherSprite = weather;

    moonMesh.add(group);
    return group;
}

/**
 * Schematic B-plane visualisation at a flyby body. Real B-plane geometry
 * is microscopic at AU scale (Earth's SOI is 0.025 helio units), so this
 * is intentionally rendered ~150× oversized for educational clarity.
 *
 * Returns a Group containing:
 *   • translucent disk perpendicular to ŝ                  (the B-plane)
 *   • disk outline                                          (sized = |B| schematic)
 *   • B-vector arrow from origin to closest-approach point  (along B̂)
 *   • incoming asymptote line                               (extends in -ŝ direction)
 *   • outgoing asymptote line                               (extends in v̂∞_out direction)
 *   • rotation-axis arrow                                   (along ĥ, perpendicular to flyby plane)
 *   • text label with B·T, B·R, |B| in km
 */
function buildBPlaneViz(flybyAssessment, v_inf_out_helio_unit, scale = 0.28) {
    const g = new THREE.Group();
    const b = flybyAssessment.b_plane;

    // helio km → scene basis: the flyby data uses heliocentric ecliptic
    // (x, y, z), and our scene maps (x_ecl, y_ecl, z_ecl) → (x, z, -y).
    const toScene = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
    const s = toScene(b.s_hat).normalize();
    const T = toScene(b.T_hat).normalize();
    const R = toScene(b.R_hat).normalize();
    const h = toScene(b.h_hat).normalize();
    const Bhat = toScene(b.B_hat).normalize();
    const v_out_hat = toScene(v_inf_out_helio_unit).normalize();

    // Translucent B-plane disk (CircleGeometry's default normal is +Z, so
    // we orient it via quaternion to face +ŝ).
    const disk = new THREE.Mesh(
        new THREE.CircleGeometry(scale, 48),
        new THREE.MeshBasicMaterial({
            color: 0x66ddff, transparent: true, opacity: 0.10,
            side: THREE.DoubleSide, depthWrite: false,
        }),
    );
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,0,1), s);
    disk.quaternion.copy(q);
    g.add(disk);

    // Disk outline ring
    const ringPts = [];
    const N = 64;
    for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        ringPts.push(
            T.clone().multiplyScalar(scale * Math.cos(a))
             .add(R.clone().multiplyScalar(scale * Math.sin(a))),
        );
    }
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color: 0x88eeff, transparent: true, opacity: 0.55 }),
    ));

    // T̂ axis tick (small line from center along +T̂)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), T.clone().multiplyScalar(scale)]),
        new THREE.LineBasicMaterial({ color: 0x44aacc, transparent: true, opacity: 0.5 }),
    ));
    // R̂ axis tick
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), R.clone().multiplyScalar(scale)]),
        new THREE.LineBasicMaterial({ color: 0x44aacc, transparent: true, opacity: 0.5 }),
    ));

    // Asymptote-in (spacecraft approaches FROM -ŝ direction TO body)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            s.clone().multiplyScalar(-2.5 * scale),
            new THREE.Vector3(0,0,0),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffaa66, transparent: true, opacity: 0.85 }),
    ));
    // Asymptote-out (along v̂∞_out from body)
    g.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0,0,0),
            v_out_hat.clone().multiplyScalar(2.5 * scale),
        ]),
        new THREE.LineBasicMaterial({ color: 0xffeecc, transparent: true, opacity: 0.95 }),
    ));

    // B-vector arrow from origin along B̂
    g.add(new THREE.ArrowHelper(
        Bhat,
        new THREE.Vector3(0,0,0),
        scale * 0.95,
        0xffcc44, scale * 0.16, scale * 0.10,
    ));

    // Rotation-axis ĥ arrow (perpendicular to flyby plane)
    g.add(new THREE.ArrowHelper(
        h,
        new THREE.Vector3(0,0,0),
        scale * 0.7,
        0xff66cc, scale * 0.14, scale * 0.09,
    ));

    // B·T / B·R label sprite
    const lbl = makeBPlaneLabel(b);
    lbl.position.copy(R.clone().multiplyScalar(scale * 1.25));
    g.add(lbl);

    return g;
}

function makeBPlaneLabel(b) {
    const c = document.createElement('canvas');
    c.width = 320; c.height = 96;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 18px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#88eeff';
    ctx.fillText('B-plane (schematic)', 160, 24);
    ctx.fillStyle = '#ffcc44';
    ctx.fillText(`|B| = ${b.B_mag.toFixed(0)} km`, 160, 48);
    ctx.fillStyle = '#cfd';
    ctx.fillText(`B·T ${b.B_dot_T.toFixed(0)}  B·R ${b.B_dot_R.toFixed(0)}`, 160, 70);
    const tex = new THREE.CanvasTexture(c);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    sprite.scale.set(0.55, 0.16, 1);
    return sprite;
}

/**
 * Spawn a brief additive flash at a position to signal a Δv burn.
 * Auto-fades and removes itself from the scene.
 */
function spawnBurnFlash(scene, position, color = 0xffaa33, life_ms = 700, sizeMul = 1) {
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialGradientTexture(color, 0),
        transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false,
    }));
    flash.position.copy(position);
    flash.scale.set(0.3 * sizeMul, 0.3 * sizeMul, 1);
    scene.add(flash);
    const start = performance.now();
    const tick = () => {
        const t = (performance.now() - start) / life_ms;
        if (t >= 1) { scene.remove(flash); flash.material.dispose(); flash.material.map.dispose(); return; }
        const s = (0.3 + 1.4 * t) * sizeMul;
        flash.scale.set(s, s, 1);
        flash.material.opacity = (1 - t) * 0.9;
        requestAnimationFrame(tick);
    };
    tick();
}

function addStarfield(scene, N, R) {
    const pos = new Float32Array(N*3);
    for (let i=0; i<N; i++) {
        const u = Math.random()*2 - 1;
        const t = Math.random()*Math.PI*2;
        const s = Math.sqrt(1 - u*u);
        pos[i*3+0] = R * s * Math.cos(t);
        pos[i*3+1] = R * u;
        pos[i*3+2] = R * s * Math.sin(t);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({
        color: 0xffffff, size: 0.55, sizeAttenuation: false, transparent: true, opacity: 0.7,
    })));
}

function makeRingLine(radius, color, opacity) {
    const N = 256;
    const pos = new Float32Array(N*3);
    for (let i=0; i<N; i++) {
        const a = (i / (N-1)) * Math.PI * 2;
        pos[i*3+0] = radius * Math.cos(a);
        pos[i*3+1] = 0;
        pos[i*3+2] = radius * Math.sin(a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

// Orbit ring of given radius in a plane spanned by (uHat, vHat).
function makeOrbitRingFromBasis(radius, uHat, vHat, color, opacity) {
    const N = 256;
    const pos = new Float32Array(N*3);
    const u = uHat.clone().normalize();
    const v = vHat.clone().normalize();
    for (let i=0; i<N; i++) {
        const a = (i / (N-1)) * Math.PI * 2;
        const p = u.clone().multiplyScalar(radius * Math.cos(a))
            .add(v.clone().multiplyScalar(radius * Math.sin(a)));
        pos[i*3+0] = p.x; pos[i*3+1] = p.y; pos[i*3+2] = p.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

// Full Kepler ellipse (focus at origin, periapsis along +periHat) sampled
// over true anomaly. dashed=true uses LineDashedMaterial.
function makeEllipseFromBasis(a, e, periHat, sideHat, color, opacity, dashed = false) {
    const N = 256;
    const pos = new Float32Array(N*3);
    const p   = a * (1 - e*e);
    const periN = periHat.clone().normalize();
    const sideN = sideHat.clone().normalize();
    for (let i=0; i<N; i++) {
        const nu = (i / (N-1)) * Math.PI * 2;
        const r  = p / (1 + e * Math.cos(nu));
        const v  = periN.clone().multiplyScalar(r * Math.cos(nu))
            .add(sideN.clone().multiplyScalar(r * Math.sin(nu)));
        pos[i*3+0] = v.x; pos[i*3+1] = v.y; pos[i*3+2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const mat = dashed
        ? new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: 0.28, gapSize: 0.18 })
        : new THREE.LineBasicMaterial ({ color, transparent: true, opacity });
    const line = new THREE.LineLoop(g, mat);
    if (dashed) line.computeLineDistances();
    return line;
}

function makeRocket(scene) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(
        new THREE.CylinderGeometry(0.012, 0.014, 0.07, 12),
        new THREE.MeshPhongMaterial({ color: 0xeeeeee, emissive: 0x222222 }),
    );
    const nose = new THREE.Mesh(
        new THREE.ConeGeometry(0.012, 0.025, 12),
        new THREE.MeshPhongMaterial({ color: 0xff5533 }),
    );
    nose.position.y = 0.045;
    const plume = new THREE.Mesh(
        new THREE.ConeGeometry(0.015, 0.06, 12, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffcc66, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
    );
    plume.rotation.x = Math.PI; plume.position.y = -0.05;
    g.add(body, nose, plume);
    scene.add(g);
    return g;
}

function clearAll(state, geo, hel) {
    for (const r of state.rockets) {
        geo.scene.remove(r.group); geo.scene.remove(r.trail);
    }
    for (const p of state.payloads) {
        geo.scene.remove(p.mesh); geo.scene.remove(p.ring); geo.scene.remove(p.trail);
    }
    for (const m of state.lunarMissions) {
        geo.scene.remove(m.craft); geo.scene.remove(m.trail);
        if (m.ellLine)     geo.scene.remove(m.ellLine);
        if (m.parkRing)    geo.scene.remove(m.parkRing);
        if (m.soiMesh)     geo.scene.remove(m.soiMesh);
        if (m.captureRing) geo.scene.remove(m.captureRing);
        if (m.arcLine)     geo.scene.remove(m.arcLine);
    }
    for (const m of state.marsMissions) {
        hel.scene.remove(m.craft); hel.scene.remove(m.trail);
        if (m.arcLine) hel.scene.remove(m.arcLine);
        if (m.soiMesh) hel.scene.remove(m.soiMesh);
    }
    for (const t of state.tours || []) {
        hel.scene.remove(t.craft); hel.scene.remove(t.trail);
        for (const lg of t.legGeoms) {
            hel.scene.remove(lg.line); hel.scene.remove(lg.marker);
            if (lg.bPlaneViz) hel.scene.remove(lg.bPlaneViz);
        }
    }
    state.rockets.length        = 0;
    state.payloads.length       = 0;
    state.lunarMissions.length  = 0;
    state.marsMissions.length   = 0;
    if (state.tours) state.tours.length = 0;
}
