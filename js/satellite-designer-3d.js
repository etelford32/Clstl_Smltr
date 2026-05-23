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

  // Always-visible locator halo — a sprite that never shrinks below a fixed
  // pixel size, so the satellite is findable even from a system view. The
  // sprite is built from a tiny canvas so we don't need an image asset.
  const haloTex = (() => {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 128;
    const g = c.getContext('2d');
    // Outer ring
    g.strokeStyle = '#00e2ff'; g.lineWidth = 6;
    g.beginPath(); g.arc(64, 64, 50, 0, Math.PI * 2); g.stroke();
    // Four tick marks (the "reticle")
    g.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      const ix = 64 + Math.cos(a) * 38, iy = 64 + Math.sin(a) * 38;
      const ox = 64 + Math.cos(a) * 60, oy = 64 + Math.sin(a) * 60;
      g.beginPath(); g.moveTo(ix, iy); g.lineTo(ox, oy); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: haloTex, transparent: true, depthTest: false, depthWrite: false,
    sizeAttenuation: false,        // <- always constant viewport-fraction size
  }));
  halo.scale.set(0.08, 0.08, 1);   // ~8% of viewport height
  halo.renderOrder = 999;          // always on top of Earth
  // IMPORTANT: not a child of satPivot — satPivot is scaled ~100× to make
  // the model visible, which would balloon the halo. We sync position
  // ourselves each frame in update().
  scene.add(halo);
  // Pickable bounding sphere (invisible) for raycasting clicks. Sits at
  // scene root too so its scale isn't yanked by satPivot's render-scale.
  const satPickProxy = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  satPickProxy.userData.kind = 'satellite';
  scene.add(satPickProxy);
  earth.userData.kind = 'earth';

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

  // ── Heading reticle — shows where the satellite is *pointed* in manual ──
  // A short ribbon drawn ahead of the satellite along the current heading.
  // Always visible in the 3-D scene so the pilot can pre-aim before firing.
  const headingGeom = new THREE.BufferGeometry();
  const headingPts = new Float32Array(6);   // 2 points × xyz
  headingGeom.setAttribute('position', new THREE.BufferAttribute(headingPts, 3));
  const headingMat = new THREE.LineBasicMaterial({
    color: 0xffd166, transparent: true, opacity: 0.85,
  });
  const headingLine = new THREE.Line(headingGeom, headingMat);
  scene.add(headingLine);
  // A tiny chevron at the tip helps direction read at a glance.
  const headingTip = new THREE.Mesh(
    new THREE.ConeGeometry(40, 120, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd166 })
  );
  headingTip.rotation.z = -Math.PI / 2;       // point along +x by default
  scene.add(headingTip);

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

  // ── Controls — single OrbitControls reconfigured per mode ───────────────
  // The pilot has full god-mode authority: left-drag rotates, right-drag
  // pans in screen space, scroll/middle-drag zooms. Two-finger trackpad
  // gestures map to dolly+pan. Pan and zoom limits widen in FREE so the
  // operator can fly the camera anywhere from sat-side up to a system view.
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.085;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 0.95;
  controls.panSpeed = 1.0;
  controls.enablePan = true;
  controls.screenSpacePanning = true;
  controls.minDistance = 30;
  controls.maxDistance = 200_000;
  controls.autoRotate = false;
  controls.autoRotateSpeed = 0.35;

  // ── Smooth target lerp — used by FOLLOW and the Focus button ────────────
  // We never *snap* the camera target; instead we move it toward a desired
  // point each frame. This keeps the satellite under the cursor smoothly
  // even as it whips around at ~7 km/s.
  const targetWanted = new THREE.Vector3();
  let targetLerp = 0;          // 0..1, how fast the target chases (per frame)

  let cameraMode = 'free';
  function setCameraMode(mode, opts = {}) {
    cameraMode = mode;
    // Default: smooth move; opts.snap = true does it instantly.
    const snap = !!opts.snap;
    if (mode === 'wide') {
      // Look at Earth's centre from a slight elevation; auto-orbit unless
      // the pilot grabs the camera. fitToApogee() drives the zoom level.
      targetWanted.set(0, 0, 0);
      controls.autoRotate = true;
      controls.minDistance = R_EARTH_KM * 1.05;
      controls.maxDistance = 200_000;
      if (snap) {
        controls.target.copy(targetWanted);
        // If the camera is currently glued to the satellite (returning from
        // FOLLOW), pull back to a comfortable system view.
        if (camera.position.length() < R_EARTH_KM * 1.6) {
          camera.position.set(0, -22000, 9000);
        }
      }
      targetLerp = 0.08;
    } else if (mode === 'follow') {
      controls.autoRotate = false;
      controls.minDistance = 25;          // can get nose-to-bus close
      controls.maxDistance = 12_000;
      // Pose the camera at a comfortable trailing-quarter angle so users
      // land in a recognisable view rather than wherever they last left it.
      if (snap && satPivot.position.lengthSq() > 0) {
        const off = new THREE.Vector3(0, -350, 180);
        camera.position.copy(satPivot.position).add(off);
        controls.target.copy(satPivot.position);
      }
      targetLerp = 0.18;
    } else { // free — fully unconstrained god-mode
      controls.autoRotate = false;
      controls.minDistance = 30;
      controls.maxDistance = 200_000;
      targetLerp = 0.0;                   // pilot owns the target
      if (snap) {
        // First-entry framing: keep the user's current orbit/zoom but
        // park the look-at on Earth's centre so they have a stable pivot.
        controls.target.set(0, 0, 0);
      }
    }
  }

  // Smoothly recenter the controls target on the satellite, regardless of
  // current camera mode. The camera position is preserved (just look-at
  // shifts) so the pilot's framing isn't yanked.
  function focusSatellite() {
    targetWanted.copy(satPivot.position);
    targetLerp = 0.22;
    // In free mode we also pull the camera in if it's farther than 4× the
    // satellite altitude — otherwise "focus" is invisible from a system view.
    if (cameraMode === 'free') {
      const distEarth = satPivot.position.length() || R_EARTH_KM;
      const camDist = camera.position.distanceTo(satPivot.position);
      const cap = distEarth * 4 + 800;
      if (camDist > cap) {
        const dir = camera.position.clone().sub(satPivot.position).normalize();
        camera.position.copy(satPivot.position).addScaledVector(dir, cap);
      }
    }
  }

  // Snap the camera back to the wide-system view. Used by the R shortcut
  // and the "↺ Reset view" button.
  function resetView() {
    setCameraMode('wide', { snap: true });
    camera.position.set(0, -22000, 9000);
  }

  // ── Sat scale: visible from any altitude ─────────────────────────────────
  // We size the satellite so its largest extent is a fixed *fraction* of its
  // distance from the camera. In follow mode at minimum zoom this approaches
  // true scale; in wide / free modes it grows linearly with distance so the
  // bird is always findable against Earth. The halo sprite is independent
  // of this scale — it stays a constant pixel size as a backstop locator.
  function setSatScale() {
    if (!satModel) return;
    const camDist = camera.position.distanceTo(satPivot.position);
    let targetExtent;
    if (cameraMode === 'follow') {
      // True-scale up close, then keep readable as the player zooms out.
      // Capped at 250 km so the model doesn't dominate when very far in FOLLOW.
      targetExtent = Math.max(satExtent * KM, Math.min(camDist * 0.05, 250));
    } else {
      // Wide / Free: ~2.5 % of camera distance with a 600 km cap so even at
      // extreme zoom-out the satellite stays smaller than Earth. The halo
      // sprite is the real find-the-bird locator at huge distances.
      targetExtent = Math.max(140, Math.min(camDist * 0.025, 600));
    }
    // satPivot scales the geometry; the pick proxy lives at root, so we
    // size it directly in scene units so a raycast comfortably hits the
    // visible bounds at any zoom.
    satPivot.scale.setScalar(targetExtent / satExtent);
    satPickProxy.scale.setScalar(targetExtent);
    // Halo: hide in close FOLLOW when the model itself fills the screen,
    // so the reticle doesn't visually dominate up close.
    halo.visible = !(cameraMode === 'follow' && camDist < 600);
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
      // Halo & pick-proxy track the satellite directly (they live at the
      // scene root so satPivot's render-scale doesn't distort them).
      halo.position.copy(satPivot.position);
      satPickProxy.position.copy(satPivot.position);
      // Velocity-aligned: rotate the model so its model-+x (after the
      // builder's Math.PI/2 yaw, that's the long axis) lies along velocity.
      if (typeof s.satRotZ === 'number') satPivot.rotation.z = s.satRotZ;

      // Heading reticle — drawn ahead of the satellite along control.heading.
      // s.headingRad is independent of velocity so the pilot can pre-aim;
      // colour goes hot when an actual manual burn is firing.
      if (typeof s.headingRad === 'number') {
        const px = satPivot.position.x, py = satPivot.position.y;
        const camDist = camera.position.distanceTo(satPivot.position);
        // Length & tip scale clamp so the reticle stays readable from
        // both nose-close (FOLLOW) and system-wide (FREE) viewpoints.
        const len = Math.min(1500, Math.max(80, camDist * 0.04));
        const tx = px + Math.cos(s.headingRad) * len;
        const ty = py + Math.sin(s.headingRad) * len;
        headingPts[0] = px; headingPts[1] = py; headingPts[2] = 0;
        headingPts[3] = tx; headingPts[4] = ty; headingPts[5] = 0;
        headingGeom.attributes.position.needsUpdate = true;
        headingTip.position.set(tx, ty, 0);
        headingTip.scale.setScalar(Math.min(8, Math.max(0.3, camDist * 0.00018)));
        headingTip.rotation.z = s.headingRad - Math.PI / 2;
        // Hot = firing, cool = aim preview. Material is shared so we just
        // swap the colour & opacity.
        const firing = !!s.headingFiring;
        const hot = firing ? 0xff9050 : 0xffd166;
        headingMat.color.setHex(hot);
        headingMat.opacity = firing ? 1.0 : 0.55;
        headingTip.material.color.setHex(hot);
        const visible = !!s.headingVisible;
        headingLine.visible = visible;
        headingTip.visible = visible;
      } else {
        headingLine.visible = false;
        headingTip.visible = false;
      }
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

    // Subject lock — when the pilot has selected the satellite, glue the
    // camera target to it in any camera mode (FOLLOW does this anyway).
    // The smooth lerp handles motion so pointer input isn't overridden.
    if (s.satM && (cameraMode === 'follow' || subject === 'satellite')) {
      targetWanted.copy(satPivot.position);
      if (targetLerp < 0.12) targetLerp = 0.12;
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
    // Smoothly chase the desired look-at target. In FREE we set targetLerp
    // to zero so pan input is preserved exactly.
    if (targetLerp > 0) {
      controls.target.lerp(targetWanted, targetLerp);
    }
    setSatScale();
    controls.update();
    renderer.render(scene, camera);
  }

  // Camera diagnostics for the UI readout (km).
  function viewInfo() {
    const altKm = Math.max(0, camera.position.length() - R_EARTH_KM);
    const distSatKm = camera.position.distanceTo(satPivot.position);
    return { altKm, distSatKm, mode: cameraMode, subject };
  }

  // ── Focal subject — Earth vs Satellite ──────────────────────────────────
  // The pilot can lock the camera's look-at on either body. Earth keeps the
  // classic system view; Satellite makes the camera chase the bird in any
  // mode (so even WIDE / FREE auto-pan keeps the spacecraft centred).
  let subject = 'earth';
  function setSubject(s) {
    subject = s === 'satellite' ? 'satellite' : 'earth';
    if (subject === 'satellite') {
      // Force a smooth chase from the current target to the satellite.
      targetWanted.copy(satPivot.position);
      targetLerp = Math.max(targetLerp, 0.2);
      // Pull the camera in if we're way out in WIDE mode.
      const camDist = camera.position.distanceTo(satPivot.position);
      if (camDist > 8000) {
        const dir = camera.position.clone().sub(satPivot.position).normalize();
        camera.position.copy(satPivot.position).addScaledVector(dir, 1800);
      }
    } else {
      targetWanted.set(0, 0, 0);
      targetLerp = Math.max(targetLerp, 0.06);
    }
  }

  // Raycast from a normalised-device click into the scene; return the kind
  // of body the user picked, or null. Used by the page to wire click-to-focus
  // on the canvas — click Earth or the satellite halo to select.
  const raycaster = new THREE.Raycaster();
  const ndcVec = new THREE.Vector2();
  function pickAt(ndcX, ndcY) {
    ndcVec.set(ndcX, ndcY);
    raycaster.setFromCamera(ndcVec, camera);
    // Test the satellite pick-proxy first (it's small but always on top).
    const satHits = raycaster.intersectObject(satPickProxy, false);
    if (satHits.length) return 'satellite';
    const earthHits = raycaster.intersectObject(earth, false);
    if (earthHits.length) return 'earth';
    return null;
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

  // First sizing — default to FREE so the user lands in true god-mode (full
  // pan/zoom/rotate around Earth) but framed wide.
  resize();
  resetView();
  setCameraMode('free', { snap: true });

  return { resize, render, update, setCameraMode, setTargetAlt, dispose,
           focusSatellite, resetView, viewInfo,
           setSubject, pickAt,
           getMode: () => cameraMode,
           getSubject: () => subject };
}
