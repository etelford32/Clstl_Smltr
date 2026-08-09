/** Mars-centered celestial direction layer backed by JPL Horizons observer tables. */
import * as THREE from 'three';
import { interpolateHorizonsObserverSamples, MARS_SKY_BODIES } from './horizons.js';

const SKY_RADIUS = 1.43;
const BODY_STYLES = Object.freeze({
    sun:   Object.freeze({ color: 0xffd166, size: 0.065, labelOffset: 0 }),
    earth: Object.freeze({ color: 0x69e4ff, size: 0.045, labelOffset: 0.055 }),
    moon:  Object.freeze({ color: 0xf4f0e8, size: 0.032, labelOffset: -0.055 }),
    ceres: Object.freeze({ color: 0xb8c2cc, size: 0.032, labelOffset: 0.03 }),
    vesta: Object.freeze({ color: 0xd7a779, size: 0.032, labelOffset: -0.03 }),
});

function glowTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 64;
    const context = canvas.getContext('2d');
    const gradient = context.createRadialGradient(32, 32, 1, 32, 32, 31);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.22, 'rgba(255,255,255,.95)');
    gradient.addColorStop(0.48, 'rgba(255,255,255,.3)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 64, 64);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function labelTexture(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 72;
    const context = canvas.getContext('2d');
    context.fillStyle = 'rgba(5,7,12,.86)';
    context.strokeStyle = `#${color.toString(16).padStart(6, '0')}aa`;
    context.lineWidth = 2;
    context.beginPath();
    context.roundRect(3, 3, 378, 66, 14);
    context.fill();
    context.stroke();
    context.fillStyle = '#fff';
    context.font = '600 26px "Space Grotesk", sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text.toUpperCase(), 192, 38, 350);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
}

function localSkyDirection({ latDeg, lonDeg, azimuthDeg, elevationDeg }) {
    const radians = Math.PI / 180;
    const lat = latDeg * radians;
    const lon = lonDeg * radians;
    const azimuth = azimuthDeg * radians;
    const elevation = elevationDeg * radians;
    const up = new THREE.Vector3(
        Math.cos(lat) * Math.cos(lon),
        Math.sin(lat),
        -Math.cos(lat) * Math.sin(lon),
    );
    const east = new THREE.Vector3(-Math.sin(lon), 0, -Math.cos(lon));
    const north = new THREE.Vector3(
        -Math.sin(lat) * Math.cos(lon),
        Math.cos(lat),
        Math.sin(lat) * Math.sin(lon),
    );
    return new THREE.Vector3()
        .addScaledVector(north, Math.cos(elevation) * Math.cos(azimuth))
        .addScaledVector(east, Math.cos(elevation) * Math.sin(azimuth))
        .addScaledVector(up, Math.sin(elevation))
        .normalize();
}

function planetocentricDirection(latDeg, lonDeg) {
    const radians = Math.PI / 180;
    const lat = latDeg * radians;
    const lon = lonDeg * radians;
    return new THREE.Vector3(
        Math.cos(lat) * Math.cos(lon),
        Math.sin(lat),
        -Math.cos(lat) * Math.sin(lon),
    );
}

export class MarsSky {
    constructor(parent, { onUpdate = null } = {}) {
        this.group = new THREE.Group();
        this.group.name = 'mars-sky-horizons';
        parent.add(this.group);
        this.onUpdate = onUpdate;
        this.ephemeris = null;
        this.entries = {};
        this.hitTargets = [];
        this.highlighted = null;
        this.disposables = [];

        const track = object => { this.disposables.push(object); return object; };
        const dotTexture = track(glowTexture());
        const hitGeometry = track(new THREE.SphereGeometry(1, 10, 8));
        const hitMaterial = track(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));

        for (const body of MARS_SKY_BODIES) {
            const style = BODY_STYLES[body.key];
            const bodyGroup = new THREE.Group();
            bodyGroup.name = `mars-sky:${body.key}`;
            bodyGroup.visible = false;

            const dotMaterial = track(new THREE.SpriteMaterial({
                map: dotTexture,
                color: style.color,
                transparent: true,
                opacity: 1,
                depthWrite: false,
                depthTest: true,
                blending: THREE.AdditiveBlending,
            }));
            const dot = new THREE.Sprite(dotMaterial);
            dot.scale.setScalar(style.size);
            dot.renderOrder = 9;
            bodyGroup.add(dot);

            const labelMaterial = track(new THREE.SpriteMaterial({
                map: track(labelTexture(body.name, style.color)),
                transparent: true,
                opacity: 0.96,
                depthWrite: false,
                depthTest: true,
            }));
            const label = new THREE.Sprite(labelMaterial);
            label.scale.set(0.20, 0.038, 1);
            label.renderOrder = 9;
            bodyGroup.add(label);

            const leaderGeometry = track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]));
            const leaderMaterial = track(new THREE.LineBasicMaterial({
                color: style.color, transparent: true, opacity: 0.42, depthWrite: false,
            }));
            const leader = new THREE.Line(leaderGeometry, leaderMaterial);
            bodyGroup.add(leader);

            const rayGeometry = track(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]));
            const rayMaterial = track(new THREE.LineBasicMaterial({
                color: style.color,
                transparent: true,
                opacity: body.key === 'sun' ? 0.48 : 0.28,
                depthWrite: false,
                depthTest: true,
            }));
            const ray = new THREE.Line(rayGeometry, rayMaterial);
            bodyGroup.add(ray);

            const hit = new THREE.Mesh(hitGeometry, hitMaterial);
            hit.scale.setScalar(Math.max(0.05, style.size));
            hit.userData.skyBodyKey = body.key;
            bodyGroup.add(hit);
            this.hitTargets.push(hit);

            this.group.add(bodyGroup);
            this.entries[body.key] = {
                body, style, group: bodyGroup, dot, label, leader, ray, hit,
                enabled: true, current: null, direction: null,
            };
        }
    }

    setBodyVisible(key, visible) {
        const entry = this.entries[key];
        if (!entry) return;
        entry.enabled = Boolean(visible);
        entry.group.visible = entry.enabled && Boolean(entry.current);
    }

    isBodyVisible(key) {
        const entry = this.entries[key];
        return Boolean(entry?.enabled && entry?.current);
    }

    getBodyRecord(key) {
        const entry = this.entries[key];
        return entry?.current ? { ...entry.body, ...entry.current } : null;
    }

    getDirection(key) {
        return this.entries[key]?.direction?.clone() || null;
    }

    updateEphemeris(ephemeris, date = new Date()) {
        this.ephemeris = ephemeris;
        this.updateTime(date);
    }

    updateTime(date = new Date()) {
        if (!this.ephemeris?.observer) return;
        const values = {};
        const observerPosition = planetocentricDirection(
            this.ephemeris.observer.lat_deg,
            this.ephemeris.observer.lon_deg,
        ).multiplyScalar(1.055);
        for (const [key, entry] of Object.entries(this.entries)) {
            const source = this.ephemeris.bodies?.[key];
            const current = interpolateHorizonsObserverSamples(source?.samples, date);
            entry.current = current;
            entry.group.visible = entry.enabled && Boolean(current);
            if (!current) continue;

            const direction = localSkyDirection({
                latDeg: this.ephemeris.observer.horizons_geodetic_lat_deg ?? this.ephemeris.observer.lat_deg,
                lonDeg: this.ephemeris.observer.lon_deg,
                azimuthDeg: current.azimuth_deg,
                elevationDeg: current.elevation_deg,
            });
            entry.direction = direction;
            const dotPosition = direction.clone().multiplyScalar(SKY_RADIUS);
            const tangentReference = Math.abs(direction.y) > 0.92
                ? new THREE.Vector3(1, 0, 0)
                : new THREE.Vector3(0, 1, 0);
            const tangent = new THREE.Vector3().crossVectors(direction, tangentReference).normalize();
            const labelPosition = dotPosition.clone().addScaledVector(tangent, entry.style.labelOffset);
            entry.dot.position.copy(dotPosition);
            entry.hit.position.copy(dotPosition);
            entry.label.position.copy(labelPosition);
            entry.leader.geometry.setFromPoints([dotPosition, labelPosition]);
            entry.ray.geometry.setFromPoints([observerPosition, dotPosition]);
            values[key] = { ...entry.body, ...current };
        }
        this.onUpdate?.(values, this.ephemeris);
    }

    /**
     * Mark one sky body as hovered, mirroring MarsLandmarks.setHighlight().
     * These markers are clickable too and had exactly the same problem: no
     * cursor change, no highlight, no way to tell.
     *
     * @param {string|null} key  body key ('sun', 'earth', …) or null to clear
     * @returns {boolean} true if the highlight actually changed
     */
    setHighlight(key) {
        const next = key && this.entries[key] ? key : null;
        if (this.highlighted === next) return false;
        this.highlighted = next;
        return true;
    }

    updateCamera(camera) {
        if (!this.ephemeris) return;
        const localCamera = this.group.worldToLocal(camera.position.clone()).normalize();
        for (const [key, entry] of Object.entries(this.entries)) {
            if (!entry.direction || !entry.current) continue;
            const frontFacing = entry.direction.dot(localCamera) > -0.08;
            const hovered = this.highlighted === key;
            const emphasis = hovered ? 1.4 : 1;
            entry.dot.scale.setScalar(entry.style.size * emphasis);
            entry.label.visible = frontFacing || hovered;
            entry.leader.visible = (frontFacing || hovered) && entry.style.labelOffset !== 0;
            entry.dot.material.opacity = hovered ? 1 : (frontFacing ? 1 : 0.18);
            entry.ray.material.opacity = hovered
                ? 0.7
                : (key === 'sun' ? 0.48 : 0.28);
        }
    }

    dispose() {
        this.group.parent?.remove(this.group);
        for (const object of this.disposables) object.dispose?.();
        this.disposables.length = 0;
    }
}

export default MarsSky;
