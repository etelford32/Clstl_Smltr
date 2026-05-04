/**
 * b-plane.js — Encounter-plane inset for the Operations console.
 *
 * Bottom-right SVG overlay over the globe. Shows, for the most
 * recently selected conjunction:
 *   - 1σ, 2σ, 3σ rings of combined miss-plane uncertainty
 *   - the miss vector as a dot at the projected (B·R, B·T) coords,
 *     with the relative-velocity direction (out of the page) called
 *     out at the corner
 *   - axis legend + numeric readout
 *
 * Geometry: the encounter B-plane is the plane through the primary at
 * TCA whose normal is v_rel (the relative-velocity vector). We pick
 * the canonical Vallado axes:
 *
 *   T-hat = (v_rel × Z_eci) / |…|     (perpendicular to v_rel,
 *                                      in-plane horizontal)
 *   R-hat = v_rel × T-hat / |v_rel|   (completes the right-handed
 *                                      basis)
 *
 * The miss vector (primary − secondary at TCA) is projected onto
 * (T-hat, R-hat); its in-plane components (B·T, B·R) place the dot.
 * If the screen didn't return v_rel (e.g. a Space-Track CDM that
 * already ships projected miss vector components, or an old screen),
 * we fall back to the polar plot — dot on +X axis at the right radius.
 *
 * Real Space-Track CDMs ship (xi, eta) pre-projected; when those land
 * via Enterprise integration, callers can pass them in directly via
 * conj.bplane = { biR, biT } and skip the on-the-fly projection.
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

// Project a miss vector onto the encounter B-plane (Vallado axes).
// Returns { biR, biT, axesValid } where axesValid is false when v_rel
// is missing or degenerate (parallel to the chosen reference Z), in
// which case the caller should fall back to the polar layout.
function projectMissOntoBPlane(missVec, vRel) {
    if (!missVec || !vRel) return { biR: null, biT: null, axesValid: false };
    const vx = vRel.x, vy = vRel.y, vz = vRel.z;
    const vMag = Math.hypot(vx, vy, vz);
    if (vMag < 1e-9) return { biR: null, biT: null, axesValid: false };

    // T-hat = (v × Z) / |…|, where Z = (0, 0, 1). Cross with Z drops
    // the z-component of v: T = (vy, -vx, 0). When v is nearly parallel
    // to Z (a polar encounter), the cross is near zero — fall back.
    const tx0 =  vy;
    const ty0 = -vx;
    const tz0 =  0;
    const tMag = Math.hypot(tx0, ty0, tz0);
    if (tMag < 1e-6 * vMag) return { biR: null, biT: null, axesValid: false };
    const tx = tx0 / tMag, ty = ty0 / tMag, tz = tz0 / tMag;

    // R-hat = (v × T) / |v|.  v × T computed directly:
    //   rx = vy*tz - vz*ty
    //   ry = vz*tx - vx*tz
    //   rz = vx*ty - vy*tx
    const rx0 = vy * tz - vz * ty;
    const ry0 = vz * tx - vx * tz;
    const rz0 = vx * ty - vy * tx;
    const rMag = Math.hypot(rx0, ry0, rz0);
    const rx = rx0 / rMag, ry = ry0 / rMag, rz = rz0 / rMag;

    const biT = missVec.x * tx + missVec.y * ty + missVec.z * tz;
    const biR = missVec.x * rx + missVec.y * ry + missVec.z * rz;
    return { biR, biT, axesValid: true };
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

    // Axis labels (T horizontal, R vertical) — only when the projection
    // is valid; otherwise we're in polar fallback mode and the labels
    // would be misleading.
    if (_state.axesValid) {
        const tLabel = el('text', { x: SIZE - 14, y: CY - 4, class: 'op-bplane-axis-label' });
        tLabel.textContent = 'T';
        elems.push(tLabel);
        const rLabel = el('text', { x: CX + 4, y: 12, class: 'op-bplane-axis-label' });
        rLabel.textContent = 'R';
        elems.push(rLabel);
    }

    // Sigma rings: 1σ, 2σ, 3σ
    for (const k of [1, 2, 3]) {
        const r = radiusOf(k * sigmaPlane);
        if (r < 1) continue;
        elems.push(el('circle', {
            cx: CX, cy: CY, r,
            class: `op-bplane-sigma-ring op-bplane-sigma-${k}`,
        }));
        const tx = el('text', {
            x: CX + r + 3, y: CY - 4,
            class: 'op-bplane-sigma-label',
        });
        tx.textContent = `${k}σ`;
        elems.push(tx);
    }

    // Miss dot. Real (B·T, B·R) when v_rel is available; +X polar
    // fallback otherwise.
    let dotX, dotY;
    if (_state.axesValid) {
        // Screen-Y is inverted vs. math-Y, so a positive R goes "up".
        dotX = CX + radiusOf(_state.biT);
        dotY = CY - radiusOf(_state.biR);
    } else {
        dotX = CX + radiusOf(_state.missKm);
        dotY = CY;
    }

    elems.push(el('line', {
        x1: CX, y1: CY,
        x2: dotX, y2: dotY,
        class: 'op-bplane-miss-vec',
    }));
    elems.push(el('circle', {
        cx: dotX, cy: dotY, r: 4,
        class: 'op-bplane-miss-dot',
    }));

    _svg.innerHTML = '';
    elems.forEach(e => _svg.appendChild(e));

    // Footer numbers.
    document.getElementById('op-bplane-name').textContent =
        `${_state.assetName} ↔ ${_state.secondaryName}`;
    document.getElementById('op-bplane-miss').textContent =
        _state.axesValid
            ? `miss ${_state.missKm.toFixed(2)} km · B·T ${_state.biT.toFixed(2)} · B·R ${_state.biR.toFixed(2)}`
            : `miss ${_state.missKm.toFixed(2)} km · polar`;
    document.getElementById('op-bplane-sigma').textContent =
        _state.dvKms != null
            ? `1σ ${sigmaPlane.toFixed(1)} km · |Δv| ${_state.dvKms.toFixed(2)} km/s`
            : `1σ ${sigmaPlane.toFixed(1)} km`;
}

/**
 * Update the inset with a fresh conjunction.
 *
 * Inputs (from the decision-deck conjunction-row click):
 *   { assetName, secondaryName, assetTle, secondaryTle,
 *     tcaMs, missKm,
 *     missVec?, vRel?, missUnit?, dvKms? }
 *
 * When `vRel` and `missVec` are present the inset projects onto the
 * real (B·T, B·R) axes. Without them it falls back to the polar dot
 * placement.
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

    // Reconstruct miss vector if only the unit + magnitude survived
    // the trip from the worker (older callers).
    let missVec = conj.missVec ?? null;
    if (!missVec && conj.missUnit && Number.isFinite(conj.missKm)) {
        missVec = {
            x: conj.missUnit.x * conj.missKm,
            y: conj.missUnit.y * conj.missKm,
            z: conj.missUnit.z * conj.missKm,
        };
    }
    const proj = projectMissOntoBPlane(missVec, conj.vRel);

    _state = {
        assetName:     conj.assetName     ?? 'asset',
        secondaryName: conj.secondaryName ?? 'secondary',
        missKm:        Math.max(0, conj.missKm ?? 0),
        sigmaAlong:    env.sigmaAlong,
        sigmaCross:    env.sigmaCross,
        sigmaRadial:   env.sigmaRadial,
        biR:           proj.biR,
        biT:           proj.biT,
        axesValid:     proj.axesValid,
        dvKms:         Number.isFinite(conj.dvKms) ? conj.dvKms : null,
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
