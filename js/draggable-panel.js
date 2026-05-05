/**
 * draggable-panel.js — pointer-driven repositioning for the Earth-app panels
 *
 * Why this exists
 * ───────────────
 * The layer / wx / info / loc panels were stuck where the CSS placed them.
 * On wide desktops that's fine; on tablets the wx panel sits on top of the
 * globe's centre of mass and on phones the layer panel hides half the
 * Earth. This module turns the existing `.panel-header` into a drag
 * handle so the user can move any panel anywhere, and persists the
 * position per panel so the next visit lands the panel where they left
 * it.
 *
 * Design choices
 * ──────────────
 *   - Pointer events, not mouse + touch separately. Modern browsers all
 *     support them and we don't have to write two parallel code paths
 *     for a finger-vs-cursor distinction the user shouldn't have to care
 *     about.
 *   - We never touch the panel's existing `right`/`bottom` CSS properties
 *     — instead we override `left`/`top` once a drag starts. That keeps
 *     the un-dragged default layout (right-anchored on desktop) intact
 *     for first-time visitors.
 *   - Header buttons (.panel-btn, .panel-close) are guarded so the
 *     close/minimize affordances still click cleanly. The header itself
 *     is the drag handle; clicks on its buttons short-circuit the drag.
 *   - We clamp the panel to the viewport on drop AND on every viewport
 *     resize. A user who shrinks the browser or rotates a phone
 *     shouldn't have to chase a panel that ended up off-screen.
 *   - Tiny drags (< 4 px) are treated as clicks so the existing
 *     header-click → minimise toggle still works on touch devices.
 *
 * Storage
 * ───────
 * `localStorage[earth-panel-pos-{id}] = JSON({left, top})` in viewport
 * pixels. We re-clamp on read so a stored position from a 27" monitor
 * doesn't push the panel off the side of an iPhone.
 */

const STORAGE_PREFIX = 'earth-panel-pos-';
const CLICK_THRESHOLD_PX = 4;
// Min visible chrome of a dragged panel — the user must always have
// something to grab onto. Without this they could drag a panel until
// only a 1-pixel sliver showed, then never get it back.
const MIN_VISIBLE_PX = 36;

function clampToViewport(panel, left, top) {
    const w = panel.offsetWidth  || 1;
    const h = panel.offsetHeight || 1;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minLeft = MIN_VISIBLE_PX - w;     // panel can drag mostly off-left, leaving 36 px chrome
    const maxLeft = vw - MIN_VISIBLE_PX;
    const minTop  = 0;                      // never let header go above viewport (becomes ungrabbable)
    const maxTop  = vh - MIN_VISIBLE_PX;
    return {
        left: Math.min(maxLeft, Math.max(minLeft, left)),
        top:  Math.min(maxTop,  Math.max(minTop,  top)),
    };
}

function readStoredPos(id) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + id);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !Number.isFinite(obj.left) || !Number.isFinite(obj.top)) return null;
        return obj;
    } catch (_) {
        return null;
    }
}

function writeStoredPos(id, pos) {
    try {
        localStorage.setItem(STORAGE_PREFIX + id, JSON.stringify(pos));
    } catch (_) {}
}

/**
 * Make `panel` draggable by its `.panel-header`. Idempotent: calling
 * twice on the same panel adds only one set of listeners.
 *
 * @param {HTMLElement} panel
 * @param {object}      [opts]
 * @param {string}      [opts.id]      Override the panel's id for storage.
 *                                     Defaults to panel.id.
 * @param {boolean}     [opts.persist] Write/read localStorage. Default true.
 */
export function makePanelDraggable(panel, { id, persist = true } = {}) {
    if (!panel || panel.dataset.draggableWired === '1') return;
    panel.dataset.draggableWired = '1';

    const storageId = id ?? panel.id;
    const header = panel.querySelector('.panel-header');
    if (!header) return;

    // Visual affordance: the header's existing cursor:pointer becomes
    // grab/grabbing for clarity. Buttons inside the header keep the
    // default cursor via the .panel-btn rule.
    header.style.cursor = 'grab';
    header.style.touchAction = 'none';   // disable browser scroll-while-dragging

    // Apply stored position if present and valid for the current viewport.
    const stored = persist ? readStoredPos(storageId) : null;
    if (stored) {
        const pos = clampToViewport(panel, stored.left, stored.top);
        applyAbsolutePosition(panel, pos.left, pos.top);
    }

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;
    let movedPx = 0;
    let pointerId = null;

    function onPointerDown(e) {
        // Ignore drags that start on a button — the existing minimise /
        // close buttons must continue to click cleanly.
        if (e.target.closest('.panel-btn')) return;
        // Only primary button (left mouse / first finger).
        if (e.button !== undefined && e.button !== 0) return;

        // Snapshot the panel's current pixel-space rect. Whether the
        // panel is still using its CSS-default right/bottom anchors or
        // already has explicit left/top, getBoundingClientRect tells us
        // where it visually IS — that's what we drag from.
        const rect = panel.getBoundingClientRect();
        startX    = e.clientX;
        startY    = e.clientY;
        startLeft = rect.left;
        startTop  = rect.top;
        movedPx   = 0;
        pointerId = e.pointerId;

        dragging = true;
        header.style.cursor = 'grabbing';
        // pointer capture lets us keep receiving events even if the
        // pointer leaves the header during a fast drag.
        try { header.setPointerCapture(pointerId); } catch (_) {}
        // Don't preventDefault on pointerdown — it would also kill the
        // synthetic click the user might be trying to perform on the
        // header to minimise. We decide drag-vs-click in pointermove.
    }

    function onPointerMove(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        movedPx = Math.max(movedPx, Math.abs(dx) + Math.abs(dy));
        const next = clampToViewport(panel, startLeft + dx, startTop + dy);
        applyAbsolutePosition(panel, next.left, next.top);
        // Once we've actually moved we suppress the impending click so
        // the header's minimise handler doesn't fire on drop.
        if (movedPx > CLICK_THRESHOLD_PX) {
            e.preventDefault();
        }
    }

    function onPointerUp(e) {
        if (!dragging || e.pointerId !== pointerId) return;
        dragging = false;
        header.style.cursor = 'grab';
        try { header.releasePointerCapture(pointerId); } catch (_) {}
        pointerId = null;

        if (movedPx > CLICK_THRESHOLD_PX) {
            // It was a real drag — persist + suppress the trailing click.
            const rect = panel.getBoundingClientRect();
            if (persist) writeStoredPos(storageId, { left: rect.left, top: rect.top });
            // Block the pending click event that would otherwise toggle
            // the minimised state. capture:true so we beat the header's
            // own click listener.
            const swallow = (ev) => {
                ev.stopPropagation();
                ev.preventDefault();
                window.removeEventListener('click', swallow, true);
            };
            window.addEventListener('click', swallow, true);
            // Safety net in case no click ever arrives (some pointer
            // sequences don't generate one).
            setTimeout(() => window.removeEventListener('click', swallow, true), 50);
        }
    }

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup',   onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);

    // Re-clamp on viewport resize so a stored position from a wider
    // browser doesn't leave the panel off-screen on a phone in
    // portrait. We only touch panels that have an explicit position;
    // un-dragged panels keep their CSS-default anchoring.
    const onResize = () => {
        if (!panel.style.left && !panel.style.top) return;
        const rect = panel.getBoundingClientRect();
        const next = clampToViewport(panel, rect.left, rect.top);
        if (next.left !== rect.left || next.top !== rect.top) {
            applyAbsolutePosition(panel, next.left, next.top);
            if (persist) writeStoredPos(storageId, next);
        }
    };
    window.addEventListener('resize',           onResize);
    window.addEventListener('orientationchange', onResize);
}

function applyAbsolutePosition(panel, left, top) {
    panel.style.left   = `${left}px`;
    panel.style.top    = `${top}px`;
    // Override the panel's CSS-default right/bottom anchors so the
    // browser doesn't stretch the panel between left and right.
    panel.style.right  = 'auto';
    panel.style.bottom = 'auto';
}

/**
 * One-shot reset: clear the stored position and let the panel snap back
 * to its CSS default. Useful for a "reset layout" button.
 */
export function resetPanelPosition(panel, { id } = {}) {
    if (!panel) return;
    const storageId = id ?? panel.id;
    try { localStorage.removeItem(STORAGE_PREFIX + storageId); } catch (_) {}
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
}

// ── Size persistence (companion to position persistence) ───────────────────
//
// Native CSS `resize:both` writes width/height to element.style on user
// drag — but it's session-volatile. This helper hooks a ResizeObserver
// and writes the dimensions to localStorage so a returning visitor
// lands at the same panel size. Independent from makePanelDraggable so
// either can be used without the other.
//
// Storage key: `${STORAGE_PREFIX}-size-${id}` (separate from position
// to keep migration / reset surgical — clearing position doesn't
// clobber size, and vice versa).

const SIZE_STORAGE_SUFFIX = '-size-';

function _readSize(id) {
    try {
        const raw = localStorage.getItem(STORAGE_PREFIX + SIZE_STORAGE_SUFFIX + id);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !Number.isFinite(obj.width) || !Number.isFinite(obj.height)) return null;
        return obj;
    } catch (_) { return null; }
}

function _writeSize(id, w, h) {
    try {
        localStorage.setItem(
            STORAGE_PREFIX + SIZE_STORAGE_SUFFIX + id,
            JSON.stringify({ width: w, height: h }),
        );
    } catch (_) {}
}

/**
 * Persist a panel's resize-handle interactions to localStorage. Reapplies
 * stored dimensions on init (clamped to viewport) and listens via
 * ResizeObserver for subsequent user-driven resizes.
 *
 * Honors the panel's own min-width / max-width / max-height CSS
 * constraints — we never write a value the layout would refuse.
 *
 * Idempotent: calling twice on the same panel is a no-op after the
 * first wire-up.
 */
export function makePanelResizable(panel, { id, persist = true, debounceMs = 250 } = {}) {
    if (!panel || panel.dataset.resizableWired === '1') return;
    panel.dataset.resizableWired = '1';
    const storageId = id ?? panel.id;

    // Apply stored size on init. We only set width/height — the panel's
    // min/max CSS rules clamp anything pathological (e.g. a stored size
    // from a wider monitor that doesn't fit on the current viewport).
    if (persist) {
        const stored = _readSize(storageId);
        if (stored) {
            panel.style.width  = `${stored.width}px`;
            panel.style.height = `${stored.height}px`;
        }
    }

    if (!persist || typeof ResizeObserver === 'undefined') return;

    // Debounced write — ResizeObserver fires on every pixel during a
    // drag, and we don't want to thrash localStorage. 250 ms after the
    // last change is fine for "save what the user settled on."
    let timer = null;
    const ro = new ResizeObserver(entries => {
        for (const entry of entries) {
            // contentBoxSize is preferred; fall back to contentRect for
            // older Safari. Both are in CSS pixels.
            let w, h;
            if (entry.contentBoxSize?.length) {
                w = entry.contentBoxSize[0].inlineSize;
                h = entry.contentBoxSize[0].blockSize;
            } else {
                w = entry.contentRect.width;
                h = entry.contentRect.height;
            }
            // Add the panel's padding+border so the stored value matches
            // what the user sees on the next reload (offsetWidth/Height
            // includes padding+border, which is what `style.width:px`
            // implies under box-sizing:border-box).
            w = panel.offsetWidth;
            h = panel.offsetHeight;
            clearTimeout(timer);
            timer = setTimeout(() => _writeSize(storageId, w, h), debounceMs);
        }
    });
    ro.observe(panel);
}

/** Reset a persisted size back to the CSS default. */
export function resetPanelSize(panel, { id } = {}) {
    if (!panel) return;
    const storageId = id ?? panel.id;
    try { localStorage.removeItem(STORAGE_PREFIX + SIZE_STORAGE_SUFFIX + storageId); } catch (_) {}
    panel.style.width = panel.style.height = '';
}

export default makePanelDraggable;
