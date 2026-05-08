/**
 * launch-plume.js — Shared engine-plume builders + tick handler.
 *
 * Every vehicle's plume is the same shape: 3 nested additive cones (hot
 * core, mid, outer smoke) plus 4 shock-diamond discs along the axis and a
 * bright bell-exit flare. The cones taper, fade, and flicker with throttle;
 * the shock diamonds shimmer at a higher frequency to suggest standing
 * over/under-expanded compression bands; the flare keeps the bell visibly
 * lit even when the plume tail thins at low throttle.
 *
 * Public API:
 *   buildPlume({
 *     coreRadius, coreLen, midRadius, midLen, outerRadius, outerLen,
 *     coreColor, midColor, outerColor,
 *   }) → THREE.Group
 *   tickPlume(plumeGroup, t, throttle)
 */

import * as THREE from 'three';

// ── Cone-stack ───────────────────────────────────────────────────────────────
// Each cone gets userData.kind='cone' so the shared tick handler can drive
// throttle/flicker. Cones are oriented with their tip at +Y (rotated π so
// the plume points -Y from the bell). baseLen is preserved so the tick can
// scale the cone uniformly per frame.

function makeConeLayer({ color, radius, length, opacity }) {
    const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
    });
    const cone = new THREE.Mesh(
        new THREE.ConeGeometry(radius, length, 28, 1, true),
        mat
    );
    cone.rotation.x = Math.PI;          // tip → -Y
    cone.position.y = -length / 2;
    cone.userData.kind = 'cone';
    cone.userData.baseOpacity = opacity;
    cone.userData.baseLen = length;
    return cone;
}

// ── Shock diamonds ───────────────────────────────────────────────────────────
// Real rocket plumes show standing compression / expansion waves as bright
// disks along the centerline (mach disks). Approximate as 4 emissive discs
// at fixed fractions of the outer-cone length, scaled and shimmered by the
// tick handler. Each disc gets a per-instance phase offset so they don't
// flicker in lockstep.

function addShockDiamonds(plumeGroup, baseRadius, plumeLen, color) {
    const positions = [0.10, 0.22, 0.36, 0.52];
    for (let i = 0; i < positions.length; i++) {
        const t = positions[i];
        const r = baseRadius * (0.65 + i * 0.04);
        const disc = new THREE.Mesh(
            new THREE.CircleGeometry(r, 24),
            new THREE.MeshBasicMaterial({
                color,
                transparent: true,
                opacity: 0.85 - i * 0.15,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide,
            })
        );
        disc.rotation.x = Math.PI / 2;          // face along Y axis
        disc.position.y = -plumeLen * t;
        disc.userData.kind = 'shock';
        disc.userData.basePosY = disc.position.y;
        disc.userData.baseOpacity = disc.material.opacity;
        disc.userData.phase = i * 0.7;
        plumeGroup.add(disc);
    }
}

// Bright disc just below the bell exit so the engine reads as "lit" even
// when plume length collapses at low throttle. Keeps a steady-but-flickering
// glow cap on the cone stack.
function addBellFlare(plumeGroup, baseRadius, plumeLen, color) {
    const flare = new THREE.Mesh(
        new THREE.CircleGeometry(baseRadius * 0.95, 28),
        new THREE.MeshBasicMaterial({
            color,
            transparent: true,
            opacity: 0.95,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            side: THREE.DoubleSide,
        })
    );
    flare.rotation.x = Math.PI / 2;
    flare.position.y = -plumeLen * 0.04;
    flare.userData.kind = 'flare';
    flare.userData.baseOpacity = 0.95;
    plumeGroup.add(flare);
}

// ── Public ───────────────────────────────────────────────────────────────────

export function buildPlume(opts) {
    const {
        coreRadius, coreLen,
        midRadius,  midLen,
        outerRadius, outerLen,
        coreColor,  midColor,  outerColor,
        name = 'Plume',
    } = opts;

    const g = new THREE.Group();
    g.name = name;
    g.visible = false;          // toggled by host UI

    g.add(makeConeLayer({ color: coreColor,  radius: coreRadius,  length: coreLen,  opacity: 0.95 }));
    g.add(makeConeLayer({ color: midColor,   radius: midRadius,   length: midLen,   opacity: 0.55 }));
    g.add(makeConeLayer({ color: outerColor, radius: outerRadius, length: outerLen, opacity: 0.25 }));

    addShockDiamonds(g, coreRadius * 1.6, outerLen, coreColor);
    addBellFlare(g, coreRadius * 1.6, outerLen, coreColor);

    return g;
}

// Drive every plume child off the same tick. Cones flicker and scale with
// throttle; shock diamonds ride along the cone axis and shimmer faster;
// the flare cap throbs on its own clock.
export function tickPlume(plume, t, throttle = 1) {
    if (!plume.visible) return;

    const wMul = 0.25 + 0.75 * throttle;
    const lMul = 0.30 + 0.70 * throttle;

    let coneIdx = 0;
    plume.children.forEach(child => {
        const u = child.userData;
        if (u.kind === 'cone') {
            const flicker = 1 + Math.sin(t * (4 - coneIdx) * 1.5 + coneIdx) * 0.04;
            const w = wMul * flicker;
            child.scale.set(w, lMul, w);
            child.material.opacity = u.baseOpacity * throttle *
                (0.92 + Math.sin(t * (6 - coneIdx) + coneIdx * 2) * 0.08);
            coneIdx++;
        } else if (u.kind === 'shock') {
            child.position.y = u.basePosY * lMul;
            child.scale.setScalar(wMul * (0.85 + Math.sin(t * 8 + u.phase * 6) * 0.15));
            child.material.opacity = u.baseOpacity * throttle *
                (0.55 + 0.45 * Math.sin(t * 6 + u.phase * 5));
        } else if (u.kind === 'flare') {
            // Flare scales hard with throttle so it's actually dark before
            // ignition. A small floor (×0.05) keeps a hint of light at low
            // throttle for the bell-mouth specular cue.
            const flick = 0.85 + Math.sin(t * 18) * 0.15;
            const lit = throttle > 0.02 ? throttle : 0;
            child.scale.setScalar(Math.max(0.05, 0.6 + 0.6 * lit) * flick);
            child.material.opacity = u.baseOpacity * lit * (0.85 + 0.15 * Math.sin(t * 18));
        }
    });
}
