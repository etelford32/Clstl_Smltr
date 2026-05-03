/**
 * corona-volumetric.js — AIA-style multi-wavelength EUV corona shader
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A single raymarched volumetric corona that integrates a synthetic
 * differential-emission-measure (DEM) profile along the line of sight and
 * weights it by the response function of one of six SDO/AIA passbands
 * (94, 131, 171, 193, 211, 304 Å) — turning the sun rendering into a
 * configurable space-weather instrument view.
 *
 * ── Physics ──────────────────────────────────────────────────────────────
 *   Optically-thin EUV emission integrated along a line of sight:
 *
 *       I_λ = ∫ DEM(T) · R_λ(T) dT
 *
 *   Each AIA channel R_λ(T) is approximated by a Gaussian in log T
 *   (peak temperature & FWHM from the AIA temperature-response tables;
 *   real responses are bimodal in places — we collapse to the dominant
 *   peak for visual clarity).
 *
 *   The synthetic DEM at point r in the corona is the sum of:
 *     DEM_quiet(r, T)    background corona, peak ~1 MK
 *     DEM_AR(r, T)       per-active-region hot-loop cell, peak 1.5–4 MK
 *     DEM_flare(r, T)    flare-hot component, peak ~10 MK, scaled by
 *                        live GOES X-ray flux
 *     − holeMask(r)      coronal-hole subtraction, dims the
 *                        emission inside open-field regions
 *
 *   Each DEM term carries an exponential altitude scale-height above the
 *   photosphere and a Gaussian angular extent around its anchor point on
 *   the sphere — so an AR is a localised bright cell, a coronal hole a
 *   localised dim cell, and the quiet corona is the diffuse fill.
 *
 * ── Channel table ────────────────────────────────────────────────────────
 *   Each channel has (log T_peak, σ_logT, pseudocolor, photDim, label).
 *   photDim is the multiplier applied to the photosphere shader's output
 *   when this EUV channel is active (94 / 131 / 171 / 193 / 211 are deep
 *   coronal lines so the disk is mostly dark; 304 is chromospheric so
 *   the disk has moderate brightness; white-light keeps the photosphere
 *   at full brightness and disables the volumetric corona entirely).
 */

// ── Channel response table ──────────────────────────────────────────────────
//
// pseudocolor matches the conventional AIA palette (171=gold, 193=brown,
// 211=purple, 304=red, 131=teal, 94=green) so a viewer familiar with
// SDO data sees what they expect.
//
// `filOpacity` is the per-step extinction coefficient for cool dense
// filament/prominence plasma in this channel.  At deep coronal lines
// (171, 193, 211 Å) the He I edge at 504 Å + H I continuum makes the
// filament strongly absorbing → filaments appear *dark* on disk.  In
// the higher-energy channels (94, 131 Å) absorption is weaker.  In
// 304 Å the cool plasma has its own emission so we use a low effective
// opacity (it self-absorbs but the envelope still glows).
export const EUV_CHANNELS = {
    'white': { logT: 0,   sigma: 0,   color: [1.00, 0.95, 0.80], photDim: 1.00, filOpacity: 0.0, label: 'White light' },
    '94':    { logT: 6.85, sigma: 0.10, color: [0.30, 0.95, 0.40], photDim: 0.05, filOpacity: 1.0, label: '94 Å · Fe XVIII · 7 MK · flare core' },
    '131':   { logT: 7.00, sigma: 0.12, color: [0.35, 0.92, 0.92], photDim: 0.05, filOpacity: 1.5, label: '131 Å · Fe XXI · 10 MK · flare hot' },
    '171':   { logT: 5.85, sigma: 0.10, color: [1.00, 0.85, 0.45], photDim: 0.10, filOpacity: 6.0, label: '171 Å · Fe IX · 0.7 MK · quiet plage' },
    '193':   { logT: 6.20, sigma: 0.12, color: [0.92, 0.70, 0.35], photDim: 0.10, filOpacity: 5.0, label: '193 Å · Fe XII · 1.6 MK · AR + holes' },
    '211':   { logT: 6.30, sigma: 0.13, color: [0.92, 0.50, 0.92], photDim: 0.10, filOpacity: 4.0, label: '211 Å · Fe XIV · 2 MK · AR loops' },
    '304':   { logT: 4.70, sigma: 0.08, color: [1.00, 0.55, 0.30], photDim: 0.35, filOpacity: 0.5, label: '304 Å · He II · 50 kK · chromo + prom' },
};

// Number of slots reserved in the shader uniforms for active regions /
// coronal holes.  Match these to the corresponding caps in sun-shader.js
// (u_regions array length) and SunSkin.setHoles().
export const N_AR_SLOTS    = 8;
export const N_HOLE_SLOTS  = 4;

// ── Vertex shader ───────────────────────────────────────────────────────────
//
// Pass world-space position so the fragment shader can build a ray from the
// (built-in) cameraPosition uniform — three.js exposes that automatically.
export const CORONA_VOL_VERT = /* glsl */`
    varying vec3 vWorldPos;

    void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
    }
`;

// ── Fragment shader ─────────────────────────────────────────────────────────
//
// 16-step raymarching from this fragment's position (front of the corona
// bounding sphere) toward the back of that sphere, clipped by the
// photospheric occluder (so the back hemisphere of corona is hidden by the
// disk, matching real EUV imagery).
//
// At each step we evaluate the synthetic DEM, multiply by the channel's
// Gaussian temperature response, accumulate scalar emission.  A coronal-hole
// mask multiplicatively subtracts.  Final color = channel pseudocolor ×
// emission, additive-blended over the photosphere.
export const CORONA_VOL_FRAG = /* glsl */`
    precision highp float;

    // cameraPosition is auto-injected by three.js for ShaderMaterial — do not
    // redeclare it (would otherwise trip "redeclared identifier" on some
    // drivers / WebGL implementations).
    uniform vec3  u_sun_world;
    uniform float u_sun_radius;
    uniform float u_corona_radius;

    uniform vec4  u_regions[${N_AR_SLOTS}];
    uniform int   u_nRegions;
    uniform vec4  u_holes[${N_HOLE_SLOTS}];
    uniform int   u_nHoles;

    uniform float u_xray_norm;          // 0..1 GOES flux → flare DEM amplitude
    uniform float u_flare_t;            // 0..1 impulsive flare flash decay
    uniform float u_activity;           // 0..1 solar-cycle activity → quiet-corona density
    uniform vec2  u_flare_lon;          // (lat_rad, lon_rad) of flare site

    uniform float u_channel_logT;       // peak log T of the active AIA channel
    uniform float u_channel_sigT;       // FWHM/√(8 ln 2) in log T
    uniform vec3  u_channel_color;      // pseudocolor (171=gold, 304=red, …)
    uniform float u_channel_intensity;  // overall brightness scaling
    uniform float u_filament_opacity;   // per-channel cool-plasma extinction coeff

    uniform float u_time;

    varying vec3 vWorldPos;

    // Hash-based noise for granulation-scale variation in the DEM
    float hash(vec3 p) {
        p  = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }
    float vnoise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(mix(hash(i),                   hash(i + vec3(1, 0, 0)), f.x),
                mix(hash(i + vec3(0, 1, 0)),   hash(i + vec3(1, 1, 0)), f.x), f.y),
            mix(mix(hash(i + vec3(0, 0, 1)),   hash(i + vec3(1, 0, 1)), f.x),
                mix(hash(i + vec3(0, 1, 1)),   hash(i + vec3(1, 1, 1)), f.x), f.y),
            f.z);
    }

    // ── Channel response: Gaussian in log T ────────────────────────────────
    float channelResponse(float logT) {
        if (u_channel_sigT < 1e-3) return 0.0;
        float d = (logT - u_channel_logT) / u_channel_sigT;
        return exp(-0.5 * d * d);
    }

    // ── Synthetic DEM at a point in sun-local space ────────────────────────
    //
    // Single combined per-AR pass that produces the diffuse AR cell, the
    // bipolar loop arcade (with Joy's-law tilt), the cool-plasma filament
    // density, and the moss-pattern footpoint emission — all sharing one
    // tangent-frame computation per AR per ray step.  This collapses what
    // were three separate N_AR-iteration loops into one, cuts shader cost
    // ~3× in the AR-bound region of the volume, and lets per-AR hash
    // scatter give every region a different bipolar axis tilt and loop
    // brightness modulation (no more uniform-looking blobs).
    //
    // p_local: position relative to sun centre (units: scene units = R_sun).
    // Writes integrated emission for the active channel into the first out
    // parameter and the cool-filament density into the second, so the caller
    // can update transmission for absorption-aware front-to-back compositing.
    void demSample(vec3 p_local, out float emission, out float fil_density) {
        emission = 0.0;
        fil_density = 0.0;
        float r = length(p_local);
        if (r < u_sun_radius * 1.001) return;
        if (r > u_corona_radius)      return;

        // Altitude above photosphere, in R_sun units
        float h = (r - u_sun_radius) / u_sun_radius;
        vec3  phat = p_local / r;

        // ── Quiet corona ── multi-octave noise for richer texture ─────────
        // Two octaves of value noise with different phases & temporal speeds
        // break the previously-uniform diffuse glow into the supergranular-
        // -scale variation visible in real EUV quiet-Sun imagery.
        float quiet_h_scale = 0.55;
        float n1 = vnoise(phat *  4.0 + vec3(u_time * 0.005));
        float n2 = vnoise(phat * 11.0 + vec3(-u_time * 0.011, u_time * 0.008, 0.0));
        float quiet_density = exp(-h / quiet_h_scale)
                            * (0.30 + 0.45 * n1 + 0.25 * n2);
        float quiet_logT = 6.00 + 0.10 * (u_activity - 0.5);
        emission += quiet_density * channelResponse(quiet_logT) * 0.40;

        // ── Combined per-AR contribution ─────────────────────────────────
        for (int k = 0; k < ${N_AR_SLOTS}; k++) {
            if (k >= u_nRegions) break;
            vec3  arPos    = normalize(u_regions[k].xyz);
            float arSigned = u_regions[k].w;
            float arInt    = abs(arSigned);
            if (arInt < 0.05) continue;
            float complex  = arSigned < 0.0 ? 1.0 : 0.0;

            // Angular distance early-out — skip ARs more than ~32° from this
            // sample.  All AR features (cell ≤ 17°, arcade ≤ 10°, filament ≤
            // 10°) decay to <1 % by 32°, so this is conservative and saves a
            // huge amount of work in off-AR pixels (most of the volume).
            float cosAng = clamp(dot(phat, arPos), -1.0, 1.0);
            if (cosAng < 0.85) continue;
            float ang     = acos(cosAng);
            float facing  = step(0.0, cosAng);

            // ── Local tangent frame with Joy's-law tilt ──────────────────
            // Hale 1919 / Howard 1991: the bipolar axis of a hemispherically
            // tilted AR pair has  tan γ = 0.5 sin |latitude|, with the
            // leading polarity tilted *toward the equator*.  We rotate the
            // local east tangent by that angle in the (east, north) plane.
            // A small per-AR random scatter (±10°, hashed off the slot
            // index) breaks the textbook-perfect alignment so a population
            // of ARs shows the natural Joy's-law spread.
            vec3 east_pure  = normalize(vec3(-arPos.z, 0.0, arPos.x));
            vec3 north_pure = normalize(cross(arPos, east_pure));
            float arLat   = asin(arPos.y);
            float gamma0  = atan(0.5 * abs(sin(arLat)));
            float arHash  = fract(sin(float(k) * 12.9898) * 43758.5453);
            float gamma   = gamma0 + (arHash - 0.5) * 0.18;          // ±5° scatter
            float cosG    = cos(gamma);
            float sinG    = sin(gamma) * (arLat > 0.0 ? -1.0 : 1.0);  // toward equator
            vec3  east    = cosG * east_pure + sinG * north_pure;
            vec3  north   = normalize(cross(arPos, east));

            // Sample-point in the AR's local frame
            vec3 d        = phat - arPos;
            float s_east  = dot(d, east);
            float s_north = dot(d, north);
            float s_up    = h;

            // ── Diffuse AR-cell envelope (slightly toned-down vs. v1) ────
            // The arcade now carries the structural emission, so the cell
            // here is just the diffuse hot-plasma background.
            float ar_dens  = arInt * exp(-h / 0.30) * exp(-ang * ang / 0.040) * facing;
            float ar_logT  = mix(6.30, 6.55, complex);
            emission += ar_dens * ar_dens * channelResponse(ar_logT) * 5.0;

            // ── Loop arcade ──────────────────────────────────────────────
            // Half-toroidal density field tilted with the AR's bipolar axis;
            // per-loop noise modulation gives the natural arcade-thread look.
            if (h > 0.005 && h < 0.20 && s_up > 0.001) {
                float R_loop  = (0.06 + 0.10 * arInt) * (1.0 + 0.20 * complex);
                float L_pil   = (0.03 + 0.07 * arInt);
                float r_min   = 0.018 + 0.005 * arInt;
                float pil_edge = 0.020;

                float pil_mask = smoothstep(-L_pil - pil_edge, -L_pil, s_north)
                               - smoothstep( L_pil,  L_pil + pil_edge, s_north);
                float r_in_plane   = sqrt(s_east * s_east + s_up * s_up);
                float dist_to_loop = abs(r_in_plane - R_loop);
                float rope         = exp(-dist_to_loop * dist_to_loop / (2.0 * r_min * r_min));

                // Per-loop variance: real arcades show different brightness
                // per thread (heated unevenly, evolving on minute timescales).
                float loop_var = 0.55 + 0.45 * vnoise(vec3(
                    s_north * 28.0,
                    s_east  * 22.0,
                    arHash * 7.0 + u_time * 0.04));

                float dens = arInt * pil_mask * rope * loop_var;
                if (dens > 1e-4) {
                    float cool_wt = mix(1.0, 0.4, complex);
                    float hot_wt  = mix(0.5, 1.5, complex);
                    emission += dens * dens * channelResponse(5.90) * 4.0 * cool_wt;
                    emission += dens * dens * channelResponse(6.30) * 4.0 * hot_wt;
                }

                // ── Moss / fine-scale footpoint emission ──────────────────
                // Bright stippled pattern at AR loop footpoints — the dotted
                // chromospheric "moss" visible in 171/193 just above the
                // photosphere.  Restricted to h < 0.025 R_sun and to the
                // outer half of the arcade footprint where loops descend.
                if (h < 0.025) {
                    float moss_n   = vnoise(phat * 95.0 + vec3(arHash * 3.0));
                    float moss_pat = pil_mask
                                   * smoothstep(0.5 * R_loop, 0.95 * R_loop, abs(s_east))
                                   * (moss_n - 0.45);
                    moss_pat = max(0.0, moss_pat) * arInt
                             * (1.0 - smoothstep(0.012, 0.025, h));
                    emission += moss_pat * channelResponse(6.10) * 8.0;
                }
            }

            // ── Filament density along PIL (post-Joy-tilt orientation) ──
            // Filament is anchored along the *tilted* east axis so it tracks
            // Joy's-law orientation alongside the loops — visually consistent.
            if (h > 0.005 && h < 0.080) {
                const float h_fil   = 0.025;
                const float h_sigma = 0.018;
                float h_mask = exp(-(h - h_fil) * (h - h_fil) / (2.0 * h_sigma * h_sigma));
                float fil_half_len = (0.04 + 0.10 * arInt) * (1.0 + 0.30 * complex);
                float fil_edge     = 0.020;
                float fil_width    = 0.012 + 0.005 * arInt;
                float along_mask = smoothstep(-fil_half_len - fil_edge, -fil_half_len, s_east)
                                 - smoothstep( fil_half_len,  fil_half_len + fil_edge, s_east);
                float across_mask = exp(-(s_north * s_north) / (2.0 * fil_width * fil_width));
                float density = arInt * along_mask * across_mask * h_mask
                              * mix(1.0, 1.40, complex);
                if (density > 0.0) {
                    fil_density += density;
                    emission    += density * channelResponse(4.50) * 1.20;
                    if (u_channel_logT > 4.5 && u_channel_logT < 5.0) {
                        emission += density * 0.30;
                    }
                }
            }
        }

        // ── Flare-hot component ──────────────────────────────────────────
        // Scaled by GOES X-ray flux + impulsive flare flash decay; localised
        // around the latest flare site so a flare impulsively brightens
        // 94/131 Å but barely touches 171/304.
        if (u_xray_norm > 0.005 || u_flare_t > 0.005) {
            vec3 flareSrc = vec3(
                cos(u_flare_lon.x) * cos(u_flare_lon.y),
                sin(u_flare_lon.x),
                cos(u_flare_lon.x) * sin(u_flare_lon.y)
            );
            float cosFA = clamp(dot(phat, flareSrc), -1.0, 1.0);
            float angF  = acos(cosFA);
            float facingF = step(0.0, cosFA);
            float flareCore = exp(-h / 0.20) * exp(-angF * angF / 0.030) * facingF;
            float flareAmp  = u_xray_norm * 0.6 + u_flare_t * 0.8;
            emission += flareCore * flareAmp * channelResponse(7.05) * 30.0;
            // Suppress filament near the flare site (filament eruption)
            float erupt_mask = exp(-angF * angF / 0.030) * u_flare_t;
            fil_density *= max(0.0, 1.0 - erupt_mask);
        }

        // ── Coronal-hole subtraction ─────────────────────────────────────
        float holeMask = 0.0;
        for (int k = 0; k < ${N_HOLE_SLOTS}; k++) {
            if (k >= u_nHoles) break;
            vec3  hp     = normalize(u_holes[k].xyz);
            float hDepth = u_holes[k].w;
            float cosA   = clamp(dot(phat, hp), -1.0, 1.0);
            float angH   = acos(cosA);
            holeMask = max(holeMask, hDepth * exp(-angH * angH / 0.18));
        }
        emission *= (1.0 - holeMask);
        fil_density = clamp(fil_density, 0.0, 4.0);
    }

    // ── Ray-sphere intersection (returns t for nearest forward hit) ───────
    // Returns a vec2 (t_near, t_far); both 0 if no hit.
    vec2 raySphere(vec3 ro, vec3 rd, vec3 sc, float sr) {
        vec3 oc = ro - sc;
        float b = dot(oc, rd);
        float c = dot(oc, oc) - sr * sr;
        float disc = b * b - c;
        if (disc < 0.0) return vec2(0.0);
        float s = sqrt(disc);
        return vec2(-b - s, -b + s);
    }

    void main() {
        vec3 ro = vWorldPos;
        vec3 rd = normalize(vWorldPos - cameraPosition);

        // Distance to *this* fragment from the camera; we step forward into
        // the volume from here (we're rendered as the front face of the
        // outer corona shell).
        // Find ray–corona-sphere far intersection (we know we're on the front)
        vec2 hit_corona = raySphere(ro, rd, u_sun_world, u_corona_radius);
        float t_exit = hit_corona.y;
        if (t_exit <= 0.0) discard;

        // Photospheric occluder: stop the ray at the near intersection if it
        // hits the disk
        vec2 hit_phot = raySphere(ro, rd, u_sun_world, u_sun_radius);
        if (hit_phot.x > 0.0) {
            t_exit = min(t_exit, hit_phot.x);
        }

        // ── Front-to-back transmission integration ────────────────────────
        // Standard volumetric compositing:
        //   emission_total += transmission · sample_emission · ds
        //   transmission   *= exp(−κ · ρ · ds)
        // where κ is the per-channel filament extinction coefficient and ρ
        // is the cool-plasma density at the sample.  A filament *in front*
        // of an AR therefore reduces the transmission of all subsequent
        // (deeper) emission samples → AR loops behind a filament are
        // attenuated, exactly producing the dark-on-disk filament look in
        // 171 / 193 / 211, while in 304 the low extinction lets the
        // filament's own emission shine through (bright limb prominence).
        // 12 steps balances coverage vs. cost — at 16 steps the volumetric
        // shader was the dominant frame-time consumer; the early-out below
        // (transmission < 0.01) typically terminates the loop in 6-8 steps
        // for AR-rich pixels anyway.
        const int N_STEPS = 12;
        float step_size = t_exit / float(N_STEPS);
        float emission = 0.0;
        float transmission = 1.0;
        for (int i = 0; i < N_STEPS; i++) {
            float t = step_size * (float(i) + 0.5);
            vec3 p_world = ro + rd * t;
            vec3 p_local = p_world - u_sun_world;

            float em, fil;
            demSample(p_local, em, fil);

            emission += transmission * em * step_size;
            float dtau = fil * step_size * u_filament_opacity;
            transmission *= exp(-dtau);

            // Cheap early-out: once the column is essentially opaque, no
            // further depth contributes.
            if (transmission < 0.01) break;
        }

        // White-light mode disables the volumetric corona entirely
        if (u_channel_sigT < 1e-3) discard;

        // Output: channel pseudocolor × accumulated emission, additively
        // blended over the photosphere.  A small bias prevents totally-zero
        // pixels off-limb from looking artificially clipped.
        vec3 col = u_channel_color * emission * u_channel_intensity;
        // Soft tonemap so high-emission flare pixels don't blow out
        col = col / (1.0 + col);
        // Alpha controls how strongly we composite over the underlying scene
        float alpha = clamp(emission * 1.5 + 0.05, 0.0, 1.0);
        gl_FragColor = vec4(col, alpha);
    }
`;
