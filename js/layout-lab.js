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
 *   2. DESIGN MODE ("Layout Lab") — enabled with `?layoutlab=1` (sticky via
 *        localStorage, `?layoutlab=0` to drop). Drag panels to reorder,
 *        hide/show, toggle full-width (in zones marked data-lab-wide="1"),
 *        save as your personal layout, export/import JSON. Publishing a
 *        variant is deliberately a git operation: export the JSON and
 *        commit it into data/layout-variants/<page>.json — the client can
 *        preview any variant but cannot publish one. That keeps the
 *        experiment definition reviewable and the anon surface read-only.
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

export const LAYOUT_VERSION = 1;

/* ── Pure layout algebra (node-tested) ─────────────────────────────── */

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

/** Validate/clamp an untrusted layout doc (import paste, fetched variant). */
export function normalizeLayout(raw, page) {
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
        };
    }
    return { v: LAYOUT_VERSION, page: raw.page || page || '', zones };
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

export function captureLayout(root, page) {
    const zones = {};
    for (const z of zoneEls(root)) {
        zones[z.getAttribute('data-lab-zone')] = {
            order: panelsOf(z).map(pid),
            hidden: panelsOf(z).filter(p => p.classList.contains('lab-hidden')).map(pid),
            wide: panelsOf(z).filter(p => p.classList.contains('lab-wide')).map(pid),
        };
    }
    return { v: LAYOUT_VERSION, page, zones };
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

function labEnabled() {
    try {
        const q = new URLSearchParams(location.search).get('layoutlab');
        if (q === '1') { localStorage.setItem(LAB_FLAG, '1'); return true; }
        if (q === '0') { localStorage.removeItem(LAB_FLAG); return false; }
        return localStorage.getItem(LAB_FLAG) === '1';
    } catch { return false; }
}

/* ── Entry point ───────────────────────────────────────────────────── */

/**
 * @param {object}  opts
 * @param {string}  opts.page          layout/storage key, e.g. 'space-weather'
 * @param {string} [opts.experimentKey]  key in EXPERIMENTS registry
 * @param {string} [opts.variantsUrl]    committed variants JSON
 */
export async function initLayoutLab({ page, experimentKey, variantsUrl } = {}) {
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

    if (variantsUrl) {
        try {
            const res = await fetch(variantsUrl, { cache: 'no-cache' });
            if (res.ok) variantsDoc = await res.json();
        } catch { /* variants file is optional */ }
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

    if (exp) wireGoals(root, exp);

    const api = { page, mode, authored, applyLayout: (l) => applyLayout(root, l) };
    if (labEnabled()) mountDesigner(root, page, authored, variantsDoc, api, exp);
    return api;
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
`;
    document.head.appendChild(s);
}

function mountDesigner(root, page, authored, variantsDoc, api, exp) {
    const open = document.createElement('button');
    open.id = 'lab-open';
    open.textContent = '🎛 Layout Lab';
    open.title = 'Design mode: drag panels, hide, resize, save layouts (?layoutlab=0 to remove this button)';
    document.body.appendChild(open);

    let bar = null;
    let dragging = null;

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

        // Variant preview picker — authored / committed variants / personal
        const sel = document.createElement('select');
        sel.title = 'Preview a layout';
        const opts = [['authored', 'As authored'], ['personal', 'My saved layout']];
        for (const vid of Object.keys(variantsDoc?.variants || {})) {
            opts.push([`variant:${vid}`, `Variant ${vid}`]);
        }
        sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
        sel.addEventListener('change', () => {
            let l = null;
            if (sel.value === 'authored') l = authored;
            else if (sel.value === 'personal') l = loadPersonal(page);
            else l = normalizeLayout(variantsDoc?.variants?.[sel.value.slice(8)], page);
            if (l) { applyLayout(root, l); api.mode = sel.value; status(); }
            else alert('No layout stored for: ' + sel.value);
        });
        el.appendChild(sel);

        btn('💾 Save mine', 'Save current arrangement as YOUR layout (this browser)', () => {
            savePersonal(page, captureLayout(root, page));
            api.mode = 'personal'; status();
        });
        btn('🧹 Clear mine', 'Delete your saved layout and go back to the authored page', () => {
            clearPersonal(page);
            applyLayout(root, authored);
            api.mode = 'authored'; status();
        });
        btn('📋 Export', 'Copy current arrangement as JSON — paste into data/layout-variants to publish as an A/B variant', async () => {
            const json = JSON.stringify(captureLayout(root, page), null, 2);
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
                applyLayout(root, l); api.mode = 'imported'; status();
            } catch (err) { alert('Import failed: ' + err.message); }
        });
        btn('↩ Reset view', 'Re-apply the as-authored layout (does not touch saved layouts)', () => {
            applyLayout(root, authored);
            api.mode = 'authored'; status();
        });
        btn('✖ Exit', 'Leave design mode', exit);
        return el;
    }
}
