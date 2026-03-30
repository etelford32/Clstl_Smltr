/**
 * solar-weather-history.js
 *
 * Lightweight multi-tier time-series storage for solar weather parameters.
 * Uses IndexedDB for persistence and in-memory ring buffers for zero-latency reads.
 *
 * Tiers
 *   tier0 — 1-min cadence, 24 h window  (1 440 records)
 *   tier1 — 1-hr  cadence, 30 d window  (  720 records)
 *   tier2 — 1-day cadence,  4 yr window (1 461 records)
 *
 * Record fields (compact — ~10 numbers per row):
 *   t, v, bz, by, n, pdyn, kp, dst, epsilon, substorm
 */

const DB_NAME    = 'solar_wx_v1';
const DB_VERSION = 1;

const TIERS = [
    { name: 'tier0', cadence_ms:     60_000, max_rows: 1_440 },
    { name: 'tier1', cadence_ms:  3_600_000, max_rows:   720 },
    { name: 'tier2', cadence_ms: 86_400_000, max_rows: 1_461 },
];

// ── Ring buffer ──────────────────────────────────────────────────────────────

class RingBuffer {
    constructor(capacity) {
        this._cap  = capacity;
        this._buf  = new Array(capacity);
        this._head = 0;
        this._size = 0;
    }

    push(item) {
        this._buf[this._head] = item;
        this._head = (this._head + 1) % this._cap;
        if (this._size < this._cap) this._size++;
    }

    /** Oldest-first ordered copy */
    toArray() {
        if (this._size === 0) return [];
        if (this._size < this._cap) return this._buf.slice(0, this._size);
        const tail = this._head % this._cap;
        return [...this._buf.slice(tail), ...this._buf.slice(0, tail)];
    }

    last(n = 1) {
        const arr = this.toArray();
        return n === 1 ? arr[arr.length - 1] : arr.slice(-n);
    }

    get size()     { return this._size; }
    get capacity() { return this._cap;  }
}

// ── Record packing ───────────────────────────────────────────────────────────

function packRecord(t, sw, coupling = {}) {
    const speed   = sw.speed   ?? sw.v       ?? 400;
    const density = sw.density ?? sw.n       ?? 5;
    const bz      = sw.bz      ?? 0;
    const by      = sw.by      ?? 0;
    // Dynamic pressure in nPa: 0.5 * m_p * n * v²  (SI, then nPa)
    const pdyn    = coupling.pdyn ??
        (0.5 * 1.673e-27 * (density * 1e6) * Math.pow(speed * 1e3, 2) * 1e9);

    return {
        t,
        v:        speed,
        bz,
        by,
        n:        density,
        pdyn:     +pdyn.toFixed(3),
        kp:       +(sw.kp          ?? coupling.kp          ?? 0).toFixed(2),
        dst:      +(coupling.dst   ?? 0).toFixed(1),
        epsilon:  +(coupling.epsilon_GW ?? 0).toFixed(1),
        substorm: +(coupling.substorm_index ?? 0).toFixed(3),
    };
}

// ── SolarWeatherHistory ──────────────────────────────────────────────────────

export class SolarWeatherHistory {
    constructor() {
        this._db        = null;
        this._rings     = TIERS.map(t => new RingBuffer(t.max_rows));
        this._lastFlush = new Array(TIERS.length).fill(0);
        this._ready     = false;
        this._dbOk      = false;
    }

    /** Open IndexedDB and warm ring buffers from stored data. */
    async open() {
        try {
            this._db  = await this._openDB();
            this._dbOk = true;
            await Promise.all(TIERS.map((tier, i) => this._warmRing(tier, i)));
        } catch (err) {
            console.warn('[SolarWxHistory] IndexedDB unavailable, using in-memory only:', err.message);
        }
        this._ready = true;
        console.info('[SolarWxHistory] ready —',
            this._rings.map((r, i) => `tier${i}:${r.size}`).join('  '));
    }

    _openDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                for (const tier of TIERS) {
                    if (!db.objectStoreNames.contains(tier.name)) {
                        db.createObjectStore(tier.name, { keyPath: 't' });
                    }
                }
            };
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror   = (e) => reject(e.target.error);
        });
    }

    async _warmRing(tier, idx) {
        const rows = await this._idbGetAll(tier.name);
        rows.sort((a, b) => a.t - b.t);
        const start = Math.max(0, rows.length - tier.max_rows);
        for (let i = start; i < rows.length; i++) this._rings[idx].push(rows[i]);
        if (rows.length > 0) {
            this._lastFlush[idx] = rows[rows.length - 1].t;
        }
    }

    _idbGetAll(storeName) {
        return new Promise((resolve, reject) => {
            const tx  = this._db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result);
            req.onerror   = () => reject(req.error);
        });
    }

    /**
     * Ingest a new solar wind reading.
     * @param {object} sw       – raw SW state (speed, density, bz, by, kp)
     * @param {object} coupling – sw-magnet-coupling detail (pdyn, dst, epsilon_GW, substorm_index)
     * @param {number} now      – timestamp ms (defaults to Date.now())
     */
    ingest(sw = {}, coupling = {}, now = Date.now()) {
        const rec = packRecord(now, sw, coupling);
        for (let i = 0; i < TIERS.length; i++) {
            if (now - this._lastFlush[i] >= TIERS[i].cadence_ms) {
                this._rings[i].push(rec);
                this._lastFlush[i] = now;
                if (this._dbOk) this._idbPut(TIERS[i].name, rec, TIERS[i].max_rows);
            }
        }
    }

    _idbPut(storeName, rec, maxRows) {
        try {
            const tx    = this._db.transaction(storeName, 'readwrite');
            const store = tx.objectStore(storeName);
            store.put(rec);
            // Async prune oldest records when store grows too large
            const countReq = store.count();
            countReq.onsuccess = () => {
                if (countReq.result > maxRows + 60) {
                    const cursorReq = store.openCursor();
                    let pruned = 0;
                    cursorReq.onsuccess = (e) => {
                        const c = e.target.result;
                        if (c && pruned < 60) { c.delete(); pruned++; c.continue(); }
                    };
                }
            };
        } catch { /* quota errors silently ignored */ }
    }

    /** Return all records in tier i (oldest-first). */
    getTier(i) { return this._rings[i].toArray(); }

    /** Return the last n records from tier0 (1-min resolution). */
    recent(n)  { return this._rings[0].last(n); }

    /** Expose ring array lengths for debugging. */
    sizes() { return this._rings.map(r => r.size); }

    get isReady() { return this._ready; }
}

// ── Synthetic history seeder ─────────────────────────────────────────────────

/**
 * Populate `history` with plausible synthetic solar wind data so that the
 * forecasting engine has something to work with on first launch.
 *
 * Models used:
 *  - SC25 sinusoidal solar-cycle amplitude
 *  - 27-day Carrington-rotation recurrence
 *  - AR(4) correlated short-term noise
 *  - Poisson CME spike events
 *
 * @param {SolarWeatherHistory} history
 * @param {number} n_days  – how many days of synthetic hourly data to generate (default 90)
 */
export function seedSyntheticHistory(history, n_days = 90) {
    const now     = Date.now();
    const H       = n_days * 24;               // total hourly steps
    const T_CYCLE = 11 * 365.25 * 86400e3;    // 11-yr cycle in ms
    const T_27    = 27 * 86400e3;             // 27-day Carrington rotation in ms
    // SC25 minimum: 2019-12-01; predicted max: 2025-07-01
    const SC25_MIN_MS = Date.UTC(2019, 11, 1);
    const SC25_MAX_MS = Date.UTC(2025, 6, 1);

    // AR(4) noise state
    let noise = [0, 0, 0, 0];
    // AR coefficients for realistic persistence
    const arPhi = [0.55, 0.20, 0.10, 0.05];

    // CME probability per hour (roughly 1 event / 18 days near max → ~0.0023/hr)
    const CME_PROB_HR = 0.0023;

    const kpSeries    = new Array(H);
    const bzSeries    = new Array(H);
    const vSeries     = new Array(H);
    const nSeries     = new Array(H);
    const epsilonSeries = new Array(H);

    for (let h = 0; h < H; h++) {
        const t_ms = now - (H - h) * 3_600_000;

        // ── Solar cycle amplitude ──────────────────────────────────────────
        const phase_cycle = (t_ms - SC25_MIN_MS) / T_CYCLE;  // fractional cycles since min
        // Sine that peaks at 0.5 cycle (= solar max); clamp to [0,1]
        const actCycle = Math.max(0, Math.min(1,
            0.5 + 0.5 * Math.sin(2 * Math.PI * phase_cycle - Math.PI / 2)));

        // ── 27-day Carrington recurrence ──────────────────────────────────
        const act27 = 0.35 * Math.max(0, Math.sin(2 * Math.PI * t_ms / T_27));

        // ── AR(4) correlated noise ─────────────────────────────────────────
        const eps = (Math.random() - 0.5) * 2;   // uniform [-1, 1]
        noise.unshift(
            arPhi[0] * noise[0] + arPhi[1] * noise[1] +
            arPhi[2] * noise[2] + arPhi[3] * noise[3] + 0.35 * eps
        );
        noise.pop();

        // ── Base Kp from solar cycle + 27-day + noise ──────────────────────
        const kpBase = 1.2 + 2.8 * actCycle + act27 + noise[0];

        // ── CME spike injection ────────────────────────────────────────────
        let kpSpike = 0;
        if (Math.random() < CME_PROB_HR * actCycle) {
            // CME storm: ramp up over 6h, decay over 24h
            const storm_kp = 4 + Math.random() * 5;   // G1–G5
            for (let d = 0; d < Math.min(30, H - h); d++) {
                const profile = d < 6
                    ? d / 6
                    : Math.exp(-(d - 6) / 12);
                kpSeries[h + d] = (kpSeries[h + d] ?? 0) + storm_kp * profile;
            }
            kpSpike = storm_kp;
        }

        const kp = Math.max(0, Math.min(9, kpBase + kpSpike + (kpSeries[h] ?? 0)));

        // ── Solar wind parameters ─────────────────────────────────────────
        const v   = 350 + 150 * actCycle + 60 * noise[1] + (kpSpike > 0 ? 300 : 0);
        const n_  = 5   + 4   * actCycle + 2  * Math.abs(noise[2]);
        const bz  = -(kp > 3 ? kp * 1.5 * Math.random() : 2 * Math.random() - 1);
        const by  = (Math.random() - 0.5) * 6;
        const bt  = Math.hypot(bz, by, 1);
        const pdyn = 0.5 * 1.673e-27 * (n_ * 1e6) * Math.pow(v * 1e3, 2) * 1e9;

        // Akasofu ε approximation (GW)
        const sinHalf4 = Math.pow(Math.sin(Math.atan2(Math.abs(bz), Math.abs(by)) / 2), 4);
        const epsilon = (7e7 * v * bt * bt * sinHalf4) * 1e-9;

        kpSeries[h]      = kp;
        bzSeries[h]      = bz;
        vSeries[h]       = v;
        nSeries[h]       = n_;
        epsilonSeries[h] = epsilon;

        // Push hourly (tier1) directly
        const sw = { speed: v, density: n_, bz, by, kp };
        const cp = { pdyn, dst: -kp * 8 * Math.random(), epsilon_GW: epsilon, substorm_index: Math.min(1, kp / 9) };
        const rec = packRecord(t_ms, sw, cp);
        history._rings[1].push(rec);

        // Push daily (tier2) at noon of each day
        if (h % 24 === 12) history._rings[2].push({ ...rec, t: t_ms });
    }

    // Tier0 (1-min): seed last 24h at 1-min cadence from the last 24 hourly points
    const last24h = kpSeries.slice(-24);
    for (let m = 0; m < 1440; m++) {
        const hIdx = Math.floor(m / 60);
        const kp_m = last24h[hIdx] ?? 1;
        const t_ms = now - (1440 - m) * 60_000;
        const v_m  = vSeries[H - 24 + hIdx] ?? 400;
        const bz_m = bzSeries[H - 24 + hIdx] ?? -1;
        const n_m  = nSeries[H - 24 + hIdx] ?? 5;
        history._rings[0].push(packRecord(t_ms,
            { speed: v_m, density: n_m, bz: bz_m, by: 0, kp: kp_m },
            { epsilon_GW: epsilonSeries[H - 24 + hIdx] ?? 0 }
        ));
    }

    // Sync lastFlush so ingest() doesn't double-write immediately
    const nowMs = Date.now();
    history._lastFlush[0] = nowMs;
    history._lastFlush[1] = nowMs;
    history._lastFlush[2] = nowMs;

    console.info('[SolarWxHistory] synthetic seed complete —',
        history.sizes().map((s, i) => `tier${i}:${s}`).join('  '));
}
