// js/eruption-scorecard.js
//
// Phase 2.4 — educational scorecard popup for manually-triggered prominence
// eruptions. Auto-flare-driven EPs run silently; only the "Erupt nearest
// filament" button surfaces this card, so the live data feed never spams
// the user.
//
// Sections:
//   1. Why it erupted   — kink twist Φ vs critical (Hood & Priest 1979),
//                         torus decay index n vs critical (Kliem & Török
//                         2006), free magnetic energy
//   2. Kinematics       — initial rise speed, asymptotic CME speed,
//                         estimated mass
//   3. Earth impact     — only when bundle is in the Earth-facing
//                         hemisphere; travel time, Bz orientation, peak
//                         Kp via simplified Newell coupling, aurora oval
//                         boundary, confidence
//   4. Counterfactual   — same physical eruption from the opposite
//                         geometry (the educational kicker — "geometry,
//                         not energy, decides")
//
// All metrics are computed from atlas meta + AR feed in pure JS — no
// extra WASM round-trips. Parameterisations are calibrated to give
// plausible values across the bundle population, not perfect physics.
// References are cited in the card footer.

const STORAGE_KEY  = 'prominence_eruption_log';
const MAX_LOG_ENTRIES = 5;

// ─── module-level state ─────────────────────────────────────────────
let _root = null;
let _autoDismissTimer = null;
let _delayTimer = null;

// ─── DOM scaffold (lazy, idempotent) ────────────────────────────────
function _ensureDom(parent = document.body) {
    if (_root) return _root;

    if (!document.getElementById('esc-styles')) {
        const style = document.createElement('style');
        style.id = 'esc-styles';
        style.textContent = `
        #eruption-scorecard {
            position: fixed; top: 80px; right: 0; width: 360px;
            transform: translateX(110%); pointer-events: none;
            transition: transform 320ms cubic-bezier(.2,.8,.2,1);
            z-index: 1000;
            font-family: -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        }
        #eruption-scorecard.visible { transform: translateX(0); pointer-events: auto; }
        #eruption-scorecard .esc-card {
            background: rgba(15, 12, 10, 0.97); color: #e8d6c4;
            border-left: 3px solid #ff5522;
            padding: 14px 16px;
            box-shadow: -8px 0 24px rgba(0,0,0,0.5);
        }
        #eruption-scorecard .esc-hdr {
            display: flex; justify-content: space-between; align-items: baseline;
            margin-bottom: 6px; padding-bottom: 8px;
            border-bottom: 1px solid #3a2820;
        }
        #eruption-scorecard .esc-title {
            font-size: 13px; font-weight: 600; color: #ffaa66;
            letter-spacing: 0.02em;
        }
        #eruption-scorecard .esc-loc {
            font-size: 10px; color: #888;
        }
        #eruption-scorecard .esc-close {
            background: transparent; border: 1px solid #3a2820; color: #888;
            cursor: pointer; padding: 1px 7px; font-size: 12px;
            line-height: 1; border-radius: 2px;
        }
        #eruption-scorecard .esc-close:hover { color: #fff; border-color: #888; }
        #eruption-scorecard .esc-section { margin: 10px 0; font-size: 11px; }
        #eruption-scorecard .esc-section-title {
            color: #ffaa66; font-weight: 600; font-size: 10px;
            text-transform: uppercase; letter-spacing: 0.06em;
            margin-bottom: 4px;
        }
        #eruption-scorecard .esc-driver {
            font-size: 12px; font-weight: 600; margin-bottom: 4px; color: #ff8855;
        }
        #eruption-scorecard table { width: 100%; font-size: 11px; border-collapse: collapse; }
        #eruption-scorecard td { padding: 1px 0; vertical-align: top; }
        #eruption-scorecard td.label { color: #888; }
        #eruption-scorecard td.label.dim { color: #555; padding-left: 8px; font-size: 10px; }
        #eruption-scorecard td.val { text-align: right; color: #e8d6c4; font-variant-numeric: tabular-nums; }
        #eruption-scorecard td.status { text-align: right; padding-left: 8px; white-space: nowrap; }
        #eruption-scorecard .stat-ok { color: #5fbf6f; }
        #eruption-scorecard .stat-warn { color: #ffaa55; }
        #eruption-scorecard .stat-crit { color: #ff5544; }
        #eruption-scorecard .esc-cf {
            margin-top: 8px; padding-top: 8px;
            border-top: 1px dashed #3a2820;
            color: #aaa; font-size: 11px; line-height: 1.45;
        }
        #eruption-scorecard .esc-cf b { color: #d8c4b0; }
        #eruption-scorecard .esc-ftr {
            margin-top: 12px; padding-top: 8px;
            border-top: 1px solid #3a2820;
            display: flex; justify-content: space-between; align-items: center; gap: 8px;
        }
        #eruption-scorecard .esc-save {
            background: #2a1a10; border: 1px solid #663322; color: #ffaa66;
            padding: 4px 10px; font-size: 11px; cursor: pointer; border-radius: 2px;
        }
        #eruption-scorecard .esc-save:hover { background: #3a2818; color: #fff; }
        #eruption-scorecard .esc-save.saved {
            background: #182a18; border-color: #2a663a; color: #5fbf6f;
        }
        #eruption-scorecard .esc-credits {
            font-size: 9px; color: #555; flex: 1; text-align: right; line-height: 1.3;
        }
        `;
        document.head.appendChild(style);
    }

    _root = document.createElement('div');
    _root.id = 'eruption-scorecard';
    _root.innerHTML = `
        <div class="esc-card">
            <div class="esc-hdr">
                <div>
                    <div class="esc-title">Eruption analysis</div>
                    <div class="esc-loc"></div>
                </div>
                <button class="esc-close" title="Dismiss">✕</button>
            </div>
            <div class="esc-body"></div>
            <div class="esc-ftr">
                <button class="esc-save">★ Save to log</button>
                <span class="esc-credits">
                    Kink: Hood &amp; Priest 1979 · Torus: Kliem &amp; Török 2006<br>
                    Coupling: Newell et al. 2007
                </span>
            </div>
        </div>
    `;
    parent.appendChild(_root);

    _root.querySelector('.esc-close').addEventListener('click', dismiss);
    _root.querySelector('.esc-save').addEventListener('click', _onSave);
    return _root;
}

// ─── public API ─────────────────────────────────────────────────────

/**
 * Show the scorecard with the given metrics. Idempotent — calling again
 * before dismissal replaces the contents.
 *
 * @param {object} metrics  — output of computeMetrics()
 * @param {object} [opts]
 *   delaySec      — show after N sim-seconds (default 0). Use ~5 to give
 *                   the impulsive-phase visual a chance to play first.
 *   simSpeed      — current simulation speed multiplier (so the delay
 *                   converts to wall-clock correctly). Default 1.
 *   autoDismissMs — auto-dismiss after this many ms of no interaction.
 *                   Default 30 000.
 */
export function show(metrics, opts = {}) {
    _ensureDom();

    const body = _root.querySelector('.esc-body');
    const loc  = _root.querySelector('.esc-loc');
    body.innerHTML = _renderBody(metrics);
    loc.textContent = `${_locStr(metrics.location)} · class ${metrics.bundleClassName}`;

    // Reset save button state.
    const saveBtn = _root.querySelector('.esc-save');
    saveBtn.classList.remove('saved');
    saveBtn.textContent = '★ Save to log';
    saveBtn.dataset.metrics = JSON.stringify(metrics);

    if (_delayTimer) { clearTimeout(_delayTimer); _delayTimer = null; }
    if (_autoDismissTimer) { clearTimeout(_autoDismissTimer); _autoDismissTimer = null; }

    const simSpeed = Math.max(0.1, opts.simSpeed ?? 1);
    const delayMs  = Math.max(0, (opts.delaySec ?? 0) * 1000 / simSpeed);
    _delayTimer = setTimeout(() => {
        _root.classList.add('visible');
        _autoDismissTimer = setTimeout(dismiss, opts.autoDismissMs ?? 30000);
    }, delayMs);
}

export function dismiss() {
    if (!_root) return;
    _root.classList.remove('visible');
    if (_autoDismissTimer) { clearTimeout(_autoDismissTimer); _autoDismissTimer = null; }
    if (_delayTimer)       { clearTimeout(_delayTimer);       _delayTimer       = null; }
}

/** Read the saved log (most recent first). Safe if storage is unavailable. */
export function readLog() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

/** Clear the log. */
export function clearLog() {
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// ─── Metrics computation ────────────────────────────────────────────
//
// All inputs come from the field-line atlas + live AR feed. Parameter
// choices: see comments alongside each calculation. Values are designed
// to be plausible across the typical bundle population, not exact.

const META_STRIDE = 8;
const R_SUN_CM    = 6.96e10;
const R_SUN_KM    = 6.96e5;
const AU_KM       = 1.496e8;
const PI_2_5      = 2.5 * Math.PI;        // critical kink twist (Hood & Priest)
const N_CRIT      = 1.5;                  // critical torus decay (Kliem & Török)
const PROM_DENSITY = 4e-15;               // g/cm³ — quiescent prominence

const CLASS_NAMES = ['QP','IP','ARP','HEDGEROW','TORNADO','EP','RAIN'];

/**
 * Compute the full metrics struct for one bundle.
 *
 * @param {object} atlas         — { lineCount, samplesPerLine, meta, positions }
 * @param {number} lineIdx       — atlas line index of the bundle parent
 * @param {object} bundle        — classifier output entry (for classId / params)
 * @param {Array}  liveRegions   — sun.html liveRegions (for AR area / mag class)
 */
export function computeMetrics({ atlas, lineIdx, bundle, liveRegions }) {
    const m0 = lineIdx * META_STRIDE;
    const apex   = atlas.meta[m0 + 3];        // R☉
    const length = atlas.meta[m0 + 4];        // R☉
    const lat    = atlas.meta[m0 + 5];        // rad
    const lon    = atlas.meta[m0 + 6];        // rad
    const twist  = atlas.meta[m0 + 7];        // rad
    const arIdx  = atlas.meta[m0 + 2] | 0;
    const ar     = (arIdx >= 0 && liveRegions[arIdx]) ? liveRegions[arIdx] : null;
    const arArea = ar ? Math.max(0.05, Math.min(1, (ar.area || 50) / 800)) : 0.10;

    // ── Why it erupted ─────────────────────────────────────────────
    const kinkExceeded = Math.abs(twist) > PI_2_5;

    // Decay index — calibrated for our buried-dipole field model. Real
    // PFSS gives n ~0.5–2.5 in active regions. Higher apex → faster
    // decay aloft → larger n.
    const apexMm = apex * R_SUN_KM / 1000;     // R☉ → Mm
    const decayIndex = clamp(0.6 + 0.020 * apexMm + 0.4 * arArea, 0.3, 2.8);
    const torusUnstable = decayIndex > N_CRIT;

    const driver = kinkExceeded ? 'kink'
                 : torusUnstable ? 'torus'
                 : 'loss-of-equilibrium';

    // Free magnetic energy = (B² / 8π) × V × free fraction (~10%)
    // B at apex (Gauss): typical AR loops 50–500 G; QP ~10 G.
    const bApexGauss = ar ? (50 + 450 * arArea) : 15;
    const rTubeCm    = (apex / 4) * R_SUN_CM;    // bundle radius proxy
    const lengthCm   = length * R_SUN_CM;
    const volCm3     = Math.PI * rTubeCm * rTubeCm * lengthCm;
    const freeEnergyErg = (bApexGauss * bApexGauss / (8 * Math.PI)) * volCm3 * 0.10;

    // ── Kinematics ─────────────────────────────────────────────────
    const initialSpeedKmS = 25 + 25 * arArea;    // 25–50 km/s
    // Asymptotic CME speed scales with apex × AR strength. QP eruptions
    // typically 200–600 km/s; ARP/Tornado eruptions 800–2400 km/s.
    const apexFactor = Math.min(1.5, apex / 0.10);
    const asymptoticSpeedKmS = 200 + 1800 * apexFactor * (0.4 + 0.6 * arArea);
    const massGrams = volCm3 * PROM_DENSITY;     // density × volume

    // ── Earth-impact geometry ──────────────────────────────────────
    // Sub-Earth point in our convention is (lat=0, lon=0). Bundle
    // longitude relative to that is lon (mod 2π). Earth-directed if
    // |lon| < 60° (the cone within which CMEs typically reach Earth).
    const lonDeg = (((lon * 180 / Math.PI) + 540) % 360) - 180;
    const latDeg = lat * 180 / Math.PI;
    const angFromCentreDeg = Math.sqrt(latDeg * latDeg + lonDeg * lonDeg);
    const earthFacing = Math.abs(lonDeg) < 60;
    const earthDirectedFrac = earthFacing
        ? clamp(1 - angFromCentreDeg / 80, 0, 1)
        : 0;

    // Travel time: 1 AU at asymptotic speed.
    const travelHours    = AU_KM / asymptoticSpeedKmS / 3600;
    const travelHoursUnc = travelHours * 0.15;   // ±15% — realistic for SEP forecasting

    // Bz orientation from rope chirality. Joy's-law-tilted ARs in the
    // northern hemisphere tend to produce southward Bz at Earth (more
    // geo-effective); southern hemisphere tends positive. Magnitude
    // scales with AR strength and CME speed.
    const bzNT = (latDeg >= 0 ? -1 : 1)
               * (5 + 25 * arArea + 0.008 * asymptoticSpeedKmS);

    // Newell coupling function (simplified): dΦ_MP/dt ∝ v^(4/3) × B_T^(2/3)
    // × sin^(8/3)(θ_C/2). For southward Bz, θ_C ≈ π so sin^(8/3) = 1.
    // For northward Bz the term collapses → quiet conditions.
    const bT       = Math.abs(bzNT);
    const couplingMul = bzNT < 0 ? 1.0 : 0.05;     // northward Bz is geo-ineffective
    const dPhi_dt = Math.pow(asymptoticSpeedKmS, 4/3) * Math.pow(bT, 2/3) * couplingMul;
    // Power-law Kp scaling (calibrated so v=500/Bz=-10 → Kp~2.5 sub-storm,
    // v=1000/Bz=-25 → Kp~5 G1, v=2000/Bz=-50 → Kp~8.5 G4).
    const peakKp   = clamp(7.5 * Math.pow(dPhi_dt / 250000, 0.40), 0, 9);

    // Aurora oval boundary — Feldstein parameterisation: Mlat ≈ 67° − 2 × Kp.
    const auroraOvalLatDeg = clamp(67 - peakKp * 2, 40, 75);

    const confidence = arArea > 0.4 ? 'medium' : 'low';

    // ── Counterfactual ─────────────────────────────────────────────
    // For a far-side eruption: "what if it had been at disk centre instead?"
    // For a disk-centre eruption: "what if it had been at the limb instead?"
    let cf;
    if (earthFacing) {
        cf = {
            label: 'Had this filament been on the far side',
            travelHours: null,
            peakKp: 0,
            auroraOvalLatDeg: null,
            sentence: 'Earth-directed <b>0%</b>. Predicted impact <b>none</b>. Same physical eruption — different geometry.',
        };
    } else {
        // Same energetics, recompute as if it were at disk centre.
        const cfBz  = (latDeg >= 0 ? -1 : 1) * (5 + 25 * arArea + 0.008 * asymptoticSpeedKmS);
        const cfMul = cfBz < 0 ? 1.0 : 0.05;
        const cfDPhi = Math.pow(asymptoticSpeedKmS, 4/3) * Math.pow(Math.abs(cfBz), 2/3) * cfMul;
        const cfKp   = clamp(7.5 * Math.pow(cfDPhi / 250000, 0.40), 0, 9);
        cf = {
            label: 'Had this same eruption originated near disk centre',
            travelHours,
            peakKp: cfKp,
            auroraOvalLatDeg: clamp(67 - cfKp * 2, 40, 75),
            sentence:
                `Travel time <b>${travelHours.toFixed(0)} hr</b>, predicted Kp <b>${cfKp.toFixed(1)}</b>, ` +
                `aurora reaches <b>~${(67 - cfKp * 2).toFixed(0)}° mlat</b>. Geometry — not energy — decides.`,
        };
    }

    return {
        // why it erupted
        driver, twistRad: twist, twistCrit: PI_2_5,
        kinkExceeded, decayIndex, decayCrit: N_CRIT, torusUnstable,
        bApexGauss, freeEnergyErg,
        // kinematics
        initialSpeedKmS, asymptoticSpeedKmS, massGrams,
        // earth impact
        earthFacing, earthDirectedFrac, subBundleLonDeg: lonDeg,
        travelHours, travelHoursUnc, bzNT, peakKp, auroraOvalLatDeg, confidence,
        // counterfactual
        cf,
        // metadata
        location: { latDeg, lonDeg },
        bundleClassId:   bundle?.classId ?? -1,
        bundleClassName: CLASS_NAMES[bundle?.classId ?? 0] || 'unknown',
        timestamp: Date.now(),
        lineIdx,
    };
}

// ─── rendering ──────────────────────────────────────────────────────

function _renderBody(m) {
    const driverLabel = m.driver === 'kink'  ? 'Kink-driven eruption'
                      : m.driver === 'torus' ? 'Torus-driven eruption'
                      :                        'Loss of equilibrium';

    let html = `
        <div class="esc-section">
            <div class="esc-section-title">Why it erupted</div>
            <div class="esc-driver">${driverLabel}</div>
            <table>
                <tr><td class="label">Magnetic twist Φ</td>
                    <td class="val">${m.twistRad.toFixed(2)} rad</td>
                    <td class="status">${_status(Math.abs(m.twistRad), m.twistCrit)}</td></tr>
                <tr><td class="label dim">— critical</td>
                    <td class="val">${m.twistCrit.toFixed(2)} rad</td><td></td></tr>
                <tr><td class="label">Torus decay index n</td>
                    <td class="val">${m.decayIndex.toFixed(2)}</td>
                    <td class="status">${_status(m.decayIndex, m.decayCrit)}</td></tr>
                <tr><td class="label dim">— critical</td>
                    <td class="val">${m.decayCrit.toFixed(2)}</td><td></td></tr>
                <tr><td class="label">Free magnetic energy</td>
                    <td class="val">${_fmtSci(m.freeEnergyErg)} erg</td><td></td></tr>
            </table>
        </div>

        <div class="esc-section">
            <div class="esc-section-title">Kinematics</div>
            <table>
                <tr><td class="label">Initial rise</td>
                    <td class="val">${m.initialSpeedKmS.toFixed(0)} km/s</td><td></td></tr>
                <tr><td class="label">Asymptotic CME speed</td>
                    <td class="val">${m.asymptoticSpeedKmS.toFixed(0)} km/s</td>
                    <td class="status">${_speedTag(m.asymptoticSpeedKmS)}</td></tr>
                <tr><td class="label">Estimated mass</td>
                    <td class="val">${_fmtSci(m.massGrams)} g</td><td></td></tr>
            </table>
        </div>
    `;

    if (m.earthFacing) {
        const stormName  = _stormClass(m.peakKp);
        const stormClass = m.peakKp >= 7 ? 'stat-crit' : m.peakKp >= 5 ? 'stat-warn' : 'stat-ok';
        const directedClass = m.earthDirectedFrac > 0.6 ? 'stat-warn' : 'stat-ok';
        html += `
            <div class="esc-section">
                <div class="esc-section-title">Earth impact forecast</div>
                <div class="esc-driver" style="color:#ffcc77">
                    Earth-directed: <span class="${directedClass}">${(m.earthDirectedFrac * 100).toFixed(0)}%</span>
                </div>
                <table>
                    <tr><td class="label">Travel time</td>
                        <td class="val">${m.travelHours.toFixed(0)} ± ${m.travelHoursUnc.toFixed(0)} hr</td><td></td></tr>
                    <tr><td class="label">Predicted Bz at Earth</td>
                        <td class="val">${m.bzNT.toFixed(0)} nT</td>
                        <td class="status">${m.bzNT < 0 ? '<span class="stat-warn">southward</span>' : '<span class="stat-ok">northward</span>'}</td></tr>
                    <tr><td class="label">Peak Kp</td>
                        <td class="val">${m.peakKp.toFixed(1)}</td>
                        <td class="status"><span class="${stormClass}">${stormName}</span></td></tr>
                    <tr><td class="label">Aurora reaches</td>
                        <td class="val">~${m.auroraOvalLatDeg.toFixed(0)}° mlat</td><td></td></tr>
                    <tr><td class="label">Confidence</td>
                        <td class="val" style="color:#888">${m.confidence}</td><td></td></tr>
                </table>
            </div>
        `;
    } else {
        html += `
            <div class="esc-section">
                <div class="esc-section-title">Earth impact forecast</div>
                <div style="color:#888;line-height:1.45">
                    Eruption from the <b>far side</b> (sub-bundle lon ${m.subBundleLonDeg.toFixed(0)}°).
                    Earth-directed <b>0%</b>. No geomagnetic impact expected.
                </div>
            </div>
        `;
    }

    html += `
        <div class="esc-cf">
            <div class="esc-section-title" style="color:#aaa">Counterfactual</div>
            <div><b>${m.cf.label}:</b> ${m.cf.sentence}</div>
        </div>
    `;
    return html;
}

function _status(val, crit) {
    return val > crit
        ? '<span class="stat-crit">⚠ exceeded</span>'
        : '<span class="stat-ok">✓ stable</span>';
}

function _speedTag(kmS) {
    if (kmS > 1500) return '<span class="stat-crit">very fast halo</span>';
    if (kmS > 1000) return '<span class="stat-warn">fast halo</span>';
    if (kmS > 500)  return '<span class="stat-ok">moderate</span>';
    return '';
}

function _stormClass(kp) {
    if (kp >= 9) return 'G5 extreme';
    if (kp >= 8) return 'G4 severe';
    if (kp >= 7) return 'G3 strong';
    if (kp >= 6) return 'G2 moderate';
    if (kp >= 5) return 'G1 minor';
    return 'sub-storm';
}

function _fmtSci(x, digits = 1) {
    if (!Number.isFinite(x) || x === 0) return '—';
    const e = Math.floor(Math.log10(Math.abs(x)));
    const c = x / Math.pow(10, e);
    return `${c.toFixed(digits)}×10<sup>${e}</sup>`;
}

function _locStr(loc) {
    if (!loc) return '';
    const ns = loc.latDeg >= 0 ? 'N' : 'S';
    const ew = loc.lonDeg >= 0 ? 'W' : 'E';
    const la = String(Math.round(Math.abs(loc.latDeg))).padStart(2, '0');
    const lo = String(Math.round(Math.abs(loc.lonDeg))).padStart(2, '0');
    return `${ns}${la}${ew}${lo}`;
}

function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

// ─── log persistence ────────────────────────────────────────────────

function _onSave(ev) {
    const btn = ev.currentTarget;
    if (btn.classList.contains('saved')) return;
    let metrics;
    try { metrics = JSON.parse(btn.dataset.metrics || 'null'); } catch { return; }
    if (!metrics) return;

    const log = readLog();
    log.unshift({
        at:        new Date(metrics.timestamp).toISOString(),
        location:  _locStr(metrics.location),
        driver:    metrics.driver,
        peakKp:    metrics.peakKp,
        speedKmS:  Math.round(metrics.asymptoticSpeedKmS),
        earthDirected: metrics.earthDirectedFrac > 0.5,
        bundleClassName: metrics.bundleClassName,
    });
    while (log.length > MAX_LOG_ENTRIES) log.pop();

    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(log)); } catch {}

    btn.classList.add('saved');
    btn.textContent = '✓ Saved';
}
