/**
 * perf-trace.js — boot-phase + data-pipeline timing for the Earth page.
 *
 * Answers "where did the seconds go between navigation and a live globe?"
 * — the question the ?debug=1 overlay (steady-state FPS / feed freshness)
 * and telemetry.js (LCP/FCP/TTFB vitals) don't cover. Three collectors,
 * all passive:
 *
 *   PHASES      performance.mark checkpoints the page drops at known boot
 *               milestones (modules evaluated → scene built → first frame
 *               → first data), plus zero-touch first-occurrence listeners
 *               on the CustomEvents the feeds already dispatch.
 *   LONG TASKS  PerformanceObserver('longtask', buffered) — main-thread
 *               stalls ≥ 50 ms, kept with timestamps so a stall can be
 *               matched against the phase it landed in.
 *   RESOURCES   performance resource entries bucketed by pipeline
 *               (js modules / vendor three / CDN textures / GIBS imagery /
 *               Open-Meteo / our api / Supabase) with count, transfer
 *               bytes, total+max duration, and when the bucket finished.
 *               This is the data-pipeline telemetry: no feed changes,
 *               the network waterfall is already the ground truth.
 *
 * Surfaces
 *   window._perfTrace.report()   structured object (probes, consoles)
 *   window._perfTrace.table()    console.table rendering of the same
 *   ?debug=1                     auto-prints the table ~12 s after load
 *   telemetry.recordVital(...)   compact phase set, riding the existing
 *                                25 % vitals sample so real-user boot
 *                                numbers accumulate in client_telemetry
 *                                (names: EARTH_BOOT_*).
 *
 * Costs nothing measurable: marks are O(1), observers are browser-side,
 * bucketing runs only when a report is asked for or at the one delayed
 * telemetry flush.
 */

const PREFIX = 'pp-earth:';

const RESOURCE_BUCKETS = [
    ['three-vendor', /\/vendor\/three|three\.module\.js/],
    ['js-modules',   /\/js\/.+\.js/],
    ['textures-cdn', /unpkg\.com|three-globe/],
    ['gibs-imagery', /gibs\.earthdata\.nasa\.gov/],
    ['open-meteo',   /open-meteo\.com/],
    ['api-weather',  /\/api\/weather\//],
    ['api-other',    /\/api\//],
    ['supabase',     /supabase\.(co|com)|cdn\.jsdelivr/],
];

// First-occurrence event checkpoints — feeds already dispatch these; the
// tracer just timestamps the first arrival of each.
const EVENT_MARKS = [
    ['weather-update',          'first-weather-update'],
    ['weather-history-ingest',  'first-history-ingest'],
    ['weather-forecast-ingest', 'first-nwp-ingest'],
    ['forecast-paint-update',   'first-model-paint'],
    ['temp-volume-update',      'level-feed-loaded'],
    ['weather-forecast-update', 'first-model-fanout'],
];

class PerfTrace {
    constructor() {
        this._marks = new Map();      // name → ms since timeOrigin
        this._longTasks = [];
        this._ltObserver = null;
        this._telemetry = null;
        this._started = false;
    }

    start({ telemetry = null } = {}) {
        if (this._started || typeof performance === 'undefined') return this;
        this._started = true;
        this._telemetry = telemetry;

        // Long tasks — buffered:true back-fills stalls that happened
        // before this module evaluated (i.e. during module fetch/eval).
        try {
            this._ltObserver = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) {
                    this._longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
                }
            });
            this._ltObserver.observe({ type: 'longtask', buffered: true });
        } catch (_) { /* longtask API not available — phases still work */ }

        for (const [ev, markName] of EVENT_MARKS) {
            document.addEventListener(ev, () => this.mark(markName), { once: true });
        }

        // Delayed one-shot: print (debug) + telemetry flush after boot has
        // had time to settle. Load event may already have fired.
        const arm = () => setTimeout(() => this._flush(), 12_000);
        if (document.readyState === 'complete') arm();
        else window.addEventListener('load', arm, { once: true });
        return this;
    }

    /** Timestamp a named checkpoint (first call wins; re-marks ignored). */
    mark(name) {
        if (this._marks.has(name)) return;
        const t = performance.now();
        this._marks.set(name, Math.round(t));
        try { performance.mark(PREFIX + name); } catch (_) { /* ok */ }
    }

    _paint(name) {
        try {
            const e = performance.getEntriesByName(name)[0];
            return e ? Math.round(e.startTime) : null;
        } catch (_) { return null; }
    }

    _resources() {
        const buckets = {};
        let entries = [];
        try { entries = performance.getEntriesByType('resource'); } catch (_) { return buckets; }
        for (const e of entries) {
            let bucket = 'other';
            for (const [name, re] of RESOURCE_BUCKETS) {
                if (re.test(e.name)) { bucket = name; break; }
            }
            const b = buckets[bucket] ??= { count: 0, kb: 0, totalMs: 0, maxMs: 0, doneAt: 0 };
            b.count++;
            b.kb      += Math.round((e.transferSize || 0) / 1024);
            b.totalMs += Math.round(e.duration);
            b.maxMs    = Math.max(b.maxMs, Math.round(e.duration));
            b.doneAt   = Math.max(b.doneAt, Math.round(e.responseEnd));
        }
        return buckets;
    }

    /** Full structured snapshot — everything the review needs. */
    report() {
        const nav = (() => {
            try {
                const n = performance.getEntriesByType('navigation')[0];
                return n ? {
                    ttfbMs:     Math.round(n.responseStart),
                    htmlDoneMs: Math.round(n.responseEnd),
                    domInteractiveMs: Math.round(n.domInteractive),
                    loadEventMs: Math.round(n.loadEventEnd || 0),
                } : null;
            } catch (_) { return null; }
        })();
        const lt = this._longTasks;
        const ltTotal = lt.reduce((s, e) => s + e.dur, 0);
        return {
            nav,
            fcpMs: this._paint('first-contentful-paint'),
            phases: Object.fromEntries(this._marks),
            longTasks: {
                count: lt.length,
                totalMs: ltTotal,
                worst: [...lt].sort((a, b) => b.dur - a.dur).slice(0, 10),
            },
            resources: this._resources(),
        };
    }

    table() {
        const r = this.report();
        console.info('[perf-trace] nav:', r.nav, 'FCP:', r.fcpMs, 'ms');
        console.table(r.phases);
        console.table(r.resources);
        console.info('[perf-trace] long tasks:', r.longTasks.count,
            'total', r.longTasks.totalMs, 'ms — worst:', r.longTasks.worst);
        return r;
    }

    _flush() {
        try {
            if (new URLSearchParams(location.search).get('debug')) this.table();
        } catch (_) { /* ok */ }
        // Compact real-user sample through the existing vitals surface
        // (recordVital self-gates on the 25 % session sample).
        const t = this._telemetry;
        if (!t?.recordVital) return;
        const r = this.report();
        const send = (name, v) => { if (Number.isFinite(v) && v > 0) t.recordVital(name, v); };
        send('EARTH_BOOT_MODULES',    r.phases['modules-evaluated']);
        send('EARTH_BOOT_SCENE',      r.phases['scene-built']);
        send('EARTH_BOOT_FRAME1',     r.phases['first-frame']);
        send('EARTH_BOOT_DATA1',      r.phases['first-weather-update']);
        send('EARTH_BOOT_LT_TOTAL',   r.longTasks.totalMs);
        send('EARTH_BOOT_JS_KB',      (r.resources['js-modules']?.kb ?? 0)
                                    + (r.resources['three-vendor']?.kb ?? 0));
    }
}

export const perfTrace = new PerfTrace();
export default perfTrace;
