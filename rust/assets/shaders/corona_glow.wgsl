// Solar corona volumetric glow shader.
//
// Applied to a larger transparent sphere surrounding the star to simulate
// the million-degree solar corona visible during eclipses.
//
// Features:
//   • Radial 1/r² intensity falloff (Thomson scattering of photospheric light)
//   • Helmet streamers along the magnetic neutral line (equatorial belt)
//   • Polar coronal holes (darker, open-field regions)
//   • Eruption-triggered brightness enhancement (CME-driven)
//   • Multi-temperature false-color (EUV-inspired: Fe IX 171Å green,
//     Fe XII 195Å yellow, Fe XIV 211Å purple)
//   • Animated streamer sway from solar wind
//
// The corona mesh is a sphere at ~2.5× star radius with additive blending.

#import bevy_pbr::forward_io::VertexOutput

// ── Material uniforms ───────────────────────────────────────────────────────

struct CoronaUniforms {
    time:            f32,
    star_radius:     f32,
    corona_radius:   f32,
    activity_scale:  f32,
    // Eruption flash: (intensity, lat, lon, age_seconds)
    eruption:        vec4<f32>,
    // Wind speed scale (from NOAA, affects streamer animation)
    wind_scale:      f32,
    _pad0:           f32,
    _pad1:           f32,
    _pad2:           f32,
};

@group(2) @binding(0) var<uniform> material: CoronaUniforms;

// ── Noise ───────────────────────────────────────────────────────────────────

fn hash1(p: f32) -> f32 {
    var q = fract(p * 0.1031);
    q = q * (q + 33.33);
    return fract(q * (q + q));
}

fn hash3(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q = q + dot(q, q.yzx + 333.3456);
    return fract((q.x + q.y) * q.z);
}

fn noise3(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);

    let n000 = hash3(i);
    let n100 = hash3(i + vec3<f32>(1.0, 0.0, 0.0));
    let n010 = hash3(i + vec3<f32>(0.0, 1.0, 0.0));
    let n110 = hash3(i + vec3<f32>(1.0, 1.0, 0.0));
    let n001 = hash3(i + vec3<f32>(0.0, 0.0, 1.0));
    let n101 = hash3(i + vec3<f32>(1.0, 0.0, 1.0));
    let n011 = hash3(i + vec3<f32>(0.0, 1.0, 1.0));
    let n111 = hash3(i + vec3<f32>(1.0, 1.0, 1.0));

    return mix(
        mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
        mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
        u.z
    );
}

// ── Fragment shader ─────────────────────────────────────────────────────────

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let world_pos = in.world_position.xyz;
    let normal    = normalize(in.world_normal);
    let time      = material.time;
    let star_r    = material.star_radius;

    // Distance from star centre (world space).
    let dist = length(world_pos);
    let r_hat = world_pos / max(dist, 0.001);

    // Height above photosphere, normalised to corona extent.
    let height = (dist - star_r) / (material.corona_radius - star_r);
    if height < 0.0 || height > 1.0 {
        return vec4<f32>(0.0);
    }

    // ── 1. Radial falloff ───────────────────────────────────────────────────
    // Thomson-scattered K-corona: I ∝ 1/r² beyond ~1.2 R☉.
    let r_ratio     = dist / star_r;
    let radial_fall = 1.0 / (r_ratio * r_ratio);

    // Smooth fade at outer edge.
    let edge_fade = smoothstep(1.0, 0.7, height);

    // ── 2. Latitude structure ───────────────────────────────────────────────
    // Heliographic latitude from Y component.
    let sin_lat = clamp(r_hat.y, -1.0, 1.0);
    let abs_lat = abs(asin(sin_lat));

    // Polar coronal holes: darker above ±60° latitude.
    let polar_hole = smoothstep(0.9, 1.1, abs_lat);
    let hole_dim   = 1.0 - polar_hole * 0.7;

    // ── 3. Helmet streamers ─────────────────────────────────────────────────
    // Bright equatorial streamer belt at the heliospheric current sheet.
    // Modulated by longitude to create 2-4 discrete streamers.
    let equatorial = 1.0 - smoothstep(0.0, 0.5, abs_lat);
    let lon        = atan2(r_hat.z, r_hat.x);

    // Streamer angular pattern (2 primary + 2 secondary).
    let wind_drift = time * 0.08 * material.wind_scale;
    let streamer_2 = 0.5 + 0.5 * cos(2.0 * (lon - wind_drift));
    let streamer_4 = 0.3 + 0.3 * cos(4.0 * (lon - wind_drift * 0.7 + 1.2));
    let streamer   = (streamer_2 + streamer_4 * 0.4) * equatorial;

    // Streamers extend further out (radial elongation).
    let streamer_height = smoothstep(1.0, 0.3, height);
    let streamer_total  = streamer * streamer_height * 0.6;

    // ── 4. Fine coronal structure ───────────────────────────────────────────
    // Small-scale brightness variations (coronal loops, plumes).
    let fine = noise3(r_hat * 8.0 + vec3<f32>(time * 0.01, 0.0, time * 0.015));
    let fine_structure = 0.85 + 0.15 * fine;

    // ── 5. EUV false-color temperature mapping ──────────────────────────────
    // Inner corona (< 1.5 R☉): hot, ~2 MK → Fe XII 195Å (yellow-green)
    // Mid corona  (1.5–3 R☉): warm, ~1 MK → Fe IX 171Å (green)
    // Outer corona (> 3 R☉):  cool, ~0.8 MK → He II 304Å (red-orange)
    let temp_inner = vec3<f32>(0.85, 0.95, 0.55); // yellow-green (hot)
    let temp_mid   = vec3<f32>(0.45, 0.90, 0.50); // green (warm)
    let temp_outer = vec3<f32>(0.90, 0.50, 0.25); // orange (cool)

    var corona_color: vec3<f32>;
    if height < 0.3 {
        let t = height / 0.3;
        corona_color = mix(temp_inner, temp_mid, t);
    } else {
        let t = (height - 0.3) / 0.7;
        corona_color = mix(temp_mid, temp_outer, t);
    }

    // Streamers are hotter (whiter).
    corona_color = mix(corona_color, vec3<f32>(1.0, 0.95, 0.85), streamer_total * 0.5);

    // ── 6. Eruption flash ───────────────────────────────────────────────────
    let eruption_intensity = material.eruption.x;
    if eruption_intensity > 0.01 {
        let erupt_lat = material.eruption.y;
        let erupt_lon = material.eruption.z;
        let erupt_age = material.eruption.w;

        // Direction of eruption.
        let erupt_dir = vec3<f32>(
            cos(erupt_lat) * cos(erupt_lon),
            sin(erupt_lat),
            cos(erupt_lat) * sin(erupt_lon)
        );

        // Angular distance from eruption site.
        let erupt_angle = acos(clamp(dot(r_hat, erupt_dir), -1.0, 1.0));

        // CME shock front: expanding ring.
        let shock_radius = erupt_age * 0.4;  // expands over time
        let shock_width  = 0.15 + erupt_age * 0.05;
        let shock_ring   = smoothstep(shock_width, 0.0,
                                      abs(erupt_angle - shock_radius));

        // Brightness boost behind the shock (CME body).
        let behind_shock = smoothstep(shock_radius, 0.0, erupt_angle);

        let erupt_fade = exp(-erupt_age * 0.3) * eruption_intensity;

        // Bright white shock + warm CME body.
        corona_color += vec3<f32>(1.0, 1.0, 0.95) * shock_ring * erupt_fade * 4.0;
        corona_color += vec3<f32>(0.9, 0.7, 0.3) * behind_shock * erupt_fade * 0.5;
    }

    // ── 7. Compose ──────────────────────────────────────────────────────────
    let intensity = radial_fall * edge_fade * hole_dim * fine_structure
                  * (0.4 + streamer_total);

    // Activity-modulated brightness.
    let activity_boost = 0.8 + material.activity_scale * 0.4;
    let final_intensity = intensity * activity_boost;

    // Alpha fades with height for smooth blending.
    let alpha = final_intensity * smoothstep(1.0, 0.0, height * height);

    // HDR output (bloom picks up values > 1.0).
    let hdr_color = corona_color * final_intensity * 1.8;

    return vec4<f32>(hdr_color, clamp(alpha * 0.6, 0.0, 0.85));
}
