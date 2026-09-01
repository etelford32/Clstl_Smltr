/**
 * sun-rope-overlay.js — the modeled CME / flux-rope TRANSIT overlay for
 * sun.html's 3D scene.
 *
 * What it draws, per rope of the published forecast train: an expanding
 * front cap at the ensemble's modeled apex distance (cone width = the
 * DONKI half-angle), two ghost caps at apex ±1σ (the kernel's own
 * sigmaApexKmAt — uncertainty drawn, never hidden), and a radial trail
 * from the 21.5 R☉ launch surface; plus Earth (⊕) on the Sun–Earth line
 * at 1 AU. Time comes from the caller each frame — the page passes the
 * scrubbed instant while scrubbing and the live clock at ● LIVE, so the
 * 7-day slider replays the whole transit.
 *
 * ARCHITECTURE RULES (the corridor's, applied here):
 *   · This module computes NO physics. Every position is a probe of the
 *     provider's LIVE kernel instance (apexKmAt / apexVKmsAt /
 *     sigmaApexKmAt) on the ONE published forecast
 *     (window.__fluxRopeForecast / 'flux-rope-forecast').
 *   · ROPES ARE BALLISTIC — the group is parented to the scene frame
 *     (Stonyhurst, Earth-line = +Z, the same frame the AR/hole markers
 *     use at their build instant) and NEVER co-rotates with the
 *     photosphere. Do not add it to the page's rotating-group list.
 *   · Radial compression is the ONE scale module's map —
 *     stage/scale.js stageRadius — linearly rescaled from stage units
 *     into this scene's units (a unit change, not a second compression
 *     law). The Sun is drawn enlarged relative to that map, and the
 *     on-canvas legend DISCLOSES both. True distances (AU) are printed
 *     in the legend, never scaled.
 *   · A dead/idle feed draws NOTHING (no fabricated rope) — the Sun
 *     Watch Forecast tab and its chips own saying why.
 *
 * Test hook: window.__sunRopes = { group, update, setVisible, state }.
 */

import { stageRadius, EARTH_S, AU_KM, RSUN_KM } from './stage/scale.js';

// 1 AU lands at 20 scene units (sun mesh = 1, camera maxDistance 60 — the
// whole corridor fits a modest zoom-out). Launch surface 21.5 R☉ ≈ 0.1 AU
// sits at the compression map's linear/log knee.
export const EARTH_SCENE_R = 20;
const LAUNCH_AU = 21.5 * RSUN_KM / AU_KM;
const PASSED_HIDE_AU = 1.2;      // beyond this the front has left the view
const ROPE_COLORS = [0xffb454, 0x4fc3f7, 0xc792ea, 0x7fe6c3, 0xff8866, 0xffd75e];
const LEGEND_MS = 600;           // legend text cadence (DOM writes, not probes)

/** Heliocentric r [AU] → scene units, through the ONE compression map. */
export function sceneRadius(rAu) {
    return stageRadius(rAu) / EARTH_S * EARTH_SCENE_R;
}

const CSS = `
.sro-legend {
    position:absolute; right:12px; bottom:14px; z-index:56;
    background:rgba(3,5,12,.8); backdrop-filter:blur(8px);
    border:1px solid rgba(120,170,255,.28); border-radius:9px;
    padding:7px 10px 8px; font:10px/1.55 system-ui,-apple-system,sans-serif;
    color:#cfd6e6; max-width:252px; pointer-events:none;
}
.sro-legend .sro-hd { font-weight:700; letter-spacing:.1em; font-size:9.5px;
    color:#9fc0ff; margin-bottom:2px; }
.sro-legend .sro-row { display:flex; align-items:baseline; gap:6px; }
.sro-legend .sro-chip { width:8px; height:8px; border-radius:2px; flex:0 0 auto;
    transform:translateY(1px); }
.sro-legend .sro-note { color:#77809a; font-size:9px; margin-top:3px; line-height:1.45; }
@media (max-width:768px) { .sro-legend { display:none; } }
`;

export function initSunRopeOverlay({ THREE, scene, host } = {}) {
    if (!THREE || !scene) return null;

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const legend = document.createElement('div');
    legend.className = 'sro-legend';
    legend.id = 'sun-rope-legend';
    legend.style.display = 'none';
    (host ?? document.body).appendChild(legend);

    const group = new THREE.Group();
    group.name = 'cme-train-overlay';
    scene.add(group);

    // ── Earth assembly (built once; shown while a forecast is live) ─────
    const earth = new THREE.Group();
    {
        const ball = new THREE.Mesh(
            new THREE.SphereGeometry(0.3, 24, 16),
            new THREE.MeshBasicMaterial({ color: 0x4fa0ff }));
        const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.55, 0.022, 8, 48),
            new THREE.MeshBasicMaterial({
                color: 0x7fb8ff, transparent: true, opacity: 0.65, depthWrite: false,
            }));
        earth.add(ball, ring);
        earth.position.set(0, 0, sceneRadius(1));
        // Sun→Earth guide line, so the corridor reads even with no rope out.
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 1.05), new THREE.Vector3(0, 0, sceneRadius(1)),
        ]);
        const line = new THREE.Line(lineGeom, new THREE.LineBasicMaterial({
            color: 0x4fa0ff, transparent: true, opacity: 0.18, depthWrite: false,
        }));
        group.add(earth, line);
    }

    // ── State ────────────────────────────────────────────────────────────
    let fc = null;               // the published live forecast (or null)
    let ropes = [];              // per-rope { root, cap, ghostLo, ghostHi, trail, color, cme, rope }
    let userVisible = true;
    let lastLegendAt = 0;
    let lastTMs = NaN;

    function disposeRopes() {
        for (const r of ropes) {
            group.remove(r.root);
            r.root.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
        }
        ropes = [];
    }

    function applyVisibility() {
        group.visible = userVisible && !!fc;
        legend.style.display = group.visible && ropes.length ? '' : 'none';
    }

    /** Stonyhurst (lat, lon W-positive) → scene direction — the exact
     *  buildRegionMarkers() frame, so a rope leaves from over its AR. */
    function dirOf(latDeg, lonDeg) {
        const lat = latDeg * Math.PI / 180, lon = lonDeg * Math.PI / 180;
        return new THREE.Vector3(
            Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon));
    }

    function rebuild(nextFc) {
        disposeRopes();
        fc = nextFc && !nextFc.idle && !nextFc.failed && nextFc.kernel ? nextFc : null;
        if (fc) {
            const up = new THREE.Vector3(0, 1, 0);
            fc.preset.ropes.forEach((rope, i) => {
                const color = ROPE_COLORS[i % ROPE_COLORS.length];
                const half = Math.max(10, Math.min(75,
                    fc.cmes[i]?.halfAngleDeg ?? 30)) * Math.PI / 180;
                const capGeom = new THREE.SphereGeometry(1, 48, 18, 0, Math.PI * 2, 0, half);
                const capMat = (opacity) => new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity, side: THREE.DoubleSide,
                    depthWrite: false, blending: THREE.AdditiveBlending,
                });
                const cap = new THREE.Mesh(capGeom, capMat(0.32));
                const ghostLo = new THREE.Mesh(capGeom, capMat(0.09));
                const ghostHi = new THREE.Mesh(capGeom, capMat(0.09));
                const trailGeom = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, sceneRadius(LAUNCH_AU), 0),
                    new THREE.Vector3(0, sceneRadius(LAUNCH_AU), 0),
                ]);
                const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({
                    color, transparent: true, opacity: 0.4, depthWrite: false,
                }));
                const root = new THREE.Group();
                root.quaternion.setFromUnitVectors(up, dirOf(rope.latDeg, rope.lonDeg));
                root.visible = false;
                root.add(cap, ghostLo, ghostHi, trail);
                group.add(root);
                ropes.push({ root, cap, ghostLo, ghostHi, trail, color, rope, cme: fc.cmes[i] });
            });
        }
        lastTMs = NaN;          // force a reposition on the next frame
        lastLegendAt = 0;
        applyVisibility();
    }

    window.addEventListener('flux-rope-forecast', (ev) => rebuild(ev.detail), { passive: true });
    if (window.__fluxRopeForecast) rebuild(window.__fluxRopeForecast);

    /** Per-frame: place every launched rope at its modeled apex at `tMs`. */
    function update(tMs) {
        if (!group.visible || !fc || !Number.isFinite(tMs)) return;
        if (tMs === lastTMs && performance.now() - lastLegendAt < LEGEND_MS) return;
        lastTMs = tMs;
        const tS = (tMs - fc.launchMs) / 1000;
        const rows = [];
        for (let i = 0; i < ropes.length; i++) {
            const r = ropes[i];
            const launched = tS > (r.rope.launchOffsetS ?? 0);
            if (!launched) {
                r.root.visible = false;
                rows.push({ r, txt: `launches ${fmtUtc(fc.launchMs + (r.rope.launchOffsetS ?? 0) * 1000)}Z` });
                continue;
            }
            const apexAu = fc.kernel.apexKmAt(i, tS) / AU_KM;
            if (apexAu >= PASSED_HIDE_AU) {
                r.root.visible = false;
                rows.push({ r, txt: 'passed L1' });
                continue;
            }
            const sigmaAu = fc.kernel.sigmaApexKmAt(i, tS) / AU_KM;
            const s = Math.max(sceneRadius(LAUNCH_AU), sceneRadius(apexAu));
            r.root.visible = true;
            r.cap.scale.setScalar(s);
            r.ghostLo.scale.setScalar(Math.max(sceneRadius(LAUNCH_AU), sceneRadius(apexAu - sigmaAu)));
            r.ghostHi.scale.setScalar(sceneRadius(apexAu + sigmaAu));
            // Past 1 AU the front fades out instead of lying about a
            // still-inbound cloud.
            const fade = apexAu <= 1 ? 1 : Math.max(0, 1 - (apexAu - 1) / (PASSED_HIDE_AU - 1));
            r.cap.material.opacity = 0.32 * fade;
            r.ghostLo.material.opacity = r.ghostHi.material.opacity = 0.09 * fade;
            r.trail.material.opacity = 0.4 * fade;
            const pos = r.trail.geometry.attributes.position;
            pos.setY(1, s);
            pos.needsUpdate = true;
            rows.push({
                r,
                txt: `apex ${apexAu.toFixed(2)} AU · ${Math.round(fc.kernel.apexVKmsAt(i, tS))} km/s`,
            });
        }
        const now = performance.now();
        if (now - lastLegendAt >= LEGEND_MS) {
            lastLegendAt = now;
            renderLegend(rows, tMs);
        }
    }

    function fmtUtc(ms) {
        return new Date(ms).toISOString().slice(5, 16).replace('T', ' ');
    }

    function renderLegend(rows, tMs) {
        const chips = rows.map(({ r, txt }, i) => {
            const hex = '#' + r.color.toString(16).padStart(6, '0');
            const launchMs = r.cme?.timeIso ? Date.parse(r.cme.timeIso)
                : fc.launchMs + (r.rope.launchOffsetS ?? 0) * 1000;
            return `<div class="sro-row"><span class="sro-chip" style="background:${hex}"></span>
                R${i} · ${fmtUtc(launchMs)}Z
                · ${Math.round(r.cme?.speedKms ?? r.rope.v0Kms)} km/s → ${txt}</div>`;
        }).join('');
        legend.innerHTML = `
            <div class="sro-hd">CME TRAIN · MODELED TRANSIT</div>
            ${chips}
            <div class="sro-note">Fronts at ensemble apex (ghosts ±1σ) · cone = DONKI
            half-angle · ⊕ Earth at 1 AU · t = ${fmtUtc(tMs)}Z<br>
            Radial scale compressed (Stage map); Sun drawn enlarged — AU readouts
            are true. Ropes are ballistic: they do not co-rotate.</div>`;
    }

    const handle = {
        group,
        update,
        setVisible(v) { userVisible = !!v; applyVisibility(); },
        get state() {
            return { live: !!fc, ropeCount: ropes.length, userVisible, groupVisible: group.visible };
        },
        dispose() { disposeRopes(); scene.remove(group); legend.remove(); },
    };
    window.__sunRopes = handle;
    return handle;
}
