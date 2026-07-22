/**
 * sw-location-box.js — the header location box on space-weather.html
 * (fix round 2026-07-22, at the author's direction: "add a location box
 * to the upper left of the space weather dashboard, just below the
 * Space Weather title").
 *
 * One compact pill under the page title showing the user's STORED
 * location — the same `ppx_user_location` store every consumer on this
 * page already reads (status band "tonight" cell, the Stage pin, the
 * aurora-spot cards). Typing a place and pressing ↵ geocodes via the
 * shared js/user-location.js Nominatim helper and writes through
 * saveUserLocation(), whose 'user-location-changed' dispatch updates
 * all of those consumers at once — this box adds NO second location
 * store and NO second event contract.
 *
 * Fallback: when ppx_user_location is empty but the signed-in profile
 * carries a saved location (user_profiles.location_* via the pp_auth
 * mirror), that seeds the box AND the store, so "the location box
 * corresponds to the user's stored location" on first visit too.
 *
 * The input is a STABLE element (verdict-card lesson): external
 * 'user-location-changed' events only rewrite its value while it is
 * not focused, so a refresh can never blow away a half-typed query.
 * Mount is fail-quiet — any error leaves the host empty, never a
 * broken header.
 */

import { geocodeQuery, saveUserLocation, loadUserLocation, clearUserLocation }
    from './user-location.js';

function track(action, meta) {
    import('./telemetry.js')
        .then((m) => m.telemetry.recordFeature('sw_dashboard', action, meta))
        .catch(() => {});
}

/** Profile-mirror fallback: pp_auth.location ({lat, lon, city} or null). */
function profileLocation() {
    try {
        const raw = localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth');
        const loc = raw ? JSON.parse(raw)?.location : null;
        return (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon))
            ? loc : null;
    } catch { return null; }
}

const fmtCoord = (loc) =>
    `${Math.abs(loc.lat).toFixed(1)}°${loc.lat >= 0 ? 'N' : 'S'} ` +
    `${Math.abs(loc.lon).toFixed(1)}°${loc.lon >= 0 ? 'E' : 'W'}`;

const CSS = `
#sw-loc-box { flex-basis: 100%; order: 10; }
.swloc-pill { display: inline-flex; align-items: center; gap: 8px;
    max-width: 100%; padding: 5px 10px; border-radius: 18px;
    background: var(--sw-surface, rgba(255,255,255,.03));
    border: 1px solid var(--sw-border, rgba(255,255,255,.08));
    transition: border-color var(--sw-t-snap, .15s ease); }
.swloc-pill:focus-within { border-color: var(--sw-border-focus, rgba(120,180,240,.4)); }
.swloc-icon { font-size: .85rem; line-height: 1; }
.swloc-input { background: transparent; border: none; outline: none;
    color: var(--sw-text-bright, #e8f4ff); font: 600 .82rem/1.2 inherit;
    font-family: inherit; letter-spacing: .02em;
    width: 15ch; min-width: 8ch; }
.swloc-input::placeholder { color: var(--sw-text-dim, #68718a); font-weight: 500; }
.swloc-coords { font-size: .72rem; color: var(--sw-text-muted, #8a93a4);
    font-variant-numeric: tabular-nums; white-space: nowrap; }
.swloc-clear { background: transparent; border: none; cursor: pointer;
    color: var(--sw-text-dim, #68718a); font-size: .8rem; line-height: 1;
    padding: 2px 4px; border-radius: 4px; }
.swloc-clear:hover { color: var(--sw-text-bright, #e8f4ff); }
.swloc-status { margin-left: 10px; font-size: .74rem;
    color: var(--sw-text-dim, #68718a); }
.swloc-status.ok { color: var(--sw-status-quiet, #00e87a); }
.swloc-status.err { color: var(--sw-status-severe, #ff7788); }
@media (max-width: 768px) {
    .swloc-pill { width: 100%; }
    .swloc-input { flex: 1; width: auto; }
}
`;

export function mountLocationBox(hostId = 'sw-loc-box') {
    if (typeof document === 'undefined') return;
    try {
        const host = document.getElementById(hostId);
        if (!host) return;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);

        host.innerHTML = `
            <span class="swloc-pill">
                <span class="swloc-icon" aria-hidden="true">📍</span>
                <input class="swloc-input" type="text" autocomplete="off"
                    placeholder="Set your location…"
                    aria-label="Your location — type a city or zip and press Enter"
                    title="Your stored location: the status band, the Stage pin, and aurora cards all follow it">
                <span class="swloc-coords"></span>
                <button class="swloc-clear" type="button" title="Clear saved location"
                    aria-label="Clear saved location" hidden>✕</button>
            </span>
            <span class="swloc-status" aria-live="polite"></span>`;

        const input  = host.querySelector('.swloc-input');
        const coords = host.querySelector('.swloc-coords');
        const clear  = host.querySelector('.swloc-clear');
        const status = host.querySelector('.swloc-status');
        let statusTimer = 0;

        const say = (msg, cls = '') => {
            status.textContent = msg;
            status.className = `swloc-status ${cls}`;
            clearTimeout(statusTimer);
            if (msg) statusTimer = setTimeout(() => { status.textContent = ''; }, 4000);
        };

        const render = (loc) => {
            if (input !== document.activeElement) {
                input.value = loc ? (loc.city || fmtCoord(loc)) : '';
            }
            coords.textContent = loc ? fmtCoord(loc) : '';
            clear.hidden = !loc;
        };

        // Boot: the store, else the signed-in profile's saved location —
        // which also SEEDS the store so every consumer picks it up.
        let loc = loadUserLocation();
        if (!loc) {
            const p = profileLocation();
            if (p) { loc = { lat: p.lat, lon: p.lon, city: p.city || '' }; saveUserLocation(loc); }
        }
        render(loc);

        input.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter') return;
            const q = input.value.trim();
            if (!q) return;
            say('Looking up…');
            input.disabled = true;
            try {
                const found = await geocodeQuery(q);
                saveUserLocation(found);      // dispatches 'user-location-changed'
                render(found);
                say(`✓ ${found.city}`, 'ok');
                track('location_set', { via: 'header-box' });
            } catch (err) {
                say(err?.message || 'Lookup failed', 'err');
            } finally {
                input.disabled = false;
            }
        });
        input.addEventListener('focus', () => input.select());
        // Blur without committing: fall back to the stored value.
        input.addEventListener('blur', () => render(loadUserLocation()));

        clear.addEventListener('click', () => {
            clearUserLocation();              // dispatches with detail null
            render(null);
            say('Location cleared', 'ok');
            track('location_clear', { via: 'header-box' });
        });

        // Follow external changes (another card, another tab via storage).
        window.addEventListener('user-location-changed', (e) => render(e.detail || null));
    } catch (e) {
        console.warn('[sw-loc-box] mount failed (non-fatal):', e);
    }
}
