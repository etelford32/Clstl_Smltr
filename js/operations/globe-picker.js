/**
 * globe-picker.js — Pointer interaction layer for the Operations globe.
 *
 * Three.js raycaster against the satellite Points mesh, throttled to
 * roughly 30 Hz. Drives:
 *   - hover  (mouse only) → tooltip with name, NORAD, group, alt;
 *   - click / tap        → onSelect(noradId);
 *   - right-click / long-press → context menu: Select / Add to fleet
 *                                (or Remove) / Screen this object /
 *                                Toggle TCA pin.
 *
 * Touch model: hover doesn't exist on touch devices, so we treat
 * pointerType === 'touch' specially:
 *   - quick tap (<250 ms, no drag) on a sat → onSelect;
 *   - long-press (>500 ms, no drag) on a sat → context menu at the
 *     touch point;
 *   - drags pass through to OrbitControls untouched.
 *
 * While the menu is open we disable OrbitControls so a stray drag
 * doesn't slide the camera out from under the menu the user is
 * about to tap.
 *
 * Pointer logic intentionally lives outside OperationsGlobe so the
 * globe module stays "scene plumbing only" and the picker can be
 * swapped for a richer GPU-picking implementation later.
 *
 * Usage:
 *   const picker = mountGlobePicker({
 *     canvas, camera, controls, tracker,
 *     onSelect:      id => visuals.setSelectedAsset(id),
 *     onAddFleet:    id => myFleet.add(id),
 *     onRemoveFleet: id => myFleet.remove(id),
 *     isInFleet:     id => myFleet.has(id),
 *     onScreen:      ()   => deck.rescreen(),
 *     onScreenOne:   id   => deck.screenOne(id),
 *     onPinTca:      ()   => visuals.toggleTcaGlyph(),
 *     onMessage:     (text, kind) => showToast(text, kind),
 *   });
 *
 * Returns a small handle `{ dispose() }`.
 */

const HOVER_FPS_HZ      = 30;
const HOVER_THROTTLE_MS = 1000 / HOVER_FPS_HZ;
const PICK_THRESHOLD    = 0.025;   // scene units (Earth radius = 1)
const TOUCH_PICK_THR    = 0.05;    // looser on touch — fingers cover more sky
const LONG_PRESS_MS     = 500;
const TAP_MAX_MS        = 350;
const TAP_MAX_DIST      = 6;       // px — touch is sloppier than a mouse

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
        canvas, camera, tracker, controls,
        onSelect      = () => {},
        onAddFleet    = () => {},
        onRemoveFleet = () => {},
        isInFleet     = () => false,
        onScreen      = () => {},
        onScreenOne   = null,
        onPinTca      = null,
        onMessage     = () => {},
    } = opts;

    if (!canvas || !camera || !tracker) {
        console.warn('[globePicker] missing canvas / camera / tracker; aborting mount');
        return { dispose() {} };
    }

    // Coarse-pointer environments (touch / pen) skip the hover
    // tooltip and use long-press for the context menu. matchMedia is
    // a reasonable proxy; we still check pointerType per-event so a
    // hybrid laptop with both works.
    const coarsePointerOnly =
        typeof matchMedia === 'function'
            ? matchMedia('(hover: none) and (pointer: coarse)').matches
            : false;

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
    let downAt        = null;     // for click vs. drag discrimination
    let longPressId   = null;     // setTimeout handle for touch long-press
    let longPressFired = false;   // suppresses the synthesized click
    let controlsWasEnabled = null; // remembered while menu is open

    function clientToNdc(clientX, clientY) {
        const r = canvas.getBoundingClientRect();
        return {
            x:  ((clientX - r.left) / r.width)  *  2 - 1,
            y: -((clientY - r.top)  / r.height) *  2 + 1,
        };
    }

    function pickFromClient(clientX, clientY, isTouch = false) {
        const ndc = clientToNdc(clientX, clientY);
        const threshold = isTouch ? TOUCH_PICK_THR : PICK_THRESHOLD;
        return tracker.pickAtNDC?.(ndc, camera, { threshold }) ?? null;
    }

    function suppressControls() {
        if (!controls) return;
        if (controlsWasEnabled == null) {
            controlsWasEnabled = controls.enabled !== false;
        }
        controls.enabled = false;
    }

    function restoreControls() {
        if (!controls) return;
        if (controlsWasEnabled != null) {
            controls.enabled = controlsWasEnabled;
        }
        controlsWasEnabled = null;
    }

    function cancelLongPress() {
        if (longPressId != null) {
            clearTimeout(longPressId);
            longPressId = null;
        }
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
                run:   () => handleAddFleet(noradId),
            });
        }
        // "Screen against my fleet" runs a one-shot fleet × {this}
        // screen and toasts the closest pass found. Useful when the
        // user spots something interesting and wants to know if it
        // threatens any of their primaries — without needing to add
        // it to the fleet first.
        if (typeof onScreenOne === 'function' && !inFleet) {
            items.push({
                id:    'screen-one',
                label: 'Screen against my fleet',
                run:   () => handleScreenOne(noradId),
            });
        }
        items.push({
            id:    'screen',
            label: 'Re-screen fleet now',
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

    async function handleAddFleet(noradId) {
        const sat = tracker.getSatellite?.(noradId);
        const label = sat?.name || `#${noradId}`;
        try {
            const result = await onAddFleet(noradId);
            // myFleet.add resolves to { ok, reason?, id? }. Older
            // call sites may return undefined — treat that as "ok"
            // since we have no information to the contrary.
            if (!result || result.ok) {
                onMessage(`Added ${label} to fleet.`, 'ok');
                return;
            }
            const reason = result.reason;
            if (reason === 'already-added') onMessage(`${label} is already in your fleet.`,    'info');
            else if (reason === 'fleet-full')  onMessage(`Fleet is full (max 10). Remove one to add.`, 'warn');
            else if (reason === 'invalid-id')  onMessage(`#${noradId} isn't a valid NORAD ID.`, 'error');
            else if (reason === 'fetch-failed') onMessage(`Couldn't load TLE for ${label}.`,    'error');
            else                                onMessage(`Couldn't add ${label}: ${reason}`, 'error');
        } catch (err) {
            onMessage(`Add failed: ${err?.message ?? err}`, 'error');
        }
    }

    async function handleScreenOne(noradId) {
        const sat = tracker.getSatellite?.(noradId);
        const label = sat?.name || `#${noradId}`;
        onMessage(`Screening ${label} against your fleet…`, 'info', { duration: 1500 });
        try {
            const hit = await onScreenOne(noradId);
            if (!hit) {
                onMessage(`${label}: no fleet conjunction below 50 km in horizon.`, 'ok');
                return;
            }
            const dv = Number.isFinite(hit.dvKms) ? ` · ${hit.dvKms.toFixed(2)} km/s` : '';
            onMessage(
                `${label} → ${hit.primaryName}: ${hit.missKm.toFixed(2)} km, ${hit.ahead}${dv}`,
                hit.missKm < 5 ? 'error' : hit.missKm < 15 ? 'warn' : 'info',
                { duration: 6000 },
            );
        } catch (err) {
            if (err?.code === 'superseded' || err?.code === 'disposed') return;
            onMessage(`Screen failed: ${err?.message ?? err}`, 'error');
        }
    }

    function showMenu(noradId, clientX, clientY) {
        const items = buildMenuItems(noradId);
        if (items.length === 0) return;
        menuTarget = noradId;
        menuOpen   = true;
        suppressControls();
        hideTooltip();

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
        restoreControls();
    }

    function onPointerMove(ev) {
        if (menuOpen) return;
        lastClient = { x: ev.clientX, y: ev.clientY };

        // Touch + pen: cancel a pending long-press if the finger has
        // moved far enough that the user is clearly dragging the
        // camera.
        if (downAt && downAt.pointerType !== 'mouse' && longPressId != null) {
            const moved = Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y);
            if (moved > TAP_MAX_DIST) cancelLongPress();
        }

        // Hover tooltip: mouse only. Coarse pointers don't have a
        // hover state, and a pen's "hover" is rarely intentional.
        if (coarsePointerOnly || (ev.pointerType && ev.pointerType !== 'mouse')) {
            return;
        }

        const now = performance.now();
        if (now - lastHoverAt < HOVER_THROTTLE_MS) {
            // Coalesce — if we've got a pending hover skip; else
            // schedule one for the trailing edge.
            if (!pendingHover) {
                pendingHover = setTimeout(() => {
                    pendingHover = null;
                    onPointerMove({ clientX: lastClient.x, clientY: lastClient.y, pointerType: 'mouse' });
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
        downAt = {
            x: ev.clientX, y: ev.clientY,
            t: performance.now(),
            button: ev.button,
            pointerType: ev.pointerType || 'mouse',
        };
        longPressFired = false;

        if (menuOpen && !menu.contains(ev.target)) {
            hideMenu();
        }

        // Long-press to open the context menu on touch (and pen). We
        // pre-check that there's a sat under the touch — if not, the
        // long-press becomes a no-op and the user can keep dragging
        // the camera without surprise.
        if (downAt.pointerType !== 'mouse') {
            const startX = ev.clientX, startY = ev.clientY;
            cancelLongPress();
            longPressId = setTimeout(() => {
                longPressId = null;
                if (!downAt) return;
                const moved = Math.hypot(downAt.x - startX, downAt.y - startY);
                if (moved > TAP_MAX_DIST) return;
                const hit = pickFromClient(startX, startY, true);
                if (!hit) return;
                longPressFired = true;
                showMenu(hit.noradId, startX, startY);
            }, LONG_PRESS_MS);
        }
    }

    function onPointerUp(ev) {
        cancelLongPress();
        if (!downAt) return;
        const dx = ev.clientX - downAt.x;
        const dy = ev.clientY - downAt.y;
        const dt = performance.now() - downAt.t;
        const isTouch = downAt.pointerType !== 'mouse';
        const tapDist = isTouch ? TAP_MAX_DIST : 4;
        const tapTime = isTouch ? TAP_MAX_MS    : 400;
        const isTap   = downAt.button === 0 && Math.hypot(dx, dy) < tapDist && dt < tapTime;
        downAt = null;

        // If the long-press already fired, don't double-fire a tap.
        if (longPressFired) { longPressFired = false; return; }
        if (!isTap) return;

        const hit = pickFromClient(ev.clientX, ev.clientY, isTouch);
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
        showMenu(hit.noradId, ev.clientX, ev.clientY);
    }

    function onPointerLeave() {
        hideTooltip();
        cancelLongPress();
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
            cancelLongPress();
            restoreControls();
        },
    };
}
