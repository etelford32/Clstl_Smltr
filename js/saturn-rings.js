/**
 * saturn-rings.js — Saturn's ring system: named components + the moon
 * resonances that sculpt them.
 *
 * The ring is the star of saturn-system.html, so this module is the single
 * source of truth for:
 *   1. SATURN_RINGS   — the named radial components (D, C, B, Cassini
 *                       Division, A with its Encke/Keeler gaps, F, G, E),
 *                       in units of Saturn's equatorial radius R_S.
 *   2. RING_RESONANCES — the discrete features that the moons carve or raise:
 *                       gap-clearing embedded moonlets (Pan/Daphnis), the
 *                       Mimas 2:1 inner Lindblad resonance that defines the
 *                       sharp B-ring outer edge + the Cassini Division, and a
 *                       few of the strong spiral density waves (Janus, Mimas,
 *                       Prometheus, Pandora). Both the 3D ring shader and the
 *                       2D ring-map / profile plots read this list, so the
 *                       wave packets in the render sit exactly where the
 *                       moons' resonances are.
 *   3. ringBrightness/ringColor — JS mirror of the GLSL radial profile so the
 *                       2D plots match the rendered ring.
 *
 * ── Data quality ──────────────────────────────────────────────────────────
 *   Radii are mean values from the standard ring nomenclature (NASA PDS Ring-
 *   Moon Systems Node; French et al. 1993; Colwell et al. 2009). Optical
 *   depths here are *visual* (clamped/eased for legibility) — the real B-ring
 *   τ saturates above ~2.5 and the C-ring/Cassini τ is ~0.05–0.1. The wave
 *   amplitudes in the renderer are exaggerated so the spiral trains read on a
 *   laptop screen; their *radii and pattern speeds* are physical.
 */

// Saturn equatorial radius — the natural length unit for the ring scene.
export const R_SATURN_KM = 60268;
const RS = R_SATURN_KM;

// Convenience: km → R_S.
const rs = km => km / RS;

// ── Named ring components ───────────────────────────────────────────────
// [inner_RS, outer_RS, color(hex), peakTau(visual 0..1), label, note]
export const SATURN_RINGS = [
    { key:'D', inner:rs(66900),  outer:rs(74510),  color:0x6b6258, tau:0.06,
      label:'D ring',  note:'Innermost, very faint — fades into the upper atmosphere.' },
    { key:'C', inner:rs(74658),  outer:rs(92000),  color:0x8a8073, tau:0.16,
      label:'C ring',  note:'“Crepe ring” — translucent, grey, holds the Titan & Maxwell ringlets.' },
    { key:'B', inner:rs(92000),  outer:rs(117580), color:0xd8c69a, tau:0.95,
      label:'B ring',  note:'The bright, dense main ring. Outer edge is held by Mimas 2:1.' },
    { key:'CD',inner:rs(117580), outer:rs(122170), color:0x6e6353, tau:0.10,
      label:'Cassini Division', note:'A 4,800 km gap opened at the Mimas 2:1 resonance — not empty, just sparse.' },
    { key:'A', inner:rs(122170), outer:rs(136775), color:0xc9b488, tau:0.55,
      label:'A ring',  note:'Threaded with spiral density waves; carries the Encke & Keeler gaps.' },
    { key:'F', inner:rs(140180), outer:rs(140400), color:0xeae2d2, tau:0.70,
      label:'F ring',  note:'A narrow, kinked, braided ringlet shepherded by Prometheus & Pandora.' },
    { key:'G', inner:rs(166000), outer:rs(175000), color:0x5d5a52, tau:0.04,
      label:'G ring',  note:'Faint dusty ring fed by a small source population near Aegaeon.' },
    { key:'E', inner:rs(180000), outer:rs(480000), color:0x3a4a52, tau:0.02,
      label:'E ring',  note:'Broad, diffuse, blue — continuously resupplied by Enceladus’ south-polar plumes.' },
];

// Sharp gaps cut *inside* a ring (subtracted from the profile). [center_RS, halfWidth_RS]
// Real widths are tiny (Keeler ~35 km); widened visually so they read.
export const RING_GAPS = [
    { key:'encke',  center:rs(133589), half:rs(160), label:'Encke Gap',  by:'Pan' },
    { key:'keeler', center:rs(136505), half:rs(60),  label:'Keeler Gap', by:'Daphnis' },
    { key:'maxwell',center:rs(87500),  half:rs(135), label:'Maxwell Gap',by:'(C-ring ringlet)' },
];

// ── Resonance features the moons impose on the rings ─────────────────────
// type: 'edge'  → an m-lobed sharp edge that co-rotates with the perturber
//       'wave'  → a spiral density-wave train propagating outward from r
//       'gap'   → an embedded moonlet clearing a gap (scalloped edges)
//   r_RS       resonance radius (R_S)
//   m          azimuthal wavenumber (number of spiral arms / edge lobes)
//   perturber  moon key whose mean motion sets the pattern speed
//   amp        visual amplitude (0..1)
export const RING_RESONANCES = [
    { key:'mimas21',  r:rs(117580), m:2, perturber:'mimas',      type:'edge', amp:0.9,
      label:'Mimas 2:1', desc:'Inner Lindblad resonance: the sharp B-ring outer edge + the Cassini Division.' },
    { key:'janus21',  r:rs(96248),  m:2, perturber:'janus',      type:'wave', amp:0.5,
      label:'Janus 2:1', desc:'Strong density wave train in the outer B ring.' },
    { key:'mimas53',  r:rs(131902), m:3, perturber:'mimas',      type:'wave', amp:0.45,
      label:'Mimas 5:3', desc:'Bright density + bending wave in the A ring.' },
    { key:'janus76',  r:rs(136770), m:7, perturber:'janus',      type:'edge', amp:0.5,
      label:'Janus 7:6', desc:'Holds the sharp outer edge of the A ring.' },
    { key:'prom',     r:rs(128000), m:5, perturber:'prometheus', type:'wave', amp:0.3,
      label:'Prometheus waves', desc:'Closely-spaced density waves through the A ring.' },
    { key:'encke',    r:rs(133589), m:1, perturber:'pan',        type:'gap',  amp:1.0,
      label:'Encke Gap', desc:'Pan orbits inside it, raising scalloped wakes on both edges.' },
    { key:'keeler',   r:rs(136505), m:1, perturber:'daphnis',    type:'gap',  amp:1.0,
      label:'Keeler Gap', desc:'Daphnis raises vertical edge waves you can see at equinox.' },
];

// ── Selectable ring "features" for the body picker / element table ───────
// Lets the user click a ring component and read its radii, width, and what
// clears it — keeping the focus on the ring even in the elements panel.
export const RING_FEATURES = SATURN_RINGS.map(r => ({
    key:'ring_' + r.key,
    name: r.label,
    isRing: true,
    inner_km: r.inner * RS,
    outer_km: r.outer * RS,
    color: r.color,
    note: r.note,
}));

// ── Radial brightness/colour profile (JS mirror of the GLSL) ─────────────
// r is in R_S. Returns a visual optical-depth proxy in [0, ~1].
function band(r, a, b, edge) {
    const lo = smoothstep(a - edge, a + edge, r);
    const hi = 1 - smoothstep(b - edge, b + edge, r);
    return lo * hi;
}
function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

export function ringBrightness(r) {
    let tau = 0;
    for (const seg of SATURN_RINGS) {
        if (seg.key === 'E' || seg.key === 'G') continue;   // too faint to plot meaningfully
        tau += band(r, seg.inner, seg.outer, 0.004) * seg.tau;
    }
    // B ring is not flat — add interior structure.
    tau += band(r, rs(99000), rs(104500), 0.01) * 0.18 * band(r, 1.52, 1.96, 0.02);
    // Subtract the sharp gaps.
    for (const g of RING_GAPS) {
        const d = Math.abs(r - g.center);
        tau *= (d < g.half) ? smoothstep(0, g.half, d) * 0.15 : 1.0;
    }
    return Math.max(0, Math.min(1, tau));
}

// Composition tint per radius (matches the renderer's region colours).
export function ringColor(r) {
    // Return [r,g,b] 0..1.
    if (r < 1.236) return [0.42, 0.39, 0.35];   // D
    if (r < 1.527) return [0.54, 0.50, 0.45];   // C — grey
    if (r < 1.951) return [0.85, 0.77, 0.60];   // B — cream/tan
    if (r < 2.027) return [0.43, 0.39, 0.33];   // Cassini
    if (r < 2.269) return [0.79, 0.71, 0.53];   // A — sandy
    if (r < 2.40)  return [0.92, 0.88, 0.80];   // F — icy
    return [0.30, 0.36, 0.40];                  // G/E — bluish
}

export const RING_INNER_RS = rs(66900);
export const RING_OUTER_RS  = rs(140400);   // out to the F ring (E/G drawn faint separately)
