/**
 * experiments.js — client-side A/B assignment + persona model + exposure tracking
 *
 * Reuses the existing anon-safe funnel pipeline rather than adding a new
 * telemetry kind or DB migration:
 *
 *     experiments.assign('home_hero')           → 'control' | 'punch'
 *     experiments.persona()                      → 'operator' | …
 *     experiments.track('landing_cta_click', {}) → funnel.step + analytics
 *
 * Every funnel/analytics event emitted through here carries the visitor's
 * persona and the compact map of variant assignments that were *read* on
 * this page, so the existing `landing_view` / `landing_cta_click` stages
 * in supabase-auth-funnel-migration.sql segment by experiment with no
 * schema change. `experiment_exposure` is an extra stage — it still
 * stores, it just won't appear in the ordered funnel-summary RPC.
 *
 * Privacy posture matches auth-funnel.js: no PII, no email, no IP. The
 * visitor id is a random opaque token used only for stable bucketing —
 * it is never joined to identity.
 *
 * Bucketing is deterministic: hash(visitorId + ':' + experimentKey) is
 * stable across sessions, so a returning visitor stays in their variant.
 */

import { funnel } from './auth-funnel.js';
import { analytics } from './analytics.js';

/* ── Persona model ──────────────────────────────────────────────────── */

export const PERSONAS = Object.freeze(['operator', 'educator', 'enthusiast', 'scientist']);
const DEFAULT_PERSONA = 'operator';

/* ── Experiment registry ────────────────────────────────────────────────
 * status:
 *   'running' — bucket visitors across variants by weight
 *   'paused'  — everyone gets the first variant (treated as control)
 * Weights are relative integers; they need not sum to 100.
 * To launch/retire a test, edit only this block.
 * ─────────────────────────────────────────────────────────────────────── */
export const EXPERIMENTS = Object.freeze({
    home_hero: {
        status: 'running',
        variants: [
            { id: 'control', w: 50 },   // informative headline
            { id: 'punch',   w: 50 },   // loss-framed / urgency headline
        ],
    },
    home_cta: {
        status: 'running',
        variants: [
            { id: 'control', w: 50 },   // neutral CTA verb
            { id: 'urgency', w: 50 },   // persona-specific stronger verb
        ],
    },
});

/* ── Storage keys ───────────────────────────────────────────────────── */
const VID_KEY      = 'pp_vid';            // localStorage — stable visitor id
const PERSONA_KEY  = 'pp_persona';        // localStorage — sticky persona
const FORCE_KEY    = 'pp_exp_force';      // localStorage — QA variant overrides
const SEEN_KEY     = 'pp_exp_seen';       // sessionStorage — exposure dedup

/* ── Utilities ──────────────────────────────────────────────────────── */

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function makeId() {
    try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch {}
    return 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function visitorId() {
    let id = lsGet(VID_KEY);
    if (id) return id;
    id = makeId();
    lsSet(VID_KEY, id);
    return id;
}

// cyrb53 — small, well-distributed string hash. Good enough for bucketing.
function hash53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function bucket(visitor, key) {
    return hash53(visitor + ':' + key) % 10000 / 100;   // [0, 100)
}

function readForces() {
    try { return JSON.parse(lsGet(FORCE_KEY) || '{}') || {}; } catch { return {}; }
}

// `?exp_<key>=<variant>` forces a variant and persists it for QA so a
// reload (or a deep link shared with a teammate) keeps the same view.
function captureUrlForces() {
    let params;
    try { params = new URLSearchParams(window.location.search); } catch { return; }
    const forces = readForces();
    let changed = false;
    for (const [k, v] of params.entries()) {
        if (!k.startsWith('exp_')) continue;
        const key = k.slice(4);
        if (EXPERIMENTS[key] && EXPERIMENTS[key].variants.some(x => x.id === v)) {
            forces[key] = v;
            changed = true;
        }
    }
    if (changed) lsSet(FORCE_KEY, JSON.stringify(forces));
}

function pickVariant(key) {
    const exp = EXPERIMENTS[key];
    if (!exp) return null;
    const variants = exp.variants;
    const forced = readForces()[key];
    if (forced && variants.some(v => v.id === forced)) return forced;
    if (exp.status !== 'running') return variants[0].id;
    const point = bucket(visitorId(), key);
    const total = variants.reduce((s, v) => s + (v.w || 0), 0) || 1;
    let acc = 0;
    for (const v of variants) {
        acc += (v.w || 0) / total * 100;
        if (point < acc) return v.id;
    }
    return variants[variants.length - 1].id;
}

/* ── Persona ────────────────────────────────────────────────────────── */

function resolvePersona() {
    try {
        const q = new URLSearchParams(window.location.search).get('persona');
        if (q && PERSONAS.includes(q)) { lsSet(PERSONA_KEY, q); return q; }
    } catch {}
    const saved = lsGet(PERSONA_KEY);
    return PERSONAS.includes(saved) ? saved : DEFAULT_PERSONA;
}

/* ── Exposure dedup (per tab/session, per experiment) ────────────────── */

function seenSet() {
    try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); }
    catch { return new Set(); }
}
function markSeen(key) {
    try {
        const s = seenSet(); s.add(key);
        sessionStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
    } catch {}
}

class Experiments {
    constructor() {
        captureUrlForces();
        this._persona     = resolvePersona();
        this._assignments = {};   // key → variant, populated lazily by assign()
    }

    visitorId() { return visitorId(); }

    /** Persona for this visitor (URL `?persona=` wins, then sticky, then operator). */
    persona() { return this._persona; }

    /** Explicit persona switch (self-select pill / nav). Persists + logs. */
    setPersona(p) {
        if (!PERSONAS.includes(p) || p === this._persona) return this._persona;
        const from = this._persona;
        this._persona = p;
        lsSet(PERSONA_KEY, p);
        this.track('landing_persona_switch', { from, to: p });
        try {
            window.dispatchEvent(new CustomEvent('pp-persona-changed', { detail: { from, to: p } }));
        } catch {}
        return p;
    }

    /**
     * Resolve (and lazily expose) the variant for an experiment. The first
     * time a key is assigned on a page an `experiment_exposure` funnel
     * stage fires — deduped per session so a re-render doesn't double-count.
     */
    assign(key) {
        if (this._assignments[key]) return this._assignments[key];
        const variant = pickVariant(key) || 'control';
        this._assignments[key] = variant;
        if (!seenSet().has(key)) {
            markSeen(key);
            funnel.step('experiment_exposure', {
                experiment: key,
                variant,
                persona: this._persona,
            });
            this._mirror('experiment_exposure', { experiment: key, variant });
        }
        return variant;
    }

    /** Alias — reads/assigns a variant without implying it's a one-shot. */
    variant(key) { return this.assign(key); }

    /** Compact { key: variant } map of everything assigned on this page. */
    assignments() { return { ...this._assignments }; }

    /**
     * Conversion / interaction event. Routes through the anon-safe funnel
     * (canonical stages like `landing_cta_click` segment automatically by
     * the attached persona + exp map) and mirrors to consent-gated GA4 /
     * Supabase analytics when available.
     */
    track(stage, props = {}) {
        const meta = { persona: this._persona, exp: this.assignments(), ...props };
        try { funnel.step(stage, meta); } catch {}
        this._mirror(stage, props);
    }

    // Consent-gated mirror — analytics.event() itself buffers/drops based
    // on window.ppConsent, so we never gate here.
    _mirror(name, props) {
        try {
            analytics.event(name, { persona: this._persona, exp: this.assignments(), ...props });
        } catch {}
    }
}

export const experiments = new Experiments();

// Expose for classic (non-module) inline scripts.
try {
    if (typeof window !== 'undefined') window.ppExperiments = experiments;
} catch {}
