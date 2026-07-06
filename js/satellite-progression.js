/**
 * Pilot progression — roguelike-style persistent unlocks for the Satellite
 * Designer. Each rank gates a set of controls and abilities; mission
 * completions award XP, which accumulates across runs and persists in
 * localStorage (and is mirrored to the cloud hangar when signed in).
 *
 * Public surface:
 *   RANKS — ordered rank ladder (rank 0 = starting "Cadet").
 *   UNLOCKS — map of every unlock key to its display metadata.
 *   defaultProfile() — fresh-pilot state.
 *   loadProfile() / saveProfile(p) — localStorage I/O.
 *   awardXp(profile, missionId, score, firstTime) — returns { profile, gained, rankedUp, newUnlocks }.
 *   currentRank(profile) — convenience.
 *   hasUnlock(profile, key) — guard for UI/engine.
 *   xpFor(profile) — { total, intoRank, span, nextRankName, atMax }.
 *
 * Design notes
 * ─────────────
 * • XP awards are tuned so the first two ranks come quickly (single mission
 *   each) and later ranks require sustained play with higher scores.
 * • Unlocks are *additive* — once you have them, you keep them. There's no
 *   spec/perk respec. This matches "training" framing: an operator who's
 *   learned a procedure doesn't unlearn it.
 * • Each unlock has a short copy line shown in the Pilot Profile panel
 *   and in the locked-chip tooltip.
 */

export const UNLOCKS = {
  // Tier 0 — Cadet
  auto_keep:     { name: 'Auto-keep',          rank: 0, desc: 'Automated prograde re-boost to defend the target altitude.' },
  prograde:      { name: 'Prograde burn',      rank: 0, desc: 'Burn along the velocity vector to raise the orbit.' },
  retrograde:    { name: 'Retrograde burn',    rank: 0, desc: 'Burn opposite the velocity vector to lower the orbit.' },
  warp_x10:      { name: 'Time warp ×10',      rank: 0, desc: 'Accelerate sim time tenfold.' },
  // Core arcade flight — available from the first launch so new pilots can fly.
  manual_steer:  { name: 'Pilot flight',       rank: 0, desc: 'W/↑ gas · S/↓ ease · A/← · D/→ steer. Arcade attitude control.' },
  // Tier 1 — Pilot
  radial:        { name: 'Radial burns',       rank: 1, desc: 'Radial-out / radial-in for plane shaping & rendezvous.' },
  warp_x100:     { name: 'Time warp ×100',     rank: 1, desc: 'Survey multi-orbit drag decay quickly.' },
  // Tier 2 — Operator
  pulse_fire:    { name: 'Pulse fire',         rank: 2, desc: 'Tap-fire for precise impulse burns (< 1 s).' },
  // Tier 3 — Navigator
  warp_x1000:    { name: 'Time warp ×1000',    rank: 3, desc: 'Long-duration station-keeping & decay analysis.' },
  predict_path: { name: 'Orbit predictor',     rank: 3, desc: 'Project the next orbit before committing to a burn.' },
  // Tier 4 — Flight Director
  fine_throttle: { name: 'Fine throttle',      rank: 4, desc: 'Sub-1% throttle resolution for cm/s conjunction nudges.' },
  rcs_strafe:    { name: 'RCS translation',    rank: 4, desc: 'Lateral nudges decoupled from main propulsion.' },
};

export const RANKS = [
  { id: 0, name: 'Cadet',            min:    0, badge: '🟢' },
  { id: 1, name: 'Pilot',            min:  100, badge: '🔵' },
  { id: 2, name: 'Operator',         min:  300, badge: '🟣' },
  { id: 3, name: 'Navigator',        min:  700, badge: '🟡' },
  { id: 4, name: 'Flight Director',  min: 1500, badge: '🟠' },
  { id: 5, name: 'Mission Cmdr',     min: 3000, badge: '⭐' },
];

const STORAGE_KEY = 'pp_sd_profile_v1';

export function defaultProfile() {
  return {
    xp: 0,
    completions: {}, totalMissions: 0, bestScore: 0,
    // Roguelike *part-tier* progression — orthogonal to rank unlocks.
    // partTiers[slot][key] = 1 | 2 | 3. Tier 1 is free; 2/3 cost spendXp.
    // Tier modifiers are computed by tierMods() at use time so balance
    // changes don't break saved profiles.
    partTiers: {},
    spentXp: 0,
  };
}

// ── Part tiers (Mk I / II / III) ───────────────────────────────────────────
// Each part slot has three tiers. Tier 1 is the base hardware that already
// ships with deriveDesign(); upgrading bumps stats with a small downside so
// upgrades are decisions, not strictly-better. Costs scale per slot to match
// how often you actually swap them.
//
// PART_TIER_COST[tier-1] gives the XP needed to *unlock* that tier on a
// specific part instance. The cost is per-part-per-slot so e.g. upgrading
// monoprop Mk II doesn't also upgrade biprop.
export const PART_TIER_COST = [0, 120, 320];      // Mk I free, II 120 XP, III 320 XP
export const PART_TIER_NAMES = ['Mk I', 'Mk II', 'Mk III'];

/**
 * Modifier multipliers a given tier applies to a part's raw stats. Returned
 * shape matches what buildModified() applies; missing keys default to 1.
 *
 *   massMul       — dry-mass multiplier (lower is better)
 *   thrustMul     — thrust output multiplier
 *   ispMul        — Isp multiplier
 *   gimbalMul     — gimbal authority multiplier
 *   throatLifeMul — erosion-life multiplier
 *   powerMul      — power-generation (panels) or draw (thrusters/payloads) mult
 *   cdMul         — drag-coefficient multiplier (lower is better for parts
 *                   in the airflow; matters at orbital altitudes)
 *   wMul          — solar-wing W/m² multiplier
 */
export function tierMods(slot, tier) {
  if (tier <= 1) return {};
  if (slot === 'thruster') {
    if (tier === 2) return { thrustMul: 1.08, ispMul: 1.05, throatLifeMul: 1.4, massMul: 1.05 };
    if (tier === 3) return { thrustMul: 1.18, ispMul: 1.12, throatLifeMul: 2.2, gimbalMul: 1.6, massMul: 1.12 };
  }
  if (slot === 'body') {
    if (tier === 2) return { massMul: 0.92, cdMul: 0.96, slewMul: 1.12 };
    if (tier === 3) return { massMul: 0.85, cdMul: 0.92, gimbalMul: 1.0 /* reaction-wheel boost handled in engine */, slewMul: 1.28 };
  }
  if (slot === 'panel') {
    if (tier === 2) return { wMul: 1.15, massMul: 0.92 };
    if (tier === 3) return { wMul: 1.32, massMul: 0.78, cdMul: 0.95 };
  }
  if (slot === 'payload') {
    if (tier === 2) return { massMul: 0.92, powerMul: 0.9 };
    if (tier === 3) return { massMul: 0.82, powerMul: 0.78, cdMul: 0.94 };
  }
  return {};
}

export function partTier(profile, slot, key) {
  return profile.partTiers?.[slot]?.[key] || 1;
}

/** Spend XP to bump a part to the next tier. Returns { ok, cost, newTier }. */
export function upgradePart(profile, slot, key) {
  const cur = partTier(profile, slot, key);
  if (cur >= 3) return { ok: false, reason: 'Max tier' };
  const cost = PART_TIER_COST[cur];               // cost to reach (cur+1)
  if (profile.xp - (profile.spentXp || 0) < cost) {
    return { ok: false, reason: 'Not enough XP', need: cost };
  }
  profile.spentXp = (profile.spentXp || 0) + cost;
  profile.partTiers = profile.partTiers || {};
  profile.partTiers[slot] = profile.partTiers[slot] || {};
  profile.partTiers[slot][key] = cur + 1;
  saveProfile(profile);
  return { ok: true, cost, newTier: cur + 1 };
}

/** Available XP — total earned minus what's been spent on part upgrades. */
export function availableXp(profile) {
  return Math.max(0, (profile.xp || 0) - (profile.spentXp || 0));
}

export function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultProfile();
    const p = JSON.parse(raw);
    // Migrate older shapes by spreading over defaults.
    return { ...defaultProfile(), ...p };
  } catch {
    return defaultProfile();
  }
}

export function saveProfile(profile) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profile)); } catch {}
}

/** Resolve the profile's current rank. Always returns a valid rank. */
export function currentRank(profile) {
  let r = RANKS[0];
  for (const rk of RANKS) if (profile.xp >= rk.min) r = rk;
  return r;
}

/** Bool: has the pilot unlocked `key` yet? */
export function hasUnlock(profile, key) {
  const u = UNLOCKS[key]; if (!u) return false;
  return currentRank(profile).id >= u.rank;
}

/** Pretty XP info for the rank-progress bar. */
export function xpFor(profile) {
  const rank = currentRank(profile);
  const nextIx = RANKS.findIndex(r => r.id === rank.id) + 1;
  const next = RANKS[nextIx] || null;
  const intoRank = profile.xp - rank.min;
  const span = next ? next.min - rank.min : 1;
  return {
    total: profile.xp,
    intoRank,
    span,
    rank,
    nextRankName: next ? next.name : null,
    pct: next ? intoRank / span : 1,
    atMax: !next,
  };
}

/** All unlocks the profile currently has, in rank order. */
export function unlocksOwned(profile) {
  const r = currentRank(profile);
  return Object.entries(UNLOCKS)
    .filter(([, v]) => v.rank <= r.id)
    .map(([k, v]) => ({ key: k, ...v }));
}

/** All unlocks not yet earned, in rank order. */
export function unlocksLocked(profile) {
  const r = currentRank(profile);
  return Object.entries(UNLOCKS)
    .filter(([, v]) => v.rank > r.id)
    .map(([k, v]) => ({ key: k, ...v }));
}

/**
 * Award XP for a mission outcome. Returns a delta the UI can toast.
 *   gained:     XP this run
 *   rankedUp:   bool — did we cross a rank threshold?
 *   newUnlocks: array of unlock keys that became available because of the rank-up
 *   profile:    the *mutated* profile (also persisted)
 */
export function awardXp(profile, missionId, score) {
  const before = currentRank(profile);
  const beforeOwned = new Set(unlocksOwned(profile).map(u => u.key));

  // Base for completing a mission + score-scaled bonus + first-time bonus.
  let gained = 25;                       // showed up, did the thing
  gained += Math.min(200, Math.floor(score / 20));
  const firstTime = !profile.completions?.[missionId];
  if (firstTime) gained += 75;           // discovery bonus

  profile.xp = Math.max(0, (profile.xp || 0) + gained);
  profile.totalMissions = (profile.totalMissions || 0) + 1;
  profile.completions = profile.completions || {};
  const prev = profile.completions[missionId] || { runs: 0, bestScore: 0 };
  profile.completions[missionId] = {
    runs: prev.runs + 1,
    bestScore: Math.max(prev.bestScore, Math.floor(score)),
  };
  if (score > profile.bestScore) profile.bestScore = Math.floor(score);

  saveProfile(profile);

  const after = currentRank(profile);
  const newUnlocks = unlocksOwned(profile)
    .filter(u => !beforeOwned.has(u.key))
    .map(u => u.key);

  return {
    profile, gained, firstTime,
    rankedUp: after.id !== before.id,
    fromRank: before, toRank: after,
    newUnlocks,
  };
}

/** Reset the profile back to a fresh Cadet — for the "restart progression" button. */
export function resetProfile() {
  const p = defaultProfile();
  saveProfile(p);
  return p;
}
