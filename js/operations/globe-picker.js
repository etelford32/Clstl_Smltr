/**
 * globe-picker.js — Mouse interaction layer for the Operations globe.
 *
 * Three.js raycaster against the satellite Points mesh, throttled to
 * roughly 30 Hz. Drives:
 *   - hover  → tooltip with name, NORAD, group, alt;
 *   - click  → onSelect(noradId) (visuals.setSelectedAsset elsewhere);
 *   - right  → context menu: "Add to fleet" / "Screen against fleet"
 *              / "Pin TCA marker" / "Remove from fleet"
 *              actions.
 *
 * Pointer logic intentionally lives outside OperationsGlobe so the
 * globe module stays "scene plumbing only" and the picker can be
 * mounted independently (or swapped for a richer GPU-picking
 * implementation later).
 *
 * Usage:
 *   const picker = mountGlobePicker({
 *     canvas, camera, tracker,
 *     onSelect:    id => visuals.setSelectedAsset(id),
 *     onAddFleet:  id => myFleet.add(id),
 *     onRemoveFleet: id => myFleet.remove(id),
 *     isInFleet:   id => myFleet.has(id),
 *     onScreen:    () => deck.rescreen(),
 *     onPinTca:    id => visuals.toggleTcaPin(id),
 *   });
 *
 * Returns a small handle `{ dispose() }`.
 */

const HOVER_FPS_HZ      = 30;
const HOVER_THROTTLE_MS = 1000 / HOVER_FPS_HZ;
const PICK_THRESHOLD    = 0.025;   // scene units (Earth radius = 1)

function fmtAlt(altKm) {
    if (!Number.isFinite(altKm)) return '— km';
    return `${altKm.toFixed(0)} km`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

export function mountGlobePicker(opts = {}) {
    const {
        canvas, camera, tracker,
        onSelect      = () => {},
        onAddFleet    = () => {},
        onRemoveFleet = () => {},
        isInFleet     = () => false,
        onScreen      = () => {},
        onPinTca      = null,
    } = opts;

    if (!canvas || !camera || !tracker) {
        console.warn('[globePicker] missing canvas / camera / tracker; aborting mount');
        return { dispose() {} };
    }

    const wrap = canvas.parentElement || document.body;
    if (getComputedStyle(wrap).position === 'static') {
        // Tooltip + menu absolutely position relative to the wrap, so
        // the wrap needs to be a containing block. Operations.html
        // already sets `position: relative`; this is just a guard.
        wrap.style.position = 'relative';
    }

    const tooltip = document.createElement('div');
    tooltip.className = 'op-pick-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.setAttribute('aria-hidden', 'true');
    tooltip.style.display = 'none';
    wrap.appendChild(tooltip);

    const menu = document.createElement('div');
    menu.className = 'op-pick-menu';
    menu.setAttribute('role', 'menu');
    menu.style.display = 'none';
    wrap.appendChild(menu);

    let lastHoverAt   = 0;
    let lastHoverId   = null;
    let pendingHover  = null;
    let lastClient    = { x: 0, y: 0 };
    let menuOpen      = false;
    let menuTarget    = null;     // norad id the menu is acting on
    let menuStarted   = false;    // remembers a contextmenu pointerdown
    let downAt        = null;     // for click vs. drag discrimination

    function clientToNdc(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        return {
            x:  ((clientX - r.left) / r.width)  *  2 - 1,
            y: -((clientY - r.top)  / r.height) *  2 + 1,
        };
    }

    function pickFromClient(clientX, clientY) {
        const ndc = clientToNdc(clientX, clientY);
        return tracker.pickAtNDC?.(ndc, camera, { threshold: PICK_THRESHOLD }) ?? null;
    }

    function placeOver(el, clientX, clientY) {
        const wrapRect = wrap.getBoundingClientRect();
        const x = clientX - wrapRect.left;
        const y = clientY - wrapRect.top;
        // Keep within the wrap; nudge if we'd overflow on the right
        // or bottom.
        const w = el.offsetWidth  || 200;
        const h = el.offsetHeight || 80;
        const xMax = wrapRect.width  - w - 8;
        const yMax = wrapRect.height - h - 8;
        el.style.left = `${Math.max(8, Math.min(xMax, x + 14))}px`;
        el.style.top  = `${Math.max(8, Math.min(yMax, y + 14))}px`;
    }

    function showTooltip(noradId, clientX, clientY) {
        const sat = tracker.getSatellite?.(noradId);
        if (!sat) { hideTooltip(); return; }
        const inFleet = isInFleet(noradId);
        tooltip.innerHTML = `
            <div class="op-pick-name">${escapeHtml(sat.name || `#${noradId}`)}</div>
            <div class="op-pick-meta">
                <span>#${noradId}</span>
                ${sat.group ? `<span class="op-pick-group">${escapeHtml(sat.group)}</span>` : ''}
                <span>${fmtAlt(sat.alt)}</span>
                ${inFleet ? '<span class="op-pick-fleet">★ fleet</span>' : ''}
            </div>
            <div class="op-pick-hint">Click to select · Right-click for actions</div>
        `;
        tooltip.style.display = 'block';
        tooltip.setAttribute('aria-hidden', 'false');
        placeOver(tooltip, clientX, clientY);
        canvas.style.cursor = 'pointer';
    }

    function hideTooltip() {
        tooltip.style.display = 'none';
        tooltip.setAttribute('aria-hidden', 'true');
        if (!menuOpen) canvas.style.cursor = '';
    }

    function buildMenuItems(noradId) {
        const sat = tracker.getSatellite?.(noradId);
        if (!sat) return [];
        const inFleet = isInFleet(noradId);
        const items = [];
        items.push({
            id:    'select',
            label: 'Select asset',
            run:   () => onSelect(noradId),
        });
        if (inFleet) {
            items.push({
                id:    'fleet-remove',
                label: 'Remove from fleet',
                run:   () => onRemoveFleet(noradId),
            });
        } else {
            items.push({
                id:    'fleet-add',
                label: 'Add to fleet',
                run:   () => onAddFleet(noradId),
            });
        }
        items.push({
            id:    'screen',
            label: 'Screen fleet conjunctions',
            run:   () => onScreen(),
        });
        if (typeof onPinTca === 'function') {
            items.push({
                id:    'pin-tca',
                label: 'Toggle TCA pin',
                run:   () => onPinTca(noradId),
            });
        }
        return items;
    }

    function showMenu(noradId, clientX, clientY) {
        const items = buildMenuItems(noradId);
        if (items.length === 0) return;
        menuTarget = noradId;
        menuOpen   = true;

        const sat = tracker.getSatellite?.(noradId);
        menu.innerHTML = `
            <div class="op-pick-menu-head">
                <span class="op-pick-menu-name">${escapeHtml(sat?.name || `#${noradId}`)}</span>
                <span class="op-pick-menu-id">#${noradId}</span>
            </div>
            <ul class="op-pick-menu-list">
                ${items.map((it, i) => `
                    <li class="op-pick-menu-item" data-action="${it.id}" tabindex="0" role="menuitem"${i === 0 ? ' data-default="1"' : ''}>
                        ${escapeHtml(it.label)}
                    </li>
                `).join('')}
            </ul>
        `;
        menu.style.display = 'block';
        placeOver(menu, clientX, clientY);

        menu.querySelectorAll('.op-pick-menu-item').forEach(li => {
            const id = li.dataset.action;
            const item = items.find(x => x.id === id);
            li.addEventListener('click', (ev) => {
                ev.stopPropagation();
                hideMenu();
                try { item?.run(); }
                catch (err) { console.warn('[globePicker] menu action threw:', err); }
            });
            li.addEventListener('keydown', (ev) => {
                if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    hideMenu();
                    try { item?.run(); }
                    catch (err) { console.warn('[globePicker] menu action threw:', err); }
                }
                if (ev.key === 'Escape') { ev.preventDefault(); hideMenu(); }
            });
        });

        // Focus the first item so keyboard users can act immediately.
        menu.querySelector('[data-default="1"]')?.focus();
    }

    function hideMenu() {
        if (!menuOpen) return;
        menu.style.display = 'none';
        menuOpen   = false;
        menuTarget = null;
    }

    function onPointerMove(ev) {
        if (menuOpen) return;
        lastClient = { x: ev.clientX, y: ev.clientY };
        // OrbitControls swallows pointer events for camera moves; our
        // hit-test still wants those positions, so we throttle and
        // pick regardless.
        const now = performance.now();
        if (now - lastHoverAt < HOVER_THROTTLE_MS) {
            // Coalesce — if we've got a pending hover skip; else
            // schedule one for the trailing edge.
            if (!pendingHover) {
                pendingHover = setTimeout(() => {
                    pendingHover = null;
                    onPointerMove({ clientX: lastClient.x, clientY: lastClient.y });
                }, HOVER_THROTTLE_MS);
            }
            return;
        }
        lastHoverAt = now;
        const hit = pickFromClient(ev.clientX, ev.clientY);
        if (hit) {
            if (lastHoverId !== hit.noradId) lastHoverId = hit.noradId;
            showTooltip(hit.noradId, ev.clientX, ev.clientY);
        } else {
            lastHoverId = null;
            hideTooltip();
        }
    }

    function onPointerDown(ev) {
        downAt = { x: ev.clientX, y: ev.clientY, t: performance.now(), button: ev.button };
        if (menuOpen && !menu.contains(ev.target)) {
            hideMenu();
        }
    }

    function onPointerUp(ev) {
        if (!downAt) return;
        const dx = ev.clientX - downAt.x;
        const dy = ev.clientY - downAt.y;
        const dt = performance.now() - downAt.t;
        const isLeftClick = downAt.button === 0 && Math.hypot(dx, dy) < 4 && dt < 400;
        downAt = null;
        if (!isLeftClick) return;

        const hit = pickFromClient(ev.clientX, ev.clientY);
        if (hit) onSelect(hit.noradId);
    }

    function onContextMenu(ev) {
        const hit = pickFromClient(ev.clientX, ev.clientY);
        if (!hit) {
            // No sat under cursor — let the browser handle the
            // contextmenu so we don't suppress dev tooling on empty
            // sky.
            return;
        }
        ev.preventDefault();
        hideTooltip();
        showMenu(hit.noradId, ev.clientX, ev.clientY);
    }

    function onPointerLeave() {
        hideTooltip();
    }

    function onWindowKeydown(ev) {
        if (ev.key === 'Escape') hideMenu();
    }

    function onDocumentClick(ev) {
        if (menuOpen && !menu.contains(ev.target)) hideMenu();
    }

    canvas.addEventListener('pointermove',  onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointerdown',  onPointerDown);
    canvas.addEventListener('pointerup',    onPointerUp);
    canvas.addEventListener('contextmenu',  onContextMenu);
    document.addEventListener('keydown',    onWindowKeydown);
    document.addEventListener('click',      onDocumentClick);

    return {
        dispose() {
            canvas.removeEventListener('pointermove',  onPointerMove);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            canvas.removeEventListener('pointerdown',  onPointerDown);
            canvas.removeEventListener('pointerup',    onPointerUp);
            canvas.removeEventListener('contextmenu',  onContextMenu);
            document.removeEventListener('keydown',    onWindowKeydown);
            document.removeEventListener('click',      onDocumentClick);
            tooltip.remove();
            menu.remove();
            if (pendingHover) clearTimeout(pendingHover);
        },
    };
}
