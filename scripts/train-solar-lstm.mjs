/**
 * train-solar-lstm.mjs — Offline trainer that produces the pretrained
 * weights shipped at /js/solar-lstm-weights.json.
 *
 * sun.html calls `_lstm.loadPretrainedWeights('/js/solar-lstm-weights.json')`
 * on load so the SWPC forecast starts *warm* instead of cold-random. The
 * file is intentionally optional (404 is non-fatal) — this script generates
 * a real, valid one.
 *
 * Ideally weights come from a multi-decade OMNI corpus. That corpus is not
 * reachable from the build environment (NOAA blocks unauthenticated egress
 * and the heliochronicles submodule ships catalog-only metadata, not hourly
 * series), so we train on a physically-grounded synthetic corpus that
 * reproduces the temporal structure the LSTM can actually exploit:
 *
 *   - strong hour-to-hour persistence
 *   - ~27.27-day corotating recurrence (coronal-hole high-speed streams)
 *   - CIR phasing: density/Bt compression on the stream leading edge,
 *     rarefaction in the trailing slow wind
 *   - sporadic CME-like transients: speed jump, density spike then dropout,
 *     fluctuating (often southward) Bz, enhanced Bt, elevated Kp, ~1–3 day decay
 *   - Kp coupled to the v·Bz_south merging-rate proxy
 *   - a slow solar-cycle activity envelope
 *
 * Deterministic: a seeded PRNG drives both corpus generation and the model's
 * Xavier init (Math.random is overridden before importing the model), so
 * re-running reproduces byte-identical weights. To retrain from a real OMNI
 * corpus later, replace generateCorpus() with a loader yielding the same
 * { t_ms, speed, density, bz, bt, kp } shape — nothing else changes.
 *
 *   Usage:  node scripts/train-solar-lstm.mjs
 *   Output: js/solar-lstm-weights.json
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
// Override Math.random *before* importing the model so Xavier init is
// deterministic too. All randomness in this process flows through one seed.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const SEED = 0x5031A2;            // fixed → reproducible weights
const rng = mulberry32(SEED);
Math.random = rng;                // model's xavierInit() picks this up

/** Standard normal via Box–Muller, drawing from the seeded rng. */
function randn() {
    const u1 = rng() || 1e-10;
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

const { SolarLSTM } = await import(join(REPO_ROOT, 'js', 'solar-lstm.js'));

// ── Physically-grounded synthetic solar-wind corpus ─────────────────────────

const HOUR_MS = 3_600_000;
const SOLAR_ROTATION_H = 27.2753 * 24;   // Carrington synodic period

/**
 * Generate `years` of hourly { t_ms, speed, density, bz, bt, kp }.
 * Values are in physical units; the model normalises them internally.
 */
function generateCorpus(years) {
    const nHours = Math.round(years * 365.25 * 24);
    const t0 = Date.UTC(2017, 0, 1);     // arbitrary epoch; only deltas matter

    // 2–4 persistent coronal-hole streams, each at a fixed Carrington
    // longitude (phase) so they recur every solar rotation. Lifetimes of
    // several rotations, then a new configuration.
    function makeStreamSet() {
        const n = 2 + Math.floor(rng() * 3);
        const streams = [];
        for (let i = 0; i < n; i++) {
            streams.push({
                phase: rng() * SOLAR_ROTATION_H,             // hours into rotation
                width: 36 + rng() * 90,                       // stream duration (h)
                vMax: 520 + rng() * 320,                      // peak speed km/s
                lifeH: (4 + rng() * 8) * SOLAR_ROTATION_H,     // recurrences
            });
        }
        return streams;
    }
    let streams = makeStreamSet();
    let streamsBornH = 0;

    // Slow solar-cycle activity envelope (0.35 quiet ↔ 1.0 active), ~11 yr.
    const cyclePhase = rng() * Math.PI * 2;

    // AR(1) coloured background noise per channel for realism.
    const ar = { s: 0, d: 0, bz: 0, bt: 0 };
    const arDecay = 0.85;

    // CME transient state (when active, overrides toward storm conditions).
    let cme = null;

    const out = new Array(nHours);
    for (let h = 0; h < nHours; h++) {
        // Refresh the stream configuration when the set ages out.
        if (h - streamsBornH > Math.min(...streams.map(s => s.lifeH))) {
            streams = makeStreamSet();
            streamsBornH = h;
        }

        const activity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(cyclePhase + (2 * Math.PI * h) / (11 * 365.25 * 24)));

        // ── Corotating high-speed streams (CIR structure) ──
        const rotPos = h % SOLAR_ROTATION_H;
        let vStream = 0, compress = 0, rarefy = 0;
        for (const s of streams) {
            let d = Math.abs(rotPos - s.phase);
            d = Math.min(d, SOLAR_ROTATION_H - d);          // wrap-around
            if (d < s.width) {
                const x = d / s.width;                       // 0 at core → 1 at edge
                const env = Math.exp(-3 * x * x);            // speed enhancement
                vStream = Math.max(vStream, (s.vMax - 400) * env);
                // Leading edge (before core, ~first third): compression.
                if (rotPos < s.phase && d < s.width * 0.4) compress = Math.max(compress, env);
                // Trailing edge: rarefaction (low density, slowly falling speed).
                if (rotPos > s.phase) rarefy = Math.max(rarefy, env * 0.7);
            }
        }

        // ── CME transients (Poisson-ish, rate scales with activity) ──
        if (!cme && rng() < 0.0016 * activity) {
            const dur = 18 + Math.floor(rng() * 54);          // 18–72 h
            cme = {
                age: 0, dur,
                dV: 150 + rng() * 450,                         // speed boost
                dRho: 6 + rng() * 22,                          // sheath density
                bzMin: -(8 + rng() * 24) * activity,           // southward depth
                btMax: 10 + rng() * 22,
                rope: rng() < 0.5 ? 1 : -1,                    // flux-rope handedness
            };
        }

        // ── Baseline slow wind ──
        ar.s  = arDecay * ar.s  + (1 - arDecay) * randn();
        ar.d  = arDecay * ar.d  + (1 - arDecay) * randn();
        ar.bz = 0.6     * ar.bz + 0.4           * randn();
        ar.bt = arDecay * ar.bt + (1 - arDecay) * randn();

        let speed   = 360 + vStream + 22 * ar.s;
        let density = 5.5 + 2.4 * ar.d + 7.0 * compress - 2.6 * rarefy
                          - 0.004 * vStream;                   // fast wind is tenuous
        let bt      = 4.8 + 1.1 * ar.bt + 3.4 * compress + 0.5 * activity * Math.abs(ar.bz);
        let bz      = 1.7 * ar.bz - 1.0 * compress * activity; // CIRs skew southward

        // CME overlay.
        if (cme) {
            const p = cme.age / cme.dur;                       // 0→1 progress
            const shock = Math.exp(-12 * p * p);               // sharp leading shock
            const ej    = Math.exp(-3 * Math.pow(p - 0.45, 2)); // smooth ejecta body
            speed   += cme.dV * (0.4 * shock + ej);
            density += cme.dRho * shock - 1.5 * ej;            // spike then dropout
            bt       = Math.max(bt, cme.btMax * (0.5 * shock + ej));
            // Smoothly rotating flux-rope Bz (one half-turn across the ejecta).
            bz       = cme.bzMin * ej * Math.sin(Math.PI * p) * cme.rope
                       + 2.0 * shock * randn();
            cme.age++;
            if (cme.age >= cme.dur) cme = null;
        }

        // ── Kp from a v·Bz_south merging-rate proxy (Newell-like) ──
        const bzSouth = Math.max(0, -bz);
        const merging = Math.pow(speed, 4 / 3) * Math.pow(bzSouth, 2 / 3);
        let kp = 0.9 + merging / 2600 + 0.4 * activity + 0.25 * randn();

        // ── Clamp to physically sane ranges ──
        speed   = Math.max(250, Math.min(950, speed));
        density = Math.max(0.3, Math.min(60, density));
        bt      = Math.max(1.5, Math.min(45, bt));
        bz      = Math.max(-45, Math.min(35, bz));
        kp      = Math.max(0, Math.min(9, kp));

        out[h] = { t_ms: t0 + h * HOUR_MS, speed, density, bz, bt, kp };
    }
    return out;
}

// ── Train ───────────────────────────────────────────────────────────────────

console.info('[train] generating synthetic corpus…');
const corpus = generateCorpus(4);                 // ~35k hourly samples
console.info(`[train] corpus: ${corpus.length} hourly records`);

// Match sun.html: new SolarLSTM({ hiddenSize: 32, seqLen: 24, lr: 0.001 })
const model = new SolarLSTM({ hiddenSize: 32, seqLen: 24, lr: 0.001 });

// Stream the corpus through ingest() exactly as live SWPC data would flow.
// Each ingest after warm-up runs one teacher-forced BPTT step on the most
// recent window — thousands of steps total. Two passes for extra convergence.
const PASSES = 2;
for (let pass = 0; pass < PASSES; pass++) {
    for (const rec of corpus) {
        model.ingest(
            { speed: rec.speed, density: rec.density, bz: rec.bz, bt: rec.bt, kp: rec.kp },
            rec.t_ms,
        );
    }
    const st = model.status();
    console.info(
        `[train] pass ${pass + 1}/${PASSES}: steps=${st.trained} ` +
        `errorEMA=${st.errorEMA} confidence=${st.confidence}`,
    );
}

// ── Sanity check: round-trip + finite forecast ──────────────────────────────

const weights = model.exportWeights();

const expect = (name, arr, len) => {
    if (!Array.isArray(arr) || arr.length !== len) {
        throw new Error(`weight ${name}: expected length ${len}, got ${arr?.length}`);
    }
    if (!arr.every(Number.isFinite)) throw new Error(`weight ${name}: non-finite value`);
};
const concat = 5 + 32;                            // N_FEAT + hiddenSize
for (const g of ['Wf', 'Wi', 'Wc', 'Wo']) expect(`lstm.${g}`, weights.lstm[g], 32 * concat);
for (const b of ['bf', 'bi', 'bc', 'bo']) expect(`lstm.${b}`, weights.lstm[b], 32);
expect('dense.W', weights.dense.W, 5 * 32);
expect('dense.b', weights.dense.b, 5);

// Re-import into a fresh model and confirm a 24h forecast is finite & in-range.
const verify = new SolarLSTM({ hiddenSize: 32, seqLen: 24, lr: 0.001 });
if (!verify.importWeights(weights)) throw new Error('importWeights() rejected exported weights');
for (const rec of corpus.slice(-48)) {
    verify.ingest({ speed: rec.speed, density: rec.density, bz: rec.bz, bt: rec.bt, kp: rec.kp }, rec.t_ms);
}
const fc = verify.forecast(24);
if (fc.length !== 24) throw new Error(`forecast length ${fc.length}, expected 24`);
for (const f of fc) {
    for (const v of f.features) {
        if (!Number.isFinite(v) || v < -1e-6 || v > 1 + 1e-6) {
            throw new Error(`forecast produced out-of-range value ${v}`);
        }
    }
}
const last = fc[fc.length - 1].raw;
console.info(
    `[train] +24h sample forecast: speed=${last.speed.toFixed(0)} km/s ` +
    `density=${last.density.toFixed(1)} bz=${last.bz.toFixed(1)} ` +
    `bt=${last.bt.toFixed(1)} kp=${last.kp.toFixed(1)}`,
);

const outPath = join(REPO_ROOT, 'js', 'solar-lstm-weights.json');
writeFileSync(outPath, JSON.stringify(weights));
console.info(
    `[train] wrote ${outPath} ` +
    `(${weights.nTrained} steps, confidence ${(weights.confidence * 100).toFixed(0)}%)`,
);
