/**
 * globe.js — Three.js scene for the Operations console.
 *
 * Owns the renderer, camera, OrbitControls, Earth + atmosphere meshes,
 * and lighting. Drives a 60 Hz render loop that:
 *   1. reads the current simTimeMs from time-bus (sync, cheap)
 *   2. rotates the Earth mesh to match GMST at that instant
 *   3. positions the sun light from the inertial sun direction
 *   4. fans out a tick(simTimeMs) callback to registered listeners
 *      (the fleet module wires SatelliteTracker.tick() through this)
 *   5. renders the scene
 *
 * The propagation work happens in listeners; this module is just the
 * scene plumbing. Resizes are observed via ResizeObserver on the canvas
 * element — works correctly when the surrounding CSS grid reflows
 * (panel toggles, persona switch, viewport changes).
 */

import * as THREE         from 'three';
import { OrbitControls }  from 'three/addons/controls/OrbitControls.js';
import { geo }            from '../geo/coords.js';
import { sunDirectionEci } from '../sun-altitude.js';
import { timeBus }        from './time-bus.js';

const EARTH_RADIUS_SCENE = 1.0;
const EARTH_TEXTURE_URL  = 'https://unpkg.com/three-globe@2.31.0/example/img/earth-blue-marble.jpg';

export class OperationsGlobe {
    constructor(canvas) {
        this.canvas = canvas;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.outputColorSpace = THREE.SRGBColorSpace;
        this.renderer.setClearColor(0x000005);

        this.scene  = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
        this.camera.position.set(0, 1.2, 3.5);

        this.controls = new OrbitControls(this.camera, canvas);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.minDistance   = 1.2;
        this.controls.maxDistance   = 20;

        // Lighting balanced for the time scrubber: a higher ambient floor
        // (matching satellites.html's tuning) keeps the night side from
        // strobing as the terminator sweeps at 3600× replay speed.
        this.scene.add(new THREE.AmbientLight(0x445878, 0.58));
        this.sunLight = new THREE.DirectionalLight(0xffffff, 1.05);
        this.sunLight.position.set(10, 2, 3);
        this.scene.add(this.sunLight);
        this._sunSceneV = new THREE.Vector3();

        const earthGeo = new THREE.SphereGeometry(EARTH_RADIUS_SCENE, 64, 64);
        const earthTex = new THREE.TextureLoader().load(
            EARTH_TEXTURE_URL,
            tex => { tex.colorSpace = THREE.SRGBColorSpace; },
        );
        const earthMat  = new THREE.MeshStandardMaterial({ map: earthTex, roughness: 0.85 });
        this.earthMesh  = new THREE.Mesh(earthGeo, earthMat);
        this.scene.add(this.earthMesh);

        const atmMesh = new THREE.Mesh(
            new THREE.SphereGeometry(EARTH_RADIUS_SCENE * 1.025, 48, 48),
            new THREE.MeshBasicMaterial({
                color: 0x4488ff, transparent: true, opacity: 0.08,
                blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
            }),
        );
        this.scene.add(atmMesh);

        this._tickListeners = new Set();
        this._raf      = null;
        this._running  = false;

        this._resize();
        this._onResize = this._resize.bind(this);
        window.addEventListener('resize', this._onResize);
        if (typeof ResizeObserver !== 'undefined') {
            this._ro = new ResizeObserver(this._onResize);
            this._ro.observe(canvas);
        }
    }

    getScene()       { return this.scene; }
    getEarthRadius() { return EARTH_RADIUS_SCENE; }

    /**
     * Register a listener that runs once per frame inside the render loop
     * with the current simTimeMs. Returns an unsubscribe.
     */
    onTick(fn) {
        this._tickListeners.add(fn);
        return () => this._tickListeners.delete(fn);
    }

    start() {
        if (this._running) return;
        this._running = true;
        const tick = () => {
            if (!this._running) return;
            this._raf = requestAnimationFrame(tick);
            this._frame();
        };
        this._raf = requestAnimationFrame(tick);
    }

    stop() {
        this._running = false;
        if (this._raf !== null) cancelAnimationFrame(this._raf);
        this._raf = null;
    }

    _frame() {
        const { simTimeMs } = timeBus.getState();
        const simDate       = new Date(simTimeMs);

        this.earthMesh.rotation.y = geo.greenwichSiderealTime(simDate);

        const sun = sunDirectionEci(simDate);
        this._sunSceneV.set(sun.x, sun.z, -sun.y).multiplyScalar(10);
        this.sunLight.position.copy(this._sunSceneV);

        for (const fn of this._tickListeners) {
            try { fn(simTimeMs); }
            catch (err) { console.warn('[opsGlobe] tick listener threw', err); }
        }

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    _resize() {
        const w = this.canvas.clientWidth;
        const h = this.canvas.clientHeight;
        if (!w || !h) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    dispose() {
        this.stop();
        window.removeEventListener('resize', this._onResize);
        this._ro?.disconnect();
    }
}
