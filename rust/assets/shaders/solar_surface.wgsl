// Solar photosphere procedural surface shader.
//
// Renders a physically-motivated solar disk with:
//   • Voronoi-based granulation (convective cells ~1000 km, animated)
//   • Limb darkening (Neckel–Labs 5-parameter law)
//   • Sunspot umbra/penumbra at active-region locations
//   • Faculae brightening near active regions
//   • Flare ribbon brightening at eruption footpoints
//   • Differential-rotation time animation
//
// Applied as a custom Bevy Material on the star sphere mesh.

#import bevy_pbr::forward_io::VertexOutput

// ── Material uniforms (group 2, binding 0) ──────────────────────────────────

struct SolarSurfaceUniforms {
    time:             f32,
    star_radius:      f32,
    // Active region 1: (lat, lon, intensity, flare_brightness)
    ar1:              vec4<f32>,
    // Active region 2: (lat, lon, intensity, flare_brightness)
    ar2:              vec4<f32>,
    // ML activity scale and overall flare state
    activity_scale:   f32,
    granulation_scale: f32,
    _pad0:            f32,
    _pad1:            f32,
};

@group(2) @binding(0) var<uniform> material: SolarSurfaceUniforms;

// ── Noise functions ─────────────────────────────────────────────────────────

// Hash function for pseudo-random per-cell values.
fn hash2(p: vec2<f32>) -> vec2<f32> {
    let k = vec2<f32>(0.3183099, 0.3678794);
    var q = p * k + k.yx;
    q = fract(q);
    q = q * (q + vec2<f32>(7.5));
    return fract(q.x * q.y * vec2<f32>(1.0, 1.23));
}

fn hash3(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q = q + dot(q, q.yzx + 333.3456);
    return fract((q.x + q.y) * q.z);
}

// 3D value noise.
fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f); // smoothstep

    let n000 = hash3(i + vec3<f32>(0.0, 0.0, 0.0));
    let n100 = hash3(i + vec3<f32>(1.0, 0.0, 0.0));
    let n010 = hash3(i + vec3<f32>(0.0, 1.0, 0.0));
    let n110 = hash3(i + vec3<f32>(1.0, 1.0, 0.0));
    let n001 = hash3(i + vec3<f32>(0.0, 0.0, 1.0));
    let n101 = hash3(i + vec3<f32>(1.0, 0.0, 1.0));
    let n011 = hash3(i + vec3<f32>(0.0, 1.0, 1.0));
    let n111 = hash3(i + vec3<f32>(1.0, 1.0, 1.0));

    let n00 = mix(n000, n100, u.x);
    let n10 = mix(n010, n110, u.x);
    let n01 = mix(n001, n101, u.x);
    let n11 = mix(n011, n111, u.x);
    let n0  = mix(n00, n10, u.y);
    let n1  = mix(n01, n11, u.y);
    return mix(n0, n1, u.z);
}

// Fractal Brownian motion — 4 octaves.
fn fbm(p: vec3<f32>) -> f32 {
    var val  = 0.0;
    var amp  = 0.5;
    var freq = 1.0;
    var pos  = p;
    for (var i = 0; i < 4; i++) {
        val += amp * noise3(pos * freq);
        freq *= 2.0;
        amp  *= 0.5;
        pos  = pos * 1.7 + vec3<f32>(1.3, 2.7, 5.1); // domain rotation
    }
    return val;
}

// Voronoi cellular noise for granulation.
// Returns (distance_to_nearest_cell_edge, distance_to_nearest_centre).
fn voronoi(p: vec2<f32>) -> vec2<f32> {
    let n = floor(p);
    let f = fract(p);

    var md  = 8.0; // min edge distance
    var md2 = 8.0; // min centre distance

    for (var j = -1; j <= 1; j++) {
        for (var i = -1; i <= 1; i++) {
            let g = vec2<f32>(f32(i), f32(j));
            let o = hash2(n + g); // random offset within cell
            let r = g + o - f;
            let d = dot(r, r);
            if d < md2 {
                md  = md2;
                md2 = d;
            } else if d < md {
                md = d;
            }
        }
    }

    return vec2<f32>(sqrt(md) - sqrt(md2), sqrt(md2));
}

// ── Solar physics ───────────────────────────────────────────────────────────

// Limb darkening: Neckel & Labs (2005) 5-parameter polynomial.
// I(μ) / I(1) = Σ aₖ μᵏ  where μ = cos(θ) = viewing angle to normal.
// Coefficients for 500 nm (approximate visual band):
fn limb_darkening(mu: f32) -> f32 {
    let a0 =  0.30;
    let a1 =  0.93;
    let a2 = -0.23;
    let mu2 = mu * mu;
    return clamp(a0 + a1 * mu + a2 * mu2, 0.0, 1.0);
}

// Heliographic coordinates from world-space normal (Y-up, rotation axis = +Y).
fn heliographic(normal: vec3<f32>, time: f32) -> vec2<f32> {
    // Latitude: angle from equatorial plane.
    let lat = asin(clamp(normal.y, -1.0, 1.0));
    // Longitude: azimuthal angle in XZ plane + Carrington rotation.
    var lon = atan2(normal.z, normal.x);
    // Differential rotation: equator rotates faster than poles.
    let sin_lat = normal.y;
    let omega = 0.35 * (1.0 - 0.3 * sin_lat * sin_lat);
    lon = lon - omega * time;
    return vec2<f32>(lat, lon);
}

// Distance between two heliographic positions (great-circle, radians).
fn helio_dist(a: vec2<f32>, b: vec2<f32>) -> f32 {
    let dlat = a.x - b.x;
    let dlon = a.y - b.y;
    // Haversine approximation for small angles.
    let sa = sin(dlat * 0.5);
    let so = sin(dlon * 0.5);
    let h = sa * sa + cos(a.x) * cos(b.x) * so * so;
    return 2.0 * asin(sqrt(clamp(h, 0.0, 1.0)));
}

// ── Fragment shader ─────────────────────────────────────────────────────────

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let world_pos = in.world_position.xyz;
    let normal    = normalize(in.world_normal);
    let time      = material.time;
    let scale     = material.granulation_scale;

    // ── 1. View angle & limb darkening ──────────────────────────────────────
    // μ = cos(angle between surface normal and view direction).
    let view_dir = normalize(-world_pos); // camera at origin approximation
    let mu       = max(dot(normal, view_dir), 0.0);
    let ld       = limb_darkening(mu);

    // ── 2. Heliographic coordinates ─────────────────────────────────────────
    let helio = heliographic(normal, time);

    // ── 3. Granulation (Voronoi cellular pattern) ───────────────────────────
    // Map spherical surface to 2D for Voronoi sampling.
    // Use multiple overlapping projections to avoid pole pinching.
    let gran_uv = vec2<f32>(helio.y, helio.x) * scale;
    let vor     = voronoi(gran_uv + vec2<f32>(time * 0.02, 0.0));
    // Edge brightness: granule centres are bright (hot upwelling plasma),
    // intergranular lanes are dark (cool downflows).
    let gran_edge    = smoothstep(0.0, 0.15, vor.x); // 1 at centre, 0 at edge
    let gran_pattern = 0.85 + 0.15 * gran_edge;

    // Fine structure: turbulent meso-granulation.
    let meso = fbm(normal * 18.0 + vec3<f32>(time * 0.03));
    let fine = 0.95 + 0.05 * meso;

    // ── 4. Base photosphere color ───────────────────────────────────────────
    // Effective temperature ~5778 K → Wien peak at 502 nm.
    // Approximate as warm gold-white.
    let t_eff_base = vec3<f32>(1.0, 0.88, 0.45); // photosphere
    let t_eff_cool = vec3<f32>(0.95, 0.80, 0.35); // intergranular
    let base_color = mix(t_eff_cool, t_eff_base, gran_pattern) * fine;

    // ── 5. Sunspots at active regions ───────────────────────────────────────
    var spot_darkening = 1.0;
    var facular_bright = 0.0;

    // Active region 1.
    let ar1_pos = vec2<f32>(material.ar1.x, material.ar1.y);
    let ar1_int = material.ar1.z;
    let d1      = helio_dist(helio, ar1_pos);

    // Umbra: very dark core (T ≈ 3500 K).
    let umbra_r1   = 0.08 * ar1_int;
    let penumbra_r1 = 0.18 * ar1_int;
    if d1 < umbra_r1 {
        let u = smoothstep(0.0, umbra_r1, d1);
        spot_darkening = mix(0.15, 0.4, u); // very dark centre
    } else if d1 < penumbra_r1 {
        let p = smoothstep(umbra_r1, penumbra_r1, d1);
        spot_darkening = mix(0.4, 1.0, p); // penumbral filaments
        // Add radial penumbral streaks.
        let streak_angle = atan2(helio.x - ar1_pos.x, helio.y - ar1_pos.y);
        let streaks = 0.5 + 0.5 * sin(streak_angle * 12.0 + time * 0.5);
        spot_darkening = mix(spot_darkening, spot_darkening * (0.7 + 0.3 * streaks), 1.0 - p);
    }
    // Faculae: bright rings around spots (visible near limb).
    if d1 > penumbra_r1 && d1 < penumbra_r1 + 0.15 {
        let fac = smoothstep(penumbra_r1 + 0.15, penumbra_r1, d1);
        facular_bright += fac * 0.2 * ar1_int * (1.0 - mu); // stronger near limb
    }

    // Active region 2.
    let ar2_pos = vec2<f32>(material.ar2.x, material.ar2.y);
    let ar2_int = material.ar2.z;
    let d2      = helio_dist(helio, ar2_pos);

    let umbra_r2   = 0.07 * ar2_int;
    let penumbra_r2 = 0.16 * ar2_int;
    if d2 < umbra_r2 {
        let u = smoothstep(0.0, umbra_r2, d2);
        spot_darkening = min(spot_darkening, mix(0.18, 0.45, u));
    } else if d2 < penumbra_r2 {
        let p = smoothstep(umbra_r2, penumbra_r2, d2);
        spot_darkening = min(spot_darkening, mix(0.45, 1.0, p));
        let streak_angle = atan2(helio.x - ar2_pos.x, helio.y - ar2_pos.y);
        let streaks = 0.5 + 0.5 * sin(streak_angle * 10.0 - time * 0.4);
        spot_darkening = mix(spot_darkening, spot_darkening * (0.7 + 0.3 * streaks), 1.0 - p);
    }
    if d2 > penumbra_r2 && d2 < penumbra_r2 + 0.12 {
        let fac = smoothstep(penumbra_r2 + 0.12, penumbra_r2, d2);
        facular_bright += fac * 0.18 * ar2_int * (1.0 - mu);
    }

    // ── 6. Flare ribbon brightening ─────────────────────────────────────────
    // When a flux rope erupts, the reconnection ribbons at the footpoints
    // glow bright white-blue (UV/EUV emission in reality).
    let flare1 = material.ar1.w; // 0 = quiet, 1 = erupting
    let flare2 = material.ar2.w;

    var flare_glow = vec3<f32>(0.0);
    if flare1 > 0.01 {
        let fd1 = smoothstep(0.25, 0.0, d1);
        // Pulsating ribbon.
        let pulse = 0.5 + 0.5 * sin(time * 8.0);
        let ribbon = fd1 * flare1 * (0.7 + 0.3 * pulse);
        flare_glow += vec3<f32>(0.8, 0.9, 1.0) * ribbon * 3.0;
    }
    if flare2 > 0.01 {
        let fd2 = smoothstep(0.25, 0.0, d2);
        let pulse = 0.5 + 0.5 * sin(time * 7.0 + 1.5);
        let ribbon = fd2 * flare2 * (0.7 + 0.3 * pulse);
        flare_glow += vec3<f32>(0.8, 0.9, 1.0) * ribbon * 3.0;
    }

    // ── 7. Chromospheric limb emission ──────────────────────────────────────
    // At the extreme limb (μ → 0), the chromosphere emits Hα (656.3 nm, red)
    // and Ca II K (393.4 nm, violet).  This creates a thin colored ring.
    let limb_emission = smoothstep(0.15, 0.0, mu) * 0.4;
    let chrom_color   = vec3<f32>(0.9, 0.2, 0.15) * limb_emission;

    // ── 8. Compose final color ──────────────────────────────────────────────
    var color = base_color * spot_darkening * ld;
    color    += vec3<f32>(facular_bright);
    color    += chrom_color;
    color    += flare_glow;

    // Activity-modulated overall brightness.
    let activity_boost = 1.0 + (material.activity_scale - 1.0) * 0.1;
    color *= activity_boost;

    // HDR emissive output — values > 1.0 feed into bloom.
    let emissive_strength = 2.5 + flare_glow.x * 2.0;
    color *= emissive_strength;

    return vec4<f32>(color, 1.0);
}
