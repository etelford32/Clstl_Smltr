/**
 * upper-atmosphere-floating-window.js — reusable draggable / minimizable
 * floating window primitive
 * ═══════════════════════════════════════════════════════════════════════════
 * Phase 21: built so the per-asset story card has a home (no slot in the
 * existing tabbed aside layout for an enlarged-view), but the primitive
 * is deliberately decoupled — any future floating UI element (export
 * dialog, conjunction-pair detail, alerts log, ...) reuses the same
 * class and gets drag + minimize + close + position-persistence for free.
 *
 * What it provides:
 *   • Title-bar drag with pointer-capture + viewport clamping
 *   • Minimize to the title bar only (body hidden, footprint shrinks)
 *   • Close button (removes from DOM + fires callback)
 *   • Per-id position + min state persisted in localStorage so a
 *     reload puts the window back where the operator left it
 *   • Dedup: opening the same id twice brings the existing instance
 *     to front rather than spawning a second copy
 *   • Z-index management: clicking any part of the window raises it
 *     to the top of the stacking order
 *
 * What it deliberately leaves to the caller:
 *   • Content. Pass a string of HTML via setBody(), or get a handle
 *     to the bodyEl and render imperatively. The window doesn't
 *     own the content model.
 *   • Update cadence. Owner can call setBody() / setTitle() any time
 *     to refresh; we don't watch for content changes.
 *
 * Why a class not a Web Component:
 *   • The page doesn't otherwise use Custom Elements, so introducing
 *     them here would create a stylistic split. A plain ES module
 *     with a class matches every other UI primitive in the codebase.
 *
 * @example
 *   import { FloatingWindow } from './upper-atmosphere-floating-window.js';
 *   const win = new FloatingWindow({
 *       id:   'story:norad:25544',         // dedup key + storage key
 *       title: 'ISS — story card',
 *       width: 480, height: 580,
 *       onClose: () => console.log('user closed'),
 *   });
 *   win.setBody('<p>Live content goes here.</p>');
 */

const STORAGE_PREFIX = 'pp-ua-fw-pos-';   // localStorage key prefix
const DEFAULT_OFFSET = 40;                // distance from viewport edge
const MIN_VISIBLE_PX = 100;               // keep at least this much on-screen

// Module-private state. The z counter monotonically increases so the
// most-recently-touched window sits at the top.
let _zCounter = 1000;
const _instances = new Map();             // id → FloatingWindow

export class FloatingWindow {
    constructor({
        id, title,
        host   = document.body,
        width  = 480,
        height = 580,
        onClose    = null,
        onMinimize = null,
    } = {}) {
        // Dedup. Constructor returning a different instance is a JS
        // pattern operators may not be familiar with; we make the
        // existing-window path explicit by exposing `instance` on the
        // class as a static lookup AND making this constructor idempotent
        // for the caller (they get back a working window either way).
        if (_instances.has(id)) {
            const existing = _instances.get(id);
            existing.setMinimized(false);
            existing.bringToFront();
            return existing;
        }

        this.id     = id;
        this.host   = host;
        this.width  = width;
        this.height = height;
        this.onClose    = onClose;
        this.onMinimize = onMinimize;
        this.minimized  = false;

        // Restore saved position. If not previously placed, default to
        // upper-right with a small offset — that's out of the way of
        // the centred main content but still visible.
        const saved = this._loadState();
        this.x = Number.isFinite(saved?.x) ? saved.x : (window.innerWidth - width - DEFAULT_OFFSET);
        this.y = Number.isFinite(saved?.y) ? saved.y : DEFAULT_OFFSET;
        // Re-clamp in case the viewport shrank since last save.
        this._clampPosition();

        this._buildDOM(title);
        this._wireEvents();
        if (saved?.minimized) this.setMinimized(true);
        _instances.set(id, this);
    }

    // ── DOM ────────────────────────────────────────────────────────────────

    _buildDOM(title) {
        const el = document.createElement('div');
        el.className = 'ua-fw';
        el.style.position = 'fixed';
        el.style.left   = `${this.x}px`;
        el.style.top    = `${this.y}px`;
        el.style.width  = `${this.width}px`;
        el.style.zIndex = String(++_zCounter);
        el.innerHTML = `
            <div class="ua-fw-bar" data-fw-bar>
                <span class="ua-fw-title">${_esc(title || '')}</span>
                <button type="button" class="ua-fw-btn" data-fw-min   title="Minimize">⎯</button>
                <button type="button" class="ua-fw-btn" data-fw-close title="Close">×</button>
            </div>
            <div class="ua-fw-body" data-fw-body></div>
        `;
        this.el      = el;
        this.barEl   = el.querySelector('[data-fw-bar]');
        this.titleEl = el.querySelector('.ua-fw-title');
        this.bodyEl  = el.querySelector('[data-fw-body]');
        this.bodyEl.style.maxHeight = `${this.height}px`;
        this.host.appendChild(el);
    }

    _wireEvents() {
        // Bring to front on any pointerdown inside the window — covers
        // clicks on the body content too. Capture-phase so it runs
        // before per-element handlers that might stopPropagation.
        this.el.addEventListener('pointerdown', () => this.bringToFront(), true);

        // Drag from the title bar. Pointer-capture lets the drag
        // continue even when the mouse exits the title-bar bounds —
        // critical when the operator drags fast.
        let dragOffset = null;
        this.barEl.addEventListener('pointerdown', (e) => {
            // Don't start a drag from the buttons.
            if (e.target.closest('button')) return;
            dragOffset = { dx: e.clientX - this.x, dy: e.clientY - this.y };
            this.barEl.setPointerCapture?.(e.pointerId);
            this.barEl.classList.add('ua-fw-bar--dragging');
            e.preventDefault();
        });
        this.barEl.addEventListener('pointermove', (e) => {
            if (!dragOffset) return;
            this.x = e.clientX - dragOffset.dx;
            this.y = e.clientY - dragOffset.dy;
            this._clampPosition();
            this.el.style.left = `${this.x}px`;
            this.el.style.top  = `${this.y}px`;
        });
        const endDrag = (e) => {
            if (!dragOffset) return;
            dragOffset = null;
            try { this.barEl.releasePointerCapture?.(e.pointerId); } catch (_) {}
            this.barEl.classList.remove('ua-fw-bar--dragging');
            this._saveState();
        };
        this.barEl.addEventListener('pointerup',     endDrag);
        this.barEl.addEventListener('pointercancel', endDrag);

        // Double-click the title bar toggles minimize — matches
        // ubiquitous OS window behaviour.
        this.barEl.addEventListener('dblclick', (e) => {
            if (e.target.closest('button')) return;
            this.setMinimized(!this.minimized);
        });

        // Buttons.
        this.el.querySelector('[data-fw-min]')
            .addEventListener('click', () => this.setMinimized(!this.minimized));
        this.el.querySelector('[data-fw-close]')
            .addEventListener('click', () => this.close());

        // Snap back into viewport if the user resizes the browser.
        this._onResize = () => {
            this._clampPosition();
            this.el.style.left = `${this.x}px`;
            this.el.style.top  = `${this.y}px`;
        };
        window.addEventListener('resize', this._onResize);
    }

    // ── Public API ────────────────────────────────────────────────────────

    setBody(html) { if (this.bodyEl) this.bodyEl.innerHTML = html; }
    setTitle(t)   { if (this.titleEl) this.titleEl.textContent = t; }
    getBodyEl()   { return this.bodyEl; }

    setMinimized(m) {
        if (this.minimized === !!m) return;
        this.minimized = !!m;
        this.el.classList.toggle('ua-fw--min', this.minimized);
        if (this.bodyEl) this.bodyEl.style.display = this.minimized ? 'none' : '';
        try { this.onMinimize?.(this.minimized); } catch (_) {}
        this._saveState();
    }

    bringToFront() { this.el.style.zIndex = String(++_zCounter); }

    close() {
        _instances.delete(this.id);
        window.removeEventListener('resize', this._onResize);
        this.el?.remove();
        try { this.onClose?.(); } catch (_) {}
    }

    // ── Internals ─────────────────────────────────────────────────────────

    _clampPosition() {
        const maxX = window.innerWidth  - MIN_VISIBLE_PX;
        const maxY = window.innerHeight - 30;        // title-bar height
        this.x = Math.max(0, Math.min(maxX, this.x));
        this.y = Math.max(0, Math.min(maxY, this.y));
    }

    _saveState() {
        try {
            localStorage.setItem(STORAGE_PREFIX + this.id, JSON.stringify({
                x: this.x, y: this.y, minimized: this.minimized,
            }));
        } catch { /* private mode / quota */ }
    }

    _loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_PREFIX + this.id);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    }
}

/** Find an existing window by id, or null. Useful for "update if open" patterns. */
export function getFloatingWindow(id) { return _instances.get(id) || null; }

/** Iterate every currently-open window (e.g. for batch repaint after a tick). */
export function forEachFloatingWindow(fn) {
    for (const w of _instances.values()) fn(w);
}

// ── Small HTML-escape helper (same as the rest of the panel) ───────────────
function _esc(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
