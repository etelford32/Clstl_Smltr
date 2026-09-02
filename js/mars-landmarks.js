/** Render the curated USGS/IAU Mars landmark atlas on the unit globe. */
import * as THREE from 'three';
import { MARS_LANDMARKS, MARS_LANDMARK_CATEGORIES } from './mars-landmarks-data.js';

const MARS_RADIUS_KM = 3396.19;
// Heights ABOVE the local surface, not absolute radii. The constants used to be
// absolute (1.041 / 1.047 / 1.078), which pinned every extent ring and dot to a
// sphere ~140 km up — fine on a smooth globe, visibly detached from the terrain
// once MOLA relief is on and the camera is close. `radiusAt` (supplied by
// mars-view.js) puts them back on the ground; the default keeps the old
// smooth-sphere behaviour for any caller that does not pass one.
const RING_OFFSET = 0.0007;
const DOT_OFFSET = 0.0013;
const LABEL_OFFSET = 0.032;
const DEFAULT_SURFACE_RADIUS = 1.0405;

function basisAt(toVector, latDeg, lonDeg) {
    const normal = toVector(latDeg, lonDeg, 1).normalize();
    const reference = Math.abs(normal.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(reference, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();
    return { normal, east, north };
}

function extentRingGeometry(toVector, landmark, radiusAt) {
    const { normal, east, north } = basisAt(toVector, landmark.latDeg, landmark.lonDeg);
    const angularRadius = Math.min(1.2, landmark.diameterKm / 2 / MARS_RADIUS_KM);
    const cosRadius = Math.cos(angularRadius);
    const sinRadius = Math.sin(angularRadius);
    const points = [];
    const direction = new THREE.Vector3();
    for (let index = 0; index < 96; index += 1) {
        const theta = index / 96 * Math.PI * 2;
        direction.set(0, 0, 0)
            .addScaledVector(normal, cosRadius)
            .addScaledVector(east, sinRadius * Math.cos(theta))
            .addScaledVector(north, sinRadius * Math.sin(theta))
            .normalize();
        // Sample the surface radius around the rim so a crater ring follows the
        // rim it is tracing instead of cutting through it.
        const latDeg = Math.asin(Math.max(-1, Math.min(1, direction.y))) * 180 / Math.PI;
        const lonDeg = Math.atan2(-direction.z, direction.x) * 180 / Math.PI;
        points.push(direction.clone().multiplyScalar(radiusAt(latDeg, lonDeg) + RING_OFFSET));
    }
    return new THREE.BufferGeometry().setFromPoints(points);
}

function glowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.28, 'rgba(255,255,255,.85)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function labelTexture(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 88;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(7,3,2,.76)';
    context.strokeStyle = `#${color.toString(16).padStart(6, '0')}88`;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(3, 3, 506, 82, 14);
    context.fill();
    context.stroke();
    context.fillStyle = '#fff3ec';
    context.font = '600 30px "Space Grotesk", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.toUpperCase(), 256, 46, 480);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

export class MarsLandmarks {
    /**
     * @param {THREE.Object3D} parent
     * @param {(latDeg:number, lonDeg:number, radius:number) => THREE.Vector3} toVector
     * @param {{ radiusAt?: (latDeg:number, lonDeg:number) => number }} [options]
     *   radiusAt returns the local surface radius so rings, dots, and labels sit
     *   on the relief. Omit it to keep the flat 1.0405 sphere.
     */
    constructor(parent, toVector, { radiusAt = () => DEFAULT_SURFACE_RADIUS } = {}) {
        this.group = new THREE.Group();
        this.group.name = 'mars-landmarks';
        parent.add(this.group);
        this.toVector = toVector;
        this.radiusAt = radiusAt;
        this.categoryGroups = {};
        this.hitTargets = [];
        this.entries = [];
        this.disposables = [];
        this.enabled = true;
        this.highlighted = null;
        // landmark → is it on the camera-facing hemisphere, as of the last
        // update(). Read by isPickable(); see the note there on why picking
        // cannot go on category visibility alone.
        this.facing = new Map();

        const track = object => { this.disposables.push(object); return object; };
        const dotTexture = track(glowTexture());
        const hitGeometry = track(new THREE.SphereGeometry(1, 10, 8));
        const hitMaterial = track(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));

        for (const category of Object.keys(MARS_LANDMARK_CATEGORIES)) {
            const categoryGroup = new THREE.Group();
            categoryGroup.name = `mars-landmarks:${category}`;
            this.categoryGroups[category] = categoryGroup;
            this.group.add(categoryGroup);
        }

        for (const landmark of MARS_LANDMARKS) {
            const category = MARS_LANDMARK_CATEGORIES[landmark.category];
            const categoryGroup = this.categoryGroups[landmark.category];
            const color = category.color;
            const surfaceRadius = this.radiusAt(landmark.latDeg, landmark.lonDeg);
            const position = toVector(landmark.latDeg, landmark.lonDeg, surfaceRadius + DOT_OFFSET);
            const normal = position.clone().normalize();

            const ringGeometry = track(extentRingGeometry(toVector, landmark, this.radiusAt));
            const ringMaterial = track(new THREE.LineBasicMaterial({
                color, transparent: true, opacity: landmark.priority === 1 ? 0.48 : 0.28, depthWrite: false,
            }));
            categoryGroup.add(new THREE.LineLoop(ringGeometry, ringMaterial));

            const dotMaterial = track(new THREE.SpriteMaterial({
                map: dotTexture, color, transparent: true, opacity: 0.9,
                depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
            }));
            const dot = new THREE.Sprite(dotMaterial);
            dot.position.copy(position);
            dot.scale.setScalar(landmark.priority === 1 ? 0.032 : 0.023);
            categoryGroup.add(dot);

            const nameTexture = track(labelTexture(landmark.name, color));
            const labelMaterial = track(new THREE.SpriteMaterial({
                map: nameTexture, transparent: true, opacity: 0.92, depthTest: true, depthWrite: false,
            }));
            const label = new THREE.Sprite(labelMaterial);
            label.position.copy(normal.clone().multiplyScalar(surfaceRadius + LABEL_OFFSET));
            label.scale.set(0.26, 0.045, 1);
            label.renderOrder = 8;
            categoryGroup.add(label);

            const hit = new THREE.Mesh(hitGeometry, hitMaterial);
            hit.position.copy(position);
            hit.scale.setScalar(0.045);
            hit.userData.landmark = landmark;
            categoryGroup.add(hit);
            this.hitTargets.push(hit);
            this.entries.push({ landmark, normal, label, dot, categoryGroup });
        }
    }

    setVisible(visible) {
        this.enabled = Boolean(visible);
        this.group.visible = this.enabled;
    }

    setCategoryVisible(category, visible) {
        if (this.categoryGroups[category]) this.categoryGroups[category].visible = Boolean(visible);
    }

    isLandmarkVisible(landmark) {
        return this.enabled && Boolean(this.categoryGroups[landmark.category]?.visible);
    }

    /**
     * Can this landmark be hovered or clicked right now?
     *
     * Category visibility is NOT enough. The hit meshes are never hidden — only
     * labels are LOD-gated — and the globe mesh is not in the raycast set, so a
     * ray cast at the middle of the disc passes straight through the planet and
     * strikes markers on the FAR SIDE. Picking on category visibility alone
     * meant clicking bare ground near the centre of Mars could open a feature
     * standing behind it, which reads as the page picking at random.
     *
     * `frontFacing` is refreshed every frame by update(); before the first
     * frame it is undefined, which correctly reads as not pickable.
     */
    isPickable(landmark) {
        if (!this.isLandmarkVisible(landmark)) return false;
        return this.facing.get(landmark) === true;
    }

    /**
     * Every landmark plus its current facing, for the feature index. Returned
     * as plain data (never the three.js entries) so the UI cannot reach into
     * the scene graph through it.
     */
    list() {
        return this.entries.map(entry => ({
            landmark: entry.landmark,
            frontFacing: this.facing.get(entry.landmark) === true,
            visible: this.isLandmarkVisible(entry.landmark),
        }));
    }

    /**
     * Mark one landmark as hovered. Every marker on this globe is clickable and
     * none of them looked it — there was no cursor change and no highlight, so
     * the only way to discover that the atlas is interactive was to click a dot
     * on the off-chance. `update()` applies the visual; this just records it.
     *
     * @param {object|null} landmark  the hovered landmark, or null to clear
     * @returns {boolean} true if the highlight actually changed
     */
    setHighlight(landmark) {
        if (this.highlighted === landmark) return false;
        this.highlighted = landmark || null;
        return true;
    }

    update(camera) {
        if (!this.enabled) return;
        const localCamera = this.group.worldToLocal(camera.position.clone());
        const cameraDistance = localCamera.length();
        const cameraDirection = localCamera.clone().normalize();
        const maximumPriority = cameraDistance < 1.72 ? 3 : cameraDistance < 2.45 ? 2 : 1;
        const facingThreshold = cameraDistance < 1.72 ? 0.72 : 0.17;
        for (const entry of this.entries) {
            const frontFacing = entry.normal.dot(cameraDirection) > facingThreshold;
            // Picking reads this, so it has to be the SAME test the rendering
            // uses — a marker you can see is a marker you can click, and one
            // you cannot see is not.
            this.facing.set(entry.landmark, frontFacing);
            const hovered = this.highlighted === entry.landmark;
            const labelDistance = localCamera.distanceTo(entry.label.position);
            const labelScale = THREE.MathUtils.clamp(labelDistance / 2.4, 0.11, 1);
            // A hovered marker swells and always shows its label, even if the
            // LOD would normally have hidden it — you are pointing at it, so it
            // has earned the pixels.
            const emphasis = hovered ? 1.45 : 1;
            entry.label.scale.set(0.26 * labelScale * emphasis, 0.045 * labelScale * emphasis, 1);
            const dotSize = entry.landmark.priority === 1 ? 0.032 : 0.023;
            entry.dot.scale.setScalar(dotSize * labelScale * emphasis);
            entry.label.visible = entry.categoryGroup.visible
                && frontFacing
                && (hovered || entry.landmark.priority <= maximumPriority);
            entry.dot.material.opacity = hovered ? 1 : (frontFacing ? 0.9 : 0.15);
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const object of this.disposables) object.dispose?.();
        this.disposables.length = 0;
    }
}
