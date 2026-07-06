/**
 * Mission scenarios for the Mission State canvas. Each one is a small
 * state machine on top of the existing orbital sim.
 *
 * ─── Mission object schema ────────────────────────────────────────────
 *
 *   id:       short snake-case key used in the URL + storage
 *   name:     human display name
 *   blurb:    1–2 sentence pre-flight briefing shown in the objective bar
 *   tip:      educational note — real-world context for the cockpit card
 *   defaults: starting slider values  { periKm, apoKm, tgtKm, throttle,
 *                                       swPreset, attitude, fuelMass }
 *   altitudeFloorKm: (optional) soft-warning altitude. Drives the
 *                    "DEORBIT WARNING → BREACHED" escalation.
 *   lookaheadOrbits: (optional, default DEFAULT_LOOKAHEAD_ORBITS) — how
 *                    far the projected-perigee helper looks for the
 *                    floor-status assessment.
 *
 * ─── Required methods ─────────────────────────────────────────────────
 *
 *   setup(ctx)            — one-time on launch. May write ctx.state,
 *                            tweak ctx.env, spawn targets/debris.
 *   tick(ctx, dt, tel)    — every frame while flying. Return:
 *                            { event?, scoreDelta?, done?, fail? }
 *   objective(ctx, tel)   — UI hint: { label, progress 0-1, status,
 *                            extras? }
 *
 * ─── Optional methods ─────────────────────────────────────────────────
 *
 *   score(ctx)            — closed-form final score (overrides the
 *                            scoreDelta sum). Use when the mission's
 *                            success metric is non-monotonic (e.g.
 *                            rendezvous = f(best miss distance)).
 *   scorecard(stats, ctx) — end-of-mission breakdown. Return:
 *                            { rows: [{ lbl, val, cls? }, ...], tip? }
 *                            cls ∈ '' | 'bonus' | 'warn' | 'bad'.
 *                            `stats` is sim.flightStats — see schema in
 *                            satellite-designer.html makeFlightStats().
 *
 * ─── ctx surface ──────────────────────────────────────────────────────
 *
 *   { sim, env, design, control, R_EARTH, MU,
 *     targetAltKm, lastPeriKm,
 *     getTarget(), getDebris(),     // pose helpers, in metres
 *     setTarget(obj), setDebris(obj),
 *     event(type, payload), setBanner(text, cls) }
 *
 * ─── Adding a new mission ─────────────────────────────────────────────
 *
 *   1. Define `export const myMission = { ... }`
 *   2. Register in MISSIONS at the bottom of this file
 *   3. Append the id to MISSION_ORDER (sets pre-flight nav order)
 *   4. Optional: scenes/missions/<id>.js for custom 3D dressing
 *
 * Missions are deliberately small so they're readable and easy to
 * balance. Keep state in ctx.state so the player's reset clears it.
 */

const TAU = Math.PI * 2;

/**
 * Mission floor & warning system
 * ──────────────────────────────
 * Each mission can declare an `altitudeFloorKm` — a soft warning threshold
 * *above* the engine's hard 80 km re-entry floor. Combined with the engine's
 * projected-perigee helper, this drives three escalating cockpit states:
 *
 *   ok      — predicted perigee stays above the floor for `lookaheadOrbits`
 *   warn    — predicted perigee dips below the floor within the look-ahead
 *             but you're not there yet (orange "DEORBIT WARNING")
 *   breach  — current perigee is already below the floor (red "BREACHED",
 *             passive score penalty applied per second in this band)
 *
 * Actual mission failure only triggers when the engine's re-entry threshold
 * is hit (alt < 80 km). The graduated warning gives the player time to react
 * — read the forecast, schedule a burn, recover — before the orbit is lost.
 *
 * Missions can opt out of the floor system by leaving altitudeFloorKm null.
 * deorbit deliberately does this (you WANT to drop). rendezvous focuses on
 * the docking objective and skips it too.
 */
export const DEFAULT_LOOKAHEAD_ORBITS = 8;
export const BREACH_SCORE_PENALTY_PER_SEC = 1.0;

/**
 * Classify the player's current orbital margin against the active mission's
 * floor. Pure: depends only on the mission spec + telemetry + a projection
 * helper that the caller supplies. The caller passes `projectFn(orbits)` so
 * we don't import the engine here (avoiding a circular dep) — typically
 * `(n) => ENG.projectPerigee(tel, n, { playerDvPerOrbit: 0 })`.
 *
 * @param {object} mission
 * @param {object} tel
 * @param {(n:number) => {periAltKmAfter:number}} projectFn
 * @returns {{ status:'ok'|'warn'|'breach',
 *             floorKm:number|null, periKm:number, projectedPeriKm:number,
 *             margin:number, lookaheadOrbits:number }}
 */
export function assessFloorStatus(mission, tel, projectFn) {
  const floor = mission?.altitudeFloorKm;
  const lookahead = mission?.lookaheadOrbits ?? DEFAULT_LOOKAHEAD_ORBITS;
  if (floor == null || !tel) {
    return { status: 'ok', floorKm: null, periKm: tel?.periAltKm ?? NaN,
             projectedPeriKm: tel?.periAltKm ?? NaN, margin: Infinity, lookaheadOrbits: lookahead };
  }
  const periKm = tel.periAltKm;
  const proj = (typeof projectFn === 'function') ? projectFn(lookahead) : null;
  const projectedPeriKm = proj?.periAltKmAfter ?? periKm;
  let status;
  if (periKm < floor) status = 'breach';
  else if (projectedPeriKm < floor) status = 'warn';
  else status = 'ok';
  return {
    status, floorKm: floor, periKm, projectedPeriKm,
    margin: periKm - floor, lookaheadOrbits: lookahead,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function circleOrbitState(MU, R, altKm, phaseRad = 0) {
  const r = R + altKm * 1000;
  const v = Math.sqrt(MU / r);
  return { x: r * Math.cos(phaseRad), y: r * Math.sin(phaseRad),
           vx: -v * Math.sin(phaseRad), vy: v * Math.cos(phaseRad) };
}
function angleOf(x, y) { let a = Math.atan2(y, x); return a < 0 ? a + TAU : a; }
function shortestArc(a, b) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return d;
}

// ─── 1) STATION-KEEPER ─────────────────────────────────────────────────────
// The classic "fight the drag" endurance run. Score = on-station seconds +
// orbit bonus. The original game.
export const stationKeeper = {
  id: 'station',
  name: 'Station-Keeper',
  blurb: 'Fight thermospheric drag and hold target altitude. Burn prograde at perigee to re-boost.',
  tip: 'Real LEO operators schedule routine prograde drag-make-up burns. Watch perigee — it falls first.',
  defaults: { periKm: 350, apoKm: 350, tgtKm: 350, throttle: 60,
              swPreset: 'quiet', attitude: 'nominal', fuelMass: 60 },
  // Warning floor 50 km below the default station — drag-only decay reaches
  // here in tens of orbits at solar nominal, faster during storms. Drives the
  // cockpit's "DEORBIT WARNING → BREACHED" escalation.
  altitudeFloorKm: 300,
  lookaheadOrbits: 8,
  setup(ctx) {
    ctx.state = { stationSeconds: 0, orbits: 0, lastAngle: 0, startTime: 0 };
  },
  tick(ctx, dt, tel) {
    const tgt = ctx.targetAltKm;
    if (tel.altKm >= tgt) ctx.state.stationSeconds += dt;
    // Orbit counter on +x crossings (prograde).
    const ang = Math.atan2(ctx.sim.state.y, ctx.sim.state.x);
    if (ctx.state.lastAngle < 0 && ang >= 0 && ctx.state.lastAngle < -0.1) ctx.state.orbits++;
    ctx.state.lastAngle = ang;
    return { scoreDelta: tel.altKm >= tgt ? dt : 0 };
  },
  objective(ctx, tel) {
    const s = ctx.state || {};
    return {
      label: `Hold ≥ ${ctx.targetAltKm} km · station ${Math.floor(s.stationSeconds || 0)} s`,
      progress: Math.min(1, (s.stationSeconds || 0) / 1800),
      status: tel.periAltKm < ctx.targetAltKm - 25 ? 'warn'
            : tel.periAltKm < 180 ? 'bad' : 'good',
      extras: { orbits: s.orbits || 0 },
    };
  },
  score(ctx) {
    const s = ctx.state || {};
    return Math.floor((s.stationSeconds || 0) + (s.orbits || 0) * 50);
  },
  // Station-keeping is fundamentally an endurance/efficiency game, so
  // the scorecard highlights on-station time + orbits completed and
  // calls out fuel waste (any Δv spent climbing >25 km above target).
  scorecard(stats, ctx) {
    const s = ctx?.state || {};
    return {
      rows: [
        { lbl: 'On-station time', val: `${Math.floor(s.stationSeconds || 0)} s` },
        { lbl: 'Orbits completed', val: String(s.orbits || 0) },
      ],
      tip: stats.bonusDvDelivered > 5
        ? 'You captured a forecast peak — that 2× window is the cheapest re-boost you can buy. Watch the radar.'
        : 'Re-boost burns deep in the gravity well (near perigee) give you the most Δenergy per Δv (the Oberth effect).',
    };
  },
};

// ─── 2) CME SURVIVAL ────────────────────────────────────────────────────────
// A quiet sun for 120 s, then a flare → density spikes. The pilot must feather
// (low-drag attitude) and re-boost to hold altitude.
export const cmeSurvival = {
  id: 'cme',
  name: 'CME Survival',
  blurb: 'A coronal mass ejection arrives at T+120 s. F10.7 → 260, Ap → 250. Feather and re-boost!',
  tip: 'Geomag storms can multiply density 3–10× at 400 km. Operators get NOAA G-scale alerts hours ahead.',
  defaults: { periKm: 380, apoKm: 380, tgtKm: 380, throttle: 70,
              swPreset: 'quiet', attitude: 'nominal', fuelMass: 80 },
  // Storm-time floor is generous — the projected-perigee model spikes during
  // the CME and the pilot needs warning, not punishment.
  altitudeFloorKm: 340,
  lookaheadOrbits: 6,
  setup(ctx) {
    ctx.state = { phase: 'quiet', triggerT: 120, stormSeconds: 0,
                  belowTarget: 0, lostAltAtTrigger: false };
    ctx.setBanner('Quiet sun — calibrate your station-keep before T+120 s', 'good');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    const tgt = ctx.targetAltKm;
    // Trigger storm.
    if (st.phase === 'quiet' && ctx.sim.state.t >= st.triggerT) {
      st.phase = 'storm';
      ctx.env.f107Sfu = 260; ctx.env.ap = 250;
      ctx.setBanner('🌞 CME IMPACT — density spiking. Feather & re-boost!', 'warn');
      ctx.event('cme');
    }
    if (st.phase === 'storm') {
      st.stormSeconds += dt;
      if (tel.altKm < tgt - 5) st.belowTarget += dt;
    }
    // Score: every storm-second above target is gold. Bonus for low fuel use.
    const inStorm = st.phase === 'storm';
    const onStation = tel.altKm >= tgt - 2;
    return { scoreDelta: inStorm && onStation ? 2 * dt : (onStation ? 0.4 * dt : 0) };
  },
  objective(ctx, tel) {
    const st = ctx.state || {};
    const tgt = ctx.targetAltKm;
    const remaining = Math.max(0, st.triggerT - (ctx.sim.state?.t || 0));
    const label = st.phase === 'storm'
      ? `STORM · hold ≥ ${tgt} km · ${Math.floor(st.stormSeconds)} s`
      : `Quiet sun · CME in ${Math.ceil(remaining)} s`;
    return {
      label,
      progress: st.phase === 'storm' ? Math.min(1, st.stormSeconds / 600) : 1 - remaining / 120,
      status: tel.altKm < tgt - 25 ? 'bad'
            : (st.phase === 'storm' ? 'warn' : 'good'),
      extras: { 'F10.7': Math.round(ctx.env.f107Sfu), Ap: Math.round(ctx.env.ap) },
    };
  },
  // CME survival rewards pre-storm conditioning — burns timed BEFORE the
  // density spike are far cheaper than fighting through it. The
  // scorecard surfaces whether the player exploited the bonus window.
  scorecard(stats, ctx) {
    const st = ctx?.state || {};
    return {
      rows: [
        { lbl: 'Phase reached', val: st.phase === 'storm' ? 'STORM' : 'Quiet' },
        { lbl: 'Storm seconds', val: `${Math.floor(st.stormSeconds || 0)} s` },
        { lbl: 'Below-target time', val: `${Math.floor(st.belowTarget || 0)} s`,
          cls: (st.belowTarget || 0) > 30 ? 'warn' : '' },
      ],
      tip: stats.bonusBurnCount > 0
        ? 'Forecast-aligned burns are the textbook play here — you used the warning lead time well.'
        : 'Next time, schedule a prograde burn during the F10.7 peak window on the radar. The 2× score reflects how much real Δv you save by burning *before* the density wall.',
    };
  },
};

// ─── 3) HOHMANN RENDEZVOUS ─────────────────────────────────────────────────
// Player starts at 300 km circular. A target satellite circulates at 800 km.
// Player must raise apogee, circularize, and approach within 5 km at < 50 m/s.
export const rendezvous = {
  id: 'rendezvous',
  name: 'Hohmann Rendezvous',
  blurb: 'Catch a target at 800 km. Burn prograde at perigee, then again at apogee to circularize.',
  tip: 'Hohmann transfers are minimum-energy two-burn intercepts. Phasing is everything — burn early or late and you miss.',
  defaults: { periKm: 300, apoKm: 300, tgtKm: 800, throttle: 100,
              swPreset: 'quiet', attitude: 'feather', fuelMass: 90 },
  setup(ctx) {
    // Target: circular @ 800 km, start half an orbit ahead.
    const rTgt = ctx.R_EARTH + 800_000;
    const startPhase = Math.PI * 0.9;
    ctx.state = {
      rTgtM: rTgt,
      omegaTgt: Math.sqrt(ctx.MU / (rTgt * rTgt * rTgt)),
      phase: startPhase,
      bestApproachM: Infinity,
      docked: false,
    };
    const p = circleOrbitState(ctx.MU, ctx.R_EARTH, 800, startPhase);
    ctx.setTarget({ x: p.x, y: p.y });
    ctx.setBanner('Raise apogee to 800 km. Aim to arrive when target is overhead.', 'good');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    st.phase = (st.phase + st.omegaTgt * dt) % TAU;
    const tx = st.rTgtM * Math.cos(st.phase);
    const ty = st.rTgtM * Math.sin(st.phase);
    ctx.setTarget({ x: tx, y: ty });

    const dx = ctx.sim.state.x - tx;
    const dy = ctx.sim.state.y - ty;
    const sep = Math.hypot(dx, dy);
    // Closing rate along the separation vector.
    const vRel = Math.hypot(ctx.sim.state.vx, ctx.sim.state.vy)
               - Math.hypot(-st.omegaTgt * ty, st.omegaTgt * tx);

    if (sep < st.bestApproachM) st.bestApproachM = sep;

    // Docking criterion: within 5 km and slow.
    if (!st.docked && sep < 5_000 && Math.abs(vRel) < 50) {
      st.docked = true;
      ctx.setBanner('✅ DOCKED — rendezvous complete', 'good');
      ctx.event('docked');
      return { scoreDelta: 5000, done: true };
    }
    // Reward closing — small positive when distance is decreasing.
    return { scoreDelta: 0 };
  },
  objective(ctx, tel) {
    const st = ctx.state || { bestApproachM: Infinity };
    const sepKm = st.bestApproachM / 1000;
    return {
      label: st.docked ? '🛰 Docked!'
        : `Approach — best ${isFinite(sepKm) ? sepKm.toFixed(1) : '—'} km`,
      progress: isFinite(sepKm) ? Math.max(0, Math.min(1, 1 - sepKm / 5000)) : 0,
      status: sepKm < 5 ? 'good' : sepKm < 50 ? 'warn' : 'bad',
      extras: { 'tgt alt': '800 km' },
    };
  },
  score(ctx) {
    const st = ctx.state || {};
    if (!st.bestApproachM || !isFinite(st.bestApproachM)) return 0;
    const km = st.bestApproachM / 1000;
    const base = Math.max(0, 2000 - km * 5);
    return Math.floor(base + (st.docked ? 5000 : 0));
  },
};

// ─── 4) CONTROLLED DEORBIT ─────────────────────────────────────────────────
// End-of-life disposal. Player must lower perigee into a re-entry window
// (60-90 km) so the satellite breaks up safely. Score: how close to 70 km
// perigee on the final orbit, with fuel-efficiency bonus.
export const deorbit = {
  id: 'deorbit',
  name: 'Controlled Deorbit',
  blurb: 'End-of-life disposal: lower perigee to 60–90 km. Burn retrograde, conserve fuel.',
  tip: 'Real operators target a specific re-entry interface (~80 km) over open ocean to keep debris off populated areas.',
  defaults: { periKm: 450, apoKm: 450, tgtKm: 70, throttle: 80,
              swPreset: 'quiet', attitude: 'nominal', fuelMass: 25 },
  setup(ctx) {
    ctx.state = { reachedWindow: false, finalPeriKm: null, fuelStart: ctx.design.fuelMass };
    ctx.setBanner('Burn RETROGRADE to lower perigee. Aim for 60–90 km.', 'good');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    if (!st.reachedWindow && tel.periAltKm >= 60 && tel.periAltKm <= 90) {
      st.reachedWindow = true;
      ctx.setBanner(`🎯 Re-entry window achieved — perigee ${tel.periAltKm.toFixed(0)} km`, 'good');
    }
    if (!ctx.sim.state.alive) {
      st.finalPeriKm = tel.periAltKm;
      return { done: true };
    }
    return {};
  },
  objective(ctx, tel) {
    const st = ctx.state || {};
    const pk = tel.periAltKm;
    const inWindow = pk >= 60 && pk <= 90;
    return {
      label: st.reachedWindow ? `Window locked · perigee ${pk.toFixed(0)} km`
        : `Lower perigee to 60–90 km · now ${pk.toFixed(0)} km`,
      progress: Math.max(0, Math.min(1, (450 - pk) / (450 - 75))),
      status: inWindow ? 'good' : pk < 60 ? 'bad' : pk < 200 ? 'warn' : '',
      extras: {},
    };
  },
  score(ctx) {
    const st = ctx.state || {};
    if (!st.reachedWindow) return Math.floor(Math.max(0, 600 - Math.abs((ctx.lastPeriKm || 450) - 75) * 4));
    const fuelUsed = (st.fuelStart || 0) - (ctx.sim.state?.fuel || 0);
    const eff = Math.max(0, 1500 - fuelUsed * 30);   // efficient burns reward
    const accuracy = 2500 - Math.min(2500, Math.abs((ctx.lastPeriKm || 75) - 75) * 60);
    return Math.floor(1500 + accuracy + eff);
  },
};

// ─── 5) COLLISION AVOIDANCE ────────────────────────────────────────────────
// A debris fragment is on an intercept course. The player has ~90 s to
// execute an avoidance burn (typically radial-out or prograde) to bring miss
// distance above 5 km. Realistic operator drill.
export const avoidance = {
  id: 'avoid',
  name: 'Conjunction Avoidance',
  blurb: 'A debris fragment is on intercept. Burn to push miss distance above 5 km before TCA.',
  tip: 'Real CARA teams (18 SDS) issue conjunction data messages 72 h ahead. A few cm/s burn can avert disaster.',
  defaults: { periKm: 420, apoKm: 420, tgtKm: 420, throttle: 50,
              swPreset: 'quiet', attitude: 'nominal', fuelMass: 50 },
  altitudeFloorKm: 380,
  lookaheadOrbits: 4,
  setup(ctx) {
    // Debris on a near-coplanar slightly-elliptical orbit, phased to cross
    // the player's path ~90 s after launch.
    const TCA = 90;
    const periKm = 350, apoKm = 500;
    const a = ctx.R_EARTH + (periKm + apoKm) / 2 * 1000;
    const omega = Math.sqrt(ctx.MU / (a * a * a));
    // Place debris angularly so that at t=TCA both satellites are near the
    // same point on the +x axis. Player starts at +x moving +y.
    const playerOmega = Math.sqrt(ctx.MU /
      Math.pow(ctx.R_EARTH + 420_000, 3));
    const playerAng = playerOmega * TCA;       // where player will be
    const debrisAng = playerAng - omega * TCA - Math.PI; // counter-rotating, meets head-on
    // We'll keep it simple: debris travels on a circular orbit at the same r
    // as the player but retrograde, phased to meet at TCA.
    const rPlayer = ctx.R_EARTH + 420_000;
    ctx.state = {
      tca: TCA, rDeb: rPlayer, omegaDeb: -playerOmega * 1.0,
      phase: playerAng - (-playerOmega) * TCA,
      bestMiss: Infinity, passed: false, missAtTCA: null,
    };
    const d = { x: rPlayer * Math.cos(ctx.state.phase),
                y: rPlayer * Math.sin(ctx.state.phase) };
    ctx.setDebris(d);
    ctx.setBanner(`🚨 CONJUNCTION ALERT · TCA in ${TCA} s · burn to >5 km miss`, 'warn');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    st.phase = (st.phase + st.omegaDeb * dt) % TAU;
    const dx_ = st.rDeb * Math.cos(st.phase);
    const dy_ = st.rDeb * Math.sin(st.phase);
    ctx.setDebris({ x: dx_, y: dy_ });

    const sep = Math.hypot(ctx.sim.state.x - dx_, ctx.sim.state.y - dy_);
    if (sep < st.bestMiss) st.bestMiss = sep;
    if (!st.passed && ctx.sim.state.t >= st.tca) {
      st.passed = true;
      st.missAtTCA = sep;
      const safe = sep > 5000;
      ctx.setBanner(safe
        ? `✅ TCA passed — miss ${(sep/1000).toFixed(2)} km. Crew safe.`
        : `💥 TCA passed — miss only ${(sep/1000).toFixed(2)} km. Asset damaged.`,
        safe ? 'good' : 'bad');
      ctx.event(safe ? 'avoid-ok' : 'avoid-fail');
      return { scoreDelta: safe ? Math.min(8000, sep) : 0, done: true };
    }
    return {};
  },
  objective(ctx, tel) {
    const st = ctx.state || {};
    const t = ctx.sim.state?.t || 0;
    const remaining = Math.max(0, (st.tca || 0) - t);
    const missKm = (st.bestMiss === Infinity ? null : st.bestMiss / 1000);
    return {
      label: st.passed
        ? `Closest approach ${missKm.toFixed(2)} km`
        : `TCA in ${remaining.toFixed(0)} s · best miss ${missKm ? missKm.toFixed(2) + ' km' : '—'}`,
      progress: st.passed ? 1 : 1 - remaining / (st.tca || 90),
      status: missKm == null ? '' : missKm < 1 ? 'bad' : missKm < 5 ? 'warn' : 'good',
      extras: {},
    };
  },
  score(ctx) {
    const st = ctx.state || {};
    if (st.missAtTCA == null) return 0;
    return Math.floor(Math.min(8000, st.missAtTCA) + (st.missAtTCA > 5000 ? 2000 : 0));
  },
};

// ─── Hindcast helpers ─────────────────────────────────────────────────────
// A small piecewise-linear interpolator used by the two hindcast missions
// below to script F10.7 / Ap profiles in sim seconds. Keypoints are an
// array of [tSec, value] pairs, monotonic in t. Values before the first
// or after the last keypoint are clamped.
function _piecewise(t, keypoints) {
  if (!keypoints.length) return 0;
  if (t <= keypoints[0][0]) return keypoints[0][1];
  if (t >= keypoints[keypoints.length - 1][0]) return keypoints[keypoints.length - 1][1];
  for (let i = 0; i < keypoints.length - 1; i++) {
    const [t0, v0] = keypoints[i], [t1, v1] = keypoints[i + 1];
    if (t >= t0 && t <= t1) {
      const a = (t - t0) / Math.max(t1 - t0, 1e-6);
      return v0 + a * (v1 - v0);
    }
  }
  return keypoints[keypoints.length - 1][1];
}

// Forecast horizon → sim-time mapping for hindcasts. The radar fetches
// horizons 0..6 hours; we compress the real-world hindcast timeline so
// the radar's 6-hour lookahead spans roughly one mission window. At
// 1200 s/hr → +6 h forecast = +7200 sim sec ≈ 2 orbital passes.
const HINDCAST_SIM_SEC_PER_FORECAST_HOUR = 1200;

// Build a `setMissionOverride(fn)` payload that returns the scripted
// F10.7/Ap *projected forward* by the forecast horizon. Includes the
// `forcing` envelope so the radar can draw its benign/adverse band.
function _makeScriptedOverride(scriptFn, sim) {
  return (horizonHours) => {
    const t = (sim.state?.t || 0) + horizonHours * HINDCAST_SIM_SEC_PER_FORECAST_HOUR;
    const { f107, ap } = scriptFn(t);
    // Uncertainty grows with horizon — same shape as the live AR(1)
    // projector. ~5% σ at h=0, climbing linearly to ~25% at h=6.
    const sigmaF107 = f107 * (0.05 + 0.033 * Math.min(horizonHours, 6));
    const sigmaAp   = ap   * (0.10 + 0.05  * Math.min(horizonHours, 6));
    return {
      horizonHours,
      f107, ap, sigmaF107, sigmaAp,
      skill: Math.max(0.2, 1 - 0.12 * horizonHours),
      forcing: {
        nominal: { f107, ap },
        benign:  { f107: Math.max(60, f107 - sigmaF107), ap: Math.max(0, ap - sigmaAp) },
        adverse: { f107: f107 + sigmaF107, ap: ap + sigmaAp },
      },
    };
  };
}

// ─── 6) STARLINK FEB 2022 HINDCAST ─────────────────────────────────────────
// On 3 Feb 2022, SpaceX deployed Group 4-7 into a 210×340 km insertion
// orbit. A G2-class storm arrived the next day; atmospheric density at
// 210 km ran ~50% above NRLMSIS predictions. 38 of 49 satellites failed
// to raise their orbits before drag won. Mission: do better than the
// fleet did — get perigee above 350 km before fuel runs out or re-entry.
//
// Storm script in sim seconds (compressed real-world 24-hour event):
//   0–1800     quiet — F10.7=120, Ap=10 (deployment, calibration burns)
//   1800–2400  ramp  — F10.7 120→165, Ap 10→50 (G2 onset)
//   2400–5400  hold  — F10.7=165, Ap=50 (storm main phase)
//   5400–7200  decay — F10.7 165→125, Ap 50→12 (recovery)
//
// Mission window 0..10800 s (3 hours sim time ≈ 2 orbital passes at the
// deployment altitude). At warp ×100 this is ~108 real-seconds — long
// enough to read the radar, plan an apogee burn, and execute.
export const starlink2022 = {
  id: 'starlink2022',
  name: 'Starlink · Feb 2022',
  blurb: '210 km deployment orbit. A G2 storm hits in 30 min. Raise perigee above 350 km before drag wins.',
  tip: 'Real event: 38 of 49 Starlinks lost. Density at 210 km ran ~50% above NRLMSIS — a moderate storm at high altitude is a deadly one at deployment altitude.',
  defaults: { periKm: 210, apoKm: 340, tgtKm: 380, throttle: 80,
              swPreset: 'nominal', attitude: 'nominal',
              // Starlink-broom drag config (16 m² frontal area at deployment)
              // is what makes the 210-km insertion deadly. Mass + thrust are
              // game-scaled (real Hall-effect = 0.05 N over 24 h of burns;
              // here compressed to chemical-class with the same Δv budget).
              dryMass: 60, fuelMass: 25, area: 16, cd: 2.2,
              thrust: 18, isp: 230 },
  altitudeFloorKm: 180,
  lookaheadOrbits: 4,
  setup(ctx) {
    ctx.state = {
      phase: 'quiet', peakPeri: 210, won: false, missionEndT: 10800,
    };
    const f107KP = [[0,120],[1800,120],[2400,165],[5400,165],[7200,125],[10800,120]];
    const apKP   = [[0,10], [1800,10], [2400,50], [5400,50], [7200,15], [10800,10]];
    // Real Feb 2022 density at 210 km ran ~1.5× over NRLMSIS. We mirror
    // that overrun in the storm window so the hindcast bites accurately.
    const densityMulKP = [[0,1], [1800,1], [2400,1.5], [5400,1.5], [7200,1.05], [10800,1]];
    ctx.state._script = (t) => ({
      f107: _piecewise(t, f107KP),
      ap:   _piecewise(t, apKP),
      densityMul: _piecewise(t, densityMulKP),
    });
    ctx.setForecastOverride?.(_makeScriptedOverride(ctx.state._script, ctx.sim));
    ctx.setBanner('Quiet sun · G2 storm forecast in 30 min — pre-burn before density rises.', 'good');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    const t = ctx.sim.state.t;
    const { f107, ap, densityMul } = st._script(t);
    ctx.env.f107Sfu = f107; ctx.env.ap = ap;
    if (densityMul != null) ctx.env.densityMul = densityMul;

    // Phase transitions for banner storytelling — 30-min lead time is
    // the educational beat: the player should USE the forecast.
    if (st.phase === 'quiet' && t >= 1800) {
      st.phase = 'onset';
      ctx.setBanner('🌞 G2 onset — density climbing through deployment altitude.', 'warn');
      ctx.event?.('storm-onset');
    } else if (st.phase === 'onset' && t >= 5400) {
      st.phase = 'recovery';
      ctx.setBanner('Storm easing — but drag at 210 km is still brutal.', 'warn');
    } else if (st.phase === 'recovery' && t >= 7200) {
      st.phase = 'clear';
      ctx.setBanner('', '');
    }

    if (tel.periAltKm > st.peakPeri) st.peakPeri = tel.periAltKm;

    // Win: reach 350 km perigee. The 38-of-49 fleet didn't.
    if (!st.won && tel.periAltKm >= 350) {
      st.won = true;
      return { event: 'orbit-raised', done: true, scoreDelta: 5000 };
    }
    // Timeout-loss: ran out the clock without raising the orbit.
    if (t >= st.missionEndT) return { event: 'timeout', fail: true, done: true };
    // Out-of-fuel + below 230 km = de facto loss (drag will finish the job).
    if (ctx.sim.state.fuel <= 0 && tel.periAltKm < 230) {
      return { event: 'fuel-out', fail: true };
    }
    return {};
  },
  teardown(ctx) {
    // Clear the override so other missions see live forecast data, and
    // un-pin densityMul so post-mission sandboxing returns to climate.
    ctx.setForecastOverride?.(null);
    if (ctx?.env) ctx.env.densityMul = 1;
  },
  objective(ctx, tel) {
    const st = ctx.state || {};
    const t = ctx.sim.state?.t || 0;
    return {
      label: st.won
        ? `🎯 Perigee ${tel.periAltKm.toFixed(0)} km — orbit raised`
        : `Raise perigee to 350 km · best ${st.peakPeri.toFixed(0)} km · phase ${st.phase || 'quiet'}`,
      progress: st.won ? 1 : Math.max(0, Math.min(1, (tel.periAltKm - 210) / 140)),
      status: tel.periAltKm < 200 ? 'bad'
            : tel.periAltKm < 300 ? 'warn' : 'good',
      extras: {
        'F10.7': Math.round(ctx.env.f107Sfu),
        Ap: Math.round(ctx.env.ap),
        T: Math.floor(t) + 's',
      },
    };
  },
  score(ctx) {
    const st = ctx.state || {};
    // Base = peak perigee gained (200 baseline). Big bonus for orbit-raise win.
    const gain = Math.max(0, (st.peakPeri || 210) - 210);
    return Math.floor(gain * 15 + (st.won ? 5000 : 0));
  },
  scorecard(stats, ctx) {
    const st = ctx?.state || {};
    return {
      rows: [
        { lbl: 'Best perigee reached', val: `${(st.peakPeri || 210).toFixed(0)} km`,
          cls: (st.peakPeri || 0) < 250 ? 'warn' : '' },
        { lbl: 'Orbit raised to 350 km?', val: st.won ? '✅ yes' : '❌ no',
          cls: st.won ? '' : 'bad' },
        { lbl: 'Mission phase reached',   val: st.phase || 'quiet' },
      ],
      tip: st.won
        ? 'You did what the real fleet could not — 38 of 49 Starlinks were lost in this exact scenario. Reading the forecast and burning early is the lesson NRLMSIS missed.'
        : 'The real fleet faced the same fate. Try pre-burning before T+90 s next time — every kg of fuel spent at 210 km is worth ~3× the same Δv at 400 km (Oberth).',
    };
  },
};

// ─── 7) GANNON STORM HINDCAST · MAY 2024 ───────────────────────────────────
// The strongest geomagnetic storm since 2003 (G5 extreme, 10–12 May 2024).
// Multiple CME impacts in series; F10.7 spiked above 250 SFU and Ap
// saturated near 200. ISS-class altitudes saw 3–10× nominal density.
// Mission: stay on-station at 380 km through a two-pulse G3→G5 sequence.
//
// Storm script in sim seconds (compressed real-world 24-hour storm):
//   0–1200      calm before — F10.7=150, Ap=15
//   1200–2400   first CME ramp — F10.7 150→230, Ap 15→100 (G3)
//   2400–4800   G3 main phase
//   4800–6000   lull — F10.7 230→210, Ap 100→60
//   6000–7200   second CME ramp — F10.7 210→245, Ap 60→200 (G5)
//   7200–10800  G5 peak hold
//   10800–13200 ramp down — F10.7 245→200, Ap 200→80
//   13200–14400 recovery — F10.7 200→175, Ap 80→40
//
// Mission window 0..14400 s (4 hours sim time ≈ 3 orbital passes at
// 380 km). At warp ×100 → 144 real-sec; at ×1000 → 14 real-sec.
export const gannon2024 = {
  id: 'gannon2024',
  name: 'Gannon · May 2024',
  blurb: 'Operational LEO at 320 km. A two-pulse G5 storm is inbound over 4 hours. Hold perigee above 305 km.',
  tip: 'Real event: strongest storm since 2003. F10.7 hit 250+ SFU, Ap saturated near 200. The May 2024 Gannon storm is the canonical G5 hindcast for LEO drag.',
  defaults: { periKm: 320, apoKm: 320, tgtKm: 320, throttle: 65,
              swPreset: 'nominal', attitude: 'nominal',
              // 320 km circular + 20 m² ram area: peak G5 drops perigee
              // ~21 km over the storm window. Forces the player to
              // actually use the radar + plan re-boosts. Mass + thrust
              // scaled for a playable Δv budget.
              dryMass: 70, fuelMass: 45, area: 20, cd: 2.4,
              thrust: 24, isp: 240 },
  altitudeFloorKm: 305,
  lookaheadOrbits: 6,
  setup(ctx) {
    ctx.state = {
      phase: 'calm', breachSec: 0, pulses: 0, survived: false,
      onStationSec: 0, missionEndT: 14400,
    };
    const f107KP = [
      [0,150],   [1200,150], [2400,230], [4800,230], [6000,210], [7200,245],
      [10800,245],[13200,200],[14400,175],[15000,160],
    ];
    const apKP = [
      [0,15],    [1200,15],  [2400,100], [4800,100], [6000,60],  [7200,200],
      [10800,200],[13200,80], [14400,40], [15000,20],
    ];
    // Real Gannon density ran 2–3× over NRLMSIS climate at LEO — saturation
    // of joule heating + ion-drag effects above the model's calibration
    // regime. Two-pulse profile mirrors the F10.7/Ap shape.
    const densityMulKP = [
      [0,1],     [1200,1],   [2400,2.0], [4800,2.0], [6000,1.6], [7200,3.0],
      [10800,3.0],[13200,1.6],[14400,1.2],[15000,1],
    ];
    ctx.state._script = (t) => ({
      f107: _piecewise(t, f107KP),
      ap:   _piecewise(t, apKP),
      densityMul: _piecewise(t, densityMulKP),
    });
    ctx.setForecastOverride?.(_makeScriptedOverride(ctx.state._script, ctx.sim));
    ctx.setBanner('Calm before the storm · two CMEs forecast at T+20 min and T+2 h.', 'good');
  },
  tick(ctx, dt, tel) {
    const st = ctx.state;
    const t = ctx.sim.state.t;
    const { f107, ap, densityMul } = st._script(t);
    ctx.env.f107Sfu = f107; ctx.env.ap = ap;
    if (densityMul != null) ctx.env.densityMul = densityMul;

    if (st.phase === 'calm' && t >= 1200) {
      st.phase = 'pulse1'; st.pulses = 1;
      ctx.setBanner('🌞 First CME impact — G3 onset. Density rising fast.', 'warn');
      ctx.event?.('cme-pulse-1');
    } else if (st.phase === 'pulse1' && t >= 4800) {
      st.phase = 'lull';
      ctx.setBanner('Brief lull — second CME 20 min out. Top off perigee now.', 'warn');
    } else if (st.phase === 'lull' && t >= 6000) {
      st.phase = 'pulse2'; st.pulses = 2;
      ctx.setBanner('🔥 Second CME — G5 extreme. Hold perigee above 305 km.', 'bad');
      ctx.event?.('cme-pulse-2');
    } else if (st.phase === 'pulse2' && t >= 10800) {
      st.phase = 'recovery';
      ctx.setBanner('Storm peak passed — long recovery tail ahead.', 'warn');
    } else if (st.phase === 'recovery' && t >= 14400) {
      st.phase = 'clear';
      ctx.setBanner('✅ Survived the storm window.', 'good');
    }

    if (tel.altKm >= 315) st.onStationSec += dt;
    if (tel.periAltKm < 305) st.breachSec += dt;

    // Win at T+14400 if alive — quality determined by breach budget.
    if (!st.survived && t >= st.missionEndT && ctx.sim.state.alive) {
      st.survived = true;
      const ok = st.breachSec < 300;     // 5-minute breach budget across the 4-hour storm
      return {
        event: ok ? 'storm-survived' : 'storm-survived-degraded',
        done: true,
        scoreDelta: ok ? 6000 : 2500,
      };
    }
    // Score trickle: each on-station second is worth 1 pt, doubled during
    // pulse2 (the G5 peak — the moment when on-station is most valuable).
    const tickPts = (tel.altKm >= 315 ? (st.phase === 'pulse2' ? 2 : 1) : 0) * dt;
    return { scoreDelta: tickPts };
  },
  teardown(ctx) {
    ctx.setForecastOverride?.(null);
    if (ctx?.env) ctx.env.densityMul = 1;
  },
  objective(ctx, tel) {
    const st = ctx.state || {};
    const t = ctx.sim.state?.t || 0;
    const endT = st.missionEndT || 14400;
    const remaining = Math.max(0, endT - t);
    return {
      label: st.survived
        ? `🏆 Storm survived (${st.breachSec.toFixed(0)} s breach total)`
        : `Hold 320 km · ${st.phase || 'calm'} · ${Math.ceil(remaining / 60)} min left · breach ${st.breachSec.toFixed(0)} s`,
      progress: Math.min(1, t / endT),
      status: tel.periAltKm < 305 ? 'bad'
            : tel.periAltKm < 315 ? 'warn' : 'good',
      extras: {
        'F10.7': Math.round(ctx.env.f107Sfu),
        Ap: Math.round(ctx.env.ap),
        pulses: st.pulses || 0,
      },
    };
  },
  score(ctx) {
    const st = ctx.state || {};
    const onStation = Math.floor(st.onStationSec || 0);
    const survivedBonus = st.survived ? (st.breachSec < 300 ? 6000 : 2500) : 0;
    const breachPenalty = Math.floor((st.breachSec || 0) * 2);
    return Math.max(0, onStation + survivedBonus - breachPenalty);
  },
  scorecard(stats, ctx) {
    const st = ctx?.state || {};
    return {
      rows: [
        { lbl: 'CME pulses faced',   val: String(st.pulses || 0) },
        { lbl: 'On-station time',    val: `${Math.floor(st.onStationSec || 0)} s` },
        { lbl: 'Floor breach time',  val: `${(st.breachSec || 0).toFixed(0)} s`,
          cls: (st.breachSec || 0) > 300 ? 'bad' : (st.breachSec || 0) > 60 ? 'warn' : '' },
        { lbl: 'Storm window survived?',
          val: st.survived ? (st.breachSec < 300 ? '✅ clean' : '⚠ degraded') : '❌ no',
          cls: st.survived ? (st.breachSec < 300 ? '' : 'warn') : 'bad' },
      ],
      tip: st.survived && st.breachSec < 300
        ? 'A clean survival of the Gannon hindcast. The two-pulse pattern is the real storm signature — operators who saw the second CME coming saved fleets.'
        : 'The Gannon storm was the strongest since 2003. The two-pulse pattern requires reading the forecast: the lull at T+80 min is your last cheap-Δv window before the G5 hits.',
    };
  },
};

// ─── Registry ──────────────────────────────────────────────────────────────
export const MISSIONS = {
  station: stationKeeper,
  cme: cmeSurvival,
  rendezvous,
  deorbit,
  avoid: avoidance,
  starlink2022,
  gannon2024,
};
// Ordering puts the historical hindcasts after the classic scenarios —
// they're the highest-physics-fidelity content and reward radar use.
export const MISSION_ORDER = [
  'station', 'cme', 'rendezvous', 'deorbit', 'avoid',
  'starlink2022', 'gannon2024',
];
