/**
 * sdo-compare-panel.js — Live SDO/AIA reference image, side-by-side with the
 * synthetic EUV corona shader.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * A small floating panel that mirrors the active EUV channel selection and
 * fetches NASA SDO's "latest" image at the matching wavelength so the
 * synthetic-DEM rendering can be A/B-checked against the real instrument
 * data in the same view.
 *
 * SDO assets are static "latest_1024_<channel>.jpg" URLs that NASA updates
 * every ~12 minutes; we attach a 5-minute-resolution cache-buster
 * (`?t=<floor>`) so browsers eventually refetch without storming the CDN
 * on every render tick.
 *
 * ── Channel coverage ────────────────────────────────────────────────────
 *   white   HMI Intensitygram (white-light continuum)
 *   94      AIA 94 Å   Fe XVIII   ~7 MK   flare core
 *   131     AIA 131 Å  Fe XXI     ~10 MK  flare hot
 *   171     AIA 171 Å  Fe IX      ~0.7 MK quiet plage / coronal loops
 *   193     AIA 193 Å  Fe XII     ~1.6 MK ARs + coronal holes (dark)
 *   211     AIA 211 Å  Fe XIV     ~2 MK   AR loops
 *   304     AIA 304 Å  He II      ~50 kK  chromosphere + prominences
 *
 * ── Usage ───────────────────────────────────────────────────────────────
 *   import { SdoComparePanel } from './js/sdo-compare-panel.js';
 *   const panel = new SdoComparePanel(document.getElementById('sdo-cmp')).start();
 *   // Sync to the EUV selector:
 *   panel.setChannel('171');
 *
 * The panel is *visual reference only* — no canvas read-back, so cross-
 * origin restrictions on NASA's CDN don't apply (an `<img src>` displays
 * fine without CORS headers).  Texture-based comparison would need a
 * proxied fetch; a future enhancement.
 */

const SDO_URL = {
    white: 'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_HMIIC.jpg',
    94:    'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0094.jpg',
    131:   'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0131.jpg',
    171:   'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0171.jpg',
    193:   'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg',
    211:   'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0211.jpg',
    304:   'https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0304.jpg',
};

const CHANNEL_DESC = {
    white: 'HMI continuum',
    94:    '94 Å · Fe XVIII · ~7 MK',
    131:   '131 Å · Fe XXI · ~10 MK',
    171:   '171 Å · Fe IX · ~0.7 MK',
    193:   '193 Å · Fe XII · ~1.6 MK',
    211:   '211 Å · Fe XIV · ~2 MK',
    304:   '304 Å · He II · ~50 kK',
};

// 5 minutes → cache-buster bucket; browsers serve from cache until the bucket
// rolls over.  AIA images update every ~12 min, so 5 min is plenty fresh.
const REFRESH_MS = 5 * 60 * 1000;

export class SdoComparePanel {
    /**
     * @param {HTMLElement} rootEl  pre-existing container element to populate
     */
    constructor(rootEl) {
        this._root    = rootEl;
        this._channel = 'white';
        this._timer   = null;
        this._render();
    }

    _render() {
        this._root.innerHTML = `
            <div class="sdo-cmp-header">
                <span class="sdo-cmp-title">SDO live · <span class="sdo-cmp-mark">A/B</span></span>
                <span class="sdo-cmp-ch" id="sdo-cmp-ch">—</span>
            </div>
            <img class="sdo-cmp-img" id="sdo-cmp-img"
                 alt="SDO live reference image at the active EUV channel"
                 referrerpolicy="no-referrer">
            <div class="sdo-cmp-foot" id="sdo-cmp-foot">— select channel —</div>
        `;
        this._img    = this._root.querySelector('#sdo-cmp-img');
        this._chEl   = this._root.querySelector('#sdo-cmp-ch');
        this._footEl = this._root.querySelector('#sdo-cmp-foot');
    }

    /**
     * Switch the panel to display the SDO image for `channel`.
     *
     * @param {string} channel  one of 'white' | '94' | '131' | '171' | '193' | '211' | '304'
     */
    setChannel(channel) {
        this._channel = channel in SDO_URL ? channel : 'white';
        const url = SDO_URL[this._channel];
        // Cache-buster bucketed to REFRESH_MS so reloads don't hammer NASA's
        // CDN at the page's render tick rate.
        const bucket = Math.floor(Date.now() / REFRESH_MS);
        const fullUrl = `${url}?t=${bucket}`;
        this._chEl.textContent = CHANNEL_DESC[this._channel] ?? this._channel;
        this._footEl.textContent = 'loading from NASA SDO…';
        this._footEl.classList.remove('sdo-cmp-err');
        this._img.onload  = () => {
            const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            this._footEl.textContent = `latest · fetched ${ts}`;
        };
        this._img.onerror = () => {
            this._footEl.textContent = 'NASA CDN unreachable — try again later';
            this._footEl.classList.add('sdo-cmp-err');
        };
        this._img.src = fullUrl;
    }

    /** Begin auto-refresh on REFRESH_MS interval. */
    start() {
        this.setChannel(this._channel);
        if (!this._timer) {
            this._timer = setInterval(() => this.setChannel(this._channel), REFRESH_MS);
        }
        return this;
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
    }

    /** Currently displayed channel ('white' | '94' | …). */
    get channel() { return this._channel; }
}
