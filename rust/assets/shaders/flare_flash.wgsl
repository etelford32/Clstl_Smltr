// Solar flare / CME shockwave effect shader.
//
// Applied to a billboard quad or expanding sphere mesh at the eruption site.
// Renders the dramatic visual signature of a solar eruption:
//
//   • Expanding CME shock front (bright white ring)
//   • Post-flare arcade glow (hot loops reforming after reconnection)
//   • EUV dimming behind the eruption (coronal mass loss)
//   • Two-ribbon flare footpoints
//
// The effect is short-lived (< 10 seconds simulation time) and fades
// exponentially after the initial flash.

#import bevy_pbr::forward_io::VertexOutput

// ── Material uniforms ───────────────────────────────────────────────────────

struct FlareUniforms {
    time:            f32,
    // Eruption properties.
    start_time:      f32,
    intensity:       f32, // 0–1 for C, ~1 for M, ~3+ for X
    // Eruption location (heliographic lat, lon).
    latitude:        f32,
    longitude:       f32,
    // Shock expansion speed (world units / second).
    expansion_speed: f32,
    // Phase: 0 = impulsive, 1 = gradual, 2 = decay.
    _pad0:           f32,
    _pad1:           f32,
};

@group(2) @binding(0) var<uniform> material: FlareUniforms;

// ── Helpers ─────────────────────────────────────────────────────────────────

fn hash1(p: f32) -> f32 {
    var q = fract(p * 0.1031);
    q = q * (q + 33.33);
    return fract(q * q);
}

// ── Fragment shader ─────────────────────────────────────────────────────────

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let world_pos = in.world_position.xyz;
    let normal    = normalize(in.world_normal);
    let dist      = length(world_pos);
    let r_hat     = world_pos / max(dist, 0.001);

    // Time since eruption.
    let age = material.time - material.start_time;
    if age < 0.0 || age > 15.0 {
        return vec4<f32>(0.0, 0.0, 0.0, 0.0);
    }

    let intensity = material.intensity;

    // ── Eruption direction ──────────────────────────────────────────────────
    let e_lat = material.latitude;
    let e_lon = material.longitude;
    let erupt_dir = normalize(vec3<f32>(
        cos(e_lat) * cos(e_lon),
        sin(e_lat),
        cos(e_lat) * sin(e_lon)
    ));

    // Angular distance from eruption axis.
    let cos_theta = dot(r_hat, erupt_dir);
    let theta     = acos(clamp(cos_theta, -1.0, 1.0));

    // ── Phase-dependent effects ─────────────────────────────────────────────

    // Phase 1: Impulsive (0–2s) — bright flash at footpoints.
    let impulsive_fade = exp(-age * 1.5);

    // Phase 2: CME shock (1–8s) — expanding bright ring.
    let shock_radius = age * material.expansion_speed * 0.15;
    let shock_width  = 0.08 + age * 0.02;
    let shock_dist   = abs(theta - shock_radius);
    let shock_ring   = smoothstep(shock_width, 0.0, shock_dist);
    let shock_fade   = exp(-age * 0.25);

    // Phase 3: Post-flare loops (2–12s) — warm glow at eruption site.
    let pfl_age  = max(0.0, age - 1.5);
    let pfl_rise = smoothstep(0.0, 2.0, pfl_age);
    let pfl_fade = exp(-pfl_age * 0.2);
    let pfl_radius = 0.2 * intensity;
    let pfl_glow   = smoothstep(pfl_radius, 0.0, theta) * pfl_rise * pfl_fade;

    // ── Color mixing ────────────────────────────────────────────────────────

    // Impulsive flash: brilliant white-blue (hard X-ray / EUV).
    let flash_color = vec3<f32>(0.85, 0.92, 1.0);
    let flash_zone  = smoothstep(0.3, 0.0, theta);
    let flash        = flash_zone * impulsive_fade * intensity;

    // Shock front: bright white with slight yellow tinge.
    let shock_color = vec3<f32>(1.0, 0.95, 0.85);
    let shock       = shock_ring * shock_fade * intensity * 0.8;

    // Post-flare arcade: warm orange-red (cooling plasma).
    let pfl_color = vec3<f32>(1.0, 0.6, 0.2);
    let pfl       = pfl_glow * intensity * 0.5;

    // EUV dimming: dark region behind the shock (coronal evacuation).
    let dimming_zone = smoothstep(shock_radius * 1.2, shock_radius * 0.5, theta);
    let dimming      = dimming_zone * shock_fade * 0.15 * intensity;

    // ── Turbulent substructure ──────────────────────────────────────────────
    // Fine-scale turbulence in the shock front.
    let turb_phase = theta * 20.0 + age * 3.0;
    let turbulence = 0.8 + 0.2 * sin(turb_phase) * cos(turb_phase * 0.7 + 1.3);

    // ── Compose ─────────────────────────────────────────────────────────────
    var color = flash_color * flash
              + shock_color * shock * turbulence
              + pfl_color * pfl;

    // Subtract dimming.
    color = color * (1.0 - dimming);

    let total_intensity = flash + shock + pfl;
    let alpha = clamp(total_intensity * 0.7, 0.0, 0.8);

    // Only the flash impulse goes above bloom threshold; rest stays subtle.
    color *= 1.2;

    return vec4<f32>(color, alpha);
}
