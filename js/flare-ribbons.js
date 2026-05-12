// js/flare-ribbons.js
//
// Phase 3.1 — feed the existing photosphere "two-ribbon" flare shader
// with real PIL geometry from the field-line atlas, replacing the
// hardcoded straight east-west arcs.
//
// Construction principle: a closed PIL-anchored field line crosses through
// the apex *above* the polarity inversion line, so its two photospheric
// footpoints sit on opposite sides of the PIL. Collect every PIL-closed
// line for the flaring AR, take {sample[0], sample[N-1]} as a footpoint
// pair, sort each side along the dominant PIL axis, and we have two
// smooth ribbon polylines that exactly trace the AR's reconnection
// geometry.
//
// Output: a 32 × 2 RGBA float DataTexture sampled by the photosphere
// fragment shader. Row 0 = ribbon A, row 1 = ribbon B; .xyz = unit
// position on the photosphere; .w = validity (1.0 valid, 0.0 padding).
// The shader walks segments with a small per-fragment loop and computes
// the minimum great-circle-ish distance to either polyline.
//
// When fewer than two valid points are available per ribbon (no atlas,
// no PIL bundles for that AR, etc.) we leave the texture cleared and
// signal the shader via an `active` uniform to fall back to the legacy
// straight-ribbon math. Graceful degradation; no production regressions.

import * as THREE from 'three';

const MAX_POINTS  = 32;
const TEX_W       = MAX_POINTS;
const TEX_H       = 2;
const META_STRIDE = 8;

let _texture = null;
let _buffer  = null;

// Most recent set of conjugate footpoint pairs (one per PIL-closed loop of
// the flaring AR), preserved across updateRibbonsForAr calls so the HXR
// kernel system can pick them up without re-walking the atlas. Cleared on
// clearRibbons() / failed updates.
let _currentPairs = [];

function _ensureTexture() {
    if (_texture) return _texture;
    _buffer  = new Float32Array(TEX_W * TEX_H * 4);
    _texture = new THREE.DataTexture(_buffer, TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType);
    _texture.minFilter = THREE.NearestFilter;
    _texture.magFilter = THREE.NearestFilter;
    _texture.wrapS = THREE.ClampToEdgeWrapping;
    _texture.wrapT = THREE.ClampToEdgeWrapping;
    _texture.generateMipmaps = false;
    _texture.needsUpdate = true;
    return _texture;
}

/** Returns the singleton ribbon DataTexture (creating it on first call). */
export function getRibbonTexture() { return _ensureTexture(); }

/**
 * Conjugate footpoint pairs from the most recent updateRibbonsForAr().
 * Each entry is `{ a: [x,y,z], b: [x,y,z], apex, lineIdx }` where a/b are
 * unit-sphere positions of the two loop footpoints (opposite sides of the
 * PIL by construction). Empty array if no flare is active or no PIL
 * bundles were found. The HXR kernel system reads this directly.
 */
export function getCurrentFootpointPairs() { return _currentPairs; }

/** Maximum points per ribbon in the texture (matches the shader loop). */
export const MAX_RIBBON_POINTS = MAX_POINTS;

/**
 * Compute ribbons from the atlas and pack them into the texture.
 *
 * @param {object} atlas   — { lineCount, samplesPerLine, meta, positions }
 * @param {number} arIdx   — AR index to filter by (matches meta[2]).
 *
 * @returns {number}       — points placed per ribbon (min of A,B). 0 means
 *                            the texture was cleared and the shader should
 *                            fall back to legacy straight ribbons.
 */
export function updateRibbonsForAr(atlas, arIdx) {
    _ensureTexture();
    _buffer.fill(0);
    _currentPairs = [];

    if (!atlas || atlas.lineCount === 0 || arIdx < 0) {
        _texture.needsUpdate = true;
        return 0;
    }

    const collected = _collectFootpoints(atlas, arIdx);
    if (!collected || collected.A.length < 2 || collected.B.length < 2) {
        _texture.needsUpdate = true;
        return 0;
    }

    // Preserve the conjugate pairing (A[i] and B[i] are from the same line)
    // separately from the texture, which sorts each side along the PIL axis.
    _currentPairs = collected.pairs;

    // Sort each ribbon along the dominant axis of the combined point set
    // so the polyline doesn't zig-zag (the shader assumes adjacent texels
    // are adjacent ribbon points).
    const A = collected.A.slice();
    const B = collected.B.slice();
    const axis = _principalAxis([...A, ...B]);
    const projSort = (a, b) => _dot3(a, axis) - _dot3(b, axis);
    A.sort(projSort);
    B.sort(projSort);

    _writeRibbon(_buffer, 0, A);
    _writeRibbon(_buffer, 1, B);
    _texture.needsUpdate = true;
    return Math.min(A.length, B.length, MAX_POINTS);
}

/** Clear the ribbon texture (signal the shader to use the legacy fallback). */
export function clearRibbons() {
    if (!_buffer) return;
    _buffer.fill(0);
    _currentPairs = [];
    _texture.needsUpdate = true;
}

// ─── footpoint collection ───────────────────────────────────────────

function _collectFootpoints(atlas, arIdx) {
    const meta = atlas.meta;
    const positions = atlas.positions;
    const samples = atlas.samplesPerLine;
    const lastSample = samples - 1;

    const A = [];
    const B = [];
    const pairs = [];
    for (let i = 0; i < atlas.lineCount; i++) {
        const m0 = i * META_STRIDE;
        if (meta[m0]     !== 0) continue;        // closed only
        if (meta[m0 + 1] !== 2) continue;        // PIL-anchored only
        if ((meta[m0 + 2] | 0) !== arIdx) continue;

        const oA = (i * samples + 0) * 3;
        const oB = (i * samples + lastSample) * 3;

        const ax = positions[oA    ], ay = positions[oA + 1], az = positions[oA + 2];
        const bx = positions[oB    ], by = positions[oB + 1], bz = positions[oB + 2];

        const aLen = Math.hypot(ax, ay, az);
        const bLen = Math.hypot(bx, by, bz);
        // Only count footpoints actually on the photosphere (within 1% of unit).
        if (Math.abs(aLen - 1.0) > 0.02 || Math.abs(bLen - 1.0) > 0.02) continue;

        const a = [ax / aLen, ay / aLen, az / aLen];
        const b = [bx / bLen, by / bLen, bz / bLen];
        A.push(a);
        B.push(b);
        pairs.push({ a, b, apex: meta[m0 + 3], lineIdx: i });
    }
    if (A.length === 0) return null;
    return { A, B, pairs };
}

// ─── principal axis (power iteration on covariance) ─────────────────

function _principalAxis(pts) {
    if (pts.length < 2) return [1, 0, 0];

    // Centre the cloud
    let cx = 0, cy = 0, cz = 0;
    for (const p of pts) { cx += p[0]; cy += p[1]; cz += p[2]; }
    cx /= pts.length; cy /= pts.length; cz /= pts.length;

    // Symmetric covariance matrix
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const p of pts) {
        const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
        xx += dx * dx; xy += dx * dy; xz += dx * dz;
        yy += dy * dy; yz += dy * dz; zz += dz * dz;
    }

    // Power iteration → dominant eigenvector. Initial guess matters less than
    // it would for an arbitrary matrix because covariance is positive-definite.
    let vx = 1, vy = 0, vz = 0;
    for (let it = 0; it < 12; it++) {
        const nx = xx * vx + xy * vy + xz * vz;
        const ny = xy * vx + yy * vy + yz * vz;
        const nz = xz * vx + yz * vy + zz * vz;
        const n = Math.hypot(nx, ny, nz);
        if (n < 1e-12) break;
        vx = nx / n; vy = ny / n; vz = nz / n;
    }
    return [vx, vy, vz];
}

function _dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

// ─── packing ────────────────────────────────────────────────────────

function _writeRibbon(buf, row, pts) {
    const n = Math.min(pts.length, MAX_POINTS);
    const rowOff = row * MAX_POINTS * 4;
    for (let i = 0; i < n; i++) {
        const o = rowOff + i * 4;
        buf[o    ] = pts[i][0];
        buf[o + 1] = pts[i][1];
        buf[o + 2] = pts[i][2];
        buf[o + 3] = 1.0;
    }
    // Trailing pixels remain zero from the prior fill(0) — w=0 signals end.
}
