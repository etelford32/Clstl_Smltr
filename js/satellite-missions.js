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

// ─── Registry ──────────────────────────────────────────────────────────────
export const MISSIONS = {
  station: stationKeeper,
  cme: cmeSurvival,
  rendezvous,
  deorbit,
  avoid: avoidance,
};
export const MISSION_ORDER = ['station', 'cme', 'rendezvous', 'deorbit', 'avoid'];
