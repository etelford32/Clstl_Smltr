/**
 * trail.js — Fading velocity ribbon for a single moving point.
 *
 * Maintains a short history of scene-space positions and renders them
 * as a THREE.Line whose vertex colours fade from full intensity at
 * the satellite's current position to black at the tail. Against a
 * dark sky background the colour fade reads as an alpha fade (each
 * vertex contributes less light), so the ribbon looks like a glowing
 * comet tail trailing the body.
 *
 * Design notes:
 *
 *   - Distance-keyed sampling. Instead of decimating by frame count
 *     or wall-clock time, push() compares against the last sample
 *     and only grows the buffer when the body has moved further than
 *     `minDistance`. That gives a consistent on-screen spacing
 *     between trail segments at every scrub speed — the visible
 *     length stays bounded by `maxSegments × minDistance` regardless
 *     of whether the user is at 1× live or 3600× replay.
 *
 *   - Jump detection. When the body teleports (operator scrubbed
 *     across an hour, layer just loaded, lat/lon snap), the new
 *     point lands far from the head. Naively connecting the two
 *     would draw a long ugly chord across empty space. Past a
 *     distance threshold (`jumpDistance`, default ~20×
 *     `minDistance`), we clear the buffer and restart the trail
 *     from the new point.
 *
 *   - Slide-down ring. When the buffer fills up we copyWithin() to
 *     drop the oldest sample. Trail buffers are tiny (default
 *     80 × 3 = 240 floats) — the memmove is essentially free
 *     compared to a per-frame raycast.
 *
 *   - Additive blending. The trail draws on top of the Earth + sky
 *     without needing a depth pass; depthWrite is off so the mesh
 *     in front always reads correctly.
 */

import * as THREE from 'three';

const DEFAULT_MAX_SEGMENTS  = 80;
// ~7.7 km in scene units (Earth R = 1 = 6378 km). One ISS-second of
// motion. At 1× live this samples roughly every 1 s; at heavy scrub
// the trail extends without sample density blowing up.
const DEFAULT_MIN_DISTANCE  = 0.0012;
// Jump-detection threshold — any push further than this from the
// head wipes the trail. 20× minDistance ≈ 150 km. Bigger than any
// real motion between adjacent frames at sane scrub speeds.
const DEFAULT_JUMP_MULTIPLE = 20;

export class Trail {
    /**
     * @param {THREE.Scene} scene
     * @param {object}      opts
     * @param {number}      [opts.color=0x00ffcc]   trail head colour
     * @param {number}      [opts.maxSegments=80]   max line segments
     * @param {number}      [opts.minDistance]      scene-units between samples
     * @param {number}      [opts.jumpDistance]     scene-units that triggers a reset
     * @param {number}      [opts.headBrightness=1] colour multiplier at head
     * @param {number}      [opts.tailBrightness=0] colour multiplier at tail
     * @param {number}      [opts.opacity=0.9]      material opacity
     */
    constructor(scene, opts = {}) {
        const {
            color           = 0x00ffcc,
            maxSegments     = DEFAULT_MAX_SEGMENTS,
            minDistance     = DEFAULT_MIN_DISTANCE,
            jumpDistance    = DEFAULT_MIN_DISTANCE * DEFAULT_JUMP_MULTIPLE,
            headBrightness  = 1.0,
            tailBrightness  = 0.0,
            opacity         = 0.9,
        } = opts;

        this._maxSegments = maxSegments;
        this._minDist2    = minDistance * minDistance;
        this._jumpDist2   = jumpDistance * jumpDistance;
        this._head        = headBrightness;
        this._tail        = tailBrightness;
        this._count       = 0;

        const c = new THREE.Color(color);
        this._r = c.r;
        this._g = c.g;
        this._b = c.b;

        // maxSegments + 1 vertices give maxSegments line segments.
        const n = maxSegments + 1;
        this._positions = new Float32Array(n * 3);
        this._colors    = new Float32Array(n * 3);
        this._capacity  = n;

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(this._positions, 3));
        geo.setAttribute('color',    new THREE.BufferAttribute(this._colors, 3));
        geo.setDrawRange(0, 0);

        const mat = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent:  true,
            opacity,
            blending:     THREE.AdditiveBlending,
            depthWrite:   false,
        });

        this._line = new THREE.Line(geo, mat);
        // Trail positions update every tick — the stale bounding sphere
        // from construction would mis-cull as the body moves.
        this._line.frustumCulled = false;
        // Behind opaque meshes (renderOrder 10 for the satellite
        // dots), so the head of the trail doesn't bleed through the
        // bus when the camera is dead-on the satellite.
        this._line.renderOrder = 5;
        scene.add(this._line);
    }

    /**
     * Push the current world-space position of the body. Called every
     * frame; the implementation decides whether to grow the buffer or
     * update the head in place.
     */
    push(x, y, z) {
        const pos = this._positions;

        if (this._count > 0) {
            const lastIdx = (this._count - 1) * 3;
            const dx = x - pos[lastIdx];
            const dy = y - pos[lastIdx + 1];
            const dz = z - pos[lastIdx + 2];
            const d2 = dx * dx + dy * dy + dz * dz;

            // Jump → restart. Clears the buffer so a long chord
            // doesn't snake from old position to new.
            if (d2 > this._jumpDist2) {
                this._count = 0;
            } else if (d2 < this._minDist2) {
                // Too close to the last sample — just update the
                // head's position so the line head tracks the body
                // exactly without polluting the buffer with
                // near-duplicate points.
                pos[lastIdx]     = x;
                pos[lastIdx + 1] = y;
                pos[lastIdx + 2] = z;
                this._line.geometry.attributes.position.needsUpdate = true;
                return;
            }
        }

        // Append. If we're full, slide everything down by one.
        let appendIdx;
        if (this._count < this._capacity) {
            appendIdx = this._count;
            this._count++;
        } else {
            // Drop oldest. copyWithin is the typed-array memmove.
            pos.copyWithin(0, 3, this._count * 3);
            appendIdx = this._capacity - 1;
        }
        const idx = appendIdx * 3;
        pos[idx]     = x;
        pos[idx + 1] = y;
        pos[idx + 2] = z;

        this._refreshColors();
        this._line.geometry.attributes.position.needsUpdate = true;
        this._line.geometry.attributes.color.needsUpdate    = true;
        this._line.geometry.setDrawRange(0, this._count);
    }

    /** Recompute per-vertex colour fade from tail to head. */
    _refreshColors() {
        const cols = this._colors;
        const n    = this._count;
        const r    = this._r;
        const g    = this._g;
        const b    = this._b;
        const tail = this._tail;
        const head = this._head;
        if (n <= 1) {
            // Single point — just use the head colour.
            if (n === 1) { cols[0] = r * head; cols[1] = g * head; cols[2] = b * head; }
            return;
        }
        const invDen = 1 / (n - 1);
        for (let i = 0; i < n; i++) {
            // i=0 (tail, oldest) → tailBrightness; i=n-1 (head, newest) → headBrightness.
            const t = i * invDen;
            const bright = tail + (head - tail) * t;
            const ci = i * 3;
            cols[ci]     = r * bright;
            cols[ci + 1] = g * bright;
            cols[ci + 2] = b * bright;
        }
    }

    /** Drop the trail history. Next push() will start fresh. */
    clear() {
        this._count = 0;
        this._line.geometry.setDrawRange(0, 0);
    }

    setVisible(on) { this._line.visible = !!on; }
    isVisible()    { return this._line.visible; }

    /** Underlying THREE.Line — exposed for debug + picker plumbing. */
    getLine() { return this._line; }

    dispose() {
        if (this._line.parent) this._line.parent.remove(this._line);
        this._line.geometry.dispose();
        this._line.material.dispose();
    }
}
