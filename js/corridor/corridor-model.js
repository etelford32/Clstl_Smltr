/**
 * js/corridor/corridor-model.js — pure scene model for the 3D Earth-arrival
 * corridor on cme-forecast.html.
 *
 * NO DOM, NO THREE, NO FETCH, NO AMBIENT TIME. Node gate:
 * tests/corridor-model.mjs.
 *
 * ── What this module is for ─────────────────────────────────────────────
 *
 * The CME forecast page, Far-Side Watch and the compounding flux-rope
 * simulator are three views of ONE physical story: a region rotates into
 * view, erupts, the rope crosses the corridor, and something arrives at
 * L1. This module is the joint that lets one scene show all three without
 * anybody re-deriving anybody else's math.
 *
 * ── The identity that makes the join free ───────────────────────────────
 *
 * `ropeFrame(lonDeg, ...)` in js/flux-rope/view.js takes STONYHURST
 * heliographic longitude — degrees east/west of the Sun-Earth line, with
 * Earth at lon 0. Far-Side Watch tracks regions in CARRINGTON longitude and
 * reports their central-meridian distance `cmd = wrap180(lonCarr - L0)`.
 *
 * Those are the same quantity. CMD is Stonyhurst longitude. So a far-side
 * region's direction in the flux-rope frame is just ropeFrame(cmd, lat, 0),
 * and a marker on the Sun's surface sits in exactly the frame a rope
 * launched from that region would use. No conversion, no third convention,
 * and no chance of the region and its CME appearing on opposite limbs.
 * tests/corridor-model.mjs pins the identity in both directions.
 *
 * ── Regions co-rotate; ropes do not ────────────────────────────────────
 *
 * A surface region is carried by solar rotation, so its CMD is a function
 * of the clock: `cmd(τ) = wrap180(lonCarr − L0(τ))`. A launched rope is
 * ballistic — its direction was fixed at launch and does NOT co-rotate.
 * Advancing the clock therefore sweeps the regions across the disc while
 * the ropes hold their headings, which is the physically correct picture
 * and the one thing a static diagram cannot show. Do not "fix" the ropes
 * to rotate with the Sun.
 *
 * ── Oracle discipline ──────────────────────────────────────────────────
 *
 * Rope geometry comes from the live kernel's per-rope probes
 * (apexKmAt / sigmaApexKmAt) whenever a kernel is present — oracle-direct,
 * so the train's wake and §16 interaction are the kernel's answer and not a
 * re-derivation. Without a kernel it falls back to stage/model.js
 * `ropeSpecAt`, itself a pinned mirror of the Rust. There is no third copy
 * of the math here and there must never be one.
 */

import { ropeFrame } from '../flux-rope/view.js';
import { ropeSpecAt, D0_KM_DEFAULT } from '../stage/model.js';
import { wrap180 } from '../farside/carrington.js';

const AU_KM = 1.495978707e8;

/** Solar radius in AU — the surface regions are drawn on. */
export const SUN_R_AU = 6.957e5 / AU_KM;

/**
 * Unit direction of a surface feature in the heliocentric flux-rope frame
 * (+x Sun→Earth, +z ecliptic north).
 *
 * @param {number} cmdDeg central-meridian distance (= Stonyhurst longitude);
 *   0 is sub-Earth, −90 the east limb (where regions emerge), +90 the west.
 * @param {number} latDeg heliographic latitude.
 */
export function sourceDirection(cmdDeg, latDeg) {
    return ropeFrame(cmdDeg, latDeg, 0).eDir;
}

/** True when a feature at this CMD is on the Earth-facing hemisphere. */
export function isEarthFacing(cmdDeg) {
    return Math.abs(wrap180(cmdDeg)) <= 90;
}

/**
 * Place Far-Side Watch tracks on the Sun for one instant.
 *
 * Takes the tracks already projected by farside-track.projectTracks (which
 * carries `cmd` for that instant) so the corridor and the watch list can
 * never disagree about where a region is — same projection, one call.
 *
 * @param {Array} tracks projected far-side tracks ({ id, lon, lat, cmd, ... })
 * @returns {Array<{id,lon,lat,cmd,dir,onDisc,strong,etaDays}>}
 */
export function placeSourceRegions(tracks) {
    return (tracks || [])
        .filter((t) => Number.isFinite(t?.cmd) && Number.isFinite(t?.lat))
        .map((t) => ({
            id: t.id,
            lon: t.lon,
            lat: t.lat,
            cmd: wrap180(t.cmd),
            dir: sourceDirection(t.cmd, t.lat),
            onDisc: isEarthFacing(t.cmd),
            strong: !!t.strong,
            etaDays: t.etaDays,
            validationCase: t.validationCase ?? null,
            flare: t.flare ?? null,
        }));
}

/**
 * Seconds of flight for rope `i` of a train at wall-clock `tauMs`.
 * Negative before that member has launched.
 */
export function ropeFlightSeconds(rope, epochMs, tauMs) {
    return (tauMs - epochMs) / 1000 - (rope?.launchOffsetS ?? 0);
}

/**
 * Geometry of one rope at flight time tS.
 *
 * `kernel` (the live flux-rope WASM instance the shared provider ran) is
 * preferred: apexKmAt/sigmaApexKmAt already contain the train's wake and
 * §16 interaction. The mirror fallback is the single-rope kinematic and is
 * flagged as such on the result so the UI can say which it drew.
 *
 * @returns {null|{frame,dAu,sigApexAu,tS,oracle:'kernel'|'mirror'}}
 */
export function ropeGeometryAt(rope, index, tS, kernel = null, wKms = 400) {
    if (!rope || !Number.isFinite(tS) || tS <= 0) return null;
    if (kernel && typeof kernel.apexKmAt === 'function') {
        const dKm = kernel.apexKmAt(index, tS);
        const sigKm = kernel.sigmaApexKmAt(index, tS);
        if (Number.isFinite(dKm) && dKm > 0 && Number.isFinite(sigKm) && sigKm > 0) {
            return {
                frame: ropeFrame(rope.lonDeg, rope.latDeg, rope.tiltDeg ?? 0),
                dAu: dKm / AU_KM,
                sigApexAu: sigKm / AU_KM,
                tS,
                oracle: 'kernel',
            };
        }
    }
    const spec = ropeSpecAt(rope, rope.wKms ?? wKms, tS, D0_KM_DEFAULT);
    if (!Number.isFinite(spec.dAu) || spec.dAu <= 0) return null;
    return { ...spec, tS, oracle: 'mirror' };
}

/**
 * The whole train at one instant, launched members only.
 *
 * @param {object} preset the provider's train preset ({ ropes, launchIso })
 * @param {number} epochMs train epoch = earliest launch (spec §12.1)
 * @param {number} tauMs   the instant to draw
 * @param {object} [kernel]
 * @returns {Array<{index,rope,geometry,launchMs}>} soonest-launched first
 */
export function trainAt(preset, epochMs, tauMs, kernel = null) {
    const ropes = preset?.ropes?.length ? preset.ropes : (preset?.rope ? [preset.rope] : []);
    const out = [];
    ropes.forEach((rope, index) => {
        const tS = ropeFlightSeconds(rope, epochMs, tauMs);
        const geometry = ropeGeometryAt(rope, index, tS, kernel);
        if (!geometry) return;   // not yet launched, or degenerate
        out.push({
            index,
            rope,
            geometry,
            launchMs: epochMs + (rope.launchOffsetS ?? 0) * 1000,
        });
    });
    return out;
}

/**
 * Apex distance of the leading rope, in AU — what the corridor's "front" is.
 * Returns null when nothing is in flight.
 */
export function leadingApexAu(train) {
    let best = null;
    for (const m of train || []) {
        if (best === null || m.geometry.dAu > best) best = m.geometry.dAu;
    }
    return best;
}

/**
 * Arrival-window markers for the corridor's Earth end.
 *
 * The forecast page's ledger is issue-locked and carries TIMES, not rope
 * geometry — so a window is drawn as a time interval at Earth, never as a
 * fabricated rope. `fraction` is where τ sits inside the window: <0 before
 * it opens, 0..1 inside, >1 after it closes.
 */
export function arrivalWindowState(event, tauMs) {
    if (!event || !Number.isFinite(event.earlyMs) || !Number.isFinite(event.lateMs)) return null;
    const span = event.lateMs - event.earlyMs;
    return {
        id: event.id,
        earlyMs: event.earlyMs,
        lateMs: event.lateMs,
        predictedMs: event.predictedMs,
        open: tauMs >= event.earlyMs && tauMs <= event.lateMs,
        past: tauMs > event.lateMs,
        fraction: span > 0 ? (tauMs - event.earlyMs) / span : (tauMs >= event.earlyMs ? 1 : 0),
        hoursToMedian: Number.isFinite(event.predictedMs)
            ? (event.predictedMs - tauMs) / 3.6e6
            : null,
    };
}
