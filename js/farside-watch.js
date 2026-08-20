/**
 * js/farside-watch.js — page controller for far-side-watch.html.
 *
 * Wires the modular far-side package (js/farside/*) into the page:
 *   feed → detect → track → emergence ETA → render + watch-list + alerts,
 * all driven by a scrubbable SIMULATION CLOCK.
 *
 * ── What the simulation actually simulates ──────────────────────────────
 *
 * Not the data. The phase-shift field is an OBSERVATION — the latest map the
 * ingestion cron stored, or a labelled synthetic stand-in — and it is held
 * fixed while the clock moves. What the clock moves is the OBSERVER: L0, the
 * sub-Earth Carrington longitude, sweeps at the synodic rate, carrying the
 * east limb across a field whose regions stay pinned where they were seen.
 *
 * That is the product, not a simplification of it. A far-side forecast is
 * exactly the statement "given where this region is now, rotation will put it
 * on the east limb in N days"; the honest way to animate it is to advance the
 * geometry and leave the measurement alone. Synthesizing an evolving future
 * field would draw regions growing and decaying on evidence nobody has.
 *
 * ── Cost model (why it scrubs at 60 fps) ────────────────────────────────
 *
 * Split by what depends on time:
 *   ONCE per observation  — detect + link (64 800-cell field, ~6 frames) and
 *                           the field bitmap, memoized in farside-render.
 *   PER FRAME             — projectTracks() over a handful of tracks, three
 *                           limb lines, and one group rotation on the globe.
 * Keep that split. Rebuilding tracks inside the scrub handler is what would
 * turn a 60 fps sweep into a 400 ms-per-step slideshow.
 *
 * ── Never simulate an alert ─────────────────────────────────────────────
 *
 * dispatchEmergenceAlerts and the CSV export read the ANCHOR projection, not
 * the scrubbed one. An alert is a claim about now; firing one because a user
 * dragged the clock into next week would be a fabricated warning.
 *
 * Gating model ("gated for sign-ups"): the page is a public PREVIEW — anyone
 * can see the map, the simulation, and the top forecast. The full watch list,
 * the alert trigger, and CSV/REST export unlock on sign-up (operator-grade
 * export is the Advanced tier).
 */

import { auth } from './auth.js';
import {
    getLatestMap, getMapSeries, getStoredFrames,
    detectSignatures,
    farSideWatchList, farSideWatchListFromFrames,
    projectTracks,
    dispatchEmergenceAlerts,
    renderFlatMap, renderTopDown,
    runSyntheticBacktest,
    carringtonL0,
    simBounds, simStatus, simSpanDays, clampEpoch, advanceEpoch,
    epochToFraction, fractionToEpoch, emergenceMarkers,
    SIM_SPEEDS,
    SOURCES,
} from './farside/index.js';

const $ = (id) => document.getElementById(id);
const DAY_MS = 86400000;

let _state = { map: null, dets: [], tracks: [], anchorWatch: [], signedIn: false, pro: false };
let _globe = null;       // FarSideGlobe instance once the 3D view mounts
/**
 * Who owns #fsw-topdown: 'pending' until mountRotationView() decides, then
 * '3d' (FarSideGlobe) or '2d' (renderTopDown fallback).
 *
 * CRITICAL — nothing may draw on that canvas while this is 'pending'. Taking a
 * 2D context makes the element permanently unable to return a WebGL one
 * ("Canvas has an existing context of a different type"), so a single
 * speculative renderTopDown() before the mount silently downgrades every
 * visitor to the 2D schematic. The clock's first paint runs before the mount,
 * which is exactly when that happens.
 */
let _rotationMode = 'pending';

/**
 * The clock. `anchorMs` is the session's reference "now" and never changes —
 * it pins the planted regions in Carrington longitude (see the "TWO INSTANTS"
 * note in farside-feed.js). `epochMs` is what the user is looking at.
 */
const _sim = {
    anchorMs: 0,
    epochMs: 0,
    playing: false,
    daysPerSec: SIM_SPEEDS[1].daysPerSec,
    raf: 0,
    lastFrame: 0,
    projected: [],
    markers: [],
};

function fmtDate(iso) {
    try { return new Date(iso).toUTCString().replace(':00 GMT', ' UTC').replace('GMT', 'UTC'); }
    catch { return iso; }
}
function fmtDay(iso) {
    try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}
/** "Wed 19 Aug · 14:20 UTC" — compact enough for the clock readout. */
function fmtSimStamp(ms) {
    const d = new Date(ms);
    const day = d.toLocaleDateString('en-GB', {
        weekday: 'short', day: '2-digit', month: 'short', timeZone: 'UTC',
    });
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${day} · ${hh}:${mm} UTC`;
}
function fmtOffset(days) {
    if (Math.abs(days) < 1 / 48) return 'now';
    const s = days >= 0 ? '+' : '−';
    return `${s}${Math.abs(days).toFixed(1)} d`;
}
/** Lead-time caption shared by every surface that quotes one. */
function etaText(t) {
    if (t.onDisc) return 'emerged';
    return t.etaDays < 0.05 ? 'at limb' : `~${t.etaDays.toFixed(1)} d`;
}

// ── Rendering ───────────────────────────────────────────────────────────

function paintFlatMap() {
    const flat = $('fsw-flat');
    if (!flat || !_state.map) return;
    // `L0` is passed explicitly: the field bitmap is the held observation, so
    // the limb markers must be drawn from the CLOCK's L0, not the map's.
    renderFlatMap(flat, _state.map, {
        tracks: _sim.projected,
        showLimbs: true,
        L0: carringtonL0(new Date(_sim.epochMs)).L0,
    });
}

function paintRotationView() {
    if (!_state.map || _rotationMode === 'pending') return;   // see _rotationMode
    if (_rotationMode === '3d') _globe.setEpoch(_sim.epochMs, { tracks: _sim.projected });
    else renderTopDown($('fsw-topdown'), _state.map, { tracks: _sim.projected });
}

/**
 * Mount the 3D rotation simulation on the #fsw-topdown canvas. Dynamically
 * imports the Three.js globe (kept out of the farside barrel so the Node smoke
 * test stays clean) and degrades to the Canvas2D renderTopDown() if WebGL or
 * the import is unavailable.
 */
async function mountRotationView() {
    const canvas = $('fsw-topdown');
    if (!canvas || !_state.map) return;
    try {
        const { FarSideGlobe } = await import('./farside/farside-globe.js');
        _globe = new FarSideGlobe(canvas);
        _rotationMode = '3d';
        _globe.render(_state.map, { tracks: _sim.projected });
        _globe.setEpoch(_sim.epochMs, { tracks: _sim.projected });
        _globe.start();
        const note = canvas.parentElement?.querySelector('.fsw-note-3d');
        if (note) {
            note.innerHTML = 'Drag to orbit · scroll to zoom. The Sun’s orientation is driven by the '
                + 'simulation clock at the true synodic rate (~13.2°/day), so a marker reaches the blue '
                + 'east-limb horizon exactly when its lead time reads zero.';
        }
    } catch (err) {
        // No WebGL / vendor missing — keep the proven 2D schematic. Only now
        // is it safe to take a 2D context on this canvas.
        _rotationMode = '2d';
        _globe = null;
        renderTopDown(canvas, _state.map, { tracks: _sim.projected });
    }
}

function renderWatchList() {
    const host = $('fsw-watchlist');
    if (!host) return;
    const { signedIn } = _state;
    const watch = _sim.projected;
    const pending = watch.filter((t) => !t.onDisc);
    $('fsw-count').textContent = String(watch.length);
    const noun = $('fsw-count-noun');
    if (noun) noun.textContent = watch.length === 1 ? 'region tracked' : 'regions tracked';
    const emergedEl = $('fsw-emerged');
    if (emergedEl) {
        const n = watch.length - pending.length;
        emergedEl.textContent = n ? `${n} emerged` : '';
        emergedEl.hidden = !n;
    }

    if (!watch.length) {
        host.innerHTML = `<p class="fsw-empty">No far-side signatures above threshold in the current map.</p>`;
        return;
    }

    // Preview gating: signed-out users see the single soonest emergence; the
    // rest are blurred behind the sign-up CTA.
    const visible = signedIn ? watch : watch.slice(0, 1);
    const hidden = signedIn ? [] : watch.slice(1);

    const row = (t) => `
      <div class="fsw-track ${t.strong ? 'fsw-track--strong' : ''} ${t.onDisc ? 'fsw-track--emerged' : ''}">
        <div class="fsw-track-hd">
          <span class="fsw-eta">${etaText(t)}</span>
          <span class="fsw-track-pos">L${t.lon.toFixed(0)}° · lat ${t.lat.toFixed(0)}°</span>
          ${t.strong ? '<span class="fsw-chip fsw-chip--strong">STRONG</span>' : ''}
          ${t.validationCase ? '<span class="fsw-chip fsw-chip--val">VALIDATION</span>' : ''}
        </div>
        <div class="fsw-track-meta">
          ${t.onDisc
            ? `<b>Earth-facing</b> · central-meridian distance ${t.cmd.toFixed(0)}°`
            : `emerges <b>${fmtDate(t.emergenceUTC)}</b> ±${t.etaBandDays.toFixed(1)} d`}
          · strength ${t.latestStrength.toFixed(2)}
          · trend ${t.trend >= 0 ? '▲' : '▼'} ${Math.abs(t.trend).toFixed(2)}
          · conf ${(t.confidence * 100).toFixed(0)}%
          · seen ${t.frames}×
          ${t.validationCase ? `<br><span class="fsw-val-note">↳ ${t.validationCase.label}</span>` : ''}
        </div>
      </div>`;

    host.innerHTML = visible.map(row).join('')
        + (hidden.length
            ? `<div class="fsw-gate-inline">
                 <div class="fsw-gate-blur">${hidden.map(row).join('')}</div>
                 <div class="fsw-gate-cta">
                   <p><b>${hidden.length}</b> more far-side ${hidden.length === 1 ? 'region' : 'regions'} tracked.</p>
                   <p class="fsw-gate-sub">Sign up free to unlock the full watch list, the "rotating into view" alert, and CSV/REST export.</p>
                   <a class="fsw-btn fsw-btn--primary" href="/signup.html?from=far-side-watch">Sign up →</a>
                   <a class="fsw-btn" href="/signin.html?from=far-side-watch">Sign in</a>
                 </div>
               </div>`
            : '');
}

/** Clock readouts + the scrubber's emergence ticks. */
function renderClock() {
    const status = simStatus(_sim.epochMs, _sim.anchorMs);

    const stamp = $('fsw-sim-stamp');
    if (stamp) stamp.textContent = fmtSimStamp(_sim.epochMs);
    const off = $('fsw-sim-offset');
    if (off) {
        off.textContent = fmtOffset(status.offsetDays);
        off.classList.toggle('is-now', status.isNow);
    }
    const l0 = $('fsw-l0');
    if (l0) l0.textContent = `L0 ${status.L0.toFixed(1)}° · B0 ${status.B0.toFixed(1)}°`;

    const scrub = $('fsw-scrub');
    if (scrub && document.activeElement !== scrub) {
        scrub.value = String(epochToFraction(_sim.epochMs, _sim.anchorMs));
    }

    // Soonest still-pending emergence, from the projection the list shows.
    const next = _sim.projected.find((t) => !t.onDisc);
    const nextEl = $('fsw-next-emerge');
    if (nextEl) {
        nextEl.textContent = next
            ? `next emergence ${etaText(next)}`
            : 'all tracked regions Earth-facing';
    }
}

/** One-time: emergence ticks along the scrubber, plus the "now" mark. */
function renderScrubTicks() {
    const host = $('fsw-scrub-ticks');
    if (!host) return;
    const nowPct = epochToFraction(_sim.anchorMs, _sim.anchorMs) * 100;
    // The scale's "now" caption rides the same fraction as the tick.
    const nowLabel = $('fsw-scrub-now');
    if (nowLabel) nowLabel.style.left = `${nowPct}%`;
    host.innerHTML = `<i class="fsw-tick fsw-tick--now" style="left:${nowPct}%" title="now"></i>`
        + _sim.markers.map((m) => {
            const pct = m.fraction * 100;
            const label = `${m.strong ? 'strong ' : ''}region emerges in ${m.etaDays.toFixed(1)} d`;
            return `<i class="fsw-tick ${m.strong ? 'fsw-tick--strong' : ''}" style="left:${pct}%" title="${label}"></i>`;
        }).join('');
}

function renderBacktest() {
    const r = _state.backtest;
    if (!r) return;
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    if ($('fsw-bt-detect')) $('fsw-bt-detect').textContent = pct(r.detectionRate);
    if ($('fsw-bt-lead'))   $('fsw-bt-lead').textContent = r.medianLeadDays != null ? `${r.medianLeadDays.toFixed(1)}d` : '—';
    if ($('fsw-bt-far'))    $('fsw-bt-far').textContent = pct(r.falseAlarmRate);
    if ($('fsw-bt-eta'))    $('fsw-bt-eta').textContent = r.meanEtaErrorDays != null ? `${r.meanEtaErrorDays.toFixed(2)}d` : '—';

    const host = $('fsw-validation');
    if (host) {
        host.innerHTML = r.perCase.map((c) => `
          <div class="fsw-val ${c.detected ? 'fsw-val--hit' : ''}">
            <div class="fsw-val-hd">${c.detected ? '✓' : '✗'} ${c.label}</div>
            <div class="fsw-val-meta">
              E-limb crossing ${fmtDay(c.crossingUTC)}${c.noaaRegion ? ` · AR${c.noaaRegion}` : ''}
              ${c.detected
                ? `· <b>flagged ${c.leadDays.toFixed(1)} d ahead</b> · ETA err ${c.etaErrorDays >= 0 ? '+' : ''}${c.etaErrorDays.toFixed(2)} d`
                : '· missed'}
            </div>
          </div>`).join('');
    }
}

function setSourcePill(map) {
    const pill = $('fsw-source-pill');
    if (!pill) return;
    if (map.synthetic) {
        pill.textContent = '⚠ SYNTHETIC — pipeline preview';
        pill.className = 'fsw-pill fsw-pill--synthetic';
    } else {
        pill.textContent = `● LIVE — ${SOURCES[map.source]?.label ?? map.source}`;
        pill.className = 'fsw-pill fsw-pill--live';
    }
    $('fsw-updated').textContent = fmtDate(map.timestamp);
}

// ── The clock ───────────────────────────────────────────────────────────

/**
 * Move the simulation to an instant and repaint everything that depends on it.
 * The single entry point — nothing else may write `_sim.epochMs`.
 */
function setEpoch(ms) {
    _sim.epochMs = clampEpoch(ms, _sim.anchorMs);
    const { L0 } = carringtonL0(new Date(_sim.epochMs));
    _sim.projected = projectTracks(_state.tracks, L0, _sim.epochMs);
    paintFlatMap();
    paintRotationView();
    renderWatchList();
    renderClock();
}

function setPlaying(on) {
    _sim.playing = !!on;
    const btn = $('fsw-play');
    if (btn) {
        btn.textContent = _sim.playing ? '❚❚ Pause' : '▶ Play';
        btn.setAttribute('aria-pressed', String(_sim.playing));
    }
    document.body.classList.toggle('fsw-playing', _sim.playing);

    if (!_sim.playing) {
        if (_sim.raf) cancelAnimationFrame(_sim.raf);
        _sim.raf = 0;
        return;
    }
    // Restarting from the end of the window rewinds to the anchor, otherwise
    // pressing Play at the far edge would look broken.
    const { endMs } = simBounds(_sim.anchorMs);
    if (_sim.epochMs >= endMs - 1) setEpoch(_sim.anchorMs);

    _sim.lastFrame = performance.now();
    const loop = (now) => {
        if (!_sim.playing) return;
        _sim.raf = requestAnimationFrame(loop);
        // Cap dt so a backgrounded tab does not resume by jumping days.
        const dt = Math.min((now - _sim.lastFrame) / 1000, 0.1);
        _sim.lastFrame = now;
        const step = advanceEpoch(_sim.epochMs, dt, _sim.daysPerSec, _sim.anchorMs);
        setEpoch(step.epochMs);
        if (step.ended) setPlaying(false);
    };
    _sim.raf = requestAnimationFrame(loop);
}

function toCSV(watch) {
    const head = 'lon_carrington,lat,eta_days,eta_band_days,emergence_utc,strength,trend,confidence,frames,strong,validation_case';
    const rows = watch.map((t) => [
        t.lon.toFixed(2), t.lat.toFixed(2), t.etaDays.toFixed(3), t.etaBandDays.toFixed(3),
        t.emergenceUTC, t.latestStrength.toFixed(3), t.trend.toFixed(3),
        t.confidence.toFixed(3), t.frames, t.strong ? 1 : 0, t.validationCase?.id ?? '',
    ].join(','));
    return [head, ...rows].join('\n');
}

function wireControls() {
    const exportBtn = $('fsw-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (!_state.signedIn) { location.href = '/signup.html?from=far-side-watch'; return; }
            // The ANCHOR watch list, never the scrubbed projection: the export
            // is the forecast artifact, and its lead times are quoted from
            // real now. A simulated viewing time is not a new forecast.
            const blob = new Blob([toCSV(_state.anchorWatch)], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `far-side-watch_${fmtDay(_state.map.timestamp)}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }

    const alertBtn = $('fsw-alert-toggle');
    if (alertBtn) {
        alertBtn.addEventListener('click', () => {
            if (!_state.signedIn) { location.href = '/signup.html?from=far-side-watch'; return; }
            // Anchor projection again — see the header. Scrubbing forward must
            // never be able to manufacture a warning.
            const fired = dispatchEmergenceAlerts(_state.anchorWatch, { force: true });
            alertBtn.textContent = fired.length
                ? `🔔 ${fired.length} alert${fired.length > 1 ? 's' : ''} sent`
                : '🔔 No region inside the lead window';
            setTimeout(() => { alertBtn.textContent = '🔔 Test emergence alert'; }, 3200);
        });
    }

    const play = $('fsw-play');
    if (play) play.addEventListener('click', () => setPlaying(!_sim.playing));

    const nowBtn = $('fsw-now');
    if (nowBtn) nowBtn.addEventListener('click', () => { setPlaying(false); setEpoch(_sim.anchorMs); });

    const scrub = $('fsw-scrub');
    if (scrub) {
        scrub.addEventListener('input', () => {
            setPlaying(false);
            setEpoch(fractionToEpoch(scrub.value, _sim.anchorMs));
        });
    }

    const speed = $('fsw-speed');
    if (speed) {
        speed.innerHTML = SIM_SPEEDS
            .map((s) => `<option value="${s.daysPerSec}">${s.label}</option>`).join('');
        speed.value = String(_sim.daysPerSec);
        speed.addEventListener('change', () => {
            _sim.daysPerSec = Number(speed.value) || SIM_SPEEDS[1].daysPerSec;
        });
    }

    // Keyboard: space toggles playback, arrows step a quarter-day. Ignored
    // while a form control has focus so the scrubber's own arrow keys work.
    window.addEventListener('keydown', (e) => {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.code === 'Space') { e.preventDefault(); setPlaying(!_sim.playing); }
        else if (e.code === 'ArrowRight') { setPlaying(false); setEpoch(_sim.epochMs + 0.25 * DAY_MS); }
        else if (e.code === 'ArrowLeft') { setPlaying(false); setEpoch(_sim.epochMs - 0.25 * DAY_MS); }
    });

    // Playback burns a frame budget for nothing behind a hidden tab.
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && _sim.playing) setPlaying(false);
    });

    // The 3D globe self-manages resize (ResizeObserver); the flat map and the
    // 2D fallback need a manual repaint.
    window.addEventListener('resize', () => {
        if (!_state.map) return;
        paintFlatMap();
        if (_rotationMode === '2d') renderTopDown($('fsw-topdown'), _state.map, { tracks: _sim.projected });
    }, { passive: true });
}

export async function initFarSideWatch() {
    try { await auth.ready(); } catch (_) {}
    _state.signedIn = !!auth.isSignedIn?.();
    _state.pro = !!auth.isPro?.();

    // Reflect gate state on the page chrome.
    document.body.classList.toggle('fsw-signedin', _state.signedIn);
    const exportBtn = $('fsw-export');
    if (exportBtn && !_state.signedIn) exportBtn.title = 'Sign up to export';

    _sim.anchorMs = Date.now();
    _sim.epochMs = _sim.anchorMs;

    wireControls();

    // Latest map for rendering: real stored grid if the cron has populated one,
    // else a labelled synthetic field pinned to this session's anchor.
    const map = await getLatestMap('gong', { atMs: _sim.anchorMs, anchorMs: _sim.anchorMs });
    _state.map = map;
    _state.dets = detectSignatures(map);

    // Tracks: prefer the cron's stored detection history; fall back to
    // detecting a synthetic series when nothing is stored yet. This is the
    // expensive step and it runs ONCE — scrubbing only re-projects.
    const frames = await getStoredFrames('gong');
    if (frames && frames.length) {
        _state.tracks = farSideWatchListFromFrames(frames);
    } else {
        _state.tracks = farSideWatchList(
            await getMapSeries('gong', undefined, { atMs: _sim.anchorMs, anchorMs: _sim.anchorMs }));
    }
    // The forecast as of real now — what alerts and exports are allowed to use.
    _state.anchorWatch = projectTracks(
        _state.tracks, carringtonL0(new Date(_sim.anchorMs)).L0, _sim.anchorMs);
    _sim.markers = emergenceMarkers(_state.tracks, _sim.anchorMs);

    // Phase-5 backtest: synthetic history today; swaps to the real farside_maps
    // archive once it has a few rotations covering a known emergence.
    try { _state.backtest = runSyntheticBacktest(); } catch (_) { _state.backtest = null; }

    setSourcePill(map);
    const span = $('fsw-span');
    if (span) span.textContent = `${simSpanDays().toFixed(0)} d`;

    setEpoch(_sim.anchorMs);   // paints map, watch list, clock (NOT the rotation
                               // view — that canvas is still unclaimed)
    renderScrubTicks();
    renderBacktest();
    // Claims #fsw-topdown and paints it for the first time. Awaited so the
    // page is not interactive before the rotation view exists.
    await mountRotationView();

    // Fire emergence alerts once for signed-in users (de-duped in the module).
    if (_state.signedIn) dispatchEmergenceAlerts(_state.anchorWatch);

    // Try to drop the upstream image in as a backdrop; hide on failure.
    const img = $('fsw-img');
    if (img) {
        img.addEventListener('error', () => { img.style.display = 'none'; });
        img.src = SOURCES.gong.endpoint;
    }

    document.body.dataset.fswReady = 'true';
}
