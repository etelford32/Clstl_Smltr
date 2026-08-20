/**
 * js/corridor/corridor-panel.js — mounts the 3D corridor and feeds it.
 *
 * Owns the data gathering, the clock, and the fail-quiet degradation for the
 * corridor view on cme-forecast.html. Builds its own DOM inside a host
 * element (the mountStage precedent) so the page only has to supply a div.
 *
 * ── Three feeds, three independent failure modes ───────────────────────
 *
 *   far side  → js/farside/* (labelled synthetic when the archive is empty)
 *   train     → js/flux-rope-forecast.js, the ONE shared provider
 *   regions   → /api/noaa/regions, only for the flare base rate
 *
 * Each is awaited separately and each is allowed to be missing. A dead
 * provider means "no train in flight", NOT a fabricated rope; a dead NOAA
 * feed means the flare base rate does not print, NOT that it prints zero.
 * The status line says which of the three are actually up, because a scene
 * that renders beautifully with two dead feeds is the failure mode that
 * matters here.
 *
 * ── One clock ──────────────────────────────────────────────────────────
 *
 * js/farside/farside-clock.js — the same module Far-Side Watch drives its
 * rotation simulation with, and the reason this page and that one agree
 * about where a region is. The window is one synodic rotation forward, so
 * every tracked region's emergence falls inside it.
 *
 * ── What the clock moves ───────────────────────────────────────────────
 *
 * Regions co-rotate (their CMD is a function of the clock); launched ropes
 * do not (their heading was fixed at launch). Advancing time therefore
 * sweeps the Sun's surface under a train that holds its course, which is
 * the actual physics and the thing a static picture cannot show. See
 * corridor-model.js.
 *
 * The provider is run ONCE per load, not per frame: the ensemble is
 * expensive and the answer does not depend on where the scrubber is. Only
 * the geometry is re-evaluated as τ moves.
 */

import {
    getLatestMap, getMapSeries, getStoredFrames,
    farSideWatchList, farSideWatchListFromFrames, projectTracks,
    carringtonL0,
    simBounds, simStatus, clampEpoch, advanceEpoch,
    epochToFraction, fractionToEpoch,
    SIM_SPEEDS,
} from '../farside/index.js';
import { attachFlareClimatology } from '../farside/flare-climatology.js';
import { placeSourceRegions, trainAt, arrivalWindowState } from './corridor-model.js';

const DAY_MS = 86400000;

const CSS = `
.cmc-wrap { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; }
.cmc-canvas-wrap { position:relative; flex:1; min-height:0; }
.cmc-wrap canvas { display:block; width:100%; height:100%; }
.cmc-hud { position:absolute; left:10px; top:9px; display:flex; flex-direction:column; gap:4px;
    pointer-events:none; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
.cmc-stamp { font-size:.8rem; font-weight:700; color:#fff; letter-spacing:-.01em; }
.cmc-feeds { display:flex; gap:6px; flex-wrap:wrap; pointer-events:auto; }
.cmc-feed { display:inline-flex; align-items:center; gap:5px; padding:2px 7px; border-radius:999px;
    border:1px solid rgba(90,110,160,.3); background:rgba(4,6,20,.6); font-size:.58rem;
    letter-spacing:.05em; text-transform:uppercase; color:#69718c; }
.cmc-feed i { width:6px; height:6px; border-radius:50%; background:#69718c; }
.cmc-feed.up { color:#7fe6c3; border-color:rgba(127,230,195,.35); }
.cmc-feed.up i { background:#7fe6c3; box-shadow:0 0 6px #7fe6c3; }
.cmc-feed.demo { color:#ffb454; border-color:rgba(255,180,84,.35); }
.cmc-feed.demo i { background:#ffb454; box-shadow:0 0 6px #ffb454; }
.cmc-feed.down { color:#ff6b8a; border-color:rgba(255,107,138,.35); }
.cmc-feed.down i { background:#ff6b8a; }
.cmc-scale { position:absolute; right:10px; top:9px; display:flex; flex-direction:column;
    align-items:flex-end; gap:5px; }
.cmc-stations { display:inline-flex; gap:3px; padding:2px; border:1px solid rgba(90,110,160,.3);
    border-radius:7px; background:rgba(4,6,20,.6); }
.cmc-stations button { border:0; border-radius:5px; padding:3px 8px; }
.cmc-scale button { border:1px solid rgba(90,110,160,.3); border-radius:6px; padding:3px 9px;
    color:#8b94ad; background:rgba(4,6,20,.6); cursor:pointer;
    font:700 .6rem/1.4 ui-monospace,monospace; text-transform:uppercase; letter-spacing:.06em; }
.cmc-scale button:hover { color:#4fc3f7; border-color:rgba(79,195,247,.45); }
.cmc-scale button[aria-pressed="true"] { color:#04121b; background:#4fc3f7; border-color:#4fc3f7; }
.cmc-disclose { max-width:230px; text-align:right; font:500 .56rem/1.45 ui-monospace,monospace;
    color:#69718c; pointer-events:none; }
.cmc-bar { flex:0 0 auto; display:flex; align-items:center; gap:9px; flex-wrap:wrap;
    padding:7px 10px 2px; }
.cmc-bar button { border:1px solid rgba(90,110,160,.3); border-radius:6px; padding:4px 11px;
    color:#cdd5e4; background:rgba(255,255,255,.04); cursor:pointer;
    font:700 .68rem/1.3 'Segoe UI',system-ui,sans-serif; white-space:nowrap; }
.cmc-bar button:hover { color:#fff; background:rgba(255,255,255,.09); }
.cmc-bar button.cmc-play { min-width:84px; color:#04121b; background:#4fc3f7; border-color:#4fc3f7; }
.cmc-bar select { border:1px solid rgba(90,110,160,.3); border-radius:6px; padding:4px 6px;
    color:#cdd5e4; background:#0b0d1f; cursor:pointer; font:700 .62rem/1.3 ui-monospace,monospace; }
.cmc-scrub-wrap { position:relative; flex:1 1 180px; min-width:120px; }
.cmc-scrub-wrap input { position:relative; z-index:2; width:100%; margin:0; accent-color:#4fc3f7;
    background:transparent; cursor:pointer; }
.cmc-ticks { position:absolute; left:0; right:0; top:50%; height:18px; transform:translateY(-50%);
    pointer-events:none; }
.cmc-tick { position:absolute; top:0; width:2px; height:18px; margin-left:-1px; border-radius:1px;
    background:#ffd166; box-shadow:0 0 6px rgba(255,209,102,.7); opacity:.8; }
.cmc-tick.now { background:#7fe6c3; box-shadow:0 0 6px rgba(127,230,195,.8); }
.cmc-offset { font:700 .64rem/1 ui-monospace,monospace; color:#ffb454; white-space:nowrap; }
.cmc-offset.is-now { color:#7fe6c3; }
.cmc-fallback { display:flex; align-items:center; justify-content:center; height:100%;
    padding:16px; text-align:center; font-size:.74rem; color:#8b94ad; }
`;

let _cssInjected = false;
function injectCss() {
    if (_cssInjected || typeof document === 'undefined') return;
    const el = document.createElement('style');
    el.textContent = CSS;
    document.head.appendChild(el);
    _cssInjected = true;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtStamp(ms) {
    const d = new Date(ms);
    const day = d.toLocaleDateString('en-GB',
        { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC' });
    return `${day} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}
function fmtOffset(days) {
    if (Math.abs(days) < 1 / 48) return 'now';
    return `${days >= 0 ? '+' : '−'}${Math.abs(days).toFixed(1)} d`;
}

/**
 * Mount the corridor.
 *
 * @param {string|HTMLElement} host
 * @param {object} [opts]
 * @param {function():object|null} [opts.getEvent] the ledger event whose
 *   arrival window to draw — read fresh on every frame so the page's
 *   selection and the scene cannot drift apart.
 * @returns {object|null} api { setEpoch, getEpoch, destroy } or null
 */
export function mountCorridor(host, opts = {}) {
    if (typeof document === 'undefined') return null;
    const el = typeof host === 'string' ? document.getElementById(host) : host;
    if (!el) return null;
    try { return build(el, opts); }
    catch (e) { console.warn('[corridor] disabled:', e); return null; }
}

function build(el, opts) {
    injectCss();
    el.innerHTML = `
      <div class="cmc-wrap">
        <div class="cmc-canvas-wrap">
          <canvas id="cmc-canvas" aria-label="3D Sun to Earth CME corridor"></canvas>
          <div class="cmc-hud">
            <span class="cmc-stamp" id="cmc-stamp">—</span>
            <div class="cmc-feeds" id="cmc-feeds"></div>
          </div>
          <div class="cmc-scale">
            <div class="cmc-stations" role="group" aria-label="Camera">
              <button type="button" data-cmc-fly="sun">Sun</button>
              <button type="button" data-cmc-fly="corridor" aria-pressed="true">Corridor</button>
              <button type="button" data-cmc-fly="earth">Earth</button>
            </div>
            <button type="button" id="cmc-truescale" aria-pressed="false">⇲ True scale</button>
            <div class="cmc-disclose">Distance log-compressed · Sun ×6.5, Earth ×107 —
              ruler rings show true AU. Drag to orbit.</div>
          </div>
        </div>
        <div class="cmc-bar">
          <button type="button" class="cmc-play" id="cmc-play" aria-pressed="false">▶ Play</button>
          <button type="button" id="cmc-now">⏱ Now</button>
          <select id="cmc-speed" aria-label="Playback speed"></select>
          <div class="cmc-scrub-wrap">
            <div class="cmc-ticks" id="cmc-ticks" aria-hidden="true"></div>
            <input id="cmc-scrub" type="range" min="0" max="1" step="0.0005"
                   aria-label="Simulated time">
          </div>
          <span class="cmc-offset is-now" id="cmc-offset">now</span>
        </div>
      </div>`;

    const $ = (id) => el.querySelector(`#${id}`);
    const state = {
        anchorMs: Date.now(),
        epochMs: Date.now(),
        playing: false,
        daysPerSec: SIM_SPEEDS[1].daysPerSec,
        raf: 0,
        lastFrame: 0,
        tracks: [],
        map: null,
        forecast: null,
        feeds: { farside: 'pending', train: 'pending', regions: 'pending' },
        view: null,
        destroyed: false,
    };

    const bounds = () => simBounds(state.anchorMs);

    function renderFeeds() {
        const chip = (key, label) => {
            const s = state.feeds[key];
            const cls = s === 'live' ? 'up' : s === 'demo' ? 'demo' : s === 'down' ? 'down' : '';
            const text = s === 'live' ? label
                : s === 'demo' ? `${label} · demo`
                : s === 'down' ? `${label} · down` : `${label} · …`;
            return `<span class="cmc-feed ${cls}"><i></i>${esc(text)}</span>`;
        };
        $('cmc-feeds').innerHTML = chip('farside', 'far side')
            + chip('train', 'CME train') + chip('regions', 'flare base rate');
    }

    function renderTicks() {
        const host2 = $('cmc-ticks');
        const nowPct = epochToFraction(state.anchorMs, state.anchorMs) * 100;
        let html = `<i class="cmc-tick now" style="left:${nowPct}%"></i>`;
        const ev = opts.getEvent?.();
        if (ev && Number.isFinite(ev.predictedMs)) {
            const f = epochToFraction(ev.predictedMs, state.anchorMs) * 100;
            html += `<i class="cmc-tick" style="left:${f}%"></i>`;
        }
        host2.innerHTML = html;
    }

    /** The one place the clock is written. */
    function setEpoch(ms) {
        state.epochMs = clampEpoch(ms, state.anchorMs);
        if (!state.view) return;

        const { L0 } = carringtonL0(new Date(state.epochMs));
        const projected = projectTracks(state.tracks, L0, state.epochMs);
        state.view.setL0(L0);
        state.view.setSources(placeSourceRegions(projected));

        const fc = state.forecast;
        if (fc && !fc.idle && fc.preset) {
            state.view.setTrain(trainAt(fc.preset, fc.launchMs ?? state.anchorMs,
                state.epochMs, fc.kernel));
        } else {
            state.view.setTrain([]);
        }
        state.view.setArrival(arrivalWindowState(opts.getEvent?.(), state.epochMs));

        const status = simStatus(state.epochMs, state.anchorMs);
        $('cmc-stamp').textContent = fmtStamp(state.epochMs);
        const off = $('cmc-offset');
        off.textContent = fmtOffset(status.offsetDays);
        off.classList.toggle('is-now', status.isNow);
        const scrub = $('cmc-scrub');
        if (document.activeElement !== scrub) {
            scrub.value = String(epochToFraction(state.epochMs, state.anchorMs));
        }
        if (!state.view._raf) state.view.renderOnce();
    }

    function setPlaying(on) {
        state.playing = !!on && !state.destroyed;
        const btn = $('cmc-play');
        btn.textContent = state.playing ? '❚❚ Pause' : '▶ Play';
        btn.setAttribute('aria-pressed', String(state.playing));
        if (!state.playing) {
            if (state.raf) cancelAnimationFrame(state.raf);
            state.raf = 0;
            return;
        }
        // Restarting at the far edge rewinds, otherwise Play looks broken.
        if (state.epochMs >= bounds().endMs - 1) setEpoch(state.anchorMs);
        state.lastFrame = performance.now();
        const loop = (now) => {
            if (!state.playing) return;
            state.raf = requestAnimationFrame(loop);
            const dt = Math.min((now - state.lastFrame) / 1000, 0.1);
            state.lastFrame = now;
            const step = advanceEpoch(state.epochMs, dt, state.daysPerSec, state.anchorMs);
            setEpoch(step.epochMs);
            if (step.ended) setPlaying(false);
        };
        state.raf = requestAnimationFrame(loop);
    }

    // ── Controls ────────────────────────────────────────────────────────
    $('cmc-play').addEventListener('click', () => setPlaying(!state.playing));
    $('cmc-now').addEventListener('click', () => { setPlaying(false); setEpoch(state.anchorMs); });
    $('cmc-scrub').addEventListener('input', (e) => {
        setPlaying(false);
        setEpoch(fractionToEpoch(e.target.value, state.anchorMs));
    });
    const speed = $('cmc-speed');
    speed.innerHTML = SIM_SPEEDS
        .map((s) => `<option value="${s.daysPerSec}">${esc(s.label)}</option>`).join('');
    speed.value = String(state.daysPerSec);
    speed.addEventListener('change', () => {
        state.daysPerSec = Number(speed.value) || SIM_SPEEDS[1].daysPerSec;
    });
    for (const btn of el.querySelectorAll('[data-cmc-fly]')) {
        btn.addEventListener('click', () => {
            for (const b of el.querySelectorAll('[data-cmc-fly]')) b.removeAttribute('aria-pressed');
            btn.setAttribute('aria-pressed', 'true');
            state.view?.flyTo(btn.dataset.cmcFly);
        });
    }
    $('cmc-truescale').addEventListener('click', (e) => {
        const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
        e.currentTarget.setAttribute('aria-pressed', String(on));
        state.view?.setTrueScale(on);
        setEpoch(state.epochMs);       // rebuild rope meshes at the new scale
    });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && state.playing) setPlaying(false);
    });

    renderFeeds();
    renderTicks();

    // ── Boot ────────────────────────────────────────────────────────────
    (async () => {
        // The renderer first: a dead feed should still show the corridor,
        // and a missing WebGL context should be said out loud rather than
        // leaving an empty box.
        try {
            const { CorridorView } = await import('./corridor-view.js');
            state.view = new CorridorView($('cmc-canvas'));
            state.view.start();
            // Test hook (tests/cme-corridor.spec.js), same precedent as
            // window.__marsLab / __swStage. Read-only view of what the scene
            // actually contains.
            try { window.__corridorProbe = () => state.view?.probe() ?? null; } catch { /* ignore */ }
        } catch (e) {
            el.querySelector('.cmc-canvas-wrap').innerHTML =
                `<div class="cmc-fallback">3D corridor unavailable in this browser
                 (WebGL required). The calendar and forecast ledger are unaffected.</div>`;
            console.warn('[corridor] no 3D:', e);
            return;
        }

        // Far side — labelled synthetic when the archive is empty.
        try {
            const map = await getLatestMap('gong',
                { atMs: state.anchorMs, anchorMs: state.anchorMs });
            state.map = map;
            state.view.setField(map);
            const frames = await getStoredFrames('gong');
            state.tracks = frames?.length
                ? farSideWatchListFromFrames(frames)
                : farSideWatchList(await getMapSeries('gong', undefined,
                    { atMs: state.anchorMs, anchorMs: state.anchorMs }));
            state.feeds.farside = map.synthetic ? 'demo' : 'live';
        } catch (e) {
            state.feeds.farside = 'down';
            console.info('[corridor] far-side unavailable', e?.message ?? e);
        }
        renderFeeds();
        setEpoch(state.epochMs);

        // Flare base rate — context only, and allowed to be absent.
        try {
            const res = await fetch('/api/noaa/regions', { headers: { accept: 'application/json' } });
            const payload = res.ok ? await res.json() : null;
            const rows = payload?.data?.regions;
            if (rows?.length) {
                state.tracks = attachFlareClimatology(state.tracks, rows);
                // Null for every track means the feed answered but carried no
                // usable probabilities — that is "down" for this purpose.
                state.feeds.regions = state.tracks.some((t) => t.flare) ? 'live' : 'down';
            } else {
                state.feeds.regions = 'down';
            }
            // The route self-reports a schema mismatch (api/_lib/noaa-regions.js).
            // Surface it: "no probabilities matched" and "SWPC is down" look
            // identical from the chip alone, and only one of them is our bug.
            if (payload?.data?.note) {
                console.info('[corridor] flare base rate:', payload.data.note,
                    'unmapped upstream keys:', payload.data.unmapped_keys);
            }
        } catch (e) {
            state.feeds.regions = 'down';
        }
        renderFeeds();
        setEpoch(state.epochMs);

        // The train — the ONE shared provider. Never fabricated.
        try {
            const { computeFluxRopeForecast } = await import('../flux-rope-forecast.js');
            const fc = await computeFluxRopeForecast();
            state.forecast = fc;
            state.feeds.train = fc?.idle ? 'down' : 'live';
            // Be a good citizen: other panels consume this event.
            try {
                window.__fluxRopeForecast = fc;
                window.dispatchEvent(new CustomEvent('flux-rope-forecast', { detail: fc }));
            } catch { /* ignore */ }
        } catch (e) {
            state.feeds.train = 'down';
            console.info('[corridor] no CME train', e?.message ?? e);
        }
        renderFeeds();
        renderTicks();
        setEpoch(state.epochMs);
        el.dataset.corridorReady = 'true';
    })();

    return {
        setEpoch: (ms) => { setPlaying(false); setEpoch(ms); },
        getEpoch: () => state.epochMs,
        refreshTicks: renderTicks,
        destroy() {
            state.destroyed = true;
            setPlaying(false);
            state.view?.dispose();
            el.innerHTML = '';
        },
    };
}
