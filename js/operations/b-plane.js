/**
 * b-plane.js — Encounter-plane inset for the Operations console.
 *
 * Bottom-right SVG overlay over the globe. Shows, for the most
 * recently selected conjunction:
 *   - 1σ, 2σ, 3σ rings of combined miss-plane uncertainty
 *   - a dot at radius = miss_km from origin
 *   - axis legend + numeric readout
 *
 * Honest-v1 caveat: a faithful B-plane requires the relative-velocity
 * direction at TCA to fix the (B·R, B·T) axes. The conjunction
 * screening pipeline today gives us miss magnitude only, so we
 * collapse to a polar plot — concentric rings = combined σ, dot at
 * the right radius. The visual semantic operators care about — "is
 * the dot inside or outside the σ rings?" — survives unchanged.
 *
 * Real Space-Track CDMs ship the miss vector with direction; when an
 * Enterprise customer wires those in, this module gets the (xi, eta)
 * pair instead of the bare radius and switches to a true B-plane.
 */

import { tleAgeUncertainty, combinedMissEnvelope } from './uncertainty.js';
import { provStore }                                from './provenance.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const SIZE = 200;
const CX = SIZE / 2;
const CY = SIZE / 2;

let _hostEl = null;
let _svg    = null;
let _state  = null;

function el(tag, attrs = {}) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
}

function ensureMounted() {
    if (_hostEl) return _hostEl;
    _hostEl = document.createElement('div');
    _hostEl.id = 'op-bplane';
    _hostEl.className = 'op-bplane op-bplane-empty';
    _hostEl.innerHTML = `
        <div class="op-bplane-head">
            <span class="op-bplane-title">Encounter</span>
            <span class="op-bplane-name" id="op-bplane-name">—</span>
        </div>
        <svg id="op-bplane-svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}"></svg>
        <div class="op-bplane-foot">
            <span class="op-bplane-miss"  id="op-bplane-miss">—</span>
            <span class="op-bplane-sigma" id="op-bplane-sigma">—</span>
        </div>
    `;
    const wrap = document.getElementById('op-globe-wrap') || document.body;
    wrap.appendChild(_hostEl);
    _svg = _hostEl.querySelector('#op-bplane-svg');
    return _hostEl;
}

function render() {
    ensureMounted();
    if (!_state) {
        _hostEl.classList.add('op-bplane-empty');
        _svg.innerHTML = '';
        document.getElementById('op-bplane-name').textContent  = '—';
        document.getElementById('op-bplane-miss').textContent  = 'Click a conjunction →';
        document.getElementById('op-bplane-sigma').textContent = '';
        return;
    }
    _hostEl.classList.remove('op-bplane-empty');

    // Pick the radius scale: max(miss + 0.5σ, 3σ) so the dot is always
    // visible AND the σ rings are visible too.
    const sigmaPlane = Math.hypot(_state.sigmaAlong, _state.sigmaCross);
    const reach = Math.max(_state.missKm * 1.15, 3.5 * sigmaPlane, 1);
    const radiusOf = (km) => (km / reach) * (SIZE * 0.42);

    const elems = [];

    // Backdrop
    elems.push(el('rect', {
        x: 0, y: 0, width: SIZE, height: SIZE,
        class: 'op-bplane-bg',
    }));

    // Crosshair axes
    elems.push(el('line', { x1: 0, y1: CY, x2: SIZE, y2: CY, class: 'op-bplane-axis' }));
    elems.push(el('line', { x1: CX, y1: 0, x2: CX, y2: SIZE, class: 'op-bplane-axis' }));

    // Sigma rings: 1σ, 2σ, 3σ
    for (const k of [1, 2, 3]) {
        const r = radiusOf(k * sigmaPlane);
        if (r < 1) continue;
        elems.push(el('circle', {
            cx: CX, cy: CY, r,
            class: `op-bplane-sigma-ring op-bplane-sigma-${k}`,
        }));
        elems.push(el('text', {
            x: CX + r + 3, y: CY - 4,
            class: 'op-bplane-sigma-label',
        })).appendChild
            ? null
            : null;
        const tx = el('text', {
            x: CX + r + 3, y: CY - 4,
            class: 'op-bplane-sigma-label',
        });
        tx.textContent = `${k}σ`;
        elems.push(tx);
    }

    // Miss dot — placed along +X by convention since true B-plane
    // direction isn't available without relative-velocity geometry.
    const missR = radiusOf(_state.missKm);
    elems.push(el('line', {
        x1: CX, y1: CY,
        x2: CX + missR, y2: CY,
        class: 'op-bplane-miss-vec',
    }));
    elems.push(el('circle', {
        cx: CX + missR, cy: CY, r: 4,
        class: 'op-bplane-miss-dot',
    }));

    _svg.innerHTML = '';
    elems.forEach(e => _svg.appendChild(e));

    // Footer numbers.
    document.getElementById('op-bplane-name').textContent =
        `${_state.assetName} ↔ ${_state.secondaryName}`;
    document.getElementById('op-bplane-miss').textContent =
        `miss ${_state.missKm.toFixed(1)} km`;
    document.getElementById('op-bplane-sigma').textContent =
        `1σ ${sigmaPlane.toFixed(1)} km`;
}

/**
 * Update the inset with a fresh conjunction.
 *
 * Inputs (from the decision-deck conjunction-row click):
 *   { assetName, secondaryName,
 *     assetTle, secondaryTle, tcaMs, missKm }
 *
 * The σ values come from each TLE's age via tleAgeUncertainty,
 * combined in quadrature (independent uncertainties).
 */
export function showConjunction(conj) {
    if (!conj || !conj.assetTle || !conj.secondaryTle) {
        _state = null;
        render();
        return;
    }
    const ap = provStore.get('idx.ap')?.value ?? 15;
    const aSig = tleAgeUncertainty(conj.assetTle,     conj.tcaMs ?? Date.now(), ap);
    const bSig = tleAgeUncertainty(conj.secondaryTle, conj.tcaMs ?? Date.now(), ap);
    const env = combinedMissEnvelope(
        { sigmaAlong: aSig.along, sigmaCross: aSig.cross, sigmaRadial: aSig.radial },
        { sigmaAlong: bSig.along, sigmaCross: bSig.cross, sigmaRadial: bSig.radial },
    );
    _state = {
        assetName:     conj.assetName     ?? 'asset',
        secondaryName: conj.secondaryName ?? 'secondary',
        missKm:        Math.max(0, conj.missKm ?? 0),
        sigmaAlong:    env.sigmaAlong,
        sigmaCross:    env.sigmaCross,
        sigmaRadial:   env.sigmaRadial,
    };
    render();
}

export function clearConjunction() {
    _state = null;
    render();
}

export function mountBPlane() {
    ensureMounted();
    render();
}
