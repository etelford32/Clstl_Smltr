/**
 * satellite-game-store.js — pub-sub state for the phase-gated game shell.
 *
 * One state tree, six phases. Every HUD readout subscribes to a single
 * listener pool; consumers patch through `gameStore.patch({ flight: {...} })`
 * and the merge is deep so partial flight updates don't blow away unrelated
 * fields.
 */
export const PHASES = Object.freeze({
  TITLE: 'title',
  GAME_TYPE: 'gameType',
  SHIP_SELECT: 'shipSelect',
  BRIEFING: 'briefing',
  FLIGHT: 'flight',
  RESOLUTION: 'resolution',
});

const initialState = {
  phase: PHASES.TITLE,
  mode: null,
  ship: 'falcon-lite',
  mission: { id: 'm03', title: 'hold station at 400 km through a G3 storm' },
  flight: {
    altKm: 400,
    peKm: 389,
    apKm: 412,
    dvLeft: 280,
    elapsed: 0,
    warp: 1,
    score: 0,
    throttle: 0.8,
    vector: 'off',
    burning: false,
    stormPeakEta: null,
  },
  result: null,
};

const listeners = new Set();
let state = structuredClone(initialState);

export const gameStore = {
  get() { return state; },
  get phase() { return state.phase; },
  setPhase(next) { this.patch({ phase: next }); },
  patch(partial) {
    state = mergeDeep(state, partial);
    listeners.forEach((fn) => fn(state));
  },
  reset() {
    state = structuredClone(initialState);
    listeners.forEach((fn) => fn(state));
  },
  subscribe(fn) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },
};

function mergeDeep(target, source) {
  const out = Array.isArray(target) ? [...target] : { ...target };
  for (const key of Object.keys(source)) {
    const sv = source[key];
    const tv = target?.[key];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object') {
      out[key] = mergeDeep(tv, sv);
    } else {
      out[key] = sv;
    }
  }
  return out;
}
