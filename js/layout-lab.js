/**
 * layout-lab.js — owner-driven drag-and-drop layout designer + layout A/B.
 *
 * The page author marks reorderable regions with `data-lab-zone="<id>"` and
 * movable blocks inside them with `data-lab-panel="<id>"`. This module then
 * provides three layers, strictly additive to the page:
 *
 *   1. APPLY  — on every load, resolve which layout to show:
 *        personal saved layout (localStorage)  >  A/B variant layout
 *        (data/layout-variants/<page>.json via js/experiments.js)  >
 *        the as-authored DOM. Applying a layout only reorders/hides/spans
 *        existing elements; it never creates or destroys panel content, so
 *        every getElementById wire-up in the page keeps working.
 *
 *   2. DESIGN MODE ("Layout Lab") — user-facing: the Customize button shows
 *        for everyone (`?layoutlab=0` hides it, `?layoutlab=1` re-enables).
 *        Drag panels to reorder, hide/show, toggle full-width (in zones
 *        marked data-lab-wide="1"), save as your personal layout,
 *        export/import JSON. Panels marked `data-lab-resize` additionally
 *        get an ALWAYS-ON bottom-edge drag handle (not gated behind design
 *        mode) whose height persists per user in a separate override store,
 *        so resizing the sim canvas never re-buckets an A/B arrangement.
 *        The attribute value is "1" (resize the panel itself) or a CSS
 *        selector for the child that owns the height (e.g. a fixed-height
 *        canvas). Publishing a variant is deliberately a git operation:
 *        export the JSON and commit it into data/layout-variants/<page>.json
 *        — the client can preview any variant but cannot publish one. That
 *        keeps the experiment definition reviewable and the anon surface
 *        read-only.
 *
 *   3. MEASURE — when an experiment key is configured and assigned,
 *        exposure fires through experiments.assign() (deduped per session)
 *        and two goal events fire through experiments.track():
 *        `sw_panel_interact` (first interaction with each panel per
 *        session) and `sw_dwell_60s`. Register goals in EXPERIMENT_GOALS.
 *
 * Import-safe in Node (tests/layout-lab.mjs): all DOM/telemetry access is
 * inside functions that are only called from initLayoutLab().
 */

// v2 (2026-07, dashboard redesign D1): adds a top-level `preset` field —
// the named preset a layout derives from (data/layout-presets/<page>.json)
// or null for hand-arranged layouts. Zone shape is UNCHANGED from v1.
// v1 docs (committed A/B variants, users' saved personal layouts) are
// accepted forever via migrateLayout — bumping the version must never
// strand a saved layout.
export const LAYOUT_VERSION = 2;

/* ── Pure layout algebra (node-tested) ─────────────────────────────── */

/** Lossless v1 → v2 migration. Returns the input untouched for any doc
 *  that is not a plain v1 object (normalizeLayout rejects those later). */
export function migrateLayout(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === 1) {
        return { ...raw, v: 2, preset: null };
    }
    return raw;
}

/**
 * Merge a saved panel order with the panels actually present in the DOM.
 * - saved ids that no longer exist are dropped
 * - ids not in saved (new panels shipped after the layout was saved) are
 *   inserted next to their DOM predecessor, so a saved layout degrades
 *   gracefully instead of dumping new panels at the end.
 */
export function mergeOrder(domIds, savedOrder) {
    const dom = domIds.filter((id, i) => domIds.indexOf(id) === i);
    const saved = (savedOrder || []).filter((id, i, a) =>
        dom.includes(id) && a.indexOf(id) === i);
    const out = [...saved];
    for (let i = 0; i < dom.length; i++) {
        const id = dom[i];
        if (out.includes(id)) continue;
        const prev = dom.slice(0, i).reverse().find(p => out.includes(p));
        out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id);
    }
    return out;
}

const strList = (v) => Array.isArray(v)
    ? v.filter((x, i, a) => typeof x === 'string' && a.indexOf(x) === i)
    : [];

// Height clamp for resizable panels. The floor keeps HUD/scrubber overlays
// usable; the ceiling keeps a stray import from creating a 50k-px canvas.
export const SIZE_MIN = 220;
export const SIZE_MAX = 1600;
export const clampSize = (h) => {
    const n = Math.round(Number(h));
    return Number.isFinite(n) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, n)) : null;
};

const sizeMap = (v) => {
    const out = {};
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [id, h] of Object.entries(v)) {
            const c = clampSize(h);
            if (typeof id === 'string' && c !== null) out[id] = c;
        }
    }
    return out;
};

/** Validate/clamp an untrusted layout doc (import paste, fetched variant).
 *  Accepts v1 docs via migrateLayout — see the LAYOUT_VERSION note. */
export function normalizeLayout(raw, page) {
    raw = migrateLayout(raw);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.v !== LAYOUT_VERSION) return null;
    if (page && raw.page && raw.page !== page) return null;
    const zones = {};
    const src = raw.zones;
    if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
    for (const [zid, z] of Object.entries(src)) {
        if (!z || typeof z !== 'object') continue;
        zones[zid] = {
            order: strList(z.order),
            hidden: strList(z.hidden),
            wide: strList(z.wide),
            size: sizeMap(z.size),
        };
    }
    const preset = (typeof raw.preset === 'string' && raw.preset.length <= 40)
        ? raw.preset : null;
    return { v: LAYOUT_VERSION, page: raw.page || page || '', preset, zones };
}

export function layoutsEqual(a, b) {
    return JSON.stringify(normalizeLayout(a) || a) ===
           JSON.stringify(normalizeLayout(b) || b);
}

/* ── DOM apply / capture ───────────────────────────────────────────── */

const zoneEls = (root) => [...root.querySelectorAll('[data-lab-zone]')];
const panelsOf = (zoneEl) =>
    [...zoneEl.children].filter(c => c.hasAttribute?.('data-lab-panel'));
const pid = (el) => el.getAttribute('data-lab-panel');

// The element whose height a resize actually changes: the panel itself for
// data-lab-resize="1", else the first match of the selector inside it (a
// fixed-height canvas like #sw-globe-canvas needs its own height driven —
// stretching only its wrapper would letterbox it).
export function resizeTarget(panel) {
    const spec = panel.getAttribute('data-lab-resize');
    if (spec == null) return null;
    if (spec === '' || spec === '1') return panel;
    try { return panel.querySelector(spec) || panel; } catch { return panel; }
}

function currentSize(panel) {
    const t = resizeTarget(panel);
    const m = t && /^(\d+)px$/.exec(t.style.height || '');
    return m ? clampSize(m[1]) : null;
}

function setSize(panel, h) {
    const t = resizeTarget(panel);
    if (!t) return;
    t.style.height = h === null ? '' : clampSize(h) + 'px';
}

export function captureLayout(root, page, preset = null) {
    const zones = {};
    for (const z of zoneEls(root)) {
        const size = {};
        for (const p of panelsOf(z)) {
            const h = currentSize(p);
            if (h !== null) size[pid(p)] = h;
        }
        zones[z.getAttribute('data-lab-zone')] = {
            order: panelsOf(z).map(pid),
            hidden: panelsOf(z).filter(p => p.classList.contains('lab-hidden')).map(pid),
            wide: panelsOf(z).filter(p => p.classList.contains('lab-wide')).map(pid),
            size,
        };
    }
    return { v: LAYOUT_VERSION, page, preset, zones };
}

export function applyLayout(root, layout) {
    const doc = normalizeLayout(layout);
    if (!doc) return false;
    for (const z of zoneEls(root)) {
        const spec = doc.zones[z.getAttribute('data-lab-zone')];
        if (!spec) continue;
        const panels = panelsOf(z);
        if (!panels.length) continue;
        const byId = new Map(panels.map(p => [pid(p), p]));
        const order = mergeOrder(panels.map(pid), spec.order);
        // Reinsert the ordered block where the first panel currently sits,
        // so non-panel siblings (header, alert bars) keep their positions.
        const marker = z.ownerDocument.createComment('lab');
        z.insertBefore(marker, panels[0]);
        for (const id of order) z.insertBefore(byId.get(id), marker);
        marker.remove();
        for (const p of panels) {
            p.classList.toggle('lab-hidden', spec.hidden.includes(pid(p)));
            const wide = spec.wide.includes(pid(p)) && z.getAttribute('data-lab-wide') === '1';
            p.classList.toggle('lab-wide', wide);
            p.style.gridColumn = wide ? '1 / -1' : '';
            if (p.hasAttribute('data-lab-resize')) {
                setSize(p, spec.size?.[pid(p)] ?? null);
            }
        }
    }
    return true;
}

/* ── Storage ───────────────────────────────────────────────────────── */

const personalKey = (page) => `pp-layout.${page}`;
const LAB_FLAG = 'pp-layout-lab';

function loadPersonal(page) {
    try { return normalizeLayout(JSON.parse(localStorage.getItem(personalKey(page)) || 'null'), page); }
    catch { return null; }
}
function savePersonal(page, layout) {
    try { localStorage.setItem(personalKey(page), JSON.stringify(layout)); } catch {}
}
function clearPersonal(page) {
    try { localStorage.removeItem(personalKey(page)); } catch {}
}

// The Lab is user-facing: on by default for everyone. `?layoutlab=0`
// stickily hides the Customize button; `?layoutlab=1` brings it back.
function labEnabled() {
    try {
        const q = new URLSearchParams(location.search).get('layoutlab');
        if (q === '1') { localStorage.removeItem(LAB_FLAG); return true; }
        if (q === '0') { localStorage.setItem(LAB_FLAG, '0'); return false; }
        return localStorage.getItem(LAB_FLAG) !== '0';
    } catch { return true; }
}

// Per-user panel heights live OUTSIDE the layout doc on purpose: dragging
// the sim canvas taller is an ergonomic tweak, not an arrangement choice —
// it must survive layout switches and must NOT convert an A/B variant view
// into a personal layout (which would silently pull the user out of the
// experiment bucket).
const sizeStoreKey = (page) => `pp-layout-size.${page}`;

function loadSizes(page) {
    try { return sizeMap(JSON.parse(localStorage.getItem(sizeStoreKey(page)) || 'null')); }
    catch { return {}; }
}
function saveSizes(page, sizes) {
    try {
        const clean = sizeMap(sizes);
        if (Object.keys(clean).length) localStorage.setItem(sizeStoreKey(page), JSON.stringify(clean));
        else localStorage.removeItem(sizeStoreKey(page));
    } catch {}
}

function applySizeOverrides(root, page) {
    const sizes = loadSizes(page);
    for (const p of root.querySelectorAll('[data-lab-panel][data-lab-resize]')) {
        const h = sizes[pid(p)];
        if (h != null) setSize(p, h);
    }
}

/* ── Entry point ───────────────────────────────────────────────────── */

/**
 * @param {object}  opts
 * @param {string}  opts.page          layout/storage key, e.g. 'space-weather'
 * @param {string} [opts.experimentKey]  key in EXPERIMENTS registry
 * @param {string} [opts.variantsUrl]    committed variants JSON
 * @param {string} [opts.presetsUrl]     committed named-preset JSON
 *                 (data/layout-presets/<page>.json — presets are starting
 *                 points the user applies and then edits; distinct from
 *                 A/B variants, which assign silently)
 * @param {Array}  [opts.registry]       self-describing panel metadata
 *                 (e.g. js/space-weather-registry.js PANELS) — enables the
 *                 gallery drawer in design mode; pages without a registry
 *                 keep the pre-D1 designer unchanged
 */
export async function initLayoutLab({ page, experimentKey, variantsUrl,
                                      presetsUrl, registry } = {}) {
    if (typeof document === 'undefined' || !page) return null;
    const root = document;
    injectStyles();

    // Authored baseline BEFORE any layout is applied — Reset returns here.
    const authored = captureLayout(root, page);

    // Telemetry is best-effort: the Lab must work even if experiments.js
    // (→ auth-funnel/analytics) fails to load. Never let it throw.
    let exp = null, variant = null, variantsDoc = null;
    try {
        if (experimentKey) {
            const mod = await import('./experiments.js');
            if (mod.EXPERIMENTS[experimentKey]) {
                exp = mod.experiments;
            }
        }
    } catch (e) { console.warn('[layout-lab] telemetry unavailable', e); }

    let presetsDoc = null;
    if (variantsUrl) {
        try {
            const res = await fetch(variantsUrl, { cache: 'no-cache' });
            if (res.ok) variantsDoc = await res.json();
        } catch { /* variants file is optional */ }
    }
    if (presetsUrl) {
        try {
            const res = await fetch(presetsUrl, { cache: 'no-cache' });
            if (res.ok) presetsDoc = await res.json();
        } catch { /* presets file is optional */ }
    }

    // Resolve what to show: personal beats variant beats authored.
    const personal = loadPersonal(page);
    let mode = 'authored';
    if (personal && applyLayout(root, personal)) {
        mode = 'personal';
    } else if (exp) {
        variant = exp.assign(experimentKey);   // exposure fires (deduped)
        const v = variantsDoc?.variants?.[variant];
        if (v && applyLayout(root, normalizeLayout(v, page))) mode = `variant:${variant}`;
    }

    // User size overrides land last so they win over whatever layout applied.
    applySizeOverrides(root, page);
    mountResizeHandles(root, page, exp);

    if (exp) wireGoals(root, exp);

    const api = {
        page, mode, authored,
        // Preset attribution for the layout the user is looking at right
        // now (null = hand-arranged / authored). "Save mine" stamps this
        // into the persisted v2 doc so analytics can tell preset-derived
        // layouts from scratch-built ones.
        preset: personal?.preset ?? null,
        applyLayout: (l) => applyLayout(root, l),
    };
    if (labEnabled()) mountDesigner(root, page, authored, variantsDoc, api, exp,
                                    presetsDoc, registry);
    return api;
}

/* ── Customization telemetry (plan §9b) — always fail-quiet ────────── */

function trackFeature(action, meta) {
    import('./telemetry.js')
        .then((m) => m.telemetry.recordFeature('sw_dashboard', action, meta))
        .catch(() => {});
}

/* ── Always-on resize handles (data-lab-resize panels) ─────────────── */

function mountResizeHandles(root, page, exp) {
    for (const panel of root.querySelectorAll('[data-lab-panel][data-lab-resize]')) {
        if (panel.querySelector(':scope > .lab-resize-handle')) continue;
        const handle = document.createElement('div');
        handle.className = 'lab-resize-handle';
        handle.title = 'Drag to resize · double-click to reset';
        handle.innerHTML = '<span class="lab-resize-pill"></span>';
        // The handle needs a positioned ancestor; every current target panel
        // already has position:relative, but don't rely on it.
        if (getComputedStyle(panel).position === 'static') panel.style.position = 'relative';
        panel.appendChild(handle);

        let startY = 0, startH = 0, active = false;
        handle.addEventListener('pointerdown', (e) => {
            const t = resizeTarget(panel);
            if (!t) return;
            active = true;
            startY = e.clientY;
            startH = t.getBoundingClientRect().height;
            handle.setPointerCapture(e.pointerId);
            handle.classList.add('lab-resizing');
            e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!active) return;
            setSize(panel, startH + (e.clientY - startY));
        });
        const finish = (e) => {
            if (!active) return;
            active = false;
            handle.classList.remove('lab-resizing');
            try { handle.releasePointerCapture(e.pointerId); } catch {}
            const sizes = loadSizes(page);
            const h = currentSize(panel);
            if (h !== null) sizes[pid(panel)] = h;
            saveSizes(page, sizes);
            try { exp?.track('sw_panel_resize', { panel: pid(panel), h }); } catch {}
        };
        handle.addEventListener('pointerup', finish);
        handle.addEventListener('pointercancel', finish);
        handle.addEventListener('dblclick', () => {
            setSize(panel, null);                    // back to stylesheet height
            const sizes = loadSizes(page);
            delete sizes[pid(panel)];
            saveSizes(page, sizes);
        });
    }
}

/* ── Goal events ───────────────────────────────────────────────────── */

function wireGoals(root, exp) {
    const seenKey = 'pp-lab-goal-seen';
    let seen;
    try { seen = new Set(JSON.parse(sessionStorage.getItem(seenKey) || '[]')); }
    catch { seen = new Set(); }
    const mark = (k) => {
        seen.add(k);
        try { sessionStorage.setItem(seenKey, JSON.stringify([...seen])); } catch {}
    };
    root.addEventListener('pointerdown', (e) => {
        const panel = e.target?.closest?.('[data-lab-panel]');
        if (!panel) return;
        const id = pid(panel);
        if (seen.has('i:' + id)) return;
        mark('i:' + id);
        exp.track('sw_panel_interact', { panel: id });
    }, { passive: true });
    if (!seen.has('dwell')) {
        setTimeout(() => {
            if (document.visibilityState === 'visible') {
                mark('dwell');
                exp.track('sw_dwell_60s', {});
            }
        }, 60_000);
    }
}

/* ── Design mode ───────────────────────────────────────────────────── */

function injectStyles() {
    if (document.getElementById('lab-styles')) return;
    const s = document.createElement('style');
    s.id = 'lab-styles';
    s.textContent = `
.lab-hidden { display: none !important; }
body.lab-design .lab-hidden { display: revert !important; opacity: .3; outline: 2px dashed rgba(255,90,90,.7); }
body.lab-design [data-lab-panel] { position: relative; outline: 1px dashed rgba(0,198,255,.45); outline-offset: 2px; cursor: grab; }
body.lab-design [data-lab-panel].lab-dragging { opacity: .35; cursor: grabbing; }
.lab-chip { position: absolute; top: 6px; right: 6px; z-index: 900; display: none; gap: 4px; }
body.lab-design .lab-chip { display: flex; }
.lab-chip button { font: 600 11px/1 system-ui; padding: 4px 7px; border-radius: 6px; border: 1px solid rgba(0,198,255,.5);
  background: rgba(4,10,20,.92); color: #9fdcff; cursor: pointer; }
.lab-chip button:hover { background: rgba(0,198,255,.25); }
#lab-toolbar { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 1000;
  display: flex; gap: 6px; align-items: center; flex-wrap: wrap; max-width: 96vw;
  background: rgba(4,10,20,.95); border: 1px solid rgba(0,198,255,.5); border-radius: 12px;
  padding: 8px 10px; font: 600 12px/1.2 system-ui; color: #cfeaff; box-shadow: 0 6px 30px rgba(0,0,0,.55); }
#lab-toolbar button, #lab-toolbar select { font: inherit; padding: 5px 9px; border-radius: 8px;
  border: 1px solid rgba(0,198,255,.4); background: rgba(0,30,55,.8); color: #cfeaff; cursor: pointer; }
#lab-toolbar button:hover { background: rgba(0,198,255,.25); }
#lab-toolbar .lab-status { color: #7fb8d8; font-weight: 500; margin-right: 4px; }
#lab-open { position: fixed; right: 14px; bottom: 14px; z-index: 1000; font: 700 12px/1 system-ui;
  padding: 9px 12px; border-radius: 10px; border: 1px solid rgba(0,198,255,.5);
  background: rgba(4,10,20,.92); color: #9fdcff; cursor: pointer; }
.lab-resize-handle { position: absolute; left: 0; right: 0; bottom: 0; height: 10px; z-index: 40;
  cursor: ns-resize; touch-action: none; display: flex; align-items: center; justify-content: center; }
.lab-resize-pill { width: 56px; height: 4px; border-radius: 2px; background: rgba(0,198,255,.28);
  transition: background .15s, width .15s; }
.lab-resize-handle:hover .lab-resize-pill,
.lab-resize-handle.lab-resizing .lab-resize-pill { background: rgba(0,198,255,.8); width: 96px; }
#lab-gallery { position: fixed; top: 60px; right: 14px; bottom: 74px; width: 300px; max-width: 92vw;
  z-index: 1000; overflow-y: auto; background: rgba(4,10,20,.96); border: 1px solid rgba(0,198,255,.5);
  border-radius: 12px; padding: 10px 12px; font: 500 12px/1.35 system-ui; color: #cfeaff;
  box-shadow: 0 6px 30px rgba(0,0,0,.55); }
.lab-gallery-head { display: flex; justify-content: space-between; align-items: center;
  font-weight: 700; font-size: 13px; margin-bottom: 6px; }
.lab-gallery-head button { font: inherit; border: 1px solid rgba(0,198,255,.4); border-radius: 6px;
  background: rgba(0,30,55,.8); color: #cfeaff; cursor: pointer; padding: 2px 8px; }
.lab-gallery-family { margin: 10px 0 4px; font-weight: 700; font-size: 11px; text-transform: uppercase;
  letter-spacing: .08em; color: #7fb8d8; }
.lab-gallery-row { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 5px 6px; border-radius: 7px; }
.lab-gallery-row:hover { background: rgba(0,198,255,.10); }
.lab-gallery-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lab-gallery-row button { flex-shrink: 0; font: 600 11px/1 system-ui; padding: 4px 8px; border-radius: 6px;
  cursor: pointer; background: rgba(4,10,20,.92); }
.lab-gallery-add { border: 1px solid rgba(90,255,150,.5); color: #8fe9ae; }
.lab-gallery-del { border: 1px solid rgba(255,120,120,.45); color: #f2a6a6; }
.lab-gallery-missing { opacity: .45; }
.lab-gallery-missing span:last-child { font-size: 10px; color: #f2a6a6; }
`;
    document.head.appendChild(s);
}

function mountDesigner(root, page, authored, variantsDoc, api, exp,
                       presetsDoc, registry) {
    const open = document.createElement('button');
    open.id = 'lab-open';
    open.textContent = '🎛 Customize';
    open.title = 'Customize this page: drag panels to rearrange, hide, resize — saved in this browser (?layoutlab=0 hides this button)';
    document.body.appendChild(open);

    let bar = null;
    let dragging = null;
    let gallery = null;

    const status = () => {
        const el = bar?.querySelector('.lab-status');
        if (el) el.textContent = `${page} · ${api.mode}`;
    };

    function enter() {
        document.body.classList.add('lab-design');
        open.style.display = 'none';
        for (const z of zoneEls(root)) wireZone(z);
        bar = buildToolbar();
        document.body.appendChild(bar);
        status();
    }
    function exit() {
        document.body.classList.remove('lab-design');
        open.style.display = '';
        bar?.remove(); bar = null;
        gallery?.remove(); gallery = null;
        for (const p of root.querySelectorAll('[data-lab-panel]')) {
            p.removeAttribute('draggable');
        }
    }
    open.addEventListener('click', enter);

    function wireZone(z) {
        for (const p of panelsOf(z)) {
            p.setAttribute('draggable', 'true');
            addChip(z, p);
        }
        if (z._labWired) return;
        z._labWired = true;
        z.addEventListener('dragstart', (e) => {
            const p = e.target?.closest?.('[data-lab-panel]');
            if (!p || p.parentElement !== z || !document.body.classList.contains('lab-design')) return;
            dragging = p;
            p.classList.add('lab-dragging');
            try { e.dataTransfer.setData('text/plain', pid(p)); e.dataTransfer.effectAllowed = 'move'; } catch {}
        });
        z.addEventListener('dragend', () => {
            dragging?.classList.remove('lab-dragging');
            dragging = null;
        });
        z.addEventListener('dragover', (e) => {
            if (!dragging || dragging.parentElement !== z) return;
            e.preventDefault();
            const over = e.target?.closest?.('[data-lab-panel]');
            if (!over || over === dragging || over.parentElement !== z) return;
            const r = over.getBoundingClientRect();
            // Vertical stacks split on Y midline; grid rows fall back to X.
            const before = (r.height >= r.width)
                ? (e.clientX - r.left) < r.width / 2
                : (e.clientY - r.top) < r.height / 2;
            z.insertBefore(dragging, before ? over : over.nextSibling);
        });
        z.addEventListener('drop', (e) => { if (dragging) e.preventDefault(); });
    }

    function addChip(z, p) {
        if (p.querySelector(':scope > .lab-chip')) return;
        const chip = document.createElement('div');
        chip.className = 'lab-chip';
        const hide = document.createElement('button');
        hide.textContent = '👁';
        hide.title = 'Hide/show this panel';
        hide.addEventListener('click', (e) => {
            e.stopPropagation();
            p.classList.toggle('lab-hidden');
        });
        chip.appendChild(hide);
        if (z.getAttribute('data-lab-wide') === '1') {
            const wide = document.createElement('button');
            wide.textContent = '⬌';
            wide.title = 'Toggle full-width';
            wide.addEventListener('click', (e) => {
                e.stopPropagation();
                const on = p.classList.toggle('lab-wide');
                p.style.gridColumn = on ? '1 / -1' : '';
            });
            chip.appendChild(wide);
        }
        p.appendChild(chip);
    }

    function buildToolbar() {
        const el = document.createElement('div');
        el.id = 'lab-toolbar';
        el.innerHTML = '<span class="lab-status"></span>';
        const btn = (label, title, fn) => {
            const b = document.createElement('button');
            b.textContent = label; b.title = title;
            b.addEventListener('click', fn);
            el.appendChild(b);
            return b;
        };

        // Layout picker — authored / personal / named presets / A/B variants.
        // Presets are the user-facing starting points (plan §6); variants
        // stay listed for QA of the experiment surface.
        const sel = document.createElement('select');
        sel.title = 'Apply a layout';
        const opt = ([v, l]) => `<option value="${v}">${l}</option>`;
        const presetIds = Object.keys(presetsDoc?.presets || {});
        let html = [['authored', 'As authored'], ['personal', 'My saved layout']].map(opt).join('');
        if (presetIds.length) {
            html += '<optgroup label="Presets">' + presetIds.map((pid2) =>
                opt([`preset:${pid2}`, presetsDoc.presets[pid2]?.label || pid2])).join('') + '</optgroup>';
        }
        const variantIds = Object.keys(variantsDoc?.variants || {});
        if (variantIds.length) {
            html += '<optgroup label="A/B variants (QA)">' + variantIds.map((vid) =>
                opt([`variant:${vid}`, `Variant ${vid}`])).join('') + '</optgroup>';
        }
        sel.innerHTML = html;
        sel.addEventListener('change', () => {
            let l = null, preset = null;
            if (sel.value === 'authored') l = authored;
            else if (sel.value === 'personal') l = loadPersonal(page);
            else if (sel.value.startsWith('preset:')) {
                preset = sel.value.slice(7);
                l = normalizeLayout(presetsDoc?.presets?.[preset]?.layout, page);
            }
            else l = normalizeLayout(variantsDoc?.variants?.[sel.value.slice(8)], page);
            if (l) {
                applyLayout(root, l);
                api.mode = sel.value;
                api.preset = preset ?? l.preset ?? null;
                status(); refreshGallery();
                if (preset) trackFeature('preset_apply', { page, preset });
            }
            else alert('No layout stored for: ' + sel.value);
        });
        el.appendChild(sel);

        if (registry?.length) {
            btn('🗂 Gallery', 'Browse every panel — show, hide, and jump to panels', toggleGallery);
        }

        btn('💾 Save mine', 'Save current arrangement as YOUR layout (this browser)', () => {
            savePersonal(page, captureLayout(root, page, api.preset));
            api.mode = 'personal'; status();
            trackFeature('layout_save', { page, preset: api.preset });
        });
        btn('🧹 Clear mine', 'Delete your saved layout and go back to the authored page', () => {
            clearPersonal(page);
            applyLayout(root, authored);
            api.mode = 'authored'; api.preset = null; status(); refreshGallery();
        });
        btn('📋 Export', 'Copy current arrangement as JSON — paste into data/layout-variants to publish as an A/B variant', async () => {
            const json = JSON.stringify(captureLayout(root, page, api.preset), null, 2);
            try { await navigator.clipboard.writeText(json); alert('Layout JSON copied to clipboard.'); }
            catch { prompt('Copy the layout JSON:', json); }
            console.log('[layout-lab] export\n' + json);
        });
        btn('📥 Import', 'Paste a layout JSON to preview it', () => {
            const raw = prompt('Paste layout JSON:');
            if (!raw) return;
            try {
                const l = normalizeLayout(JSON.parse(raw), page);
                if (!l) throw new Error('not a v' + LAYOUT_VERSION + ' layout for ' + page);
                applyLayout(root, l); api.mode = 'imported'; api.preset = l.preset; status(); refreshGallery();
            } catch (err) { alert('Import failed: ' + err.message); }
        });
        btn('↩ Reset view', 'Re-apply the as-authored layout (does not touch saved layouts)', () => {
            applyLayout(root, authored);
            api.mode = 'authored'; api.preset = null; status(); refreshGallery();
        });
        btn('✖ Exit', 'Leave design mode', exit);
        return el;
    }

    /* ── Gallery drawer (registry pages only) ──────────────────────────
       D1 semantics: every panel already exists in the page DOM, so
       "adding" a panel = un-hiding it (and jumping to it); "removing" =
       hiding. Live thumbnails and multi-instance land with D2 — the
       drawer's contract (registry-driven rows, show/hide, jump) is
       stable across that upgrade. */

    function toggleGallery() {
        if (gallery) { gallery.remove(); gallery = null; return; }
        gallery = buildGallery();
        document.body.appendChild(gallery);
    }

    function refreshGallery() {
        if (!gallery) return;
        gallery.remove();
        gallery = buildGallery();
        document.body.appendChild(gallery);
    }

    function panelEl(id) {
        return root.querySelector(`[data-lab-panel="${id}"]`);
    }

    function buildGallery() {
        const wrap = document.createElement('div');
        wrap.id = 'lab-gallery';
        const head = document.createElement('div');
        head.className = 'lab-gallery-head';
        head.innerHTML = '<span>Panel gallery</span>';
        const close = document.createElement('button');
        close.textContent = '✕';
        close.title = 'Close the gallery';
        close.addEventListener('click', toggleGallery);
        head.appendChild(close);
        wrap.appendChild(head);

        // Group registry entries by family, preserving registry order.
        const groups = new Map();
        for (const entry of registry) {
            if (!groups.has(entry.family)) groups.set(entry.family, []);
            groups.get(entry.family).push(entry);
        }
        for (const [family, entries] of groups) {
            const h = document.createElement('div');
            h.className = 'lab-gallery-family';
            h.textContent = entries[0]?.familyLabel || family;
            wrap.appendChild(h);
            for (const entry of entries) {
                const el = panelEl(entry.id);
                const row = document.createElement('div');
                row.className = 'lab-gallery-row';
                row.title = entry.blurb || '';
                const label = document.createElement('span');
                label.className = 'lab-gallery-title';
                label.textContent = entry.title;
                row.appendChild(label);
                if (!el) {
                    // Registry drift guard: the node test should make this
                    // unreachable, but the drawer must not lie if it isn't.
                    row.classList.add('lab-gallery-missing');
                    const chip = document.createElement('span');
                    chip.textContent = 'not on page';
                    row.appendChild(chip);
                    wrap.appendChild(row);
                    continue;
                }
                const tgl = document.createElement('button');
                const hidden = el.classList.contains('lab-hidden');
                tgl.textContent = hidden ? '＋ Show' : '－ Hide';
                tgl.className = hidden ? 'lab-gallery-add' : 'lab-gallery-del';
                tgl.addEventListener('click', () => {
                    const on = !el.classList.toggle('lab-hidden');
                    tgl.textContent = on ? '－ Hide' : '＋ Show';
                    tgl.className = on ? 'lab-gallery-del' : 'lab-gallery-add';
                    if (on) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    trackFeature(on ? 'panel_add' : 'panel_remove', { page, panel: entry.id });
                });
                row.appendChild(tgl);
                wrap.appendChild(row);
            }
        }
        return wrap;
    }
}
