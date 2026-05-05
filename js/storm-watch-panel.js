/**
 * storm-watch-panel.js — top-5 active tropical-cyclone tracker UI
 *
 * Subscribes to the existing `storm-update` event dispatched by
 * StormFeed and paints the five most intense active storms worldwide
 * into a dedicated panel. Click a storm card → fly the camera to its
 * eye position via the global `flyToLatLon` hook earth.html exposes.
 *
 * Why an independent module
 * ─────────────────────────
 * The cloud shader already consumes the storm feed for visual eye
 * markers, but a global tracker is a different UX concern — users want
 * to see the *list* (names, intensities, basins, motion) and jump
 * between storms. Pulling that into its own module keeps earth.html
 * tighter and lets the panel evolve independently of the rendering
 * path.
 *
 * Card content per storm
 * ──────────────────────
 *   - Classification badge (TD / TS / HU / TY / STY / MH) with
 *     intensity-driven background colour
 *   - Storm name (e.g. "TROPICAL STORM ALPHA")
 *   - Sustained wind in knots → mph + Saffir-Simpson category
 *   - Intensity bar — visual reinforcement of the wind speed
 *   - Basin code (ATL/EPAC/WPAC/etc.) and signed lat/lon
 *   - Motion arrow + speed
 *   - Pressure (when reported by NHC)
 *
 * The panel is created entirely from JS so its DOM doesn't have to be
 * in earth.html's already-large markup. CSS lives alongside the panel
 * builder so a future split-into-component is a one-file move.
 */

// Saffir–Simpson cutoffs for sustained wind (knots). Used to assign a
// hurricane category and pick the badge tint.
const CATEGORY_CUTOFFS_KT = [64, 83, 96, 113, 137];   // Cat 1..5 lower bounds

// Classification → display label + background tint. Tints walk warm as
// the storm intensifies; the same gradient is reused on the intensity
// bar so the visual story is monotonic in danger.
const CLASS_META = {
    TD:  { label: 'Tropical Depression', tint: '#3a8acb' },
    TS:  { label: 'Tropical Storm',      tint: '#3ec1b8' },
    HU:  { label: 'Hurricane',           tint: '#f59f3b' },
    TY:  { label: 'Typhoon',             tint: '#f08020' },
    STY: { label: 'Super Typhoon',       tint: '#e64545' },
    MH:  { label: 'Major Hurricane',     tint: '#d8345f' },
};

// Pretty basin names — the upstream codes are terse.
const BASIN_LABEL = {
    ATLANTIC: 'Atlantic',
    EPAC:     'East Pacific',
    CPAC:     'Central Pacific',
    WPAC:     'West Pacific',
    IO:       'Indian Ocean',
    SH:       'Southern Hemisphere',
};

function categoryFromKt(kt) {
    if (!Number.isFinite(kt)) return null;
    let cat = 0;
    for (let i = 0; i < CATEGORY_CUTOFFS_KT.length; i++) {
        if (kt >= CATEGORY_CUTOFFS_KT[i]) cat = i + 1;
    }
    return cat;   // 0 = sub-hurricane
}

// 16-point compass label from a degrees-from-north heading. Ratings of
// "moving WSW at 10 kt" read better in plain text on a small card than
// a compass rose ever would.
function bearingLabel(deg) {
    if (!Number.isFinite(deg)) return '—';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE',
                  'S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}

function formatLatLon(lat, lon) {
    const ns = lat >= 0 ? 'N' : 'S';
    const ew = lon >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(1)}° ${ns}, ${Math.abs(lon).toFixed(1)}° ${ew}`;
}

// ── DOM scaffolding ────────────────────────────────────────────────────────

const STYLE_ID = 'storm-watch-panel-style';
const PANEL_ID = 'storm-watch-panel';

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
#${PANEL_ID} {
    position: absolute; top: 130px; left: 10px; z-index: 60;
    width: 240px; max-width: calc(100vw - 20px);
    background: rgba(8,10,18,.86); backdrop-filter: blur(10px);
    border: 1px solid rgba(255,160,80,.28); border-radius: 9px;
    padding: 10px 11px 8px;
    font-size: 11px; color: #d6dee6;
    box-shadow: 0 6px 24px rgba(0,0,0,.45);
    transition: transform .18s ease;
}
#${PANEL_ID}.panel-minimized .panel-body { max-height: 0; opacity: 0; }
#${PANEL_ID} .panel-header {
    display:flex; align-items:center; justify-content:space-between;
    cursor:pointer; user-select:none; padding-bottom:6px;
    border-bottom:1px solid rgba(255,255,255,.06); margin-bottom:6px;
}
#${PANEL_ID} .panel-header h3 {
    margin:0; font-size:11px; color:#ffb066; letter-spacing:.6px;
    text-transform:uppercase; font-weight:600;
    display:flex; align-items:center; gap:6px;
}
#${PANEL_ID} .sw-pulse {
    width:7px; height:7px; border-radius:50%;
    background:#ff9050; box-shadow:0 0 8px #ff9050;
    animation: sw-pulse 1.6s ease-in-out infinite;
}
#${PANEL_ID} .sw-pulse.offline { background:#555; box-shadow:none; animation:none; }
@keyframes sw-pulse {
    0%, 100% { opacity:.4; transform:scale(.85); }
    50%      { opacity:1;  transform:scale(1.2); }
}
#${PANEL_ID} .panel-body { overflow:hidden; transition:max-height .3s ease, opacity .25s; max-height:60vh; overflow-y:auto; }
#${PANEL_ID} .panel-body::-webkit-scrollbar { width:3px; }
#${PANEL_ID} .panel-body::-webkit-scrollbar-thumb { background:rgba(255,160,80,.25); border-radius:2px; }
#${PANEL_ID} .sw-empty {
    text-align:center; padding:14px 6px;
    color:#778; font-size:10.5px; font-style:italic;
}
#${PANEL_ID} .sw-card {
    border-radius:6px; padding:7px 8px 6px;
    margin-bottom:5px; cursor:pointer;
    background:rgba(255,255,255,.04);
    border:1px solid rgba(255,255,255,.06);
    transition:background .15s, transform .12s, border-color .15s;
}
#${PANEL_ID} .sw-card:hover {
    background:rgba(255,160,80,.10);
    border-color:rgba(255,160,80,.30);
    transform:translateY(-1px);
}
#${PANEL_ID} .sw-card.active {
    /* Pinned card after click — stronger tint than hover so the
       user can see which storm's cone the globe is highlighting
       without the cursor on the card. */
    background:rgba(255,160,80,.18);
    border-color:rgba(255,160,80,.55);
    box-shadow:0 0 10px rgba(255,160,80,.20);
}
#${PANEL_ID} .sw-card:last-child { margin-bottom:0; }
#${PANEL_ID} .sw-row1 {
    display:flex; align-items:center; gap:6px;
    margin-bottom:3px;
}
#${PANEL_ID} .sw-badge {
    font-size:9px; padding:2px 6px; border-radius:3px;
    font-weight:700; letter-spacing:.4px;
    color:#fff; flex-shrink:0;
}
#${PANEL_ID} .sw-name {
    font-size:11px; color:#ffd9b8; font-weight:600;
    flex:1; min-width:0;
    text-overflow:ellipsis; overflow:hidden; white-space:nowrap;
    text-transform:capitalize;
}
#${PANEL_ID} .sw-cat {
    font-size:9px; color:#ffa060; font-weight:600;
    flex-shrink:0;
}
#${PANEL_ID} .sw-bar {
    height:3px; border-radius:2px; margin:3px 0 4px;
    background:rgba(255,255,255,.08);
    overflow:hidden;
}
#${PANEL_ID} .sw-bar-fill {
    height:100%; background:linear-gradient(90deg,
        #3a8acb 0%, #3ec1b8 25%, #f59f3b 55%,
        #f08020 75%, #e64545 92%, #d8345f 100%);
    transition:width .3s ease;
}
#${PANEL_ID} .sw-row2 {
    display:flex; align-items:center; justify-content:space-between;
    font-size:9.5px; color:#8895a3; gap:6px;
}
#${PANEL_ID} .sw-row2 .sw-meta { display:flex; gap:4px; align-items:center; }
#${PANEL_ID} .sw-mv-arrow {
    display:inline-block;
    transform-origin:center;
    color:#ffb070;
}
#${PANEL_ID} .sw-foot {
    font-size:9px; color:#4f5c6a; margin-top:4px;
    padding-top:4px; border-top:1px dashed rgba(255,255,255,.06);
    text-align:right;
}
@media (max-width: 640px) {
    #${PANEL_ID} {
        width: 230px; top: auto; bottom: 70px; left: 10px;
    }
    #${PANEL_ID} .panel-body { max-height: 38vh; }
}
`;
    document.head.appendChild(style);
}

function buildPanelDOM() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
        <div class="panel-header" data-minimize="${PANEL_ID}">
            <h3><span class="sw-pulse" id="${PANEL_ID}-pulse"></span>🌀 Storm Watch <span id="${PANEL_ID}-count" style="opacity:.6;font-weight:400;margin-left:4px;"></span></h3>
            <div class="panel-actions">
                <button class="panel-btn" data-minimize-btn="${PANEL_ID}" title="Minimise">▾</button>
                <button class="panel-btn panel-close" data-close="${PANEL_ID}" title="Close">✕</button>
            </div>
        </div>
        <div class="panel-body">
            <div id="${PANEL_ID}-list"></div>
            <div class="sw-foot" id="${PANEL_ID}-foot">awaiting NHC feed…</div>
        </div>
    `;
    return panel;
}

// ── StormWatchPanel ────────────────────────────────────────────────────────

export class StormWatchPanel {
    /**
     * @param {object} [opts]
     * @param {(lat:number, lon:number) => void} [opts.onStormClick]
     *   Optional callback when the user clicks a storm card; defaults to
     *   `window.flyToLatLon` if exposed by earth.html.
     * @param {(stormId:string|null, storm:object|null) => void} [opts.onStormFocus]
     *   Optional callback fired when the user hovers OR clicks a storm
     *   card. The storm-track overlay uses this to highlight the
     *   selected cone on the globe and dim the rest. Receives nulls
     *   when the user mouses out of the panel.
     * @param {number} [opts.maxStorms=5]
     */
    constructor({ onStormClick, onStormFocus, maxStorms = 5 } = {}) {
        this._maxStorms    = maxStorms;
        this._onStormClick = onStormClick;
        this._onStormFocus = onStormFocus;
        this._panel        = null;
        this._listEl       = null;
        this._countEl      = null;
        this._footEl       = null;
        this._pulseEl      = null;
        this._lastDetail   = null;
        this._activeId     = null;        // last hovered/clicked storm id
        this._onUpdate     = this._onUpdate.bind(this);
    }

    mount({ parent = document.body } = {}) {
        if (this._panel) return this;
        injectStyle();
        this._panel   = buildPanelDOM();
        parent.appendChild(this._panel);
        this._listEl  = this._panel.querySelector(`#${PANEL_ID}-list`);
        this._countEl = this._panel.querySelector(`#${PANEL_ID}-count`);
        this._footEl  = this._panel.querySelector(`#${PANEL_ID}-foot`);
        this._pulseEl = this._panel.querySelector(`#${PANEL_ID}-pulse`);

        // Click delegation: one listener on the list root, route to the
        // clicked card via dataset. Cheap, and survives re-renders that
        // wipe child nodes.
        this._listEl.addEventListener('click', (ev) => {
            const card = ev.target.closest('.sw-card');
            if (!card) return;
            const lat = parseFloat(card.dataset.lat);
            const lon = parseFloat(card.dataset.lon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
            // A click pins the focus to this storm — separate from
            // hover-driven focus so a quick mouse-out doesn't
            // immediately clear it. Re-clicking the same card toggles
            // the pin off.
            const id = card.dataset.id || null;
            if (this._pinnedId === id) {
                this._pinnedId = null;
                this._setActiveStorm(null);
            } else {
                this._pinnedId = id;
                this._setActiveStorm(id);
            }
            this._flyTo(lat, lon);
        });

        // Hover focus — highlight the corresponding cone on the globe
        // while the mouse is over a card. Pointer events keep the
        // behaviour consistent across mouse and touch (a tap fires
        // pointerover before click, so we get a brief highlight even
        // on touch devices). Hover focus only applies when no storm
        // is pinned; otherwise the pinned highlight wins.
        this._listEl.addEventListener('pointerover', (ev) => {
            if (this._pinnedId) return;
            const card = ev.target.closest('.sw-card');
            if (!card) return;
            this._setActiveStorm(card.dataset.id || null);
        });
        this._listEl.addEventListener('pointerout', (ev) => {
            if (this._pinnedId) return;
            // Only clear when the pointer actually leaves the list
            // entirely — moving between two cards keeps a focus
            // active.
            if (!ev.relatedTarget || !this._listEl.contains(ev.relatedTarget)) {
                this._setActiveStorm(null);
            }
        });

        window.addEventListener('storm-update', this._onUpdate);

        // Initial paint with an empty state so the panel is never blank
        // — the user sees a hint while the first feed tick arrives.
        this._render();
        return this;
    }

    unmount() {
        window.removeEventListener('storm-update', this._onUpdate);
        if (this._panel?.parentElement) this._panel.parentElement.removeChild(this._panel);
        this._panel = this._listEl = this._countEl = this._footEl = this._pulseEl = null;
    }

    /** Underlying root element so callers can wire drag / minimise chrome. */
    get element() { return this._panel; }

    // ── Internal ──────────────────────────────────────────────────────

    _onUpdate(ev) {
        this._lastDetail = ev?.detail ?? null;
        this._render();
    }

    _flyTo(lat, lon) {
        if (typeof this._onStormClick === 'function') {
            this._onStormClick(lat, lon);
            return;
        }
        // Fallback: earth.html optionally exposes a global flyToLatLon
        // that drives the same camera animation as the user-pin button.
        if (typeof window.flyToLatLon === 'function') {
            window.flyToLatLon(lat, lon);
        }
    }

    /**
     * Mark one card as "active" — adds the visual highlight class and
     * notifies the host (earth.html) so the storm-track overlay can
     * brighten the matching cone and dim the rest. Idempotent.
     */
    _setActiveStorm(id) {
        if (id === this._activeId) return;
        this._activeId = id;
        // Update DOM highlight class without re-rendering the whole list.
        if (this._listEl) {
            this._listEl.querySelectorAll('.sw-card.active').forEach(el => el.classList.remove('active'));
            if (id) {
                const card = this._listEl.querySelector(`.sw-card[data-id="${CSS.escape(id)}"]`);
                if (card) card.classList.add('active');
            }
        }
        // Look up the full storm object so the host can drive overlays
        // that need more than the id (e.g. cone tints by classification).
        let storm = null;
        if (id && this._lastDetail?.storms) {
            storm = this._lastDetail.storms.find(s => s.id === id) ?? null;
        }
        if (typeof this._onStormFocus === 'function') {
            this._onStormFocus(id, storm);
        }
        // Also fire a window event so any other consumer (e.g. a future
        // analytics pane or the layer panel's status pip) can react.
        window.dispatchEvent(new CustomEvent('storm-watch-focus', {
            detail: { id, storm },
        }));
    }

    _render() {
        if (!this._listEl) return;

        const detail = this._lastDetail;
        const status = detail?.status ?? 'connecting';
        const all    = detail?.storms ?? [];

        // Sort by intensity descending — the headline UI is "scariest
        // storms first." Filter out any with non-finite intensity to
        // keep a clean ranking.
        const ranked = all
            .filter(s => Number.isFinite(s.intensityKt))
            .sort((a, b) => b.intensityKt - a.intensityKt)
            .slice(0, this._maxStorms);

        // Pulse colour reflects feed health.
        if (this._pulseEl) {
            this._pulseEl.classList.toggle('offline', status === 'offline');
        }

        if (this._countEl) {
            this._countEl.textContent = all.length
                ? `· ${all.length} active`
                : '';
        }

        if (ranked.length === 0) {
            this._listEl.innerHTML = `
                <div class="sw-empty">
                    ${status === 'offline'
                        ? 'NHC feed unreachable — retrying.'
                        : 'No active tropical cyclones worldwide right now. 🌊'}
                </div>`;
            // No storms left — drop any lingering active focus so the
            // overlay clears and the host's onStormFocus fires with null.
            if (this._activeId || this._pinnedId) {
                this._pinnedId = null;
                this._setActiveStorm(null);
            }
        } else {
            this._listEl.innerHTML = ranked.map(s => this._cardHtml(s)).join('');
            // If the previously-active storm dissipated, clear focus.
            // Otherwise re-apply the active class to the same card after
            // the innerHTML rewrite wiped it.
            if (this._activeId) {
                const stillThere = ranked.some(s => s.id === this._activeId);
                if (!stillThere) {
                    this._pinnedId = null;
                    this._setActiveStorm(null);
                } else {
                    const card = this._listEl.querySelector(`.sw-card[data-id="${CSS.escape(this._activeId)}"]`);
                    if (card) card.classList.add('active');
                }
            }
        }

        if (this._footEl) {
            const updated = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            this._footEl.textContent = `Source: NHC CurrentStorms · updated ${updated}`;
        }
    }

    _cardHtml(s) {
        const meta  = CLASS_META[s.classification] ?? { label: s.classification, tint: '#888' };
        const cat   = categoryFromKt(s.intensityKt);
        const mph   = Math.round(s.intensityKt * 1.15078);
        const motionDir = bearingLabel(s.movementDir);
        const motionKt  = Number.isFinite(s.movementKt) ? Math.round(s.movementKt) : null;
        // Bar fill: 35 kt (TS threshold) → 0%, 165 kt (off-the-charts STY) → 100%.
        const barPct = Math.max(0, Math.min(100, ((s.intensityKt - 35) / 130) * 100));
        const basin  = BASIN_LABEL[s.basin] ?? s.basin ?? '—';
        const press  = Number.isFinite(s.pressureHpa) ? `${Math.round(s.pressureHpa)} hPa` : '';

        // The arrow rotates to match movementDir. CSS rotates from the
        // top — at 0° (north) the unicode arrow already points up, so
        // movementDir maps directly onto the rotation angle.
        const arrowDeg = Number.isFinite(s.movementDir) ? s.movementDir : 0;

        return `
            <div class="sw-card" data-id="${s.id ?? ''}" data-lat="${s.lat}" data-lon="${s.lon}"
                 title="${meta.label} — click to fly to eye">
                <div class="sw-row1">
                    <span class="sw-badge" style="background:${meta.tint}">${s.classification ?? '?'}</span>
                    <span class="sw-name">${(s.name ?? 'Unnamed').toLowerCase()}</span>
                    <span class="sw-cat">${cat ? `Cat ${cat}` : ''}</span>
                </div>
                <div style="font-size:9.5px;color:#aab;">
                    ${Math.round(s.intensityKt)} kt · ${mph} mph${press ? ' · ' + press : ''}
                </div>
                <div class="sw-bar"><div class="sw-bar-fill" style="width:${barPct.toFixed(0)}%"></div></div>
                <div class="sw-row2">
                    <span class="sw-meta">${basin} · ${formatLatLon(s.lat, s.lon)}</span>
                    <span class="sw-meta">
                        ${motionKt != null
                            ? `<span class="sw-mv-arrow" style="transform:rotate(${arrowDeg}deg)">↑</span> ${motionDir} ${motionKt} kt`
                            : '—'}
                    </span>
                </div>
            </div>`;
    }
}

export default StormWatchPanel;
