/**
 * scenario.js — Determinism foundation for the Operations console.
 *
 * Owns the canonical "what is the user looking at right now?" state and
 * derives three things from it:
 *
 *   1. Scenario hash — 8-char hex chip that tightens when anything that
 *      affects results changes. Driven by FNV-1a on a stable JSON
 *      serialisation of the inputs (sync, fast, deterministic — we
 *      don't need crypto-grade collision resistance for "did anything
 *      change" identity).
 *
 *   2. Permalink — a URL with `?t=…&m=…&p=…&l=…&h=…` that reconstructs
 *      the exact state on load. Anyone can paste it into Slack and the
 *      receiver gets the same view. Hash is included as an integrity
 *      check; mismatch logs a console warning but doesn't block load.
 *
 *   3. Seeded RNG — xorshift32 seeded by the hash. Any visual
 *      stochasticity (particle jitter, dotted shimmers landing in
 *      future tier-2 visuals) goes through this so it reproduces
 *      identically across machines for the same scenario.
 *
 * In Live mode, simTime is replaced with the literal 'live' before
 * hashing — otherwise the hash would tick every emit. Live links
 * intentionally don't permalink (a live state isn't capturable);
 * scrub and replay both produce stable links.
 *
 * Hash inputs intentionally exclude TLE / SWPC catalog timestamps
 * for now — those land with step 6's provenance store. Today the
 * catalog version is implicit (whatever CelesTrak served).
 */

import { timeBus } from './time-bus.js';

export const MODEL_VERSIONS = Object.freeze({
    sgp4:       'SGP4 r2024.06',
    atmosphere: 'NRLMSISE-00 v2.1',
    magnetopause: 'Shue 1998',
    covariance: 'Vallado age-map (synthetic)',
});

const MODEL_LABEL = `${MODEL_VERSIONS.sgp4} · ${MODEL_VERSIONS.atmosphere}`;

const state = {
    persona: 'sat-ops',
    layers:  [],
};

const subs = new Set();
let _hashCache       = null;
let _lastNotifiedHash = null;

/* ─── FNV-1a 32-bit ───────────────────────────────────────── */

function fnv1a32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/* ─── xorshift32 — seeded RNG primitive ───────────────────── */

function makeRng(seed) {
    let s = (seed >>> 0) || 0xdeadbeef;
    return function rng() {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;  s >>>= 0;
        return s / 0x100000000;
    };
}

/* ─── Hash composition ────────────────────────────────────── */

function hashInputs() {
    const t = timeBus.getState();
    return {
        m: MODEL_VERSIONS,
        p: state.persona,
        l: state.layers.slice().sort(),
        // In live mode the hash is a sentinel — otherwise it would
        // tick every bus emit and the chip would never sit still.
        mode: t.mode,
        time: t.mode === 'live' ? 'live' : Math.round(t.simTimeMs / 1000),
        speed: t.mode === 'replay' ? t.speed : null,
    };
}

function computeHash() {
    if (_hashCache != null) return _hashCache;
    const json = JSON.stringify(hashInputs());
    _hashCache = fnv1a32(json).toString(16).padStart(8, '0');
    return _hashCache;
}

function maybeNotify() {
    _hashCache = null;
    const h = computeHash();
    if (h === _lastNotifiedHash) return;
    _lastNotifiedHash = h;
    for (const fn of subs) {
        try { fn(); } catch (err) { console.warn('[scenario] subscriber threw', err); }
    }
}

/* ─── Permalink ───────────────────────────────────────────── */

function buildPermalink() {
    const t = timeBus.getState();
    const params = new URLSearchParams();
    if (t.mode !== 'live') {
        params.set('t', String(Math.round(t.simTimeMs)));
        params.set('m', t.mode);
        if (t.mode === 'replay') params.set('sp', String(t.speed));
    }
    if (state.persona && state.persona !== 'sat-ops') params.set('p', state.persona);
    if (state.layers.length > 0) params.set('l', state.layers.join(','));
    params.set('h', computeHash());

    const qs = params.toString();
    return `${location.origin}/operations${qs ? '?' + qs : ''}`;
}

/* ─── URL → state ─────────────────────────────────────────── */

/**
 * Parse `?t=…&m=…&sp=…&p=…&l=…&h=…` and push state into the time bus
 * and the scenario module. Layer reconciliation has to happen in the
 * caller (operations.html boot) because the scenario module
 * intentionally doesn't import the fleet.
 *
 * Returns the parsed shape so the caller can decide how to apply it
 * (e.g. skip fleet.bootstrap when `layers` is set).
 */
function parseUrl(searchString) {
    const params = new URLSearchParams(searchString || location.search);

    const out = {
        time:    null,
        mode:    null,
        speed:   null,
        persona: null,
        layers:  null,
        hash:    null,
    };

    const t = params.get('t');
    if (t) {
        const n = Number(t);
        if (Number.isFinite(n)) out.time = n;
    }

    const m = params.get('m');
    if (m === 'scrub' || m === 'replay') out.mode = m;

    const sp = params.get('sp');
    if (sp) {
        const n = Number(sp);
        if (timeBus.SPEEDS.includes(n)) out.speed = n;
    }

    const p = params.get('p');
    if (p) out.persona = p;

    const l = params.get('l');
    if (l) out.layers = l.split(',').map(s => s.trim()).filter(Boolean);

    out.hash = params.get('h') || null;
    return out;
}

/* ─── Subscribe to time-bus so hash invalidates on time change ─ */

timeBus.subscribe(() => maybeNotify());

/* ─── Public API ─────────────────────────────────────────── */

export const scenario = {
    /** Update the active persona id (e.g. 'sat-ops'). */
    setPersona(id) {
        if (!id || state.persona === id) return;
        state.persona = id;
        maybeNotify();
    },
    getPersona() { return state.persona; },

    /**
     * Replace the active layer set. Pass an array of layer IDs that
     * are actually rendered (loaded + visible). Order doesn't matter —
     * the hash sorts internally.
     */
    setLayers(ids) {
        const next = Array.from(new Set(ids || [])).sort();
        if (next.length === state.layers.length &&
            next.every((v, i) => v === state.layers[i])) {
            return;
        }
        state.layers = next;
        maybeNotify();
    },
    getLayers() { return state.layers.slice(); },

    /** 8-char hex hash of the current scenario state. */
    getHash() { return computeHash(); },

    /** Permalink that reconstructs the current scenario on load. */
    getPermalink: buildPermalink,

    /**
     * Fresh xorshift32 RNG seeded by the current hash. Call once per
     * frame (or per render pass) where you need reproducible noise.
     */
    getRng() {
        const seed = parseInt(computeHash(), 16);
        return makeRng(seed);
    },

    /** Subscribe to hash changes (only fires when the hash actually moves). */
    subscribe(fn) {
        subs.add(fn);
        try { fn(); } catch (_) {}
        return () => subs.delete(fn);
    },

    /**
     * Parse the current location.search (or the override) and return
     * the requested state. Caller is responsible for applying it
     * (bus.setSimTime, fleet.setLayerOn, etc.) so this module stays
     * decoupled from the fleet/persona DOM.
     */
    parseUrl,

    /** Compact "models" string for the chip. */
    modelLabel: MODEL_LABEL,

    MODEL_VERSIONS,
};
