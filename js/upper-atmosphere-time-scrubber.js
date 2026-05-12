/**
 * upper-atmosphere-time-scrubber.js — operator scrubber on top of TimeBus
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase E: the operator-facing widget that turns the time-bus into a
 * direct-manipulation surface. Anchored to the bottom of the globe
 * canvas (familiar video-scrubber paradigm — most ops users have
 * muscle-memory for "drag the handle to a moment"). The whole widget
 * is purely a controller; all sim-state lives on the shared TimeBus.
 *
 * What it does
 * ────────────
 *   • Renders a horizontal track scaled to the bus's bounds (default
 *     -30 d past .. +1 h future, configurable on the bus).
 *   • Live handle reflects bus.simTimeMs every frame, driven by
 *     bus.onTick (advance) + bus.onJump (explicit set).
 *   • Drag the handle (or click the track) → bus.setSimTime() with
 *     pixel→ms mapping. While dragging the bus's rate is forced to 0
 *     so the simulation doesn't crawl out from under the operator.
 *   • On drag release: if the operator landed within 30 s of wall-
 *     clock now, restore the prior rate (back to live). Otherwise
 *     stay paused — the operator is examining a moment, not playing.
 *   • Tick marks labelled at sensible offsets (-30d / -7d / -24h /
 *     -1h / now / +1h) keep the operator oriented.
 *   • Live UTC readout to seconds. Severity chip on mode:
 *       LIVE / PAUSED / WARP / REPLAY.
 *   • Snap-to-now button restores rate=1 and simTime=wall-clock.
 *
 * What it deliberately doesn't do
 * ────────────────────────────────
 *   • Doesn't own any sim state. Mutations go through the bus; reads
 *     come from the bus. The widget is replaceable / re-mountable.
 *   • Doesn't auto-mount. Caller passes a host element and constructs
 *     a TimeScrubber. Multiple scrubbers can coexist (each subscribes
 *     to the same bus + reflects the same value).
 *   • Doesn't debounce its setSimTime calls during drag. The bus is
 *     cheap to mutate; downstream consumers that ARE expensive
 *     (analyzer, MC sweeps) already cache on a deadband and re-trigger
 *     only when their inputs cross a meaningful boundary.
 *
 * Cleanup
 * ───────
 * Caller can call .destroy() to unmount the DOM + drop subscriptions
 * — pattern matches the FloatingWindow / FleetPanel destructors.
 */

import { getTimeBus } from './upper-atmosphere-time-bus.js';

// Stylable via design tokens (Phase 22). The widget pulls its sizing
// from CSS custom properties on the host, so a smaller embedding
// (e.g. a sidebar) just tightens the tokens locally.
const HANDLE_DRAG_TOLERANCE_MS = 30_000;   // snap to live on release
const DOUBLE_CLICK_MS          = 350;      // dblclick → snap to now

// ── Tick marks. Each entry is { offsetMs, label } where offsetMs is
// "relative to wall-clock now" (negative = past). The widget projects
// these onto the track using the bus's CURRENT bounds (so a tick can
// drift in/out of range as wall-clock advances). ──────────────────────
const TICKS = Object.freeze([
    { offsetMs: -30 * 86400000, label: '-30d' },
    { offsetMs: -7  * 86400000, label: '-7d'  },
    { offsetMs: -24 * 3600000,  label: '-24h' },
    { offsetMs: -1  * 3600000,  label: '-1h'  },
    { offsetMs:  0,             label: 'now'  },
    { offsetMs:  1  * 3600000,  label: '+1h'  },
]);

export class TimeScrubber {
    /**
     * @param {HTMLElement} host           container element (widget appends to this)
     * @param {object} [opts]
     * @param {object} [opts.bus]          override the singleton (testing)
     * @param {string} [opts.label]        readout heading
     */
    constructor(host, opts = {}) {
        if (!host) throw new Error('TimeScrubber: host element required');
        this.host  = host;
        this.bus   = opts.bus || getTimeBus();
        this.label = opts.label || 'sim time';

        // Interaction state.
        this._dragging         = false;
        this._dragPointerId    = null;
        this._dragRatePrePause = null;
        this._lastClickAt      = 0;

        this._mountDOM();
        this._wireEvents();
        this._subscribe();
        this._render();
    }

    /** Drop the widget cleanly. */
    destroy() {
        this._offTick?.();
        this._offJump?.();
        window.removeEventListener('resize', this._onResize);
        this._el?.remove();
        this._el = null;
    }

    // ── DOM ────────────────────────────────────────────────────────────

    _mountDOM() {
        const el = document.createElement('div');
        el.className = 'ua-scrub';
        el.innerHTML = `
            <div class="ua-scrub-head">
                <span class="ua-scrub-utc" data-utc>—</span>
                <span class="ua-scrub-mode" data-mode>—</span>
                <span class="ua-scrub-rate" data-rate></span>
                <button type="button" class="ua-scrub-snap" data-snap
                        title="Snap to wall-clock now + rate=1×">⏭ Now</button>
            </div>
            <div class="ua-scrub-track" data-track>
                <div class="ua-scrub-track-fill"   data-fill></div>
                <div class="ua-scrub-track-ticks"  data-ticks></div>
                <button type="button" class="ua-scrub-handle" data-handle
                        title="Drag to a specific moment; double-click to snap to now"></button>
            </div>
        `;
        this.host.appendChild(el);
        this._el     = el;
        this._utcEl  = el.querySelector('[data-utc]');
        this._modeEl = el.querySelector('[data-mode]');
        this._rateEl = el.querySelector('[data-rate]');
        this._track  = el.querySelector('[data-track]');
        this._fill   = el.querySelector('[data-fill]');
        this._ticks  = el.querySelector('[data-ticks]');
        this._handle = el.querySelector('[data-handle]');
        this._snap   = el.querySelector('[data-snap]');
        this._renderTicks();
    }

    _renderTicks() {
        // Re-render tick labels each time so they reflect the CURRENT
        // wall-clock anchor. Tokens (--ua-text-faint) inherited from
        // the panel container's design-token scope.
        this._ticks.innerHTML = '';
        const { pastMs, futureMs } = this.bus.getBounds();
        const now = Date.now();
        const rangeMs = futureMs - pastMs;
        for (const tick of TICKS) {
            const targetMs = now + tick.offsetMs;
            if (targetMs < pastMs || targetMs > futureMs) continue;
            const frac = (targetMs - pastMs) / rangeMs;
            const x = `${(frac * 100).toFixed(2)}%`;
            const tickEl = document.createElement('span');
            tickEl.className = 'ua-scrub-tick';
            tickEl.style.left = x;
            tickEl.innerHTML = `<span class="ua-scrub-tick-mark"></span>`
                             + `<span class="ua-scrub-tick-label">${tick.label}</span>`;
            this._ticks.appendChild(tickEl);
        }
    }

    // ── Events ─────────────────────────────────────────────────────────

    _wireEvents() {
        // Pointer interactions on the track. Capture lets us continue
        // the drag even when the mouse moves outside the track bounds
        // (the operator's hand often overshoots).
        this._track.addEventListener('pointerdown', (e) => this._onPointerDown(e));
        this._track.addEventListener('pointermove', (e) => this._onPointerMove(e));
        this._track.addEventListener('pointerup',   (e) => this._onPointerUp(e));
        this._track.addEventListener('pointercancel', (e) => this._onPointerUp(e));

        // Dblclick → snap. Detected by manual interval comparison since
        // 'dblclick' fires AFTER the second click and we've already
        // moved the simTime by then; intercepting both clicks is cleaner.
        this._track.addEventListener('click', (e) => this._maybeDoubleClick(e));

        // Snap button.
        this._snap.addEventListener('click', () => this.bus.snapToNow());

        // Re-project ticks + handle on resize (the pixel → ms mapping
        // depends on the track's clientWidth).
        this._onResize = () => { this._renderTicks(); this._render(); };
        window.addEventListener('resize', this._onResize);
    }

    _subscribe() {
        // Two channels: continuous tick for advancement + jump for
        // discrete repositioning. Both render the same fields; we
        // keep them split so future consumers can differentiate.
        this._offTick = this.bus.onTick(() => { if (!this._dragging) this._render(); });
        this._offJump = this.bus.onJump(() => { if (!this._dragging) this._render(); });
    }

    // ── Render ─────────────────────────────────────────────────────────

    _render() {
        if (!this._el) return;
        const sim  = this.bus.getSimTime();
        const rate = this.bus.getRate();
        const mode = this.bus.getMode();

        // UTC label: "2026-05-12 14:32:18 UTC". toISOString gives
        // "2026-05-12T14:32:18.123Z" — slice to seconds + tag UTC.
        const iso = new Date(sim).toISOString();
        const utc = iso.slice(0, 10) + ' ' + iso.slice(11, 19) + ' UTC';
        this._utcEl.textContent = utc;

        // Mode chip: token-driven colour. Phase 22 design tokens give
        // us amber for paused/warp, green for live, red for replay.
        const modeLabel = mode === 'replay' ? 'REPLAY'
                        : mode === 'paused' ? 'PAUSED'
                        : mode === 'warp'   ? 'WARP'
                        : 'LIVE';
        this._modeEl.textContent = modeLabel;
        this._modeEl.dataset.mode = mode;       // CSS hooks off this

        // Rate chip — only when non-1× (otherwise redundant with mode).
        if (Math.abs(rate - 1) < 1e-9 || rate === 0) {
            this._rateEl.textContent = '';
            this._rateEl.style.display = 'none';
        } else {
            this._rateEl.textContent = rate > 0 ? `${rate}×` : `${rate}×`;
            this._rateEl.style.display = '';
        }

        // Handle position: pixel offset from track left, projected
        // through the current bus bounds.
        const { pastMs, futureMs } = this.bus.getBounds();
        const range = futureMs - pastMs;
        const frac = Math.max(0, Math.min(1,
            (sim - pastMs) / Math.max(1, range)));
        const x = `${(frac * 100).toFixed(3)}%`;
        this._handle.style.left = x;
        this._fill.style.width  = x;
    }

    // ── Interaction handlers ───────────────────────────────────────────

    _onPointerDown(e) {
        // Left button only; right/middle keep browser-default behaviour.
        if (e.button !== 0) return;
        this._dragging = true;
        this._dragPointerId = e.pointerId;
        this._dragRatePrePause = this.bus.getRate();
        // Freeze the bus so it doesn't advance under the operator's
        // finger. setSimTime calls below will move it; we restore the
        // rate on release.
        this.bus.pause();
        this._track.setPointerCapture?.(e.pointerId);
        this._el.classList.add('is-dragging');
        this._applyClientX(e.clientX);
        e.preventDefault();
    }
    _onPointerMove(e) {
        if (!this._dragging || e.pointerId !== this._dragPointerId) return;
        this._applyClientX(e.clientX);
    }
    _onPointerUp(e) {
        if (!this._dragging) return;
        this._dragging = false;
        try { this._track.releasePointerCapture?.(e.pointerId); } catch (_) {}
        this._el.classList.remove('is-dragging');
        // If the operator landed within 30 s of wall-clock now, treat
        // the gesture as "go live" — restore the prior rate. Otherwise
        // stay paused; the operator is examining a moment.
        //
        // We read "wall" through the bus's getBounds().nowMs rather
        // than Date.now() directly. The bus may have a non-default
        // clock injected (tests; future page-time-offset features),
        // and the widget should match whatever the bus considers
        // "now" — not race a separate Date.now() that drifts.
        const sim  = this.bus.getSimTime();
        const wall = this.bus.getBounds().nowMs;
        if (Math.abs(sim - wall) < HANDLE_DRAG_TOLERANCE_MS) {
            this.bus.snapToNow();
        }
        // else: bus stays paused at the new simTime
        this._dragPointerId = null;
    }

    _applyClientX(clientX) {
        const rect = this._track.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
        const frac = rect.width > 0 ? x / rect.width : 0;
        const { pastMs, futureMs } = this.bus.getBounds();
        const ms = pastMs + frac * (futureMs - pastMs);
        // setSimTime emits an onJump event; our subscriber skips the
        // render while _dragging is true (we own the visual state
        // directly during drag), so we re-render here.
        this.bus.setSimTime(ms, { reason: 'scrub' });
        this._render();
    }

    _maybeDoubleClick(e) {
        const now = performance.now();
        if (now - this._lastClickAt < DOUBLE_CLICK_MS) {
            // Avoid a feedback loop: dblclick on the track snaps to now.
            this.bus.snapToNow();
        }
        this._lastClickAt = now;
    }
}
