/**
 * time-strip.js — Bidirectional binding between the DOM transport
 * controls and the time-bus.
 *
 *   DOM → bus  : pointer drag on the track, transport buttons, speed
 *                buttons, keyboard shortcuts (Space, N, ←, →).
 *   bus → DOM  : cursor position, "now" tick position, mode chip,
 *                play/pause glyph, active speed highlight, readout.
 *
 * The bus emits at ≤ 10 Hz which is plenty for a UTC seconds readout
 * and CSS `left:` updates. A 60 Hz globe (step 10+) reads getState()
 * inline instead of subscribing.
 */

import { timeBus } from './time-bus.js';

const MIN_MS  = 60 * 1000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS  = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function pad2(n) { return String(n).padStart(2, '0'); }

function formatUtc(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
           `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

function formatOffset(simMs, nowMs) {
    const diff = simMs - nowMs;
    const abs  = Math.abs(diff);
    if (abs < 30_000) return 'now';
    const sign = diff < 0 ? '−' : '+';
    if (abs < HOUR_MS) {
        const m = Math.floor(abs / 60_000);
        const s = Math.floor((abs % 60_000) / 1000);
        return `${sign}${m}m ${pad2(s)}s`;
    }
    if (abs < DAY_MS) {
        const h = Math.floor(abs / HOUR_MS);
        const m = Math.floor((abs % HOUR_MS) / 60_000);
        return `${sign}${h}h ${pad2(m)}m`;
    }
    const d = Math.floor(abs / DAY_MS);
    const h = Math.floor((abs % DAY_MS) / HOUR_MS);
    return `${sign}${d}d ${pad2(h)}h`;
}

const MODE_META = Object.freeze({
    live:   Object.freeze({ label: 'Live',   cls: 'op-chip--live'   }),
    scrub:  Object.freeze({ label: 'Scrub',  cls: 'op-chip--scrub'  }),
    replay: Object.freeze({ label: 'Replay', cls: 'op-chip--replay' }),
});

export function mountTimeStrip(opts) {
    const {
        track, cursor, nowTick,
        modeChip, modeLabel,
        btnHome, btnBack, btnPlay, btnFwd, btnEnd, btnNow,
        speedBtns, jumpBtns, readout,
    } = opts;

    if (!track || !cursor) {
        console.warn('[timeStrip] missing track/cursor; aborting mount');
        return () => {};
    }

    /* ─── DOM → bus ───────────────────────────────────────── */

    let dragging = false;

    function trackToSimMs(clientX) {
        const rect    = track.getBoundingClientRect();
        const t       = (clientX - rect.left) / rect.width;
        const clamped = Math.max(0, Math.min(1, t));
        const { rangeMs } = timeBus.getState();
        return rangeMs.start + clamped * (rangeMs.end - rangeMs.start);
    }

    function onPointerDown(ev) {
        if (ev.button != null && ev.button !== 0) return;
        dragging = true;
        try { track.setPointerCapture?.(ev.pointerId); } catch (_) {}
        timeBus.setSimTime(trackToSimMs(ev.clientX), { fromUser: true });
        ev.preventDefault();
    }
    function onPointerMove(ev) {
        if (!dragging) return;
        timeBus.setSimTime(trackToSimMs(ev.clientX), { fromUser: true });
    }
    function onPointerUp(ev) {
        if (!dragging) return;
        dragging = false;
        try { track.releasePointerCapture?.(ev.pointerId); } catch (_) {}
    }

    track.addEventListener('pointerdown',   onPointerDown);
    track.addEventListener('pointermove',   onPointerMove);
    track.addEventListener('pointerup',     onPointerUp);
    track.addEventListener('pointercancel', onPointerUp);

    /* ─── Buttons ─────────────────────────────────────────── */

    btnHome?.addEventListener('click', () => {
        const { rangeMs } = timeBus.getState();
        timeBus.setSimTime(rangeMs.start, { fromUser: true });
    });
    btnBack?.addEventListener('click', () => timeBus.step(-HOUR_MS));
    btnPlay?.addEventListener('click', () => timeBus.togglePlay());
    btnFwd ?.addEventListener('click', () => timeBus.step(+HOUR_MS));
    btnEnd ?.addEventListener('click', () => {
        const { rangeMs } = timeBus.getState();
        timeBus.setSimTime(rangeMs.end, { fromUser: true });
    });
    btnNow?.addEventListener('click', () => timeBus.setMode('live'));

    speedBtns?.forEach(btn => {
        btn.addEventListener('click', () => {
            const speed = Number(btn.dataset.speed);
            timeBus.setSpeed(speed);
            if (timeBus.getState().mode !== 'replay') timeBus.setMode('replay');
        });
    });

    // Forward-jump buttons: each carries a millisecond delta in
    // data-jump-ms. Predictions-first UX, so jumps are positive by
    // default — a negative delta still works if a button declares one.
    jumpBtns?.forEach(btn => {
        btn.addEventListener('click', () => {
            const deltaMs = Number(btn.dataset.jumpMs);
            if (!Number.isFinite(deltaMs) || deltaMs === 0) return;
            timeBus.step(deltaMs);
        });
    });

    /* ─── Keyboard ────────────────────────────────────────── */

    function onKey(ev) {
        // Don't hijack typing inside form fields.
        const t = ev.target;
        if (t?.matches?.('input,textarea,select,[contenteditable="true"]')) return;

        switch (ev.key) {
            case ' ':
                ev.preventDefault();
                if (timeBus.getState().mode === 'live') timeBus.setMode('scrub');
                else timeBus.togglePlay();
                break;
            case 'n':
            case 'N':
                if (ev.metaKey || ev.ctrlKey) return;
                timeBus.setMode('live');
                break;
            case 'ArrowLeft':
                if (timeBus.getState().mode !== 'live') {
                    ev.preventDefault();
                    timeBus.step(-HOUR_MS);
                }
                break;
            case 'ArrowRight':
                if (timeBus.getState().mode !== 'live') {
                    ev.preventDefault();
                    timeBus.step(+HOUR_MS);
                }
                break;
        }
    }
    document.addEventListener('keydown', onKey);

    /* ─── ARIA ────────────────────────────────────────────── */

    track.setAttribute('role', 'slider');
    track.setAttribute('aria-label', 'Simulation time');
    if (!track.hasAttribute('tabindex')) track.setAttribute('tabindex', '0');

    /* ─── bus → DOM ───────────────────────────────────────── */

    function render(snap) {
        const { mode, simTimeMs, speed, paused, rangeMs, nowMs } = snap;
        const span = rangeMs.end - rangeMs.start;

        // Cursor.
        const tCursor = (simTimeMs - rangeMs.start) / span;
        cursor.style.left = `${(tCursor * 100).toFixed(3)}%`;
        track.setAttribute('aria-valuemin',  String(rangeMs.start));
        track.setAttribute('aria-valuemax',  String(rangeMs.end));
        track.setAttribute('aria-valuenow',  String(Math.round(simTimeMs)));
        track.setAttribute('aria-valuetext', formatUtc(simTimeMs));

        // "Now" tick — drifts visibly even while the cursor stays put.
        if (nowTick) {
            const tNow = (nowMs - rangeMs.start) / span;
            nowTick.style.left = `${(tNow * 100).toFixed(3)}%`;
        }

        // Mode chip in the hero.
        const meta = MODE_META[mode] || MODE_META.live;
        if (modeChip) {
            modeChip.classList.remove('op-chip--live', 'op-chip--scrub', 'op-chip--replay');
            modeChip.classList.add(meta.cls);
        }
        if (modeLabel) {
            let label = meta.label;
            if (mode === 'replay') {
                label += paused ? ' · paused' : ` · ${speed}×`;
            } else if (mode === 'scrub') {
                label += ` · ${formatOffset(simTimeMs, nowMs)}`;
            }
            modeLabel.textContent = label;
        }

        // Play/pause glyph.
        if (btnPlay) {
            const playing = mode === 'replay' && !paused;
            btnPlay.textContent = playing ? '⏸' : '▶︎';
            btnPlay.title       = playing ? 'Pause (Space)' : 'Play replay (Space)';
        }

        // Speed highlight (replay-only).
        speedBtns?.forEach(btn => {
            const on = mode === 'replay' && Number(btn.dataset.speed) === speed;
            btn.classList.toggle('op-scrub-btn--on', on);
        });

        // Readout under the track.
        if (readout) {
            readout.textContent = `${formatUtc(simTimeMs)} · ${formatOffset(simTimeMs, nowMs)} · ${mode}`;
        }
    }

    const off = timeBus.subscribe(render);

    return () => {
        off();
        document.removeEventListener('keydown', onKey);
        track.removeEventListener('pointerdown',   onPointerDown);
        track.removeEventListener('pointermove',   onPointerMove);
        track.removeEventListener('pointerup',     onPointerUp);
        track.removeEventListener('pointercancel', onPointerUp);
    };
}
