/**
 * tests/page-flow.mjs — unit tests for js/page-flow-core.js (pure).
 *
 * Run: node tests/page-flow.mjs
 *
 * Covers the logic the site-wide visitor-flow pipeline depends on:
 * referrer classification (the from→to transition edge + landing flag),
 * the engagement tracker's dwell/visible/active accounting, exit payload
 * assembly (incl. the exit_to freshness window), and the refresh rule
 * that lets a re-engaged tab improve its already-shipped exit.
 */

import {
    classifyRef, deviceClass, makePvId, buildEnter, buildExit,
    shouldRefreshExit, EngagementTracker,
    ACTIVE_WINDOW_MS, EXIT_CLICK_WINDOW_MS, EXIT_REFRESH_MIN_ACTIVE_S,
} from '../js/page-flow-core.js';

let failures = 0;
function check(name, cond, detail = '') {
    if (cond) { console.log(`  ok   ${name}`); }
    else      { failures++; console.error(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}

const ORIGIN = 'https://parkersphysics.com';

// ── classifyRef ──────────────────────────────────────────────────────
console.log('classifyRef');
{
    let r = classifyRef('', ORIGIN);
    check('empty referrer → direct landing', r.ref === null && r.landing === 1);

    r = classifyRef(`${ORIGIN}/earth.html?x=1#h`, ORIGIN);
    check('internal referrer → pathname edge, not a landing',
        r.ref === '/earth.html' && r.landing === 0, JSON.stringify(r));

    r = classifyRef(`${ORIGIN}/`, ORIGIN);
    check('internal root referrer → "/"', r.ref === '/' && r.landing === 0);

    r = classifyRef('https://www.google.com/search?q=space+weather&email=a@b.c', ORIGIN);
    check('external referrer → origin only (query/PII stripped)',
        r.ref === 'https://www.google.com' && r.landing === 1, JSON.stringify(r));

    r = classifyRef('not a url', ORIGIN);
    check('unparseable referrer → direct landing', r.ref === null && r.landing === 1);
}

// ── deviceClass ──────────────────────────────────────────────────────
console.log('deviceClass');
{
    check('719 → mobile (funnel 720px cut)', deviceClass(719) === 'mobile');
    check('720 → desktop', deviceClass(720) === 'desktop');
    check('0/undefined → mobile (degrade small)', deviceClass(0) === 'mobile' && deviceClass(undefined) === 'mobile');
}

// ── makePvId ─────────────────────────────────────────────────────────
console.log('makePvId');
{
    const id = makePvId();
    check('8 chars', id.length === 8, id);
    const a = makePvId(() => 0.123456789);
    const b = makePvId(() => 0.987654321);
    check('distinct for distinct rand', a !== b);
    check('padded when rand yields short strings', makePvId(() => 0).length === 8);
}

// ── EngagementTracker ────────────────────────────────────────────────
console.log('EngagementTracker');
{
    // Dwell is wall-clock regardless of activity.
    const t = new EngagementTracker(0);
    let s = t.snapshot(30_000);
    check('dwell = wall clock', s.dwell_s === 30);
    check('visible accrues while foregrounded', s.visible_s === 30);
    check('no input → zero active', s.active_s === 0);

    // Active = sum of inter-activity gaps < window.
    const t2 = new EngagementTracker(0);
    t2.activity(1_000);
    t2.activity(4_000);    // +3s
    t2.activity(8_000);    // +4s
    t2.activity(60_000);   // gap 52s > 10s window → not counted
    t2.activity(62_000);   // +2s
    s = t2.snapshot(62_000);
    check('active sums short gaps only', s.active_s === 9, `active_s=${s.active_s}`);

    // Visibility: hidden time counts toward neither visible nor active.
    const t3 = new EngagementTracker(0);
    t3.activity(2_000);
    t3.activity(5_000);            // +3s active
    t3.setVisible(false, 10_000);  // 10s visible so far
    t3.activity(15_000);           // background input — ignored
    t3.setVisible(true, 40_000);
    t3.activity(42_000);           // first activity after re-show: no bridge
    t3.activity(45_000);           // +3s active
    s = t3.snapshot(50_000);
    check('visible excludes hidden span', s.visible_s === 20, `visible_s=${s.visible_s}`);
    check('active never bridges a hide', s.active_s === 6, `active_s=${s.active_s}`);
    check('dwell still wall clock across hide', s.dwell_s === 50);

    // Clicks counted separately, and count as activity.
    const t4 = new EngagementTracker(0);
    t4.interact(1_000);
    t4.interact(3_000);   // +2s active
    s = t4.snapshot(5_000);
    check('interact() counts clicks', s.clicks === 2);
    check('interact() feeds active time', s.active_s === 2, `active_s=${s.active_s}`);

    // Constructed hidden (page opened in a background tab).
    const t5 = new EngagementTracker(0, { visible: false });
    t5.activity(2_000);            // background input — ignored
    t5.setVisible(true, 10_000);
    s = t5.snapshot(15_000);
    check('background-tab open accrues nothing until shown',
        s.visible_s === 5 && s.active_s === 0, JSON.stringify(s));
}

// ── buildEnter ───────────────────────────────────────────────────────
console.log('buildEnter');
{
    const e = buildEnter({
        pv: 'abcd1234', referrer: `${ORIGIN}/index.html`, origin: ORIGIN,
        viewportW: 1440, visitorId: 'vid-1',
    });
    check('enter carries phase/pv/ref/landing/device/visitor_id',
        e.phase === 'enter' && e.pv === 'abcd1234' && e.ref === '/index.html'
        && e.landing === 0 && e.device === 'desktop' && e.visitor_id === 'vid-1',
        JSON.stringify(e));

    const e2 = buildEnter({ pv: 'x', referrer: '', origin: ORIGIN, viewportW: 400, visitorId: null });
    check('null visitorId omits the key entirely', !('visitor_id' in e2));
    check('direct mobile landing', e2.landing === 1 && e2.device === 'mobile' && e2.ref === null);
}

// ── buildExit ────────────────────────────────────────────────────────
console.log('buildExit');
{
    const snap = { dwell_s: 42, visible_s: 40, active_s: 17, clicks: 5 };
    const x = buildExit({
        pv: 'abcd1234', snapshot: snap, maxScrollPct: 63.7,
        lastLinkClick: { path: '/earth.html', t: 99_000 }, t: 100_000, visitorId: 'vid-1',
    });
    check('exit carries engagement summary',
        x.phase === 'exit' && x.dwell_s === 42 && x.visible_s === 40
        && x.active_s === 17 && x.clicks === 5 && x.scroll_pct === 64,
        JSON.stringify(x));
    check('fresh internal click → exit_to', x.exit_to === '/earth.html');

    const stale = buildExit({
        pv: 'x', snapshot: snap, maxScrollPct: 0,
        lastLinkClick: { path: '/earth.html', t: 10_000 }, t: 10_000 + EXIT_CLICK_WINDOW_MS + 1,
        visitorId: null,
    });
    check('stale click (past window) → exit_to null', stale.exit_to === null);
    check('scroll clamped to [0,100]',
        buildExit({ pv: 'x', snapshot: snap, maxScrollPct: 250, lastLinkClick: null, t: 0, visitorId: null }).scroll_pct === 100);
}

// ── shouldRefreshExit ────────────────────────────────────────────────
console.log('shouldRefreshExit');
{
    check('no sent exit → no refresh path', shouldRefreshExit(null, { active_s: 100 }) === false);
    check('below threshold → skip',
        shouldRefreshExit({ active_s: 10 }, { active_s: 10 + EXIT_REFRESH_MIN_ACTIVE_S - 1 }) === false);
    check('at threshold → refresh',
        shouldRefreshExit({ active_s: 10 }, { active_s: 10 + EXIT_REFRESH_MIN_ACTIVE_S }) === true);
}

// ── constants sanity ─────────────────────────────────────────────────
console.log('constants');
{
    check('active window is 10s', ACTIVE_WINDOW_MS === 10_000);
}

if (failures) {
    console.error(`\n${failures} failure(s)`);
    process.exit(1);
}
console.log('\nAll page-flow core tests passed.');
