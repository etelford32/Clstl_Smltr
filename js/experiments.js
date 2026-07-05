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
    // Legacy index.html hero headline. Variants are owned by the page's
    // inline copy map; experiments.js only does the bucketing + exposure.
    // New variants can be added without code change to the renderer — any
    // id not in the page map falls back to `control` at render time.
    home_headline: {
        status: 'running',
        variants: [
            { id: 'control', w: 25 },   // "Space-Grade Data. On Demand."
            { id: 'palm',    w: 25 },   // "Space-Grade Data, in your palm"
            { id: 'cosmos',  w: 25 },   // "Hold the cosmos in your hand"
            { id: 'wonder',  w: 25 },   // "Real Physics. Real Data. Real Wonder."
        ],
    },
    // Legacy index.html hero sub-paragraph. control = short punchy blurb,
    // long = the expanded narrative variant marketing wants to test.
    home_sub: {
        status: 'running',
        variants: [
            { id: 'control', w: 50 },
            { id: 'long',    w: 50 },
        ],
    },
    home_cta: {
        status: 'running',
        variants: [
            { id: 'control', w: 50 },   // neutral CTA verb
            { id: 'urgency', w: 50 },   // persona-specific stronger verb
        ],
    },
    // Hero background renderer. particles = the light drifting field;
    // constellation = the 3D operational-fleet globe (real Walker shells
    // from constellation-catalog.js + a storm-drag control).
    hero_bg: {
        status: 'running',
        variants: [
            { id: 'particles',     w: 50 },
            { id: 'constellation', w: 50 },
        ],
    },
    // Page-level: which homepage HTML is served at `/`. The 50/50 split is
    // owned by Vercel Edge Middleware (middleware.js), which pins the choice
    // in the `pp_home_v` cookie. `cookie`/`cookieMap` make this experiment
    // read that server decision instead of hashing independently, so the
    // recorded assignment can never disagree with the page actually served.
    home_redesign: {
        status: 'running',
        cookie: 'pp_home_v',
        cookieMap: { index: 'control', v2: 'redesign', v3: 'signup' },
        variants: [
            { id: 'control',  w: 34 },   // legacy index.html
            { id: 'redesign', w: 33 },   // home-v2.html (operator-first)
            { id: 'signup',   w: 33 },   // home-v3.html (signup-first)
        ],
    },
});

/* ── Goals registry ─────────────────────────────────────────────────────
 * Per-experiment conversion goals the admin dashboard charts. The first
 * goal is the primary lift metric; the rest are guardrail / secondary.
 *
 * Each entry is the event_name actually emitted somewhere in the app via
 * `experiments.track()` / `analytics.event()` / `funnel.step()` — so adding
 * a new goal here is *only* a UI registration, the underlying event must
 * already fire. Stages that double as funnel steps (landing_cta_click,
 * signup_succeeded) work out of the box because experiments.track() routes
 * through both client_telemetry and analytics_events.
 *
 * To launch a new goal: emit the event from app code, then add it here.
 * ─────────────────────────────────────────────────────────────────────── */
export const EXPERIMENT_GOALS = Object.freeze({
    home_hero: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'signup_succeeded',   label: 'Signup' },
    ],
    home_headline: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'scroll_depth',       label: 'Scroll past hero' },
        { stage: 'signup_succeeded',   label: 'Signup' },
    ],
    home_sub: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'scroll_depth',       label: 'Scroll past hero' },
        { stage: 'signup_succeeded',   label: 'Signup' },
    ],
    home_cta: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'signup_succeeded',   label: 'Signup' },
    ],
    hero_bg: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'scroll_depth',       label: 'Scroll past hero' },
    ],
    home_redesign: [
        { stage: 'landing_cta_click',  label: 'CTA click (primary)' },
        { stage: 'signup_succeeded',   label: 'Signup' },
        { stage: 'checkout_started',   label: 'Checkout started' },
    ],
});

/* ── Storage keys ───────────────────────────────────────────────────── */
const VID_KEY      = 'pp_vid';            // localStorage — stable visitor id
const PERSONA_KEY  = 'pp_persona';        // localStorage — sticky persona
const FORCE_KEY    = 'pp_exp_force';      // localStorage — QA variant overrides
const SEEN_KEY     = 'pp_exp_seen';       // sessionStorage — exposure dedup

/* ── Utilities ──────────────────────────────────────────────────────── */

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

function cookieGet(name) {
    try {
        const esc = name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1');
        const m = document.cookie.match(new RegExp('(?:^|; )' + esc + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
}

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
    // Server-pinned assignment (e.g. middleware-decided page split). The
    // cookie is authoritative so the served page and the recorded variant
    // stay in lockstep; we only fall through to hashing if it's absent.
    if (exp.cookie) {
        const raw = cookieGet(exp.cookie);
        const mapped = raw && exp.cookieMap ? exp.cookieMap[raw] : raw;
        if (mapped && variants.some(v => v.id === mapped)) return mapped;
    }
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
            // visitor_id is the stable localStorage UUID. Including it on
            // the exposure event is what enables cross-day retention
            // queries — the admin retention RPC groups returns by this id.
            // Privacy posture is unchanged: pp_vid is a random opaque
            // token that has always existed client-side and is never
            // joined to identity.
            const vid = visitorId();
            funnel.step('experiment_exposure', {
                experiment: key,
                variant,
                persona: this._persona,
                visitor_id: vid,
            });
            this._mirror('experiment_exposure', { experiment: key, variant, visitor_id: vid });
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
    // on window.ppConsent, so we never gate here. GA4 can't segment on a
    // nested object, so the assignments map is also flattened to scalar
    // `exp_<key>` params (registerable as GA4 custom dimensions). The rich
    // `exp` object is kept for Supabase analytics_events (arbitrary JSON).
    _mirror(name, props) {
        try {
            const exp = this.assignments();
            const flat = {};
            for (const k in exp) flat['exp_' + k] = exp[k];
            analytics.event(name, {
                persona: this._persona,
                exp,
                ...flat,
                ...props,
            });
        } catch {}
    }
}

export const experiments = new Experiments();

// Expose for classic (non-module) inline scripts.
try {
    if (typeof window !== 'undefined') window.ppExperiments = experiments;
} catch {}
