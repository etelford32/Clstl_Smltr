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
export const EUV_CHANNELS = {
    'white': { logT: 0,   sigma: 0,   color: [1.00, 0.95, 0.80], photDim: 1.00, label: 'White light' },
    '94':    { logT: 6.85, sigma: 0.10, color: [0.30, 0.95, 0.40], photDim: 0.05, label: '94 Å · Fe XVIII · 7 MK · flare core' },
    '131':   { logT: 7.00, sigma: 0.12, color: [0.35, 0.92, 0.92], photDim: 0.05, label: '131 Å · Fe XXI · 10 MK · flare hot' },
    '171':   { logT: 5.85, sigma: 0.10, color: [1.00, 0.85, 0.45], photDim: 0.10, label: '171 Å · Fe IX · 0.7 MK · quiet plage' },
    '193':   { logT: 6.20, sigma: 0.12, color: [0.92, 0.70, 0.35], photDim: 0.10, label: '193 Å · Fe XII · 1.6 MK · AR + holes' },
    '211':   { logT: 6.30, sigma: 0.13, color: [0.92, 0.50, 0.92], photDim: 0.10, label: '211 Å · Fe XIV · 2 MK · AR loops' },
    '304':   { logT: 4.70, sigma: 0.08, color: [1.00, 0.55, 0.30], photDim: 0.35, label: '304 Å · He II · 50 kK · chromo + prom' },
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
    // p_local: position relative to sun centre (units: scene units = R_sun)
    // Returns wavelength-integrated emission for the active channel.
    float demEmission(vec3 p_local) {
        float r = length(p_local);
        if (r < u_sun_radius * 1.001) return 0.0;
        if (r > u_corona_radius)      return 0.0;

        // Altitude above photosphere, in R_sun units
        float h = (r - u_sun_radius) / u_sun_radius;
        vec3  phat = p_local / r;

        float emission = 0.0;

        // ── Quiet corona: log T ≈ 6.0 (1 MK) ──────────────────────────────
        // Hydrostatic-ish exponential scale height; subtle large-scale
        // longitude-dependent variation via low-frequency noise.
        float quiet_h_scale = 0.55;                                   // R_sun
        float quiet_density = exp(-h / quiet_h_scale)
                            * (0.5 + 0.5 * vnoise(phat * 4.0 + vec3(u_time * 0.005)));
        float quiet_logT = 6.00 + 0.10 * (u_activity - 0.5);
        emission += quiet_density * channelResponse(quiet_logT) * 0.40;

        // ── Active-region hot-loop cells ──────────────────────────────────
        // Each AR contributes a localised Gaussian in angular separation,
        // higher density (∝ B², proxied by intensity), and higher T for
        // complex (β-γ-δ) regions (encoded as negative w).
        float ar_h_scale = 0.30;
        for (int k = 0; k < ${N_AR_SLOTS}; k++) {
            if (k >= u_nRegions) break;
            vec3  arPos    = normalize(u_regions[k].xyz);
            float arSigned = u_regions[k].w;
            float arInt    = abs(arSigned);
            float complex  = arSigned < 0.0 ? 1.0 : 0.0;
            float cosAng   = clamp(dot(phat, arPos), -1.0, 1.0);
            float ang      = acos(cosAng);
            // AR loops only on the half-sphere facing the AR (cosAng > 0)
            float facing   = step(0.0, cosAng);
            float ar_dens  = arInt * exp(-h / ar_h_scale)
                           * exp(-ang * ang / 0.040) * facing;
            // T_AR_simple ≈ 2 MK, T_AR_complex ≈ 4 MK
            float ar_logT  = mix(6.30, 6.55, complex);
            // Emission-measure goes as n²; we approximate by squaring density
            emission += ar_dens * ar_dens * channelResponse(ar_logT) * 8.0;
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
            float flare_logT = 7.05;
            emission += flareCore * flareAmp * channelResponse(flare_logT) * 30.0;
        }

        // ── Coronal-hole subtraction ─────────────────────────────────────
        // Open-field-line regions are evacuated → multiplicative dimming
        // of the local emission.  Holes have angular width ~30°.
        float holeMask = 0.0;
        for (int k = 0; k < ${N_HOLE_SLOTS}; k++) {
            if (k >= u_nHoles) break;
            vec3  hp     = normalize(u_holes[k].xyz);
            float hDepth = u_holes[k].w;
            float cosAng = clamp(dot(phat, hp), -1.0, 1.0);
            float ang    = acos(cosAng);
            holeMask = max(holeMask, hDepth * exp(-ang * ang / 0.18));
        }
        emission *= (1.0 - holeMask);

        return emission;
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

        const int N_STEPS = 16;
        float step_size = t_exit / float(N_STEPS);
        float emission = 0.0;
        for (int i = 0; i < N_STEPS; i++) {
            float t = step_size * (float(i) + 0.5);
            vec3 p_world = ro + rd * t;
            vec3 p_local = p_world - u_sun_world;
            emission += demEmission(p_local) * step_size;
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
