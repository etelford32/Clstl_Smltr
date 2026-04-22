/**
 * moon-landing-sites.js — Apollo + Artemis III candidate surface markers.
 *
 * Mounted as child meshes of the MoonSkin.moonMesh so markers rotate with
 * the Moon and inherit its world-space transform. Each marker is a small
 * colored sphere slightly raised above the surface (r = 1.005 on a unit
 * Moon) with an additive halo for visibility against the shaded regolith.
 *
 * Intentionally lightweight — no raycasting, no HTML overlays. The
 * info-panel carries the per-site coordinates + context; the globe just
 * marks the positions visibly.
 */

import * as THREE from 'three';
import { APOLLO_SITES, ARTEMIS_III_CANDIDATES, latLonToXYZ } from './artemis-data.js';

const APOLLO_COLOR          = 0xffae44;  // amber — continuity with Apollo programme aesthetic
const ARTEMIS_COLOR         = 0x44ccff;  // cyan  — forward-looking
const MARKER_RADIUS         = 0.008;     // proportional to moon radius 1.0
const MARKER_ALT            = 1.006;     // raised above surface to avoid z-fight
const HALO_RADIUS_MULT      = 2.6;

function _markerGeometry() {
    return new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
}

function _haloMaterial(color) {
    // Soft additive halo so the marker reads against both lunar day (bright
    // regolith) and lunar night (Earthshine-lit terminator).
    return new THREE.SpriteMaterial({
        color,
        transparent:   true,
        opacity:       0.55,
        depthWrite:    false,
        blending:      THREE.AdditiveBlending,
    });
}

function _placeMarker(group, lat, lon, color, userData = {}) {
    const p = latLonToXYZ(lat, lon, MARKER_ALT);

    const dot = new THREE.Mesh(
        _markerGeometry(),
        new THREE.MeshBasicMaterial({ color }),
    );
    dot.position.set(p.x, p.y, p.z);
    dot.userData = userData;
    group.add(dot);

    // Sprite halo doubles the visible footprint without bloating geometry
    const sprite = new THREE.Sprite(_haloMaterial(color));
    sprite.position.set(p.x, p.y, p.z);
    sprite.scale.setScalar(MARKER_RADIUS * HALO_RADIUS_MULT * 2);
    sprite.userData = userData;
    group.add(sprite);

    return { dot, sprite };
}

export class LandingSites {
    /**
     * @param {THREE.Object3D} parent — the MoonSkin.moonMesh (unit sphere,
     *                                    spins with lunar rotation)
     */
    constructor(parent) {
        this._apollo  = new THREE.Group();
        this._artemis = new THREE.Group();
        this._apollo.name  = 'landing-sites:apollo';
        this._artemis.name = 'landing-sites:artemis3';

        for (const s of APOLLO_SITES) {
            _placeMarker(this._apollo, s.lat, s.lon, APOLLO_COLOR, {
                site: s.id, label: s.mission, region: s.region, kind: 'apollo',
            });
        }
        for (const s of ARTEMIS_III_CANDIDATES) {
            _placeMarker(this._artemis, s.lat, s.lon, ARTEMIS_COLOR, {
                site: s.id, label: s.name, region: s.note, kind: 'artemis3',
            });
        }

        parent.add(this._apollo);
        parent.add(this._artemis);

        this._apolloVisible  = true;
        this._artemisVisible = true;
    }

    setApolloVisible(visible)  { this._apollo.visible  = !!visible; this._apolloVisible  = !!visible; }
    setArtemisVisible(visible) { this._artemis.visible = !!visible; this._artemisVisible = !!visible; }

    dispose() {
        for (const group of [this._apollo, this._artemis]) {
            group.parent?.remove(group);
            group.traverse(obj => {
                if (obj.geometry) obj.geometry.dispose?.();
                if (obj.material) obj.material.dispose?.();
            });
        }
    }
}
