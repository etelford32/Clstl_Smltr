/**
 * launch-ui-panels.js — Collapse + drag + density UI behaviors for the
 * launch planner. Three small, self-contained features that share one
 * localStorage-backed state object so the user's panel layout sticks
 * across reloads.
 *
 *   makeCollapsible(panelEl)    Header click toggles a body-hidden state.
 *                               Persists per-panel by data-collapse-id.
 *   makeDraggable(el, opts)     Pointer-capture drag inside the offsetParent,
 *                               clamped to bounds, position persists per-key.
 *                               Double-click handle resets to default.
 *   setDensity(level)           Sets [data-density="compact"|"default"] on
 *                               document.body so CSS can override paddings
 *                               + font sizes globally.
 *
 * Storage shape (one object, JSON in localStorage under STORAGE_KEY):
 *   {
 *     "collapse:vehicle": false,
 *     "collapse:strip":   true,
 *     "drag:met":         { x: 18, y: 320 },
 *     "density":          "compact"
 *   }
 */

const STORAGE_KEY = 'lp:ui-state-v1';

let _state = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
})();

function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_state)); }
    catch {}
}

export function getPref(key, fallback) {
    return _state[key] ?? fallback;
}

export function setPref(key, value) {
    if (value === null || value === undefined) delete _state[key];
    else _state[key] = value;
    persist();
}

// ── Collapsible panels ───────────────────────────────────────────────────────

/**
 * Wires up a panel for collapse/expand.
 *
 *   <section class="lp-panel" data-collapse-id="achievements">
 *     <header class="lp-collapse-hd"> ... </header>     ← clickable
 *     <div    class="lp-collapse-body"> ... </div>      ← hidden when collapsed
 *   </section>
 *
 * The header gets a rotating chevron appended (if not already present).
 * State persists by id under "collapse:<id>".
 */
export function makeCollapsible(panelEl, { defaultCollapsed = false } = {}) {
    const id = panelEl.dataset.collapseId;
    if (!id) return;
    const hd   = panelEl.querySelector('.lp-collapse-hd');
    const body = panelEl.querySelector('.lp-collapse-body');
    if (!hd || !body) return;

    if (!hd.querySelector('.lp-collapse-chev')) {
        const chev = document.createElement('span');
        chev.className = 'lp-collapse-chev';
        chev.setAttribute('aria-hidden', 'true');
        chev.textContent = '▾';
        hd.appendChild(chev);
    }

    const initial = getPref(`collapse:${id}`, defaultCollapsed);
    panelEl.classList.toggle('lp-panel--collapsed', !!initial);

    hd.style.cursor = 'pointer';
    hd.setAttribute('role', 'button');
    hd.setAttribute('tabindex', '0');
    hd.setAttribute('aria-controls', body.id || '');
    hd.setAttribute('aria-expanded', initial ? 'false' : 'true');

    function toggle(e) {
        // Ignore clicks on inner interactive elements.
        if (e && e.target.closest('button, a, input, select, [role="button"]:not(.lp-collapse-hd)')) return;
        const next = !panelEl.classList.contains('lp-panel--collapsed');
        panelEl.classList.toggle('lp-panel--collapsed', next);
        hd.setAttribute('aria-expanded', next ? 'false' : 'true');
        setPref(`collapse:${id}`, next);
    }
    hd.addEventListener('click', toggle);
    hd.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
}

// ── Draggable overlays ───────────────────────────────────────────────────────

/**
 * Turns `el` into a click-and-drag panel within its offsetParent. The drag
 * handle is `opts.handle` if provided, otherwise the element itself.
 *
 * Position stored per opts.key in localStorage. Double-clicking the handle
 * resets to the element's CSS-defined default (clears stored position).
 *
 * Bounds: the element is clamped so it stays inside its offsetParent with
 * an `inset` margin so it doesn't touch the edges.
 */
export function makeDraggable(el, { key, handle, inset = 6 } = {}) {
    const handleEl = handle || el;
    handleEl.classList.add('lp-drag-handle');

    // Apply persisted position, if any.
    const saved = getPref(`drag:${key}`);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        applyXY(el, saved.x, saved.y);
    }

    let dragging = false;
    let startMouse = { x: 0, y: 0 };
    let startEl    = { x: 0, y: 0 };
    let parentRect = null;

    function onDown(e) {
        // Don't grab if user is clicking a button / form control inside.
        if (e.target.closest('button, a, input, select')) return;
        const parent = el.offsetParent;
        if (!parent) return;
        parentRect = parent.getBoundingClientRect();
        const rect = el.getBoundingClientRect();
        startEl    = { x: rect.left - parentRect.left, y: rect.top - parentRect.top };
        startMouse = { x: e.clientX, y: e.clientY };
        dragging   = true;
        el.classList.add('lp-dragging');
        try { handleEl.setPointerCapture(e.pointerId); } catch {}
        e.preventDefault();
    }

    function onMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startMouse.x;
        const dy = e.clientY - startMouse.y;
        const rect = el.getBoundingClientRect();
        let x = startEl.x + dx;
        let y = startEl.y + dy;
        x = Math.max(inset, Math.min(parentRect.width  - rect.width  - inset, x));
        y = Math.max(inset, Math.min(parentRect.height - rect.height - inset, y));
        applyXY(el, x, y);
    }

    function onUp() {
        if (!dragging) return;
        dragging = false;
        el.classList.remove('lp-dragging');
        const x = parseFloat(el.style.left || '0');
        const y = parseFloat(el.style.top  || '0');
        if (key) setPref(`drag:${key}`, { x, y });
    }

    function onDblClick() {
        // Reset to CSS-defined default.
        el.style.left = '';
        el.style.top  = '';
        el.style.right = '';
        el.style.bottom = '';
        if (key) setPref(`drag:${key}`, null);
    }

    handleEl.addEventListener('pointerdown',   onDown);
    handleEl.addEventListener('pointermove',   onMove);
    handleEl.addEventListener('pointerup',     onUp);
    handleEl.addEventListener('pointercancel', onUp);
    handleEl.addEventListener('dblclick',      onDblClick);
}

function applyXY(el, x, y) {
    el.style.left   = x + 'px';
    el.style.top    = y + 'px';
    el.style.right  = 'auto';
    el.style.bottom = 'auto';
}

// ── Density ──────────────────────────────────────────────────────────────────

/** Set "compact" or "default" on document.body. CSS does the rest. */
export function setDensity(level) {
    const lvl = (level === 'compact') ? 'compact' : 'default';
    document.body.dataset.density = lvl;
    setPref('density', lvl);
}

/** Initialize density from localStorage (called once on page load). */
export function initDensity() {
    const saved = getPref('density', 'default');
    document.body.dataset.density = saved;
    return saved;
}

/** Toggle density between compact and default. Returns the new value. */
export function toggleDensity() {
    const next = (document.body.dataset.density === 'compact') ? 'default' : 'compact';
    setDensity(next);
    return next;
}

// ── Convenience: wire all panels at once ─────────────────────────────────────

/**
 * Walks every [data-collapse-id] panel in the document and wires it up.
 * Pass an object map of { id: { defaultCollapsed: true } } to override
 * default collapse behavior for specific panels.
 */
export function wireAllCollapsibles(overrides = {}) {
    const panels = document.querySelectorAll('[data-collapse-id]');
    panels.forEach(p => {
        const o = overrides[p.dataset.collapseId] || {};
        makeCollapsible(p, o);
    });
}
