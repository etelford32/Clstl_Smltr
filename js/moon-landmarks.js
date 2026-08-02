/**
 * moon-landmarks.js — surface feature markers for the Moon page.
 * ═══════════════════════════════════════════════════════════════════════════
 * Renderer ONLY. All feature data (names, IAU coordinates, diameters,
 * categories, colors) comes from js/moon-landmarks-data.js, which has its
 * own Node gate (tests/moon-landmarks.mjs).
 *
 * Mounted as a child of MoonSkin.moonMesh (like moon-landing-sites.js) so
 * markers rotate with the lunar body. Each feature gets:
 *   • a TRUE-EXTENT ring — a small circle on the sphere at the feature's
 *     real angular radius (diameter / 2R_moon), so Clavius visibly dwarfs
 *     Tycho and South Pole–Aitken spans a third of the globe. No symbolic
 *     sizes: the ring IS the feature's footprint.
 *   • a small center dot sprite for visibility at distance,
 *   • an invisible hit sphere for hover raycasting (three's Raycaster
 *     tests non-visible meshes, which is exactly what we want here; the
 *     page filters hits through the category-visibility flags). Hit radii
 *     scale with feature size but are clamped so SPA can't eat the whole
 *     nearside's hover space.
 *
 * The page owns the raycaster and the tooltip DOM; this module just
 * exposes hitTargets (userData.landmark on each) and per-category groups.
 */

import * as THREE from 'three';
import { LANDMARKS, LANDMARK_CATEGORIES } from './moon-landmarks-data.js';
import { latLonToXYZ } from './artemis-data.js';

const RING_ALT = 1.004;    // ring altitude above the unit sphere (z-fight clearance)
const DOT_ALT = 1.008;
const R_MOON_KM = 1737.4;  // matches moon-interior-model; only used for angular radii

/** Orthonormal basis around the feature-centre direction. */
function _basisAt(lat, lon) {
    const c = latLonToXYZ(lat, lon, 1);
    const n = new THREE.Vector3(c.x, c.y, c.z);
    const up = Math.abs(n.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const e1 = new THREE.Vector3().crossVectors(up, n).normalize();
    const e2 = new THREE.Vector3().crossVectors(n, e1).normalize();
    return { n, e1, e2 };
}

/** Small-circle ring on the sphere: angular radius alpha around (lat, lon). */
function _ringGeometry(lat, lon, alphaRad, segments = 96) {
    const { n, e1, e2 } = _basisAt(lat, lon);
    const ca = Math.cos(alphaRad), sa = Math.sin(alphaRad);
    const pts = [];
    for (let i = 0; i < segments; i++) {
        const th = (i / segments) * Math.PI * 2;
        const p = new THREE.Vector3()
            .addScaledVector(n, ca)
            .addScaledVector(e1, sa * Math.cos(th))
            .addScaledVector(e2, sa * Math.sin(th))
            .multiplyScalar(RING_ALT);
        pts.push(p);
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
}

/** Radial-gradient sprite texture (a mapless SpriteMaterial is a solid square). */
function _glowSpriteTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
}

// ═══════════════════════════════════════════════════════════════════════════
export class MoonLandmarks {
    /** @param {THREE.Object3D} parent — MoonSkin.moonMesh (rotates with the Moon) */
    constructor(parent) {
        this.group = new THREE.Group();
        this.group.name = 'moon-landmarks';
        parent.add(this.group);

        this._disposables = [];
        const track = (o) => { this._disposables.push(o); return o; };

        /** Per-category groups, toggled by the page. */
        this.categoryGroups = {};
        /** Invisible hit meshes for the page's raycaster (userData.landmark). */
        this.hitTargets = [];
        this._sprites = new Map();   // name → { sprite, baseScale, pulseT }

        const spriteTex = track(_glowSpriteTexture());
        const hitGeo = track(new THREE.SphereGeometry(1, 12, 10));

        for (const key of Object.keys(LANDMARK_CATEGORIES)) {
            const g = new THREE.Group();
            g.name = `landmarks:${key}`;
            this.categoryGroups[key] = g;
            this.group.add(g);
        }

        for (const lm of LANDMARKS) {
            const cat = LANDMARK_CATEGORIES[lm.category];
            const g = this.categoryGroups[lm.category];
            const color = cat.color;

            // True-extent ring
            const alpha = Math.min(Math.PI / 2, (lm.diameterKm / 2) / R_MOON_KM);
            const ringMat = track(new THREE.LineBasicMaterial({
                color, transparent: true, opacity: 0.5, depthWrite: false,
            }));
            g.add(new THREE.LineLoop(track(_ringGeometry(lm.latDeg, lm.lonDeg, alpha)), ringMat));

            // Center dot sprite
            const p = latLonToXYZ(lm.latDeg, lm.lonDeg, DOT_ALT);
            const sprMat = track(new THREE.SpriteMaterial({
                map: spriteTex, color, transparent: true, opacity: 0.8,
                depthWrite: false, blending: THREE.AdditiveBlending,
            }));
            const spr = new THREE.Sprite(sprMat);
            spr.position.set(p.x, p.y, p.z);
            const baseScale = 0.022;
            spr.scale.setScalar(baseScale);
            g.add(spr);
            this._sprites.set(lm.name, { sprite: spr, baseScale, pulseT: -10 });

            // Invisible hover target — sized with the feature, clamped
            const hitR = Math.min(0.11, Math.max(0.038, Math.sin(alpha) * 0.55));
            const hit = new THREE.Mesh(hitGeo);
            hit.visible = false;
            hit.scale.setScalar(hitR);
            hit.position.set(p.x, p.y, p.z);
            hit.userData = { landmark: lm };
            g.add(hit);
            this.hitTargets.push(hit);
        }
    }

    setCategoryVisible(key, v) {
        const g = this.categoryGroups[key];
        if (g) g.visible = !!v;
    }

    /** Is this landmark's category currently shown? (raycast-hit filter) */
    isLandmarkVisible(lm) {
        const g = this.categoryGroups[lm.category];
        return !!g && g.visible && this.group.visible;
    }

    /** Flash a landmark's dot (panel-list click → find it on the globe). */
    pulse(name) {
        const s = this._sprites.get(name);
        if (s) s.pulseT = 0;   // armed; update() animates from here
    }

    update(dt) {
        for (const s of this._sprites.values()) {
            if (s.pulseT < 0) continue;
            s.pulseT += dt;
            if (s.pulseT > 2.4) {
                s.sprite.scale.setScalar(s.baseScale);
                s.pulseT = -10;
                continue;
            }
            // Three swelling beats, decaying
            const k = 1 + 1.6 * Math.abs(Math.sin(s.pulseT * Math.PI * 1.25)) * (1 - s.pulseT / 2.4);
            s.sprite.scale.setScalar(s.baseScale * k);
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const o of this._disposables) o.dispose?.();
        this._disposables.length = 0;
    }
}
