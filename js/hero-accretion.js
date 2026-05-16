/**
 * hero-accretion.js — 3D analytical hero for the optimized homepage
 *
 * A WebGL scene tuned to "Parkers Physics": a relativistic thin
 * accretion disc, Parker-spiral interplanetary-field arms (the
 * Archimedean spiral Eugene Parker derived for the solar wind), and
 * twisting flux-rope "twistor" filaments rising off the disc. Every
 * structure is driven by its real equation and exposed as an adjustable
 * control, so it is scientific *and* fun to play with — and it is a
 * single A/B variant of `hero_bg`, mounted only when assigned.
 *
 * The physics, intentionally first-order:
 *   • ISCO          r_isco = (3 + Z2 − √((3−Z1)(3+Z1+2Z2))) for spin a*
 *   • Disc temp     T(r) ∝ Ṁ^¼ · r^(−¾) · (1 − √(r_in/r))^¼   (Shakura–Sunyaev)
 *   • Colour        Planckian blackbody locus from T(r)
 *   • Beaming       D = √(1−β²)/(1 − β·n̂)  ,  I ∝ D³   (approaching side bright)
 *   • Parker spiral φ(r) = φ₀ − (Ω_⊙ / V_sw)(r − r₀)
 *   • Twistor       helix of adjustable winding about a rising guide curve
 *
 * Performance / safety: caps DPR, pauses on hidden tab, renders a single
 * static frame under prefers-reduced-motion, and fully disposes on
 * destroy(). mount() throws if WebGL is unavailable so the caller can
 * fall back to the particle field.
 *
 *   import { mountHeroAccretion } from './js/hero-accretion.js';
 *   const h = mountHeroAccretion({ reduced:false, onInteract(name){…} });
 *   // … later
 *   h.destroy();
 */

import * as THREE from './vendor/three-0.160.0/three.module.js';

const TOKENS = {
    uv:   0x9d3aff,
    pink: 0xff1f9c,
    arc:  0x8ff0ff,
    indigo: 0x6a48ff,
};

const DEFAULTS = {
    spin: 0.6,        // a*  (0 → Schwarzschild, →1 maximal Kerr)
    mdot: 1.0,        // Ṁ   accretion rate (brightness/temperature scale)
    incl: 24,         // camera inclination, degrees
    vsw: 430,         // solar-wind speed km/s → Parker spiral tightness
    twist: 2.4,       // turns in each twistor flux rope
};

function iscoRadius(aStar) {
    // Bardeen–Press–Teukolsky ISCO in gravitational radii (prograde).
    const a = Math.max(0, Math.min(0.999, aStar));
    const Z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
    const Z2 = Math.sqrt(3 * a * a + Z1 * Z1);
    return 3 + Z2 - Math.sqrt((3 - Z1) * (3 + Z1 + 2 * Z2));
}

/* ── Accretion-disc shader ──────────────────────────────────────────── */

const DISC_VERT = /* glsl */`
  varying vec2 vP;     // object-space disc-plane position
  varying float vT01;  // 0..1 radial parameter
  void main(){
    vP = position.xy;
    vT01 = length(position.xy);          // RingGeometry built on unit radius
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
  }
`;

const DISC_FRAG = /* glsl */`
  precision highp float;
  varying vec2 vP;
  varying float vT01;
  uniform float uRin, uRout, uMdot, uTime, uBeta, uFlare, uFlareAng;
  uniform vec2  uCamObj;               // camera position projected to disc plane

  vec3 blackbody(float t){
    t = clamp(t, 1000.0, 40000.0) / 100.0;
    float r,g,b;
    r = t <= 66.0 ? 1.0 : clamp(1.292 * pow(t - 60.0, -0.1332), 0.0, 1.0);
    g = t <= 66.0 ? clamp(0.390 * log(t) - 0.634, 0.0, 1.0)
                   : clamp(1.130 * pow(t - 60.0, -0.0755), 0.0, 1.0);
    b = t >= 66.0 ? 1.0 : (t <= 19.0 ? 0.0 : clamp(0.543 * log(t - 10.0) - 1.196, 0.0, 1.0));
    return vec3(r,g,b);
  }

  void main(){
    float R = mix(uRin, uRout, vT01);            // physical radius (r_g)
    if (R < uRin || vT01 > 1.0) discard;

    // Shakura–Sunyaev effective temperature (arbitrary inner scale).
    float f  = max(0.0, 1.0 - sqrt(uRin / R));
    float T  = 42000.0 * pow(uMdot, 0.25) * pow(uRin / R, 0.75) * pow(f, 0.25);
    vec3  col = blackbody(T);

    // Relativistic Doppler beaming. velocity ⟂ radius, speed ∝ 1/√R.
    vec2 rad = normalize(vP);
    vec2 vel = vec2(-rad.y, rad.x);
    vec2 nLos = normalize(uCamObj - vP);
    float beta = uBeta * inversesqrt(max(R / uRin, 1.0));
    float bl   = beta * dot(vel, nLos);
    float D    = sqrt(max(1.0 - beta*beta, 1e-3)) / (1.0 - bl);
    float beam = clamp(pow(D, 3.0), 0.15, 6.0);

    // Differential-rotation banding (Keplerian shear: Ω ∝ R^-1.5).
    float ang  = atan(vP.y, vP.x);
    float band = 0.78 + 0.22 * sin(ang * 3.0 - uTime * 3.2 * pow(uRin / R, 1.5));

    // Soft inner/outer falloff.
    float edge = smoothstep(0.0, 0.06, vT01) * (1.0 - smoothstep(0.82, 1.0, vT01));

    // Orbiting flare hot-spot.
    float dA = abs(atan(sin(ang - uFlareAng), cos(ang - uFlareAng)));
    float hot = uFlare * exp(-dA*dA*5.0) * exp(-pow((vT01-0.34)*4.0,2.0));

    float bright = (beam * band + hot * 2.2) * edge;
    vec3  outc   = col * bright + vec3(0.55,0.75,1.0) * hot;
    float a      = clamp(bright * 0.95 + hot, 0.0, 1.0);
    gl_FragColor = vec4(outc, a);
  }
`;

function parkerSpiralCurve(arm, vsw) {
    // φ(r) = φ0 − (Ω/V)(r − r0). Ω fixed (source rotation); V from slider.
    // Larger V_sw → looser (more radial) spiral, exactly as in the heliosphere.
    const r0 = 7, rMax = 150, OmegaOverV = 26 / Math.max(120, vsw);
    const phi0 = (arm * Math.PI * 2) / 5;
    const pts = [];
    for (let i = 0; i <= 90; i++) {
        const r = r0 + (rMax - r0) * (i / 90);
        const phi = phi0 - OmegaOverV * (r - r0);
        const tilt = 0.06 * r * Math.sin(phi * 0.5);     // gentle out-of-plane warp
        pts.push(new THREE.Vector3(r * Math.cos(phi), tilt, r * Math.sin(phi)));
    }
    return new THREE.CatmullRomCurve3(pts);
}

function twistorCurve(seed, twist) {
    // A flux rope: helix of `twist` turns wound about a guide arc that
    // rises off the disc plane. Pure parametric — adjust & watch it wind.
    const pts = [];
    const baseAng = seed * 2.2, lean = 0.5 + seed * 0.15;
    for (let i = 0; i <= 80; i++) {
        const s = i / 80;
        const gx = Math.cos(baseAng) * (14 + 60 * s);
        const gz = Math.sin(baseAng) * (14 + 60 * s);
        const gy = 70 * Math.pow(s, 1.4) * lean;
        const rad = 9 * (1 - s) + 2.5;
        const a = twist * Math.PI * 2 * s + seed;
        pts.push(new THREE.Vector3(
            gx + rad * Math.cos(a),
            gy + rad * Math.sin(a) * 0.6,
            gz + rad * Math.sin(a),
        ));
    }
    return new THREE.CatmullRomCurve3(pts);
}

export function mountHeroAccretion({ reduced = false, onInteract = () => {} } = {}) {
    const canvas = document.createElement('canvas');
    canvas.id = 'hero-3d';
    Object.assign(canvas.style, {
        position: 'fixed', inset: '0', zIndex: '0',
        pointerEvents: 'none', width: '100%', height: '100%',
    });

    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    } catch (e) {
        throw new Error('WebGL unavailable: ' + (e && e.message));
    }
    if (!renderer.getContext()) throw new Error('WebGL context creation failed');

    document.body.insertBefore(canvas, document.body.firstChild);
    const dprCap = window.innerWidth < 760 ? 1.5 : 2;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.1, 2000);
    const rig    = new THREE.Group();             // tilted by inclination
    scene.add(rig);

    const params = { ...DEFAULTS };

    // ── Event horizon shadow + photon ring ──────────────────────────
    const horizon = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 32),
        new THREE.MeshBasicMaterial({ color: 0x000000 }),
    );
    rig.add(horizon);
    const photon = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.06, 16, 96),
        new THREE.MeshBasicMaterial({ color: 0xfff0d8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }),
    );
    photon.rotation.x = Math.PI / 2;
    rig.add(photon);

    // ── Accretion disc ───────────────────────────────────────────────
    const discGeo = new THREE.RingGeometry(0.0001, 1, 256, 90);
    const discMat = new THREE.ShaderMaterial({
        vertexShader: DISC_VERT, fragmentShader: DISC_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uRin:   { value: 3 }, uRout: { value: 90 }, uMdot: { value: 1 },
            uTime:  { value: 0 }, uBeta: { value: 0.46 },
            uFlare: { value: 0 }, uFlareAng: { value: 0 },
            uCamObj:{ value: new THREE.Vector2(0, 120) },
        },
    });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.scale.setScalar(90);
    rig.add(disc);

    // ── Parker spiral arms ───────────────────────────────────────────
    const spiralGroup = new THREE.Group();
    rig.add(spiralGroup);
    function buildSpirals() {
        while (spiralGroup.children.length) {
            const c = spiralGroup.children.pop();
            c.geometry.dispose(); c.material.dispose();
        }
        for (let arm = 0; arm < 5; arm++) {
            const geo = new THREE.TubeGeometry(parkerSpiralCurve(arm, params.vsw), 120, 0.42, 8, false);
            const mat = new THREE.MeshBasicMaterial({
                color: arm % 2 ? TOKENS.uv : TOKENS.indigo,
                transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending,
            });
            spiralGroup.add(new THREE.Mesh(geo, mat));
        }
    }
    buildSpirals();

    // ── Twistor flux ropes ───────────────────────────────────────────
    const twistGroup = new THREE.Group();
    rig.add(twistGroup);
    function buildTwistors() {
        while (twistGroup.children.length) {
            const c = twistGroup.children.pop();
            c.geometry.dispose(); c.material.dispose();
        }
        for (let i = 0; i < 4; i++) {
            const geo = new THREE.TubeGeometry(twistorCurve(i, params.twist), 110, 0.7, 8, false);
            const mat = new THREE.MeshBasicMaterial({
                color: i % 2 ? TOKENS.pink : TOKENS.arc,
                transparent: true, opacity: 0.42, blending: THREE.AdditiveBlending,
            });
            twistGroup.add(new THREE.Mesh(geo, mat));
        }
    }
    buildTwistors();

    // ── Depth starfield ──────────────────────────────────────────────
    {
        const N = 700, pos = new Float32Array(N * 3);
        for (let i = 0; i < N; i++) {
            const rr = 220 + Math.random() * 600;
            const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
            pos[i*3]   = rr * Math.sin(ph) * Math.cos(th);
            pos[i*3+1] = rr * Math.cos(ph) * 0.6;
            pos[i*3+2] = rr * Math.sin(ph) * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({
            color: 0xcfd8ff, size: 1.1, sizeAttenuation: false,
            transparent: true, opacity: 0.5,
        })));
    }

    // ── Geometry that depends on adjustable params ───────────────────
    function applyPhysics() {
        const rIsco = iscoRadius(params.spin);          // in r_g
        const rg = 2.4;                                  // visual r_g scale
        horizon.scale.setScalar(rg * 1.0);
        photon.scale.setScalar(rg * 2.6);
        const rin = rg * rIsco, rout = rg * 38;
        discMat.uniforms.uRin.value  = rin;
        discMat.uniforms.uRout.value = rout;
        discMat.uniforms.uMdot.value = params.mdot;
        discMat.uniforms.uBeta.value = 0.32 + 0.30 * params.spin;
        disc.scale.setScalar(rout);
    }
    applyPhysics();

    function applyView() {
        const inc = THREE.MathUtils.degToRad(params.incl);
        rig.rotation.set(0, 0, 0);
        rig.rotateX(-inc);
        const dist = 215;
        camera.position.set(0, dist * Math.sin(inc) + 14, dist * Math.cos(inc));
        camera.lookAt(0, 0, 0);
    }

    function resize() {
        const w = window.innerWidth, h = window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        applyView();
    }
    resize();
    window.addEventListener('resize', resize);

    // ── Flare (the "gamey" button): orbiting hot-spot + brightness pulse
    let flareEnergy = 0, flareAng = 0;
    function triggerFlare() {
        flareEnergy = 1;
        flareAng = Math.random() * Math.PI * 2;
        onInteract('flare');
    }

    // ── Render loop ──────────────────────────────────────────────────
    let raf = 0, running = true, t = 0;
    const camObj = new THREE.Vector3();
    function tick() {
        if (!running) return;
        t += 0.016;
        discMat.uniforms.uTime.value = t;

        flareEnergy *= 0.975;
        flareAng += 0.05;
        discMat.uniforms.uFlare.value = flareEnergy;
        discMat.uniforms.uFlareAng.value = flareAng;

        // Camera position in the disc's object plane (for beaming).
        camObj.copy(camera.position);
        disc.worldToLocal(camObj);
        discMat.uniforms.uCamObj.value.set(camObj.x, camObj.y);

        spiralGroup.rotation.y += 0.0016;            // source co-rotation
        twistGroup.rotation.y -= 0.0011;
        twistGroup.children.forEach((m, i) => { m.rotation.y = Math.sin(t * 0.5 + i) * 0.08; });
        photon.rotation.z += 0.004;

        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
    }

    function renderOnce() { renderer.render(scene, camera); }

    if (reduced) {
        running = false;
        renderOnce();
    } else {
        document.addEventListener('visibilitychange', () => {
            running = !document.hidden;
            if (running) { raf = requestAnimationFrame(tick); }
            else cancelAnimationFrame(raf);
        });
        raf = requestAnimationFrame(tick);
    }

    /* ── Controls panel ──────────────────────────────────────────────
       Styled with the design tokens; collapsible; emits onInteract so
       the A/B layer can measure engagement, not just conversion. */
    const panel = document.createElement('div');
    panel.setAttribute('aria-label', 'Accretion model controls');
    Object.assign(panel.style, {
        position: 'fixed', left: '20px', bottom: '20px', zIndex: '5',
        width: '232px', padding: '14px 16px 16px',
        background: 'rgba(7,2,26,.74)', backdropFilter: 'blur(10px)',
        border: '1px solid var(--border-2,#2a2050)', borderRadius: '14px',
        boxShadow: '0 0 36px rgba(157,58,255,.28)',
        font: "11px/1.4 var(--font-mono,'JetBrains Mono',monospace)",
        color: 'var(--fg-3,#a89dcc)', userSelect: 'none',
    });

    const row = (label, min, max, step, val, key, fmt) => {
        const wrap = document.createElement('label');
        wrap.style.cssText = 'display:block;margin:11px 0 0';
        const head = document.createElement('div');
        head.style.cssText = 'display:flex;justify-content:space-between;letter-spacing:.06em;text-transform:uppercase;color:var(--fg-4,#7a6f9c)';
        const name = document.createElement('span'); name.textContent = label;
        const out  = document.createElement('span');
        out.style.color = 'var(--lightning-arc,#8ff0ff)';
        out.textContent = fmt(val);
        head.append(name, out);
        const inp = document.createElement('input');
        inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = val;
        inp.style.cssText = 'width:100%;margin-top:6px;accent-color:#9d3aff;cursor:pointer;pointer-events:auto';
        let logged = false;
        inp.addEventListener('input', () => {
            params[key] = parseFloat(inp.value);
            out.textContent = fmt(params[key]);
            if (key === 'vsw') buildSpirals();
            else if (key === 'twist') buildTwistors();
            else if (key === 'incl') applyView();
            else applyPhysics();
            if (reduced) renderOnce();
            if (!logged) { logged = true; onInteract('slider_' + key); }
        });
        wrap.append(head, inp);
        return wrap;
    };

    const title = document.createElement('div');
    title.style.cssText = "font:700 10px/1 var(--font-display,'Orbitron',sans-serif);letter-spacing:.18em;text-transform:uppercase;color:var(--uv-300,#d29aff);display:flex;justify-content:space-between;align-items:center";
    const tlabel = document.createElement('span'); tlabel.textContent = 'Accretion model';
    const collapse = document.createElement('button');
    collapse.type = 'button'; collapse.textContent = '–';
    collapse.setAttribute('aria-label', 'Collapse controls');
    collapse.style.cssText = 'pointer-events:auto;cursor:pointer;background:none;border:none;color:inherit;font:inherit;padding:2px 6px';
    title.append(tlabel, collapse);

    const body = document.createElement('div');
    body.append(
        row('Spin a*',       0,    0.99, 0.01, params.spin,  'spin',  v => v.toFixed(2)),
        row('Accretion Ṁ',   0.2,  3,    0.05, params.mdot,  'mdot',  v => v.toFixed(2) + '×'),
        row('Inclination',   5,    85,   1,    params.incl,  'incl',  v => v.toFixed(0) + '°'),
        row('Wind V_sw',     250,  800,  10,   params.vsw,   'vsw',   v => v.toFixed(0) + ' km/s'),
        row('Twist',         0,    6,    0.1,  params.twist, 'twist', v => v.toFixed(1) + ' turns'),
    );
    const flareBtn = document.createElement('button');
    flareBtn.type = 'button'; flareBtn.textContent = '⚡ Trigger flare';
    flareBtn.style.cssText = "pointer-events:auto;cursor:pointer;margin-top:14px;width:100%;padding:9px;border-radius:8px;border:1px solid var(--border-uv,#7b3aff);background:linear-gradient(135deg,#9d3aff,#ff1f9c);color:#0a0420;font:700 10px/1 var(--font-display,'Orbitron',sans-serif);letter-spacing:.12em;text-transform:uppercase";
    flareBtn.addEventListener('click', triggerFlare);
    body.append(flareBtn);

    let open = window.innerWidth >= 760;        // collapsed by default on phones
    function syncOpen() {
        body.style.display = open ? 'block' : 'none';
        collapse.textContent = open ? '–' : '+';
    }
    collapse.addEventListener('click', () => { open = !open; syncOpen(); onInteract('panel_toggle'); });
    syncOpen();

    panel.append(title, body);
    document.body.appendChild(panel);

    /* ── Teardown ────────────────────────────────────────────────────*/
    function destroy() {
        running = false;
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', resize);
        scene.traverse(o => {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
            }
        });
        renderer.dispose();
        canvas.remove();
        panel.remove();
    }

    return {
        destroy,
        triggerFlare,
        set(key, value) {
            if (!(key in params)) return;
            params[key] = value;
            if (key === 'vsw') buildSpirals();
            else if (key === 'twist') buildTwistors();
            else if (key === 'incl') applyView();
            else applyPhysics();
            if (reduced) renderOnce();
        },
    };
}
