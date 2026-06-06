/**
 * focus-mesh.js — Zoom-to-detail mesh for the selected satellite.
 *
 * The catalogue cloud renders as a single THREE.Points layer (one dot
 * per object). That's the right primitive for tens of thousands of
 * objects, but it gives an operator no sense of what a specific object
 * *is* — a 3-axis-stabilised payload with solar wings reads identically
 * to a tumbling rocket body or a fragmentation shard.
 *
 * FocusMesh closes that gap for the ONE object the operator has
 * selected. When the camera is zoomed close to the selected satellite,
 * its dot is promoted to a low-poly 3D glyph whose silhouette encodes
 * its class (payload / rocket body / debris) and whose scale tracks the
 * object's RCS / mass bucket from debris-catalog.estimateSize(). Zoom
 * back out and it fades to nothing, leaving the dot.
 *
 * This is a deliberately bounded slice of "per-satellite LOD":
 *   - Only the selected object is promoted — not the nearest-N. Giving
 *     69 k catalogue objects meshes is infeasible and pointless; the
 *     operator's attention is on their selection.
 *   - Objects that ALREADY render a dedicated mesh (Starlink, SL-16/8
 *     rocket bodies, Envisat, ISS, Hubble, Tiangong) are skipped so we
 *     never double-render.
 *   - The glyph is a class-typed *icon*, intentionally oversized at
 *     globe scale (a true-scale 3 m bus would be ~5e-7 scene units —
 *     invisible). Same convention the hero/Starlink meshes use.
 *
 * Reuses HeroMesh for the LVLH placement + along-track recovery (a
 * single instance, repointed via setNorad/setGeometry on each new
 * selection) so the orientation math lives in one tested place.
 */

import * as THREE from 'three';
import { HeroMesh, buildHeroMaterial } from './hero-mesh.js';
import { annotate as annotateDebris } from '../debris-catalog.js';

// NORADs / groups that already render their own dedicated mesh. The
// FocusMesh stays out of their way so a selected ISS doesn't get both
// the hero model and a generic glyph stacked on the same position.
const DEDICATED_GROUPS = new Set(['starlink', 'sl-16-rb', 'sl-8-rb', 'envisat']);
const DEDICATED_NORADS = new Set([
    25544,   // ISS (iss-model.js)
    20580,   // Hubble (hubble-model.js)
    48274,   // Tiangong / Tianhe (tiangong-model.js)
    27386,   // Envisat (envisat-model.js)
]);

// Camera-to-satellite distance fade window, in scene units (Earth
// radius = 1). Camera minDistance is 1.2 from the origin and a LEO sat
// sits at ~1.06, so when zoomed in the camera→sat distance drops well
// below 0.5 — these thresholds make the glyph appear only on a
// deliberate close approach, not the moment a far object is selected.
const FADE_START = 1.40;   // begin fading the glyph in
const FADE_FULL  = 0.55;   // fully opaque at / inside this distance

/* ── Geometry builders ───────────────────────────────────────────── */

/** pushBox(out, cx,cy,cz, sx,sy,sz, rgb) — one flat-shaded box. */
function pushBox(out, cx, cy, cz, sx, sy, sz, rgb) {
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const c = [
        [cx - hx, cy - hy, cz - hz], [cx + hx, cy - hy, cz - hz],
        [cx + hx, cy + hy, cz - hz], [cx - hx, cy + hy, cz - hz],
        [cx - hx, cy - hy, cz + hz], [cx + hx, cy - hy, cz + hz],
        [cx + hx, cy + hy, cz + hz], [cx - hx, cy + hy, cz + hz],
    ];
    const faces = [
        { corners: [1, 2, 6, 5], normal: [ 1, 0, 0] },
        { corners: [3, 0, 4, 7], normal: [-1, 0, 0] },
        { corners: [2, 3, 7, 6], normal: [ 0, 1, 0] },
        { corners: [0, 1, 5, 4], normal: [ 0,-1, 0] },
        { corners: [4, 5, 6, 7], normal: [ 0, 0, 1] },
        { corners: [3, 2, 1, 0], normal: [ 0, 0,-1] },
    ];
    for (const f of faces) {
        const base = out.positions.length / 3;
        for (const ci of f.corners) {
            out.positions.push(c[ci][0], c[ci][1], c[ci][2]);
            out.normals.push(f.normal[0], f.normal[1], f.normal[2]);
            out.colors.push(rgb[0], rgb[1], rgb[2]);
        }
        out.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}

function finalize(out) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out.positions, 3));
    geo.setAttribute('normal',   new THREE.Float32BufferAttribute(out.normals, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(out.colors, 3));
    geo.setIndex(out.indices);
    return geo;
}

/** Fill a primitive geometry with a single vertex colour. */
function tint(geo, rgb) {
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = rgb[0]; arr[i * 3 + 1] = rgb[1]; arr[i * 3 + 2] = rgb[2]; }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geo;
}

const COL_BUS    = [0.82, 0.85, 0.90];   // light grey chassis
const COL_PANEL  = [0.12, 0.15, 0.30];   // navy solar cells
const COL_ROCKET = [0.56, 0.58, 0.62];   // bare metal upper stage
const COL_DEBRIS = [0.50, 0.45, 0.40];   // dull fragment

/** Winged payload: central bus + two solar arrays along ±X (cross-track). */
function buildPayload() {
    const out = { positions: [], normals: [], colors: [], indices: [] };
    pushBox(out, 0, 0, 0, 0.60, 0.50, 0.20, COL_BUS);          // bus
    const px = 0.30 + 0.05 + 0.75;                              // hinge + half-panel
    pushBox(out,  px, 0, 0, 1.50, 0.42, 0.03, COL_PANEL);      // +X wing
    pushBox(out, -px, 0, 0, 1.50, 0.42, 0.03, COL_PANEL);      // -X wing
    return finalize(out);
}

/** Rocket body: an elongated cylinder along +Y (along-track). */
function buildRocketBody() {
    const geo = new THREE.CylinderGeometry(0.22, 0.22, 1.5, 16, 1);
    return tint(geo, COL_ROCKET);
}

/** Debris fragment: an angular low-poly chunk. */
function buildDebris() {
    const geo = new THREE.IcosahedronGeometry(0.45, 0);
    // Jitter the vertices a touch so it reads as an irregular shard
    // rather than a perfect die. Deterministic-ish; cosmetic only.
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
        const j = 0.85 + 0.30 * ((Math.sin(i * 12.9898) * 43758.5453) % 1);
        pos.setXYZ(i, pos.getX(i) * j, pos.getY(i) * j, pos.getZ(i) * j);
    }
    geo.computeVertexNormals();
    return tint(geo, COL_DEBRIS);
}

/**
 * Classify a selected object into a glyph kind from its name + group.
 * Excluded (dedicated-mesh) objects never reach here.
 */
function glyphKind(name, group) {
    const n = String(name || '').toUpperCase();
    if (/\bR\/B\b|ROCKET|\bDPAF\b|\bAKM\b/.test(n) || /-rb$/.test(group || '')) return 'rocket';
    if (/\bDEB\b|DEBRIS|\bFRAG\b|COOLANT|SHROUD/.test(n) || /-debris$/.test(group || '')) return 'debris';
    return 'payload';
}

/**
 * Map the estimateSize() bucket to a glyph scale (scene units). The
 * glyph is an icon, not a model, so this only spans ~2.5× across the
 * size classes — enough to read "big bus" vs "small fragment" at a
 * glance without a 9 t stage swallowing the camera.
 */
function glyphScale(size) {
    const m = size?.massKg;
    if (Number.isFinite(m)) {
        if (m > 1000) return 0.0110;
        if (m > 100)  return 0.0085;
        if (m > 10)   return 0.0065;
        return 0.0048;
    }
    return 0.0070;
}

/* ── FocusMesh ───────────────────────────────────────────────────── */

export class FocusMesh {
    /**
     * @param {object} globe   OperationsGlobe (scene + camera)
     * @param {object} tracker SatelliteTracker
     * @param {object} opts
     * @param {() => (number|null)} opts.getSelectedId
     * @param {(fn:(id:number|null)=>void) => (()=>void)} opts.onSelectChange
     */
    constructor(globe, tracker, opts = {}) {
        this._globe   = globe;
        this._tracker = tracker;
        this._camera  = globe.camera;

        this._selectedId   = null;
        this._activeNorad  = null;     // norad the glyph is currently built for
        this._needsRebuild = false;
        this._kind         = null;

        // One reusable material so opacity tweaks (the fade) don't churn
        // shader programs. Transparent so the fade reads on the dark sky.
        this._material = buildHeroMaterial({ roughness: 0.5, metalness: 0.18 });
        this._material.transparent = true;
        this._material.opacity     = 0;

        // A single HeroMesh, repointed per selection. Seed with a
        // throwaway 1-tri geometry + an out-of-catalogue norad so it
        // stays hidden until the first real selection lands.
        const seed = new THREE.BufferGeometry();
        seed.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0], 3));
        this._hero = new HeroMesh(globe, tracker, {
            norad:      -1,
            geometry:   seed,
            material:   this._material,
            modelScale: glyphScale(null),
            name:       'op-focus-mesh',
        });
        this._hero.getMesh().renderOrder = 13;   // above dots (10) + highlight sprite (12)

        const off = opts.onSelectChange?.((id) => {
            const next = id == null ? null : Number(id);
            if (next === this._selectedId) return;
            this._selectedId   = next;
            this._needsRebuild = true;
        });
        this._offSel = off;
        // Pick up the current selection if one already exists.
        const cur = opts.getSelectedId?.();
        if (cur != null) { this._selectedId = Number(cur); this._needsRebuild = true; }
    }

    /** Decide whether a selected object should get a generic glyph. */
    _excluded(sat) {
        if (!sat) return true;
        if (DEDICATED_NORADS.has(sat.norad_id)) return true;
        if (DEDICATED_GROUPS.has(sat.group))    return true;
        return false;
    }

    _rebuild() {
        this._needsRebuild = false;
        this._activeNorad  = null;
        this._kind         = null;

        const id = this._selectedId;
        if (id == null) { this._hero.setVisible(false); return; }

        const sat = this._tracker.getSatellite?.(id);
        if (!sat) {
            // TLE may not have landed yet (e.g. just added via the
            // picker). Leave needsRebuild set so the next tick retries
            // once the satellite is in the catalogue.
            this._needsRebuild = true;
            this._hero.setVisible(false);
            return;
        }
        if (this._excluded(sat)) { this._hero.setVisible(false); return; }

        let size = null;
        try {
            size = annotateDebris({ name: sat.name, noradId: id })?.size ?? null;
        } catch (_) { /* best-effort sizing */ }

        const kind = glyphKind(sat.name, sat.group);
        const geo  = kind === 'rocket' ? buildRocketBody()
                   : kind === 'debris' ? buildDebris()
                   :                     buildPayload();

        this._hero.setGeometry(geo);
        this._hero.setModelScale?.(glyphScale(size));
        this._hero.setNorad(id);
        this._activeNorad = id;
        this._kind        = kind;
    }

    /** Drive per frame from the globe's render loop. */
    tick(simTimeMs) {
        if (this._needsRebuild) this._rebuild();
        if (this._activeNorad == null) return;

        // Camera → satellite distance in scene units. getPositionXYZ
        // returns the already-scaled scene-frame position the camera
        // sees, so this is directly comparable to camera.position.
        const p = this._tracker.getPositionXYZ?.(this._activeNorad, _scratch);
        if (!p || (p.x === 0 && p.y === 0 && p.z === 0)) {
            this._hero.setVisible(false);
            return;
        }
        const dist = this._camera.position.distanceTo(_scratch);
        const opacity = clamp((FADE_START - dist) / (FADE_START - FADE_FULL), 0, 1);

        if (opacity <= 0.01) {
            this._hero.setVisible(false);
            return;
        }
        this._material.opacity = opacity;
        this._hero.setVisible(true);
        this._hero.tick(simTimeMs);
    }

    dispose() {
        this._offSel?.();
        this._hero.dispose();
    }
}

const _scratch = new THREE.Vector3();
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
