/**
 * rng.js — deterministic, seedable PRNG for the accretion-disc lab.
 *
 * A run is reproducible iff (scenario, seed, cfg) fully determine it, so every
 * stochastic draw in scenarios.js / disc.js must come from makeRng(seed) rather
 * than Math.random(). Same seed + same settings ⇒ the same universe — this is
 * the "world seed" the setup lobby exposes to the user (think Minecraft / AoE
 * map seed).
 *
 * mulberry32: tiny, fast, well-distributed 32-bit generator. NOT cryptographic.
 * No external dependencies.
 */

// Map arbitrary user input (number or string) to a uint32 seed. Numeric input
// is truncated to uint32; strings are folded with an FNV-1a-style hash so that
// memorable seeds like "theia" work as world names.
export function normalizeSeed(input) {
    if (typeof input === 'number' && Number.isFinite(input)) {
        return input >>> 0;
    }
    const s = String(input ?? '').trim();
    // A bare decimal string is treated as a number ("12345" -> 12345).
    if (/^\d+$/.test(s)) return (parseInt(s, 10) >>> 0);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// A fresh random uint32 seed — used by the "reroll" / new-world control.
export function randomSeed() {
    return Math.floor(Math.random() * 0x100000000) >>> 0;
}

// mulberry32 → a function returning a float in [0, 1). Deterministic for a
// given seed; calling it advances the stream.
export function makeRng(seed) {
    let a = normalizeSeed(seed) || 1;       // avoid the degenerate 0 state
    return function rng() {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
