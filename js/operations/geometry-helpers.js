/**
 * geometry-helpers.js — Tiny merged-geometry primitives for the
 * Operations hero meshes.
 *
 * The starlink-model / rocket-body-model / envisat-model files each
 * ship their own copies of pushBox / pushCylinderSide / pushCap; this
 * module is the unified version that new hero-class meshes (ISS,
 * Hubble, Tiangong) build against, so we're not maintaining four
 * copies of the same trig loop. The existing files keep their inline
 * copies for now — they'll migrate when next touched.
 *
 * All helpers append into the same `out = { positions, normals,
 * colors, indices }` accumulator (typed-array-friendly plain
 * arrays). `finalizeGeometry(out)` packs that into a THREE.BufferGeometry
 * with per-vertex colours, flat normals, and a precomputed bounding
 * sphere.
 *
 * Each face uses fresh vertices (no smoothing across edges) so per-
 * face colour + per-face normal stays flat. This is the right
 * trade-off for the hero meshes — they're rendered with
 * MeshStandardMaterial({ flatShading: true }), so smoothed normals
 * would be ignored anyway, and the flat per-face colouring is what
 * gives the bus / panel / antenna decks their distinctness.
 */

import * as THREE from 'three';

/**
 * Append a rectangular box. `faceColors` is a 6-tuple of 3-vectors
 * in order [+X, -X, +Y, -Y, +Z, -Z].
 */
export function pushBox(out, cx, cy, cz, sx, sy, sz, faceColors) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = [
        [cx - hx, cy - hy, cz - hz],
        [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz],
        [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz],
        [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz],
        [cx - hx, cy + hy, cz + hz],
    ];
    const faces = [
        { corners: [1, 2, 6, 5], normal: [ 1,  0,  0], color: faceColors[0] },
        { corners: [3, 0, 4, 7], normal: [-1,  0,  0], color: faceColors[1] },
        { corners: [2, 3, 7, 6], normal: [ 0,  1,  0], color: faceColors[2] },
        { corners: [0, 1, 5, 4], normal: [ 0, -1,  0], color: faceColors[3] },
        { corners: [4, 5, 6, 7], normal: [ 0,  0,  1], color: faceColors[4] },
        { corners: [3, 2, 1, 0], normal: [ 0,  0, -1], color: faceColors[5] },
    ];
    for (const f of faces) {
        const base = out.positions.length / 3;
        for (const ci of f.corners) {
            out.positions.push(c[ci][0], c[ci][1], c[ci][2]);
            out.normals.push(f.normal[0], f.normal[1], f.normal[2]);
            out.colors.push(f.color[0], f.color[1], f.color[2]);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

/**
 * Append a cylinder side (no caps). Cylinder is oriented along its
 * local Y axis. Frustum-aware — pass different radiusTop / radiusBottom
 * for cones / nozzles. Slant normals tilt toward the smaller end.
 */
export function pushCylinderSide(out, radiusBottom, radiusTop, height, yCenter, segments, color, axis = 'y') {
    const halfH = height / 2;
    const aBot  = yCenter - halfH;
    const aTop  = yCenter + halfH;
    const dr    = radiusTop - radiusBottom;
    const slant = Math.hypot(height, dr);
    const nRadial = slant > 0 ? height / slant : 1;
    const nAxial  = slant > 0 ? -dr    / slant : 0;

    for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const base = out.positions.length / 3;

        // Per-corner positions. The `axis` parameter rotates which
        // two components of (cos, sin) form the cross-section plane;
        // the third holds the cap-to-cap height.
        const p = (ang, r, ax) => {
            const cs = Math.cos(ang), sn = Math.sin(ang);
            if (axis === 'y') return [cs * r, ax, sn * r];
            if (axis === 'x') return [ax, cs * r, sn * r];
            return [cs * r, sn * r, ax];
        };
        const p0 = p(a0, radiusBottom, aBot);
        const p1 = p(a1, radiusBottom, aBot);
        const p2 = p(a1, radiusTop,    aTop);
        const p3 = p(a0, radiusTop,    aTop);
        out.positions.push(p0[0], p0[1], p0[2],
                           p1[0], p1[1], p1[2],
                           p2[0], p2[1], p2[2],
                           p3[0], p3[1], p3[2]);

        // Midpoint normal — flat per-segment shading.
        const mid = (a0 + a1) / 2;
        const cm  = Math.cos(mid), sm = Math.sin(mid);
        let nx, ny, nz;
        if (axis === 'y')      { nx = cm * nRadial; ny = nAxial;       nz = sm * nRadial; }
        else if (axis === 'x') { nx = nAxial;       ny = cm * nRadial; nz = sm * nRadial; }
        else                   { nx = cm * nRadial; ny = sm * nRadial; nz = nAxial;       }

        for (let k = 0; k < 4; k++) {
            out.normals.push(nx, ny, nz);
            out.colors.push(color[0], color[1], color[2]);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

/**
 * Append a flat disc cap at position `axisPos` along the chosen
 * axis. `up=true` means the cap normal points along +axis.
 */
export function pushCap(out, radius, axisPos, segments, up, color, axis = 'y') {
    const sign = up ? 1 : -1;
    const center = out.positions.length / 3;
    const centerP = axis === 'y' ? [0, axisPos, 0]
                  : axis === 'x' ? [axisPos, 0, 0]
                  :                [0, 0, axisPos];
    const normal  = axis === 'y' ? [0, sign, 0]
                  : axis === 'x' ? [sign, 0, 0]
                  :                [0, 0, sign];
    out.positions.push(...centerP);
    out.normals.push(...normal);
    out.colors.push(color[0], color[1], color[2]);

    for (let i = 0; i <= segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const cs = Math.cos(a), sn = Math.sin(a);
        const p = axis === 'y' ? [cs * radius, axisPos, sn * radius]
                : axis === 'x' ? [axisPos, cs * radius, sn * radius]
                :                [cs * radius, sn * radius, axisPos];
        out.positions.push(p[0], p[1], p[2]);
        out.normals.push(normal[0], normal[1], normal[2]);
        out.colors.push(color[0], color[1], color[2]);
    }
    for (let i = 0; i < segments; i++) {
        const a = center + 1 + i;
        const b = center + 1 + ((i + 1) % (segments + 1));
        if (up) out.indices.push(center, a, b);
        else    out.indices.push(center, b, a);
    }
}

/** Pack the accumulator into a THREE.BufferGeometry. */
export function finalizeGeometry(out) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(out.normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(out.colors, 3));
    geo.setIndex(out.indices);
    geo.computeBoundingSphere();
    return geo;
}

/** Fresh empty accumulator. */
export function newAccum() {
    return { positions: [], normals: [], colors: [], indices: [] };
}
