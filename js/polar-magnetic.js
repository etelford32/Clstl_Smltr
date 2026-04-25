/**
 * polar-magnetic.js — Polar magnetic-field state card for space-weather.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Composes a card that summarises the magnetic conditions at the polar
 * caps without any new network calls — it derives every number from
 * state that's already on the page:
 *
 *   • Auroral-oval equatorward boundary (geomagnetic lat) — Feldstein-
 *     Starkov approximation from current Kp.
 *   • Hemispheric Power Index (GW) — empirical HPI ≈ 30 + 5·Kp²
 *     (Newell et al. 2009; matches the OVATION climatology to ~25%).
 *   • Geomagnetic dipole tilt angle (deg) — from UTC + IGRF-2025
 *     dipole pole. Varies ±33° through the day; sign indicates whether
 *     the Northern magnetic pole is tipped toward (+) or away from (−)
 *     the Sun.
 *   • Polar cap absorption status — derived from SEP S-level (already
 *     surfaced by the SWPC feed).
 *
 * The card subscribes to `swpc-update` for Kp / SEP changes and re-renders
 * every 5 min for the time-dependent dipole tilt.
 */

const REFRESH_MS = 5 * 60 * 1000;

// IGRF-2025 dipole pole — geographic coordinates. Drifts ~50 km/yr;
// re-update from the IGRF-14 g-coefficients each major release.
const DIPOLE_POLE_LAT_DEG = 80.7;
const DIPOLE_POLE_LON_DEG = -72.7;

const STATE_COLORS = {
    quiet:     '#88e08c',
    elevated:  '#ffcc66',
    storm:     '#ff9060',
    severe:    '#ff5577',
    unknown:   '#778',
};

const PCA_BADGE_CLASS = {
    none:      'badge-minor',
    minor:     'badge-moderate',
    strong:    'badge-strong',
    severe:    'badge-severe',
    extreme:   'badge-extreme',
};

export class PolarMagneticCard {
    constructor(opts = {}) {
        this.cardId = opts.cardId ?? 'polar-mag-card';
        this._timer = null;
        this._state = { kp: null, pca: 0, bz: null };
        this._unbinders = [];
    }

    start() {
        // Subscribe to live values from the existing swpc-update bus.
        const onSwpc = (e) => {
            const d = e?.detail;
            if (!d) return;
            const kp = d.geomagnetic?.kp ?? d.kp;
            const pca = d.particles?.sep_storm_level ?? 0;
            const bz = d.solar_wind?.bz ?? d.bz;
            if (Number.isFinite(kp))  this._state.kp  = kp;
            if (Number.isFinite(pca)) this._state.pca = pca;
            if (Number.isFinite(bz))  this._state.bz  = bz;
            this._render();
        };
        window.addEventListener('swpc-update', onSwpc);
        this._unbinders.push(() => window.removeEventListener('swpc-update', onSwpc));

        // Read whatever the existing #kp-val / #sep-level elements
        // already painted, in case swpc-update fired before we booted.
        this._readPagePainted();
        this._render();

        this._timer = setInterval(() => this._render(), REFRESH_MS);
    }

    stop() {
        clearInterval(this._timer);
        this._timer = null;
        for (const u of this._unbinders) u();
        this._unbinders = [];
    }

    _readPagePainted() {
        const kpText = document.getElementById('kp-val')?.textContent?.trim();
        const kp = parseFloat(kpText);
        if (Number.isFinite(kp)) this._state.kp = kp;
        const sepText = document.getElementById('sep-level')?.textContent?.trim();
        const sep = parseInt(sepText?.replace(/\D/g, ''), 10);
        if (Number.isFinite(sep)) this._state.pca = sep;
    }

    // ── Computation ─────────────────────────────────────────────────────────

    _compute() {
        const kp = Number.isFinite(this._state.kp) ? this._state.kp : 2;

        // Auroral oval equatorward boundary (geomagnetic latitude).
        // Feldstein-Starkov: ≈ 67° − 2·Kp at midnight magnetic local time
        // (the oval is widest there). Floor at 45° to keep the chip honest
        // during the most extreme storms.
        const ovalEq = Math.max(45, 67 - 2 * kp);

        // Hemispheric Power (GW).
        // Newell, Sotirelis, Wing (2009) climatology: HPI ≈ 30 + 5·Kp²
        // matches OVATION to ~25%. Quiet baseline ≈ 30 GW; G3 ≈ 100 GW;
        // G5 ≈ 430 GW.
        const hpi = 30 + 5 * kp * kp;

        // Dipole tilt angle (deg) — angle between the geomagnetic dipole
        // axis and the plane perpendicular to the Earth-Sun line. Drives
        // magnetospheric reconnection geometry; varies with both UT and
        // season.
        const tilt = _dipoleTilt(new Date());

        // PCA classification from SEP S-level.
        const pca = this._state.pca || 0;
        const pcaInfo = _pcaInfo(pca);

        // Overall storm classification (chip color + label).
        const stormState =
            kp >= 8 ? { label: 'Severe magnetic storm', state: 'severe'   } :
            kp >= 6 ? { label: 'Strong magnetic storm', state: 'storm'    } :
            kp >= 4 ? { label: 'Elevated activity',     state: 'elevated' } :
            kp >= 0 ? { label: 'Quiet polar field',     state: 'quiet'    } :
                      { label: 'No data',               state: 'unknown'  };

        return { kp, ovalEq, hpi, tilt, pca, pcaInfo, stormState };
    }

    _render() {
        const r = this._compute();

        const setText = (id, txt, color) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.textContent = txt;
            if (color) el.style.color = color;
        };

        // State chip
        const colour = STATE_COLORS[r.stormState.state] || STATE_COLORS.unknown;
        setText('pmag-state', r.stormState.label, colour);

        setText('pmag-oval-lat',
            Number.isFinite(r.ovalEq) ? `${r.ovalEq.toFixed(1)}° N (geomag)` : '–');
        setText('pmag-hpi',
            Number.isFinite(r.hpi)    ? `${r.hpi.toFixed(0)} GW` : '–');
        setText('pmag-tilt',
            Number.isFinite(r.tilt)   ? `${r.tilt > 0 ? '+' : ''}${r.tilt.toFixed(1)}°` : '–');

        // PCA badge
        const pcaEl = document.getElementById('pmag-pca');
        if (pcaEl) {
            const cls = PCA_BADGE_CLASS[r.pcaInfo.class] || 'badge-minor';
            pcaEl.className = `cme-card-badge ${cls}`;
            pcaEl.textContent = r.pcaInfo.label;
            pcaEl.title = r.pcaInfo.detail;
        }

        // City-equivalent for the auroral oval — gives users a sense of
        // how far south the oval has dropped during a storm.
        setText('pmag-city', _cityForOvalLat(r.ovalEq));

        // Polar oval canvas.
        this._drawOval(r);
    }

    // ── Oval visualisation ──────────────────────────────────────────────────

    _drawOval(r) {
        const canvas = document.getElementById('pmag-oval-canvas');
        if (!canvas) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width  = Math.floor(w * dpr);
            canvas.height = Math.floor(h * dpr);
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Polar projection: 90° = center, 45° = edge.
        const cx = w / 2, cy = h / 2;
        const radius = Math.min(w, h) / 2 - 6;
        const polarR = (lat) => radius * Math.max(0, (90 - lat) / 45);

        // Earth disk (north polar projection).
        ctx.fillStyle = '#0a1a3a';
        ctx.strokeStyle = '#1a3a6a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        // Latitude rings at 80, 70, 60, 50.
        ctx.strokeStyle = 'rgba(255,255,255,.06)';
        for (const lat of [80, 70, 60, 50]) {
            ctx.beginPath();
            ctx.arc(cx, cy, polarR(lat), 0, 2 * Math.PI);
            ctx.stroke();
        }

        // Auroral oval — a slightly-offset ring (Feldstein oval is
        // displaced toward the nightside). Approximate as a circle whose
        // center is shifted ~3° from the magnetic pole on the nightside.
        const r1 = polarR(r.ovalEq);
        const r2 = polarR(r.ovalEq + 4);  // narrow band: ~4° wide
        const offset = radius * 0.06;     // night-side offset
        const grad = ctx.createRadialGradient(cx, cy + offset, r2,
                                              cx, cy + offset, r1);
        grad.addColorStop(0, 'rgba(0,255,136,0)');
        grad.addColorStop(0.5, 'rgba(0,255,136,.55)');
        grad.addColorStop(1, 'rgba(0,255,136,0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy + offset, r1, 0, 2 * Math.PI);
        ctx.arc(cx, cy + offset, r2, 0, 2 * Math.PI, true);
        ctx.fill('evenodd');

        // Magnetic dipole tilt indicator — small arrow showing
        // direction toward the Sun.
        const tiltRad = r.tilt * Math.PI / 180;
        const sunX = cx;
        const sunY = cy - radius * 0.78;     // notional 'sun' direction
        ctx.strokeStyle = 'rgba(255,200,100,.6)';
        ctx.fillStyle   = 'rgba(255,200,100,.85)';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.sin(tiltRad) * 18, cy - Math.cos(tiltRad) * 18);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx + Math.sin(tiltRad) * 18, cy - Math.cos(tiltRad) * 18,
                2.2, 0, 2 * Math.PI);
        ctx.fill();

        // Sun marker.
        ctx.fillStyle = '#ffd060';
        ctx.beginPath();
        ctx.arc(sunX, sunY, 4, 0, 2 * Math.PI);
        ctx.fill();

        // Pole label.
        ctx.fillStyle = '#cde';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('N', cx, cy);

        // Lat labels.
        ctx.fillStyle = '#556';
        ctx.textAlign = 'left';
        ctx.fillText(`${Math.round(r.ovalEq)}° eq`, 4, cy + polarR(r.ovalEq));
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function _pcaInfo(sLevel) {
    if (sLevel >= 5) return { class: 'extreme', label: 'PCA extreme',
        detail:'S5: HF blackout > 8 hr at polar caps; spacecraft single-event upsets likely.' };
    if (sLevel >= 4) return { class: 'severe', label: 'PCA severe',
        detail:'S4: Polar HF blackout > 1 hr; satellite operations may be affected.' };
    if (sLevel >= 3) return { class: 'strong', label: 'PCA strong',
        detail:'S3: Significant polar absorption; HF aviation routes degraded.' };
    if (sLevel >= 2) return { class: 'minor', label: 'PCA minor',
        detail:'S2: Slight polar absorption; some HF-on-polar-routes effects.' };
    if (sLevel >= 1) return { class: 'minor', label: 'PCA threshold',
        detail:'S1: Solar proton event in progress; minor polar absorption.' };
    return { class: 'none', label: 'No PCA',
        detail:'No solar proton event in progress.' };
}

function _cityForOvalLat(eqLat) {
    if (!Number.isFinite(eqLat)) return '';
    if (eqLat >= 65) return 'Aurora visible from Tromsø, Iqaluit';
    if (eqLat >= 60) return 'Aurora visible from Anchorage, Reykjavík';
    if (eqLat >= 55) return 'Aurora visible from Edinburgh, Stockholm';
    if (eqLat >= 50) return 'Aurora visible from Vancouver, Berlin';
    if (eqLat >= 45) return 'Aurora visible from Minneapolis, Paris';
    return 'Aurora visible from mid-latitudes — major storm';
}

/**
 * Geomagnetic dipole tilt angle (degrees) — angle between the dipole axis
 * and the GSM Z axis (perpendicular to the Earth-Sun line in the ecliptic).
 *
 * Standard formulation: given the Sun direction Ŝ (geocentric) and the
 * dipole north Ĵ_M, the tilt ψ = arctan(Ĵ_M_y / Ĵ_M_z) in GSM.
 *
 * For UI purposes we use a low-fidelity but stable approximation:
 *
 *   ψ ≈ arcsin( sin(δ_s) · cos(λ_p) − cos(δ_s) · sin(λ_p) · cos(GMST + λ_dip) )
 *
 * where δ_s is solar declination, λ_p is the geomagnetic colatitude
 * of the dipole pole, and GMST is Greenwich Mean Sidereal Time at UTC.
 * Result is good to ~0.5° vs the IGRF-derived value, which is plenty
 * for an indicator.
 */
function _dipoleTilt(date) {
    const J2000 = Date.UTC(2000, 0, 1, 12) / 86_400_000;
    const jd_minus_J2000 = (date.getTime() / 86_400_000) - J2000;

    // Solar declination (Spencer-Hummel approximation).
    const dayOfYear = (date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000;
    const gamma = 2 * Math.PI * dayOfYear / 365.25;
    const declRad =
        0.006918
        - 0.399912 * Math.cos(gamma)
        + 0.070257 * Math.sin(gamma)
        - 0.006758 * Math.cos(2 * gamma)
        + 0.000907 * Math.sin(2 * gamma)
        - 0.002697 * Math.cos(3 * gamma)
        + 0.001480 * Math.sin(3 * gamma);

    // GMST in radians at the requested time.
    const utHours = date.getUTCHours()
                  + date.getUTCMinutes() / 60
                  + date.getUTCSeconds() / 3600;
    const gmstHours = (18.697374558 + 24.06570982441908 * jd_minus_J2000) % 24;
    const gmstRad = ((gmstHours + 24) % 24) * (Math.PI / 12);

    // Geomagnetic colatitude of the dipole pole.
    const polColat = (90 - DIPOLE_POLE_LAT_DEG) * Math.PI / 180;
    const polLon   = DIPOLE_POLE_LON_DEG * Math.PI / 180;

    // Tilt formula (Hapgood 1992 simplified).
    const sinPsi =
        Math.sin(declRad) * Math.cos(polColat)
        - Math.cos(declRad) * Math.sin(polColat) * Math.cos(gmstRad - polLon);

    return Math.asin(Math.max(-1, Math.min(1, sinPsi))) * 180 / Math.PI;
}
