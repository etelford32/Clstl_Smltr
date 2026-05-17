/**
 * hero-constellation.js — 3D operational-constellation hero
 *
 * A WebGL scene that replaces the accretion-disc hero with something
 * directly on-message for "storm-resilient LEO drag forecasting": a dark
 * Earth orbited by the real operational satellite constellations
 * (Starlink, OneWeb, Iridium, the GNSS fleets …) propagated from the
 * shared catalog in constellation-catalog.js — same Walker-Delta shells
 * the rest of the product reasons about, not decorative dots.
 *
 * It is a single A/B variant of `hero_bg`, mounted only when assigned.
 *
 * Design intent vs. the old accretion variant:
 *   • CONTRAST — the scene is a dark Earth + sparse points (not a
 *     full-screen additive glow), it is pushed to the right so the
 *     headline column stays clear, and a left-edge scrim guarantees the
 *     intro copy always has a dark backing. The text reads cleanly.
 *   • ON-BRAND — the "gamey" control is a geomagnetic storm: it swells
 *     the thermosphere and visibly drags the low LEO shells down,
 *     dramatising the exact failure mode the product forecasts.
 *
 * The physics, intentionally first-order:
 *   • Circular orbits (e≈0): u(t) = u₀ + n·t,  n = 2π / period
 *   • Walker shells from the catalog (i / RAAN / altitude per plane)
 *   • Radial map exaggerates the LEO band for legibility, compresses MEO
 *   • Storm drag ∝ (how low the shell is): Δr = −S · k_drag,
 *     k_drag = clamp((900−alt_km)/900, 0, 1), S an easing storm envelope
 *
 * Performance / safety: caps DPR, pauses on hidden tab, renders one
 * static frame under prefers-reduced-motion, fully disposes on
 * destroy(). mount() throws if WebGL is unavailable so the caller can
 * fall back to the particle field.
 *
 *   import { mountHeroConstellation } from './js/hero-constellation.js';
 *   const h = mountHeroConstellation({ reduced:false, onInteract(name){…} });
 *   // … later
 *   h.destroy();
 */

import * as THREE from './vendor/three-0.160.0/three.module.js';
import { CONSTELLATIONS, spawnConstellationPositions } from './constellation-catalog.js';

const TOKENS = {
    uv:   0x9d3aff,
    pink: 0xff1f9c,
    arc:  0x8ff0ff,
    warn: 0xffd23f,        // storm / drag tint
};

const DEFAULTS = {
    warp: 120,             // time-warp ×  (orbit speed)
    drag: 1.0,             // storm-drag sensitivity multiplier
    meo:  false,           // include the MEO GNSS fleets (true scale dwarfs LEO)
};

const EARTH_R = 26;        // Earth radius in scene units

/* Earth = 1 R⊕. LEO band stretched so 400–1400 km is legible; the MEO
   GNSS belt at ~20 000 km is log-compressed so it stays on screen. */
function visualRadius(altKm) {
    if (altKm <= 2000) return EARTH_R * (1 + (altKm / 2000) * 0.95);
    return EARTH_R * (1.95 + (Math.log10(altKm) - Math.log10(2000)) * 0.95);
}

/* ── Atmosphere / thermosphere Fresnel rim ──────────────────────────── */

const RIM_VERT = /* glsl */`
  varying vec3 vN;
  varying vec3 vView;
  void main(){
    vN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position,1.0);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;
const RIM_FRAG = /* glsl */`
  precision highp float;
  varying vec3 vN;
  varying vec3 vView;
  uniform vec3 uColor;
  uniform float uPower, uIntensity;
  void main(){
    float f = pow(1.0 - max(dot(vN, vView), 0.0), uPower);
    gl_FragColor = vec4(uColor * f * uIntensity, f);
  }
`;

export function mountHeroConstellation({ reduced = false, onInteract = () => {} } = {}) {
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
    const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.1, 4000);
    const world  = new THREE.Group();           // slow auto-spin lives here
    scene.add(world);

    const params = { ...DEFAULTS };

    // ── Soft key light so the globe reads as a sphere ────────────────
    scene.add(new THREE.AmbientLight(0x223052, 1.0));
    const key = new THREE.DirectionalLight(0x9fb6ff, 1.15);
    key.position.set(-1, 0.55, 0.7);
    scene.add(key);

    // ── Earth ────────────────────────────────────────────────────────
    const earth = new THREE.Mesh(
        new THREE.SphereGeometry(EARTH_R, 64, 48),
        new THREE.MeshStandardMaterial({
            color: 0x0c1730, emissive: 0x040a18, roughness: 1, metalness: 0,
        }),
    );
    world.add(earth);

    // Lat/long graticule — the "technical globe" read, kept faint.
    {
        const pts = [];
        const seg = 96;
        for (let k = 1; k < 6; k++) {                       // parallels
            const lat = (k / 6 - 0.5) * Math.PI;
            const ry = Math.sin(lat) * EARTH_R;
            const rr = Math.cos(lat) * EARTH_R;
            for (let s = 0; s < seg; s++) {
                const a = (s / seg) * Math.PI * 2, b = ((s + 1) / seg) * Math.PI * 2;
                pts.push(rr*Math.cos(a)*1.002, ry*1.002, rr*Math.sin(a)*1.002);
                pts.push(rr*Math.cos(b)*1.002, ry*1.002, rr*Math.sin(b)*1.002);
            }
        }
        for (let m = 0; m < 12; m++) {                      // meridians
            const lon = (m / 12) * Math.PI * 2;
            for (let s = 0; s < seg; s++) {
                const a = (s / seg - 0.5) * Math.PI, b = ((s + 1) / seg - 0.5) * Math.PI;
                pts.push(Math.cos(a)*Math.cos(lon)*EARTH_R*1.002, Math.sin(a)*EARTH_R*1.002, Math.cos(a)*Math.sin(lon)*EARTH_R*1.002);
                pts.push(Math.cos(b)*Math.cos(lon)*EARTH_R*1.002, Math.sin(b)*EARTH_R*1.002, Math.cos(b)*Math.sin(lon)*EARTH_R*1.002);
            }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
        earth.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
            color: TOKENS.arc, transparent: true, opacity: 0.10,
        })));
    }

    // Atmosphere rim glow.
    const atmoMat = new THREE.ShaderMaterial({
        vertexShader: RIM_VERT, fragmentShader: RIM_FRAG,
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor:     { value: new THREE.Color(TOKENS.arc) },
            uPower:     { value: 3.2 },
            uIntensity: { value: 0.9 },
        },
    });
    const atmo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.045, 48, 32), atmoMat);
    world.add(atmo);

    // Thermosphere shell — normally invisible; swells amber during a storm.
    const thermoMat = new THREE.ShaderMaterial({
        vertexShader: RIM_VERT, fragmentShader: RIM_FRAG,
        transparent: true, side: THREE.BackSide, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: {
            uColor:     { value: new THREE.Color(TOKENS.warn) },
            uPower:     { value: 2.2 },
            uIntensity: { value: 0.0 },
        },
    });
    const thermo = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R * 1.08, 40, 28), thermoMat);
    world.add(thermo);

    // ── Constellations (real catalog, propagated) ────────────────────
    // One Points cloud + one node ring per constellation; per-sat orbit
    // params packed into typed arrays for a cheap per-frame update.
    const fleets = [];
    for (const c of CONSTELLATIONS) {
        const specs = spawnConstellationPositions(c);
        const N = specs.length;
        if (!N) continue;

        const baseR = new Float32Array(N);   // visual orbit radius
        const u0    = new Float32Array(N);    // arg-of-lat at t=0 (rad)
        const nrate = new Float32Array(N);    // mean motion (rad/s, real)
        const ci    = new Float32Array(N), si = new Float32Array(N);
        const cO    = new Float32Array(N), sO = new Float32Array(N);
        let lowAlt = 1e9;

        for (let j = 0; j < N; j++) {
            const o = specs[j].orbital;
            const i = THREE.MathUtils.degToRad(o.inclinationDeg);
            const Om = THREE.MathUtils.degToRad(o.raanDeg);
            baseR[j] = visualRadius(specs[j].altitudeKm);
            u0[j] = THREE.MathUtils.degToRad((o.meanAnomalyDeg0 + o.argPerigeeDeg) % 360);
            nrate[j] = (Math.PI * 2) / (o.periodMin * 60);
            ci[j] = Math.cos(i); si[j] = Math.sin(i);
            cO[j] = Math.cos(Om); sO[j] = Math.sin(Om);
            lowAlt = Math.min(lowAlt, specs[j].altitudeKm);
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
        const baseCol = new THREE.Color(c.color);
        const mat = new THREE.PointsMaterial({
            color: baseCol.clone(),
            size: c.meo ? 2.6 : 2.0,
            sizeAttenuation: true,
            transparent: true, opacity: 0.95,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        const points = new THREE.Points(geo, mat);
        points.frustumCulled = false;

        // One faint node ring at the primary shell to suggest the plane.
        const shell0 = c.shells[0];
        const ringR  = visualRadius(shell0.altKm);
        const ringPts = [];
        const inc0 = THREE.MathUtils.degToRad(shell0.inclDeg);
        for (let s = 0; s <= 128; s++) {
            const a = (s / 128) * Math.PI * 2;
            const x = ringR * Math.cos(a), y0 = ringR * Math.sin(a);
            ringPts.push(x, y0 * Math.cos(inc0), y0 * Math.sin(inc0));
        }
        const ringGeo = new THREE.BufferGeometry();
        ringGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ringPts), 3));
        const ring = new THREE.Line(ringGeo, new THREE.LineBasicMaterial({
            color: baseCol.clone(), transparent: true, opacity: 0.10,
            blending: THREE.AdditiveBlending,
        }));

        const visible = !c.meo;            // LEO on by default; MEO behind toggle
        points.visible = visible;
        ring.visible = visible;
        world.add(points);
        world.add(ring);

        // Drag sensitivity: lower shells bleed altitude fastest in a storm.
        const dragK = Math.max(0, Math.min(1, (900 - lowAlt) / 900));

        fleets.push({
            cat: c, N, baseR, u0, nrate, ci, si, cO, sO,
            points, ring, mat, baseCol, dragK, on: visible,
        });
    }

    // ── Depth starfield ──────────────────────────────────────────────
    {
        const M = 650, pos = new Float32Array(M * 3);
        for (let i = 0; i < M; i++) {
            const rr = 700 + Math.random() * 1800;
            const th = Math.random() * Math.PI * 2, ph = Math.acos(2 * Math.random() - 1);
            pos[i*3]   = rr * Math.sin(ph) * Math.cos(th);
            pos[i*3+1] = rr * Math.cos(ph);
            pos[i*3+2] = rr * Math.sin(ph) * Math.sin(th);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        scene.add(new THREE.Points(g, new THREE.PointsMaterial({
            color: 0xcfd8ff, size: 1.0, sizeAttenuation: false,
            transparent: true, opacity: 0.45,
        })));
    }

    // ── Camera + right-shift so the headline column stays clear ──────
    function applyView() {
        const w = window.innerWidth, h = window.innerHeight;
        camera.aspect = w / h;
        // Push the globe right of centre on wide screens (text is left);
        // centre it on narrow screens where the copy stacks full-width.
        const shift = w < 900 ? 0 : 0.42;
        camera.setViewOffset(w * (1 + shift), h, 0, 0, w, h);
        camera.updateProjectionMatrix();
    }
    camera.position.set(0, EARTH_R * 1.05, EARTH_R * 3.15);
    camera.lookAt(0, 0, 0);

    function resize() {
        renderer.setSize(window.innerWidth, window.innerHeight, false);
        applyView();
    }
    resize();
    window.addEventListener('resize', resize);

    // ── Left-edge scrim — guarantees the intro copy a dark backing ───
    const scrim = document.createElement('div');
    Object.assign(scrim.style, {
        position: 'fixed', inset: '0', zIndex: '0', pointerEvents: 'none',
        background: 'linear-gradient(100deg,' +
            'rgba(7,2,26,.88) 0%,rgba(7,2,26,.74) 32%,' +
            'rgba(7,2,26,.34) 56%,rgba(7,2,26,0) 78%)',
    });
    document.body.insertBefore(scrim, canvas.nextSibling);

    // ── Storm (the on-brand "gamey" control) ─────────────────────────
    let stormEnv = 0;
    function triggerStorm() {
        stormEnv = 1;
        onInteract('storm');
    }

    // ── Render loop ──────────────────────────────────────────────────
    let raf = 0, running = true, simT = 0;
    let last = performance.now();
    const _amber = new THREE.Color(TOKENS.warn);
    const _arc   = new THREE.Color(TOKENS.arc);

    function updateFleets() {
        for (const f of fleets) {
            if (!f.on) continue;
            const arr = f.points.geometry.attributes.position.array;
            const drop = stormEnv * f.dragK * params.drag * EARTH_R * 0.16;
            for (let j = 0; j < f.N; j++) {
                const R = f.baseR[j] - drop;
                const u = f.u0[j] + f.nrate[j] * simT;
                const x = R * Math.cos(u), yo = R * Math.sin(u);
                // incline about X, then rotate node about Y (polar axis up)
                const y1 = yo * f.ci[j], z1 = yo * f.si[j];
                arr[j*3]   = x * f.cO[j] + z1 * f.sO[j];
                arr[j*3+1] = y1;
                arr[j*3+2] = -x * f.sO[j] + z1 * f.cO[j];
            }
            f.points.geometry.attributes.position.needsUpdate = true;
            // Low shells flush amber while the storm is biting.
            const heat = Math.min(1, stormEnv * f.dragK * 1.4);
            f.mat.color.copy(f.baseCol).lerp(_amber, heat);
        }
    }

    function frame(now) {
        if (!running) return;
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        simT += dt * params.warp;

        stormEnv *= Math.pow(0.5, dt / 3.2);          // ~3 s half-life
        if (stormEnv < 1e-3) stormEnv = 0;

        updateFleets();
        thermoMat.uniforms.uIntensity.value = stormEnv * 1.6;
        thermo.scale.setScalar(1 + stormEnv * 0.10);
        atmoMat.uniforms.uColor.value.copy(_arc).lerp(_amber, stormEnv * 0.7);

        world.rotation.y += dt * 0.025;               // gentle globe spin
        earth.rotation.y += dt * 0.012;

        renderer.render(scene, camera);
        raf = requestAnimationFrame(frame);
    }

    function renderOnce() { updateFleets(); renderer.render(scene, camera); }

    if (reduced) {
        running = false;
        simT = 900;                                   // a frozen, populated sky
        renderOnce();
    } else {
        document.addEventListener('visibilitychange', () => {
            running = !document.hidden;
            if (running) { last = performance.now(); raf = requestAnimationFrame(frame); }
            else cancelAnimationFrame(raf);
        });
        raf = requestAnimationFrame(frame);
    }

    /* ── Controls panel ──────────────────────────────────────────────
       Same design-token styling / collapse / onInteract contract as the
       other hero variants, so the A/B layer measures engagement. */
    const panel = document.createElement('div');
    panel.setAttribute('aria-label', 'Constellation model controls');
    Object.assign(panel.style, {
        position: 'fixed', left: '20px', bottom: '20px', zIndex: '5',
        width: '244px', padding: '14px 16px 16px',
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
            if (reduced) renderOnce();
            if (!logged) { logged = true; onInteract('slider_' + key); }
        });
        wrap.append(head, inp);
        return wrap;
    };

    const title = document.createElement('div');
    title.style.cssText = "font:700 10px/1 var(--font-display,'Orbitron',sans-serif);letter-spacing:.18em;text-transform:uppercase;color:var(--uv-300,#d29aff);display:flex;justify-content:space-between;align-items:center";
    const tlabel = document.createElement('span'); tlabel.textContent = 'Operational fleet';
    const collapse = document.createElement('button');
    collapse.type = 'button'; collapse.textContent = '–';
    collapse.setAttribute('aria-label', 'Collapse controls');
    collapse.style.cssText = 'pointer-events:auto;cursor:pointer;background:none;border:none;color:inherit;font:inherit;padding:2px 6px';
    title.append(tlabel, collapse);

    const body = document.createElement('div');

    const count = document.createElement('div');
    count.style.cssText = 'margin-top:9px;font-size:10px;letter-spacing:.05em;color:var(--fg-4,#7a6f9c);text-transform:uppercase';
    function refreshCount() {
        const tot = fleets.reduce((a, f) => a + (f.on ? f.cat.countActive : 0), 0);
        count.textContent = '~' + tot.toLocaleString() + ' active modeled';
    }
    refreshCount();
    body.append(count);

    body.append(
        row('Time warp',  0,   400, 5,    params.warp, 'warp', v => v.toFixed(0) + '×'),
        row('Storm drag', 0.2, 3,   0.05, params.drag, 'drag', v => v.toFixed(2) + '×'),
    );

    // Constellation legend — click to toggle a fleet in/out of the sky.
    const legend = document.createElement('div');
    legend.style.cssText = 'margin-top:13px;display:flex;flex-direction:column;gap:5px;max-height:168px;overflow:auto';
    let legendLogged = false;
    for (const f of fleets) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('aria-pressed', String(f.on));
        b.title = f.cat.summary;
        b.style.cssText = 'pointer-events:auto;cursor:pointer;display:flex;align-items:center;gap:8px;width:100%;padding:5px 7px;border-radius:7px;border:1px solid var(--border-2,#2a2050);background:none;color:inherit;font:inherit;text-align:left;transition:opacity .15s,border-color .15s';
        const sw = document.createElement('span');
        sw.style.cssText = `width:9px;height:9px;border-radius:50%;flex-shrink:0;background:${f.cat.color};box-shadow:0 0 7px ${f.cat.color}`;
        const nm = document.createElement('span');
        nm.style.cssText = 'flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
        nm.textContent = f.cat.name + (f.cat.meo ? ' · MEO' : '');
        b.append(sw, nm);
        const sync = () => {
            f.points.visible = f.ring.visible = f.on;
            b.style.opacity = f.on ? '1' : '0.4';
            b.setAttribute('aria-pressed', String(f.on));
        };
        sync();
        b.addEventListener('click', () => {
            f.on = !f.on;
            if (f.cat.meo) params.meo = fleets.some(x => x.cat.meo && x.on);
            sync();
            refreshCount();
            if (reduced) renderOnce();
            if (!legendLogged) { legendLogged = true; onInteract('legend_toggle'); }
        });
        legend.append(b);
    }
    body.append(legend);

    const stormBtn = document.createElement('button');
    stormBtn.type = 'button'; stormBtn.textContent = '⚡ Trigger geomagnetic storm';
    stormBtn.style.cssText = "pointer-events:auto;cursor:pointer;margin-top:14px;width:100%;padding:9px;border-radius:8px;border:1px solid var(--border-uv,#7b3aff);background:linear-gradient(135deg,#9d3aff,#ff1f9c);color:#0a0420;font:700 10px/1.3 var(--font-display,'Orbitron',sans-serif);letter-spacing:.10em;text-transform:uppercase";
    stormBtn.addEventListener('click', triggerStorm);
    body.append(stormBtn);

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
        scrim.remove();
        panel.remove();
    }

    return {
        destroy,
        triggerStorm,
        set(key, value) {
            if (!(key in params)) return;
            params[key] = value;
            if (reduced) renderOnce();
        },
    };
}
