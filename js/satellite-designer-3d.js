/**
 * Mission-state 3-D scene for the Satellite Designer.
 *
 * One WebGL canvas renders Earth (sphere), atmosphere shell, target-altitude
 * ring, orbit trail, the satellite (parametric build), debris/target markers,
 * and a starfield. Three camera modes:
 *   wide   — fits the whole orbit, gentle auto-orbit, no input
 *   follow — chases the satellite (zoom on the bird), pointer drags rotate
 *            around it, scroll wheel zooms in/out
 *   free   — full OrbitControls around Earth, no auto-rotate
 *
 * Engine state arrives in metres; the scene works in kilometres
 * (SCENE_SCALE = 1/1000) so Three.js precision stays comfortable.
 *
 * Public surface (returned by init):
 *   resize(), render(), setBuild(build), setCameraMode(mode),
 *   setTargetAlt(km), update({ trailM, satM, satRotZ, targetSat,
 *     debris, earthSpin }), dispose().
 */
import * as BUILDER from './satellite-builder.js';

const KM = 1 / 1000;            // metres → scene units (km)
const R_EARTH_KM = 6371;
const TRAIL_MAX = 2400;

const VERT_STAR = `
attribute float aSize;
varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (300.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
  vAlpha = clamp(aSize * 0.4, 0.25, 1.0);
}`;
const FRAG_STAR = `
varying float vAlpha;
void main(){
  float d = distance(gl_PointCoord, vec2(0.5));
  if (d > 0.5) discard;
  float a = vAlpha * smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(0.85, 0.92, 1.0, a);
}`;

/**
 * Build the scene. `canvas` is the destination <canvas>. THREE module is
 * passed in so the host can use its own import map.
 */
export async function init(canvas, THREE) {
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.setClearColor(0x02030a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 5, 200_000);
  camera.position.set(0, -22000, 9000);
  camera.up.set(0, 0, 1);                  // orbit plane is xy, +z up
  camera.lookAt(0, 0, 0);

  // ── Lights — sun key + soft fill ──────────────────────────────────────────
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.position.set(40000, -10000, 12000);
  scene.add(sun);
  scene.add(new THREE.AmbientLight(0x1a2740, 1.0));
  // Faint cyan rim from "behind" Earth keeps the night side from going black.
  const rim = new THREE.DirectionalLight(0x4d7fb8, 0.35);
  rim.position.set(-20000, 8000, -4000);
  scene.add(rim);

  // ── Earth ────────────────────────────────────────────────────────────────
  // Procedural ocean / continent fake — a two-tone gradient over a sphere,
  // with a brighter spot toward the sun direction so the day-night terminator
  // is legible without a texture download.
  const earthMat = new THREE.MeshStandardMaterial({
    color: 0x244878, roughness: 0.85, metalness: 0.05,
    emissive: 0x040c1c, emissiveIntensity: 0.45,
  });
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH_KM, 96, 64), earthMat);
  scene.add(earth);

  // Latitude / longitude wire-net for orientation cues.
  const grid = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.SphereGeometry(R_EARTH_KM * 1.0008, 24, 12)),
    new THREE.LineBasicMaterial({ color: 0x4ea0d8, transparent: true, opacity: 0.18 })
  );
  scene.add(grid);

  // Inner & outer atmosphere shells (denser → fainter as altitude rises).
  const atmInner = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH_KM + 90, 64, 32),
    new THREE.MeshBasicMaterial({
      color: 0x6cb3ff, transparent: true, opacity: 0.13,
      side: THREE.BackSide, depthWrite: false,
    })
  );
  scene.add(atmInner);
  const atmOuter = new THREE.Mesh(
    new THREE.SphereGeometry(R_EARTH_KM + 600, 64, 32),
    new THREE.MeshBasicMaterial({
      color: 0x4e8edd, transparent: true, opacity: 0.05,
      side: THREE.BackSide, depthWrite: false,
    })
  );
  scene.add(atmOuter);

  // ── Target altitude ring ─────────────────────────────────────────────────
  const targetRing = new THREE.Mesh(
    new THREE.RingGeometry(R_EARTH_KM + 300 - 8, R_EARTH_KM + 300 + 8, 192),
    new THREE.MeshBasicMaterial({
      color: 0x5fe39a, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  // Lies in the orbit plane (xy by default — perfect).
  scene.add(targetRing);

  // ── Orbit trail (rolling buffer of positions) ────────────────────────────
  const trailGeom = new THREE.BufferGeometry();
  const trailPos = new Float32Array(TRAIL_MAX * 3);
  const trailAttr = new THREE.BufferAttribute(trailPos, 3);
  trailAttr.setUsage(THREE.DynamicDrawUsage);
  trailGeom.setAttribute('position', trailAttr);
  trailGeom.setDrawRange(0, 0);
  const trail = new THREE.Line(trailGeom,
    new THREE.LineBasicMaterial({ color: 0x00c6ff, transparent: true, opacity: 0.85 }));
  scene.add(trail);

  // ── Satellite (built from BUILDER.buildGroup, drawn in its own pivot) ────
  // The model lives in metres (extent of order 1–10 m). When viewed from
  // 20 000 km away that's a single sub-pixel, so we *scale* the model so it
  // is always a visible fraction of the screen — true size only in extreme
  // close-ups (follow mode at minimum zoom).
  const satPivot = new THREE.Group();
  scene.add(satPivot);
  let satModel = null;
  let satExtent = 1;
  function rebuildSat(build) {
    if (satModel) {
      satPivot.remove(satModel);
      satModel.traverse(o => {
        if (o.isMesh) {
          o.geometry?.dispose?.();
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m?.dispose?.());
        }
      });
    }
    satModel = BUILDER.buildGroup(THREE, build);
    // Builder uses +z as thrust axis. Our prograde is along the velocity
    // vector — we'll yaw the pivot to align +x of the model with velocity.
    satModel.rotation.y = Math.PI / 2;
    satPivot.add(satModel);
    satExtent = Math.max(0.3, BUILDER.buildExtent(build));
  }

  // ── Target satellite / debris markers (for missions) ─────────────────────
  const targetSatMesh = new THREE.Mesh(
    new THREE.SphereGeometry(60, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd166 })
  );
  targetSatMesh.visible = false;
  scene.add(targetSatMesh);
  const targetHalo = new THREE.Mesh(
    new THREE.RingGeometry(120, 160, 48),
    new THREE.MeshBasicMaterial({
      color: 0xffd166, transparent: true, opacity: 0.6,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  targetHalo.visible = false;
  scene.add(targetHalo);

  const debrisMesh = new THREE.Mesh(
    new THREE.IcosahedronGeometry(50, 0),
    new THREE.MeshStandardMaterial({ color: 0xff6b7d, emissive: 0x551018, roughness: 0.8 })
  );
  debrisMesh.visible = false;
  scene.add(debrisMesh);

  // ── Stars (point sprites on a far sphere) ────────────────────────────────
  const STAR_R = 120_000;
  const N_STARS = 1800;
  const sg = new THREE.BufferGeometry();
  const sp = new Float32Array(N_STARS * 3);
  const ss = new Float32Array(N_STARS);
  for (let i = 0; i < N_STARS; i++) {
    // Uniform sphere
    const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2;
    const r = Math.sqrt(1 - u * u);
    sp[i * 3] = STAR_R * r * Math.cos(t);
    sp[i * 3 + 1] = STAR_R * r * Math.sin(t);
    sp[i * 3 + 2] = STAR_R * u;
    ss[i] = 0.6 + Math.random() * 3.2;
  }
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  sg.setAttribute('aSize', new THREE.BufferAttribute(ss, 1));
  const starMat = new THREE.ShaderMaterial({
    vertexShader: VERT_STAR, fragmentShader: FRAG_STAR,
    transparent: true, depthWrite: false,
  });
  const stars = new THREE.Points(sg, starMat);
  scene.add(stars);

  // ── Controls (one OrbitControls, reconfigured per mode) ──────────────────
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.85;
  controls.minDistance = R_EARTH_KM * 1.05;
  controls.maxDistance = 90_000;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  // Pointer interaction breaks the auto-orbit until the mode is reset.
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  let cameraMode = 'wide';
  function setCameraMode(mode) {
    cameraMode = mode;
    if (mode === 'wide') {
      controls.target.set(0, 0, 0);
      controls.autoRotate = true;
      controls.minDistance = R_EARTH_KM * 1.05;
      controls.maxDistance = 90_000;
    } else if (mode === 'follow') {
      controls.autoRotate = false;
      controls.minDistance = 40;     // get *right* up close to the satellite
      controls.maxDistance = 9000;
    } else { // free
      controls.target.set(0, 0, 0);
      controls.autoRotate = false;
      controls.minDistance = R_EARTH_KM * 1.05;
      controls.maxDistance = 200_000;
    }
  }

  // ── Sat scale: visible from any altitude ─────────────────────────────────
  // We size the satellite so its largest extent is a fixed *fraction* of its
  // distance from the camera. In follow mode at minimum zoom this approaches
  // true scale; in wide mode it stays at ~80 km so the operator can see it.
  function setSatScale() {
    if (!satModel) return;
    const camDist = camera.position.distanceTo(satPivot.position);
    let targetExtent;
    if (cameraMode === 'follow') {
      // Smoothly true-scale up to ~200 km out, then keep readable.
      targetExtent = Math.max(satExtent * KM, Math.min(camDist * 0.05, 200));
    } else {
      targetExtent = Math.max(80, camDist * 0.018);
    }
    satPivot.scale.setScalar(targetExtent / satExtent);
  }

  // ── Trail buffer ─────────────────────────────────────────────────────────
  let trailLen = 0;
  function writeTrail(arrM) {
    // Copy the last TRAIL_MAX points from the engine's trail array (metres).
    const n = Math.min(arrM.length, TRAIL_MAX);
    const start = arrM.length - n;
    for (let i = 0; i < n; i++) {
      const [x, y] = arrM[start + i];
      trailPos[i * 3]     = x * KM;
      trailPos[i * 3 + 1] = y * KM;
      trailPos[i * 3 + 2] = 0;
    }
    trailLen = n;
    trailAttr.needsUpdate = true;
    trailGeom.setDrawRange(0, n);
  }

  // ── Per-frame update from the simulation ─────────────────────────────────
  let earthRot = 0;
  function update(s) {
    if (s.build) rebuildSat(s.build);

    if (s.satM) {
      satPivot.position.set(s.satM[0] * KM, s.satM[1] * KM, 0);
      // Velocity-aligned: rotate the model so its model-+x (after the
      // builder's Math.PI/2 yaw, that's the long axis) lies along velocity.
      if (typeof s.satRotZ === 'number') satPivot.rotation.z = s.satRotZ;
    }
    if (s.trailM) writeTrail(s.trailM);

    if (s.targetSat) {
      targetSatMesh.position.set(s.targetSat[0] * KM, s.targetSat[1] * KM, 0);
      targetHalo.position.copy(targetSatMesh.position);
      // Halo always faces the camera.
      targetHalo.lookAt(camera.position);
      targetSatMesh.visible = true; targetHalo.visible = true;
    } else {
      targetSatMesh.visible = false; targetHalo.visible = false;
    }

    if (s.debris) {
      debrisMesh.position.set(s.debris[0] * KM, s.debris[1] * KM, 0);
      debrisMesh.visible = true;
    } else {
      debrisMesh.visible = false;
    }

    if (typeof s.earthSpin === 'number') {
      earthRot = s.earthSpin;
      earth.rotation.z = earthRot;
      grid.rotation.z = earthRot;
    }

    // Follow mode: keep the controls target locked to the satellite.
    if (cameraMode === 'follow' && s.satM) {
      controls.target.copy(satPivot.position);
    }
  }

  function setTargetAlt(km) {
    const r = R_EARTH_KM + km;
    targetRing.geometry.dispose();
    targetRing.geometry = new THREE.RingGeometry(r - 8, r + 8, 192);
  }

  function fitToApogee(rApoKm) {
    if (cameraMode !== 'wide') return;
    const want = Math.max((R_EARTH_KM + rApoKm) * 2.6, R_EARTH_KM * 2.2);
    const cur = camera.position.length();
    const lerp = cur + (want - cur) * 0.04;
    camera.position.setLength(lerp);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    renderer.setSize(r.width, r.height, false);
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
  }

  function render(rApoKm) {
    if (typeof rApoKm === 'number') fitToApogee(rApoKm);
    setSatScale();
    controls.update();
    renderer.render(scene, camera);
  }

  function dispose() {
    renderer.dispose();
    controls.dispose();
    scene.traverse(o => {
      if (o.isMesh || o.isLine || o.isPoints) {
        o.geometry?.dispose?.();
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m?.dispose?.());
      }
    });
  }

  // First sizing.
  resize();
  setCameraMode('wide');

  return { resize, render, update, setCameraMode, setTargetAlt, dispose,
           getMode: () => cameraMode };
}
