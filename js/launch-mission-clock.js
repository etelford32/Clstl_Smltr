/**
 * launch-mission-clock.js — Mission elapsed-time controller for the
 * canvas's liftoff animation.
 *
 * Drives a single T-3 → T+50 timeline that the framework reads each frame
 * to know the vehicle's:
 *
 *   throttle    — engine throttle setting [0..1], drives plume length +
 *                 width + opacity. Includes startup ramp at T-3 and a
 *                 max-Q bucket at T+45 → T+55 (100% → 70% → 100%).
 *   altitude    — m above pad-top. Quadratic with T (≈ Saturn-V T/W
 *                 profile, simplified). Caps near 1500 m at end-of-clip.
 *   pitch       — radians. Linear ramp T+25 → T+50, peaks at 30°.
 *   roll        — radians. Linear ramp T+10 → T+18, 0 → 180°.
 *                 (Real shuttles rolled to align with launch azimuth;
 *                 we just rotate the stack about its long axis for the
 *                 visual "I see the orbiter from a new angle" beat.)
 *   skyMix      — [0..1]. 0 = pad fog/lighting, 1 = upper-atmosphere look.
 *   padOpacity  — [0..1]. Pad fades out as the rocket clears it (the
 *                 camera follows the rocket up; the pad is no longer
 *                 useful context once it's >300 m below).
 *   trailH      — m of vertical exhaust trail to render below the
 *                 vehicle, anchored to the pad.
 *
 * Phases (rough match to a Saturn V / shuttle profile, compressed to
 * ~50 s for visual punch — real shuttle MECO is at ~T+8 min):
 *
 *   T-3  → T-0    engine startup: throttle 0 → 1, vehicle still on pad
 *   T+0  → T+10   liftoff, slow initial accel (T/W just over 1)
 *   T+10 → T+18   roll program: 0° → 180° around long axis
 *   T+25 → T+50   pitch program: 0° → 30°
 *   T+45 → T+55   max-Q throttle bucket: 100% → 70%
 *   T+55 → T+70   throttle back up
 *   T+50           clip end — framework auto-resets to T_START
 *
 * Public API:
 *   createMissionClock() →
 *     { start, stop, reset, update(now), snapshot(), finished, get T, get running }
 */

const T_START   = -3;
const T_END     = 50;
// Visual cap on altitude at clip end — keeps the rocket within ~1.5 km
// of the pad so the orbiting camera doesn't zoom out into nothing.
const ALT_CAP_M = 1500;

function smoothstep(a, b, x) {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
}

// Engine throttle. Sharp ramp during startup, max-Q bucket mid-clip.
export function throttleAt(T) {
    if (T < T_START)  return 0;
    if (T < -0.2)     return smoothstep(T_START, -0.2, T);
    if (T < 45)       return 1.0;
    if (T < 55)       return 1.0 - 0.30 * smoothstep(45, 55, T);
    if (T < 70)       return 0.70 + 0.30 * smoothstep(55, 70, T);
    return 1.0;
}

// Altitude. Quadratic ramp once liftoff begins. y = 0.6 * T^2 gives:
//   T+10 → 60 m, T+20 → 240 m, T+30 → 540 m, T+45 → 1215 m
// Capped at ALT_CAP_M so framing stays sane.
export function altitudeAt(T) {
    if (T <= 0) return 0;
    return Math.min(ALT_CAP_M, 0.6 * T * T);
}

// 30° pitch peak, ramp during T+25 → T+50.
export function pitchAt(T) {
    return (Math.PI / 6) * smoothstep(25, 50, T);
}

// 180° roll across T+10 → T+18.
export function rollAt(T) {
    return Math.PI * smoothstep(10, 18, T);
}

// Sky mix — drives fog color shift + density falloff.
export function skyMixAt(T) {
    if (T < 0)  return 0;
    return Math.min(1, T / 35);
}

// Pad fades out between T+12 and T+25, after the rocket has cleared.
export function padOpacityAt(T) {
    if (T < 12) return 1;
    return 1 - smoothstep(12, 25, T);
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createMissionClock() {
    const state = { running: false, T: T_START };
    let lastNow = 0;

    return {
        get T()       { return state.T; },
        get running() { return state.running; },

        start() {
            state.running = true;
            state.T = T_START;
            lastNow = performance.now();
        },

        stop()  { state.running = false; },
        reset() { state.running = false; state.T = T_START; },

        update(now) {
            if (!state.running) return;
            const dt = (now - lastNow) / 1000;
            lastNow = now;
            state.T = Math.min(T_END + 5, state.T + dt);
        },

        finished() {
            return state.T >= T_END;
        },

        snapshot() {
            const T = state.T;
            return {
                T,
                throttle:   throttleAt(T),
                altitude:   altitudeAt(T),
                pitch:      pitchAt(T),
                roll:       rollAt(T),
                skyMix:     skyMixAt(T),
                padOpacity: padOpacityAt(T),
                // Trail height = altitude, but we render the trail anchored
                // to the pad so it grows as the rocket leaves. Cap = ALT_CAP
                // so the cylinder geometry doesn't blow up.
                trailH:     altitudeAt(T),
            };
        },
    };
}

export const MISSION_T_START = T_START;
export const MISSION_T_END   = T_END;
