// Solar MHD velocity-field compute shader.
//
// GPU equivalent of `simulation/fluid.rs :: velocity_at()`.
// Requires wgpu compute support — available on native (Vulkan / Metal / DX12)
// and WebGPU, but NOT on WebGL2.
//
// To activate (Phase 3):
//   1. Add a `FluidPipelinePlugin` to the render app.
//   2. Bind this shader to a `ComputePipelineDescriptor`.
//   3. Dispatch from a custom `RenderGraph` node each frame, writing into
//      a storage `Texture3d` that the particle material samples from.
//
// Workgroup layout: 8×8×4 threads (matches GRID_RES=16 with 2 tiles per axis).

// ── Bindings ─────────────────────────────────────────────────────────────────

struct Params {
    time:          f32,
    star_radius:   f32,
    domain_radius: f32,
    grid_res:      u32,
}

// Flat velocity buffer: vec4 (xyz = velocity, w = unused padding for alignment).
@group(0) @binding(0) var<storage, read_write> velocity_field: array<vec4<f32>>;
@group(0) @binding(1) var<uniform>             params: Params;

// ── Entry point ───────────────────────────────────────────────────────────────

@compute @workgroup_size(8, 8, 4)
fn update_field(@builtin(global_invocation_id) gid: vec3<u32>) {
    let R = params.grid_res;
    if gid.x >= R || gid.y >= R || gid.z >= R { return; }

    let cell_idx = gid.z * R * R + gid.y * R + gid.x;

    // Map grid index → world position in [-domain_radius, +domain_radius]³.
    let frac = (vec3<f32>(gid) / f32(R - 1u)) * 2.0 - 1.0;
    let pos  = frac * params.domain_radius;

    let vel = compute_velocity(pos);
    velocity_field[cell_idx] = vec4<f32>(vel, 0.0);
}

// ── Physics ───────────────────────────────────────────────────────────────────

fn compute_velocity(pos: vec3<f32>) -> vec3<f32> {
    let dist = length(pos);
    if dist < 0.01 { return vec3<f32>(0.0, 0.0, 0.0); }

    let r_hat    = pos / dist;
    let star_r   = params.star_radius;

    let wind = solar_wind(pos, r_hat, dist, star_r);
    let rot  = differential_rotation(pos, dist, star_r);
    let conv = supergranule_field(pos, r_hat, dist, star_r);

    // Damp inside the deep radiative interior (< 50 % of star radius).
    var damp = 1.0;
    if dist < star_r * 0.5 {
        let t = dist / (star_r * 0.5);
        damp = t * t;
    }

    return (wind + rot + conv) * damp;
}

// Radial outflow: zero beneath photosphere, √-ramp through the corona.
fn solar_wind(pos: vec3<f32>, r_hat: vec3<f32>, dist: f32, star_r: f32) -> vec3<f32> {
    if dist <= star_r { return vec3<f32>(0.0); }
    let frac = clamp((dist - star_r) / (params.domain_radius - star_r), 0.0, 1.0);
    return r_hat * 1.6 * sqrt(frac);
}

// Carrington differential rotation: Ω(λ) = Ω_eq × (1 − 0.3 sin²λ).
fn differential_rotation(pos: vec3<f32>, dist: f32, star_r: f32) -> vec3<f32> {
    let rho = sqrt(pos.x * pos.x + pos.z * pos.z);
    if rho < 0.01 { return vec3<f32>(0.0); }

    // φ̂ — azimuthal unit vector in the XZ plane.
    let phi_hat = vec3<f32>(-pos.z / rho, 0.0, pos.x / rho);

    let sin_lat = clamp(pos.y / dist, -1.0, 1.0);
    let omega   = 0.35 * (1.0 - 0.3 * sin_lat * sin_lat);
    let r_cyl   = min(rho, star_r); // cap at photosphere
    return phi_hat * omega * r_cyl;
}

// Eight convective supergranule plumes, parameterised by (lon₀, lat₀) seeds.
fn supergranule_field(
    pos:    vec3<f32>,
    r_hat:  vec3<f32>,
    dist:   f32,
    star_r: f32,
) -> vec3<f32> {
    let t = params.time;
    var total = vec3<f32>(0.0);

    // (lon0, lat0) seed pairs — must match fluid.rs SEEDS constant.
    let seeds = array<vec2<f32>, 8>(
        vec2<f32>(0.000,  0.000),
        vec2<f32>(0.785,  0.524),
        vec2<f32>(1.571, -0.524),
        vec2<f32>(2.356,  0.785),
        vec2<f32>(3.142,  0.000),
        vec2<f32>(3.927, -0.785),
        vec2<f32>(4.712,  0.524),
        vec2<f32>(5.498, -0.262),
    );

    for (var i = 0u; i < 8u; i++) {
        let lon = seeds[i].x + t * (0.08 + f32(i) * 0.012);
        let lat = seeds[i].y + sin(t * (0.04 + f32(i) * 0.007)) * 0.2;

        let sin_lat = sin(lat);
        let cos_lat = cos(lat);
        let sin_lon = sin(lon);
        let cos_lon = cos(lon);

        let centre_dir = normalize(vec3<f32>(cos_lat * cos_lon, sin_lat, cos_lat * sin_lon));

        let cos_angle = clamp(dot(r_hat, centre_dir), -1.0, 1.0);
        let angle     = acos(cos_angle);
        let sigma     = 0.55;
        let influence = exp(-(angle * angle) / (2.0 * sigma * sigma));
        if influence < 0.002 { continue; }

        // Upwelling at centre.
        let s2        = sigma * 0.6;
        let up_str    = exp(-(angle * angle) / (2.0 * s2 * s2));
        let v_up      = r_hat * up_str * 0.9;

        // Lateral outflow away from centre.
        let pos_surf   = r_hat * star_r;
        let to_centre  = normalize(centre_dir * star_r - pos_surf);
        let out_frac   = clamp(angle / sigma, 0.0, 1.0);
        let v_lateral  = -to_centre * out_frac * 0.6;

        // Coriolis vortex.
        let hemi_sign = sign(pos.y / star_r);
        let v_vortex  = normalize(cross(r_hat, vec3<f32>(0.0, 1.0, 0.0))) * hemi_sign * 0.25;

        // Damp above photosphere.
        var h_damp = 1.0;
        if dist > star_r {
            let h = clamp((dist - star_r) / star_r, 0.0, 1.0);
            h_damp = (1.0 - h) * (1.0 - h);
        }

        total += (v_up + v_lateral + v_vortex) * influence * h_damp;
    }

    return total;
}
