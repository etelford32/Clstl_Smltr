/** Render the curated USGS/IAU Mars landmark atlas on the unit globe. */
import * as THREE from 'three';
import { MARS_LANDMARKS, MARS_LANDMARK_CATEGORIES } from './mars-landmarks-data.js';

const MARS_RADIUS_KM = 3396.19;
const RING_ALTITUDE = 1.041;
const DOT_ALTITUDE = 1.047;

function basisAt(toVector, latDeg, lonDeg) {
    const normal = toVector(latDeg, lonDeg, 1).normalize();
    const reference = Math.abs(normal.y) > 0.98 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const east = new THREE.Vector3().crossVectors(reference, normal).normalize();
    const north = new THREE.Vector3().crossVectors(normal, east).normalize();
    return { normal, east, north };
}

function extentRingGeometry(toVector, landmark) {
    const { normal, east, north } = basisAt(toVector, landmark.latDeg, landmark.lonDeg);
    const angularRadius = Math.min(1.2, landmark.diameterKm / 2 / MARS_RADIUS_KM);
    const cosRadius = Math.cos(angularRadius);
    const sinRadius = Math.sin(angularRadius);
    const points = [];
    for (let index = 0; index < 96; index += 1) {
        const theta = index / 96 * Math.PI * 2;
        points.push(new THREE.Vector3()
            .addScaledVector(normal, cosRadius)
            .addScaledVector(east, sinRadius * Math.cos(theta))
            .addScaledVector(north, sinRadius * Math.sin(theta))
            .multiplyScalar(RING_ALTITUDE));
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
    constructor(parent, toVector) {
        this.group = new THREE.Group();
        this.group.name = 'mars-landmarks';
        parent.add(this.group);
        this.categoryGroups = {};
        this.hitTargets = [];
        this.entries = [];
        this.disposables = [];
        this.enabled = true;

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
            const position = toVector(landmark.latDeg, landmark.lonDeg, DOT_ALTITUDE);
            const normal = position.clone().normalize();

            const ringGeometry = track(extentRingGeometry(toVector, landmark));
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
            label.position.copy(normal.clone().multiplyScalar(1.078));
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

    update(camera) {
        if (!this.enabled) return;
        const localCamera = this.group.worldToLocal(camera.position.clone());
        const cameraDistance = localCamera.length();
        const cameraDirection = localCamera.normalize();
        const maximumPriority = cameraDistance < 1.72 ? 3 : cameraDistance < 2.45 ? 2 : 1;
        for (const entry of this.entries) {
            const frontFacing = entry.normal.dot(cameraDirection) > 0.17;
            entry.label.visible = entry.categoryGroup.visible
                && entry.landmark.priority <= maximumPriority
                && frontFacing;
            entry.dot.material.opacity = frontFacing ? 0.9 : 0.15;
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const object of this.disposables) object.dispose?.();
        this.disposables.length = 0;
    }
}
