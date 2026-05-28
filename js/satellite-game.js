/**
 * satellite-game.js — entry for the phase-gated satellite-game shell.
 *
 * Wires the store, scene, overlays and transition controllers, runs the main
 * loop, and steps the real Parker flight engine in `tickFlight()`. The toy
 * linear-drag model from the original bundle scaffold has been replaced by
 * calls into `satellite-designer-engine.js` (RK4, thermosphere density,
 * Tsiolkovsky), so HUD readouts come from the same physics pipeline that
 * drives `satellite-designer.html`.
 *
 * State plumbing:
 *   - `engineState` / `design` / `env` / `control` live module-private so the
 *     RK4 stepper can mutate without copy-thrash through the store.
 *   - The store's `flight` object is the UI-visible projection, written each
 *     tick from `ENG.telemetry()`.
 *   - `burnHeld` is the SPACE / burn-button latch; it gates `control.throttle`
 *     so the engine only fires while the pilot is holding the input.
 */
import './telemetry.js';
import * as ENG from './satellite-designer-engine.js';
import { gameStore, PHASES } from './satellite-game-store.js';
import { SceneController } from './satellite-game-scene.js';
import { OverlayController } from './satellite-game-overlays.js';
import { TransitionController } from './satellite-game-transitions.js';

// ── DOM hooks ───────────────────────────────────────────────────────────────
const canvas = document.getElementById('world');
const overlayRoot = document.getElementById('ui-overlay');
const veil = document.getElementById('transition-veil');

const scene = new SceneController(canvas);
const transitions = new TransitionController(veil);
const overlays = new OverlayController(overlayRoot, { onAction: handleAction });

// ── Ship presets — minimal hardcoded set. Once the parts bay is reused
//    from satellite-designer, replace this with BUILDER.deriveDesign().
const SHIPS = {
  'falcon-lite': { dryMass: 120, fuelMass: 60,  area: 1.2, cd: 2.2, thrust: 22, isp: 225, engine: 'monoprop' },
  'sparrow-ii':  { dryMass: 180, fuelMass: 110, area: 1.5, cd: 2.2, thrust: 35, isp: 280, engine: 'biprop'   },
};

// Default mission: 400 km circular through a moderately active thermosphere.
// Matches the bundle's hard-coded m03 briefing copy until missions wire in.
const MISSION_DEFAULT = {
  periKm: 400, apoKm: 400,
  env: { f107Sfu: 180, ap: 48, gravityMul: 1 },
};

// UI burn-vector chips use 'retro'; the engine speaks 'retrograde'.
const VEC_TO_MODE = {
  off: 'off',
  prograde: 'prograde',
  retro: 'retrograde',
  'radial-out': 'radial-out',
  'radial-in': 'radial-in',
};

// ── Engine state (module-private so RK4 can mutate without store thrash) ────
let engineState = null;
let design = null;
let env = { ...ENG.defaultEnv(), ...MISSION_DEFAULT.env };
let control = { throttle: 0.8, mode: 'off', attitudeMult: 1, heading: 0 };
let scoreAccum = 0;
let bestAltHeld = 0;
let runActive = false;

let lastTime = performance.now();
let burnHeld = false;

scene.setStage(PHASES.TITLE);
overlays.showPhase(PHASES.TITLE);

gameStore.subscribe((state) => {
  overlays.updateHud(state.flight);
  overlays.updateBriefing(state.mission);
  if (state.result) overlays.updateResolution(state.result);
});

requestAnimationFrame(loop);
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (gameStore.phase === PHASES.FLIGHT) {
    tickFlight(dt);
  }

  scene.tick(dt, now);
  requestAnimationFrame(loop);
}

// ── Flight tick — real RK4 step from satellite-designer-engine.js ──────────
function tickFlight(dt) {
  if (!engineState || !engineState.alive || !runActive) return;
  const f = gameStore.get().flight;

  // Time warp is capped per-frame so a thousand-times warp can't skip a whole
  // perigee in a single step at LEO altitudes. The engine's `advance()` does
  // its own altitude-adaptive sub-stepping below this cap.
  const simSecs = Math.min(dt * f.warp, 240);

  // Burn input + vector chip together determine the engine's mode/throttle.
  const requestedMode = VEC_TO_MODE[f.vector] || 'off';
  control.mode = (burnHeld && requestedMode !== 'off') ? requestedMode : 'off';
  control.throttle = control.mode === 'off' ? 0 : f.throttle;

  const adv = ENG.advance(engineState, design, env, control, simSecs);
  engineState = adv.state;
  const tel = ENG.telemetry(engineState, design, env, control.attitudeMult);

  // Score model: reward holding altitude above the mission target, with a
  // bonus for burns that happen while *also* above target (i.e. productive
  // station-keeping rather than panic-firing on the way down).
  if (tel.altKm > 380) scoreAccum += simSecs * 0.5;
  if (control.throttle > 0 && tel.altKm > 380) scoreAccum += simSecs * 2;
  if (tel.altKm > bestAltHeld) bestAltHeld = tel.altKm;

  // Storm-peak ETA — placeholder countdown until the forecast module is
  // wired in (PR #787 added it; integration tracked in the README).
  const stormPeakEta = Math.max(0, 600 - tel.missionTime);

  gameStore.patch({ flight: {
    altKm: tel.altKm,
    peKm: tel.periAltKm,
    apKm: isFinite(tel.apoAltKm) ? tel.apoAltKm : tel.altKm,
    dvLeft: tel.dvRemaining,
    elapsed: tel.missionTime,
    burning: tel.fuel > 0 && control.throttle > 0 && control.mode !== 'off',
    score: Math.round(scoreAccum),
    stormPeakEta: stormPeakEta > 0 && stormPeakEta < 599 ? stormPeakEta : null,
  } });

  // End conditions: re-entry, hard ceiling on mission length, or alt<100km
  // even before the engine flips alive=false (sim instability guard).
  if (!engineState.alive || tel.altKm < 100 || tel.missionTime > 1800) {
    finishRun(tel);
  }
}

function startFlight() {
  const shipKey = gameStore.get().ship || 'falcon-lite';
  const ship = SHIPS[shipKey] || SHIPS['falcon-lite'];
  design = ENG.makeDesign(ship);
  env = { ...ENG.defaultEnv(), ...MISSION_DEFAULT.env };
  engineState = ENG.initState(design, {
    periKm: MISSION_DEFAULT.periKm, apoKm: MISSION_DEFAULT.apoKm, env,
  });
  control = { throttle: 0.8, mode: 'off', attitudeMult: 1, heading: 0 };
  scoreAccum = 0; bestAltHeld = 0;
  runActive = true;

  const dvBudget = design.fuelMass > 0
    ? design.isp * ENG.G0 * Math.log((design.dryMass + design.fuelMass) / design.dryMass)
    : 0;

  gameStore.patch({
    flight: {
      altKm: MISSION_DEFAULT.periKm,
      peKm: MISSION_DEFAULT.periKm,
      apKm: MISSION_DEFAULT.apoKm,
      dvLeft: dvBudget,
      elapsed: 0,
      warp: 1,
      score: 0,
      throttle: 0.8,
      vector: 'off',
      burning: false,
      stormPeakEta: 600,
    },
    result: null,
  });
}

function endFlight() {
  burnHeld = false;
  runActive = false;
}

function finishRun(tel) {
  if (!runActive) return;
  runActive = false;
  const dvRemaining = tel?.dvRemaining ?? 0;
  const heldKm = Math.round(bestAltHeld || tel?.altKm || 0);
  const result = {
    summary: `held ${heldKm} km · ${formatElapsed(tel?.missionTime ?? 0)} · ${Math.round(dvRemaining)} m/s Δv remaining`,
    score: Math.round(scoreAccum),
    delta: '+0 vs personal best',
    coach: !tel?.alive
      ? `re-entered at ${Math.round(tel?.altKm ?? 0)} km. start station-keeping burns before perigee drops below 250 km.`
      : dvRemaining < 20
        ? 'you ran the tank dry. start burns earlier in the storm window to spend Δv where it counts.'
        : 'good propellant discipline. try burning closer to the forecast peak for more altitude per m/s.',
  };
  gameStore.patch({ result });
  goToPhase(PHASES.RESOLUTION);
}

function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

async function goToPhase(next, { useCameraMove = false } = {}) {
  const fromFlight = gameStore.phase === PHASES.FLIGHT;
  if (useCameraMove) {
    overlays.showPhase(null);
    await transitions.camera(async () => {
      scene.launchSequence(() => {});
      await wait(1400);
    });
    gameStore.setPhase(next);
    scene.setStage(next);
    overlays.showPhase(next);
    if (next === PHASES.FLIGHT) startFlight();
    return;
  }
  await transitions.fade(async () => {
    gameStore.setPhase(next);
    scene.setStage(next);
    overlays.showPhase(next);
    if (next === PHASES.FLIGHT) startFlight();
    if (fromFlight && next !== PHASES.FLIGHT) endFlight();
  });
}

async function handleAction({ kind, name, value }) {
  if (kind === 'mode') {
    overlays.setSelectedMode(value);
    gameStore.patch({ mode: value });
    return;
  }
  if (kind === 'ship') {
    if (value === 'new') return;
    overlays.setSelectedShip(value);
    gameStore.patch({ ship: value });
    return;
  }
  if (kind === 'vec') {
    gameStore.patch({ flight: { vector: value } });
    return;
  }
  if (kind === 'warp') {
    gameStore.patch({ flight: { warp: value } });
    return;
  }
  if (kind === 'action') {
    switch (name) {
      case 'start':
        await goToPhase(PHASES.GAME_TYPE);
        break;
      case 'confirm-mode':
        if (!gameStore.get().mode) gameStore.patch({ mode: 'campaign' });
        await goToPhase(PHASES.SHIP_SELECT);
        break;
      case 'confirm-ship':
        await goToPhase(PHASES.BRIEFING);
        break;
      case 'launch':
        await goToPhase(PHASES.FLIGHT, { useCameraMove: true });
        break;
      case 'back':
        await goBack();
        break;
      case 'retry':
        await goToPhase(PHASES.BRIEFING);
        break;
      case 'next-mission':
        gameStore.patch({ mission: nextMission(gameStore.get().mission) });
        await goToPhase(PHASES.BRIEFING);
        break;
      case 'hangar':
        await goToPhase(PHASES.SHIP_SELECT);
        break;
      case 'title':
        await goToPhase(PHASES.TITLE);
        break;
      case 'open-menu':
        // Esc / menu button ends the current run; resolution screen takes over.
        if (runActive && engineState) {
          const tel = ENG.telemetry(engineState, design, env, control.attitudeMult);
          finishRun(tel);
        }
        break;
      case 'expand-hud':
        console.log('expand-hud: drawer not yet implemented');
        break;
      case 'open-scores':
      case 'open-options':
      case 'edit-parts':
        console.log(`${name}: not yet implemented`);
        break;
    }
  }
}

async function goBack() {
  const cur = gameStore.phase;
  const back = {
    [PHASES.GAME_TYPE]: PHASES.TITLE,
    [PHASES.SHIP_SELECT]: PHASES.GAME_TYPE,
    [PHASES.BRIEFING]: PHASES.SHIP_SELECT,
  }[cur];
  if (back) await goToPhase(back);
}

function nextMission(current) {
  const id = Number(String(current.id).replace(/\D/g, '')) || 0;
  return {
    id: `m${String(id + 1).padStart(2, '0')}`,
    title: 'hold station at 420 km through a G4 storm',
  };
}

window.addEventListener('keydown', (e) => {
  const phase = gameStore.phase;

  if (phase === PHASES.TITLE && !e.repeat && !['Tab', 'Shift', 'Meta', 'Control', 'Alt'].includes(e.key)) {
    e.preventDefault();
    handleAction({ kind: 'action', name: 'start' });
    return;
  }

  if (phase === PHASES.FLIGHT) {
    if (e.code === 'Space' && !e.repeat) { e.preventDefault(); burnHeld = true; }
    if (e.code === 'Digit1') handleAction({ kind: 'vec', value: 'off' });
    if (e.code === 'Digit2') handleAction({ kind: 'vec', value: 'prograde' });
    if (e.code === 'Digit3') handleAction({ kind: 'vec', value: 'retro' });
    if (e.code === 'Digit4') handleAction({ kind: 'vec', value: 'radial-out' });
    if (e.code === 'Digit5') handleAction({ kind: 'vec', value: 'radial-in' });
    if (e.key === 'Escape') handleAction({ kind: 'action', name: 'open-menu' });
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') burnHeld = false;
});

// Touch/mouse hold-to-burn on the big burn button. Mirrors the desktop
// SPACE-key latch so mobile pilots get the same throttle gate.
document.addEventListener('pointerdown', (e) => {
  if (gameStore.phase !== PHASES.FLIGHT) return;
  if (e.target.closest('.burn-btn')) { burnHeld = true; }
});
document.addEventListener('pointerup', () => { burnHeld = false; });
document.addEventListener('pointercancel', () => { burnHeld = false; });

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
