/**
 * satellite-game-scene.js — single-canvas Three.js stage controller.
 *
 * One persistent WebGLRenderer/Scene. Six phase stages are pre-built and
 * toggled via group visibility; the camera tweens between each stage's
 * canonical pose. `launchSequence()` is the briefing → flight camera move
 * that lets the transition controller fire a continuous shot instead of a
 * crossfade.
 */
import * as THREE from 'three';
import { PHASES } from './satellite-game-store.js';

export class SceneController {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x040210, 1);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    this.camera.position.set(0, 0, 8);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0x4060a0, 0.4));
    const sun = new THREE.DirectionalLight(0xffeecc, 1.2);
    sun.position.set(8, 4, 6);
    this.scene.add(sun);

    this.stages = {
      [PHASES.TITLE]: this._buildTitleStage(),
      [PHASES.GAME_TYPE]: this._buildAmbientStage(),
      [PHASES.SHIP_SELECT]: this._buildShipStage(),
      [PHASES.BRIEFING]: this._buildShipStage(0.6),
      [PHASES.FLIGHT]: this._buildFlightStage(),
      [PHASES.RESOLUTION]: this._buildResolutionStage(),
    };

    Object.values(this.stages).forEach((s) => {
      s.group.visible = false;
      this.scene.add(s.group);
    });

    this.activeStage = null;
    this.tween = null;

    this._handleResize = this._handleResize.bind(this);
    window.addEventListener('resize', this._handleResize);
    this._handleResize();
  }

  setStage(phase) {
    if (this.activeStage) this.activeStage.group.visible = false;
    const next = this.stages[phase];
    if (!next) return;
    next.group.visible = true;
    this.activeStage = next;
    if (next.camera) this._tweenCamera(next.camera.pos, next.camera.target, 0.8);
  }

  _tweenCamera(toPos, toTarget, durationS) {
    const fromPos = this.camera.position.clone();
    const lookCurrent = new THREE.Vector3();
    this.camera.getWorldDirection(lookCurrent);
    const fromTarget = fromPos.clone().add(lookCurrent.multiplyScalar(5));
    const start = performance.now();
    const durMs = durationS * 1000;

    this.tween = (now) => {
      const t = Math.min(1, (now - start) / durMs);
      const e = easeInOutCubic(t);
      this.camera.position.lerpVectors(fromPos, toPos, e);
      const target = new THREE.Vector3().lerpVectors(fromTarget, toTarget, e);
      this.camera.lookAt(target);
      if (t >= 1) this.tween = null;
    };
  }

  launchSequence(onComplete) {
    const fromPos = new THREE.Vector3(0, 0.8, 4.5);
    const toPos = new THREE.Vector3(0, 0, 14);
    const target = new THREE.Vector3(0, 0, 0);
    const start = performance.now();
    const durMs = 2200;

    if (this.stages[PHASES.SHIP_SELECT]) this.stages[PHASES.SHIP_SELECT].group.visible = true;
    if (this.stages[PHASES.FLIGHT]) this.stages[PHASES.FLIGHT].group.visible = false;

    this.tween = (now) => {
      const t = Math.min(1, (now - start) / durMs);
      const e = easeInOutCubic(t);
      this.camera.position.lerpVectors(fromPos, toPos, e);
      this.camera.lookAt(target);

      if (t > 0.55 && !this._switchedToFlight) {
        this._switchedToFlight = true;
        if (this.stages[PHASES.SHIP_SELECT]) this.stages[PHASES.SHIP_SELECT].group.visible = false;
        if (this.stages[PHASES.FLIGHT]) this.stages[PHASES.FLIGHT].group.visible = true;
        this.activeStage = this.stages[PHASES.FLIGHT];
      }

      if (t >= 1) {
        this.tween = null;
        this._switchedToFlight = false;
        if (onComplete) onComplete();
      }
    };
  }

  tick(dt, now) {
    if (this.tween) this.tween(now);
    if (this.activeStage && this.activeStage.update) {
      this.activeStage.update(dt, now);
    }
    this.renderer.render(this.scene, this.camera);
  }

  _handleResize() {
    // Read the canvas's actual layout size so the renderer respects the
    // surrounding chrome (top nav, etc.) instead of bleeding behind it.
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    window.removeEventListener('resize', this._handleResize);
    this.renderer.dispose();
  }

  _buildTitleStage() {
    const group = new THREE.Group();
    const stars = makeStarfield(800, 400);
    group.add(stars);
    const distant = makeEarth(0.6, [12, -3, -8]);
    group.add(distant);
    return {
      group,
      camera: { pos: new THREE.Vector3(0, 0, 8), target: new THREE.Vector3(0, 0, 0) },
      update: (dt) => {
        stars.rotation.y += dt * 0.005;
        distant.rotation.y += dt * 0.02;
      },
    };
  }

  _buildAmbientStage() {
    const group = new THREE.Group();
    const stars = makeStarfield(600, 400);
    group.add(stars);
    return {
      group,
      camera: { pos: new THREE.Vector3(0, 0, 10), target: new THREE.Vector3(0, 0, 0) },
      update: (dt) => { stars.rotation.y += dt * 0.003; },
    };
  }

  _buildShipStage(zoom = 1) {
    const group = new THREE.Group();
    const stars = makeStarfield(400, 200);
    group.add(stars);
    const ship = makeShip();
    group.add(ship);
    const z = 4.5 / zoom;
    return {
      group,
      ship,
      camera: { pos: new THREE.Vector3(0, 0.8, z), target: new THREE.Vector3(0, 0, 0) },
      update: (dt) => {
        ship.rotation.y += dt * 0.18;
        stars.rotation.y += dt * 0.002;
      },
    };
  }

  _buildFlightStage() {
    const group = new THREE.Group();
    const stars = makeStarfield(1200, 500);
    group.add(stars);
    const earth = makeEarth(4, [0, 0, 0]);
    group.add(earth);
    const orbitRadius = 5.2;
    const orbit = makeOrbitTrace(orbitRadius);
    group.add(orbit);
    const sat = makeShip(0.18);
    group.add(sat);
    let theta = 0;
    return {
      group,
      camera: { pos: new THREE.Vector3(0, 3, 14), target: new THREE.Vector3(0, 0, 0) },
      update: (dt) => {
        earth.rotation.y += dt * 0.04;
        theta += dt * 0.25;
        sat.position.set(Math.cos(theta) * orbitRadius, 0, Math.sin(theta) * orbitRadius);
        sat.rotation.y = -theta;
      },
    };
  }

  _buildResolutionStage() {
    const group = new THREE.Group();
    const stars = makeStarfield(800, 400);
    group.add(stars);
    const earth = makeEarth(3, [3, -1, -2]);
    group.add(earth);
    return {
      group,
      camera: { pos: new THREE.Vector3(-2, 1, 10), target: new THREE.Vector3(0, 0, 0) },
      update: (dt) => {
        stars.rotation.y += dt * 0.002;
        earth.rotation.y += dt * 0.03;
      },
    };
  }
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function makeStarfield(count, radius) {
  const geom = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = radius * (0.6 + 0.4 * Math.random());
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color: 0xa8c0d8, size: 0.7, sizeAttenuation: false, transparent: true, opacity: 0.85 });
  return new THREE.Points(geom, mat);
}

function makeEarth(radius, position) {
  const group = new THREE.Group();
  const geom = new THREE.SphereGeometry(radius, 48, 32);
  const mat = new THREE.MeshStandardMaterial({ color: 0x2a5f8a, roughness: 0.85, metalness: 0.05, emissive: 0x0a1a30, emissiveIntensity: 0.3 });
  const sphere = new THREE.Mesh(geom, mat);
  group.add(sphere);
  const atm = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.04, 48, 32),
    new THREE.MeshBasicMaterial({ color: 0x4a90c8, transparent: true, opacity: 0.12, side: THREE.BackSide })
  );
  group.add(atm);
  group.position.set(...position);
  return group;
}

function makeOrbitTrace(radius) {
  const segments = 128;
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
  }
  const geom = new THREE.BufferGeometry().setFromPoints(points);
  const mat = new THREE.LineBasicMaterial({ color: 0x00c6ff, transparent: true, opacity: 0.35 });
  return new THREE.Line(geom, mat);
}

function makeShip(scale = 1) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.7, 16),
    new THREE.MeshStandardMaterial({ color: 0xb8c4d0, metalness: 0.4, roughness: 0.35 })
  );
  body.rotation.z = Math.PI / 2;
  group.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.25, 16),
    new THREE.MeshStandardMaterial({ color: 0x8090a0, metalness: 0.4, roughness: 0.4 })
  );
  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.475;
  group.add(nose);
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x1a3050, metalness: 0.3, roughness: 0.2, emissive: 0x0a2040, emissiveIntensity: 0.4 });
  const pL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.6), panelMat);
  pL.position.set(0, 0, 0.45);
  group.add(pL);
  const pR = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.6), panelMat);
  pR.position.set(0, 0, -0.45);
  group.add(pR);
  group.scale.setScalar(scale);
  return group;
}
