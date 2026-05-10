/**
 * upper-atmosphere-fleet.js — Drag-forecast asset fleet (25-cap, localStorage)
 * ═══════════════════════════════════════════════════════════════════════════
 * Operator-facing asset list for the upper-atmosphere page. Modeled on
 * `js/operations/my-fleet.js` (subscribe / list / add / remove / clear) but
 * lifted to 25 assets and broadened to accept three input modes:
 *
 *   • NORAD ID                  → fetched via /api/celestrak/tle?norad=<id>
 *   • Raw 2-line TLE block      → parsed inline (no fetch)
 *   • CelesTrak group bulk-pull → /api/celestrak/tle?group=<g>, capped at 25
 *
 * Storage is per-browser localStorage; signed-in PRO sync is a follow-up
 * (the change-event surface stays the same so the panel doesn't have to
 * rewire for it).
 *
 * Asset shape:
 *
 *   {
 *     id:        string,      // stable: 'norad:<id>' | 'tle:<sha>' (collision-free)
 *     noradId:   number|null, // null for paste-only TLEs missing a catalog id
 *     name:      string,      // best-known label, falls back to "#<id>"
 *     line1:     string|null, // TLE line 1 (set on resolve)
 *     line2:     string|null, // TLE line 2
 *     bcM2PerKg: number,      // ballistic coefficient override (defaults below)
 *     status:    'pending' | 'ready' | 'error',
 *     err:       string|null, // human-readable failure reason
 *     addedAt:   number,      // wall-clock ms
 *   }
 *
 * Subscribers receive the current list on subscribe and on every mutation.
 *
 * @example
 *   import { UpperAtmosphereFleet } from './upper-atmosphere-fleet.js';
 *   const fleet = new UpperAtmosphereFleet();
 *   fleet.onChange(list => repaint(list));
 *   await fleet.addNorad(25544);              // ISS
 *   await fleet.addTleBlock(rawText);         // paste from clipboard
 *   await fleet.bulkAddGroup('starlink', 10); // top-10 from group
 */

import { DEFAULT_BC_BY_NORAD } from './upper-atmosphere-trajectory-analysis.js';

const STORAGE_KEY = 'pp-ua-fleet-v1';
export const MAX_ASSETS = 25;

// Default ballistic coefficient when neither the catalog nor the user
// has supplied one. 0.020 m²/kg is the published Starlink-class typical;
// it places a ~500 km LEO sat in the right decay-rate ballpark.
const DEFAULT_BC = 0.020;

// ── Persistence ──────────────────────────────────────────────────────────────

function _load() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw
            .filter(a => a && (Number.isInteger(a.noradId) || (a.line1 && a.line2)))
            .slice(0, MAX_ASSETS);
    } catch { return []; }
}

function _save(assets) {
    try {
        // Persist the bare minimum needed to resurrect — name, TLE, BC.
        // Status / err are runtime-only (always pending on reload anyway).
        const slim = assets.slice(0, MAX_ASSETS).map(a => ({
            id:        a.id,
            noradId:   a.noradId ?? null,
            name:      a.name ?? null,
            line1:     a.line1 ?? null,
            line2:     a.line2 ?? null,
            bcM2PerKg: a.bcM2PerKg ?? DEFAULT_BC,
            addedAt:   a.addedAt ?? Date.now(),
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(slim));
    } catch { /* private mode / quota — silently degrade */ }
}

// ── TLE parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse a pasted TLE block. Accepts:
 *   • Two-line:    "1 25544U ...\n2 25544 ..."        → { name: '#25544', line1, line2 }
 *   • Three-line:  "ISS (ZARYA)\n1 25544U ...\n2..."  → { name: 'ISS (ZARYA)', line1, line2 }
 *
 * Returns an array of parsed entries (a single block can contain many TLEs
 * concatenated). Validates the format superficially — the SGP4 parser will
 * catch bad checksums later if any.
 */
export function parseTleBlock(text) {
    if (!text) return [];
    const lines = String(text)
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(l => l.replace(/\s+$/, ''))
        .filter(l => l.length > 0);

    const out = [];
    let i = 0;
    while (i < lines.length) {
        const a = lines[i];
        const b = lines[i + 1];
        const c = lines[i + 2];

        // Three-line block: name + line1 + line2
        if (b && c
            && b.startsWith('1 ') && b.length >= 60
            && c.startsWith('2 ') && c.length >= 60) {
            const noradId = _noradFromLine(b);
            out.push({
                name: a.trim(),
                line1: b,
                line2: c,
                noradId,
            });
            i += 3;
            continue;
        }
        // Two-line block: line1 + line2
        if (a && b
            && a.startsWith('1 ') && a.length >= 60
            && b.startsWith('2 ') && b.length >= 60) {
            const noradId = _noradFromLine(a);
            out.push({
                name: noradId ? `#${noradId}` : 'unknown',
                line1: a,
                line2: b,
                noradId,
            });
            i += 2;
            continue;
        }
        i++;
    }
    return out;
}

function _noradFromLine(line) {
    // Columns 3..7 of a TLE line carry the 5-digit NORAD ID.
    const id = parseInt(line.slice(2, 7).trim(), 10);
    return Number.isInteger(id) ? id : null;
}

function _idForAsset({ noradId, line1, line2 }) {
    if (noradId) return `norad:${noradId}`;
    // Anonymous TLE — hash the body so paste-twice dedups.
    const sig = (line1 || '') + '|' + (line2 || '');
    let h = 0;
    for (let i = 0; i < sig.length; i++) h = ((h << 5) - h + sig.charCodeAt(i)) | 0;
    return `tle:${(h >>> 0).toString(16)}`;
}

// ── CelesTrak proxy fetch helpers ────────────────────────────────────────────

const CELESTRAK_BASE = '/api/celestrak/tle';

/**
 * Fetch a single TLE by NORAD ID. Returns { line1, line2, name, noradId } or
 * null on failure (network, 404, malformed).
 */
async function fetchNoradTle(noradId, { signal } = {}) {
    try {
        const res = await fetch(`${CELESTRAK_BASE}?norad=${noradId}`, { signal });
        if (!res.ok) return null;
        const data = await res.json();
        const arr = Array.isArray(data) ? data : data?.objects;
        const e = arr?.[0];
        if (!e?.line1 || !e?.line2) return null;
        return {
            line1:   e.line1,
            line2:   e.line2,
            name:    e.name || `#${noradId}`,
            noradId: e.norad_id || noradId,
        };
    } catch { return null; }
}

/**
 * Fetch the top-N TLEs from a CelesTrak group (active, starlink, oneweb, …).
 * Returned in catalog order — caller can sort by perigee/apogee if it wants
 * to bias toward the highest-drag subset.
 */
async function fetchGroup(group, max = MAX_ASSETS, { signal } = {}) {
    try {
        const res = await fetch(`${CELESTRAK_BASE}?group=${encodeURIComponent(group)}`, { signal });
        if (!res.ok) return [];
        const data = await res.json();
        const arr = Array.isArray(data) ? data : data?.objects || [];
        return arr.slice(0, max).map(e => ({
            line1:   e.line1,
            line2:   e.line2,
            name:    e.name || (e.norad_id ? `#${e.norad_id}` : 'unknown'),
            noradId: e.norad_id || _noradFromLine(e.line1 || ''),
        })).filter(a => a.line1 && a.line2);
    } catch { return []; }
}

// ── Fleet store ──────────────────────────────────────────────────────────────

export class UpperAtmosphereFleet {
    constructor() {
        this._assets  = [];
        this._subs    = new Set();
        this._inflight = new Map();   // id → AbortController for pending fetches

        // Restore from localStorage. Each restored entry already carries
        // its TLE, so it's `ready` immediately — no refetch needed unless
        // the user explicitly asks for one.
        for (const a of _load()) {
            this._assets.push({
                id:        a.id || _idForAsset(a),
                noradId:   a.noradId ?? null,
                name:      a.name || (a.noradId ? `#${a.noradId}` : 'unknown'),
                line1:     a.line1 ?? null,
                line2:     a.line2 ?? null,
                bcM2PerKg: Number.isFinite(a.bcM2PerKg) ? a.bcM2PerKg : _defaultBcFor(a.noradId),
                status:    (a.line1 && a.line2) ? 'ready' : 'pending',
                err:       null,
                addedAt:   a.addedAt ?? Date.now(),
            });
        }
        // Resolve any restored entries that were missing TLEs (rare).
        for (const asset of this._assets) {
            if (asset.status === 'pending' && asset.noradId) {
                this._resolveNorad(asset).catch(() => {});
            }
        }
    }

    list()        { return this._assets.slice(); }
    has(id)       { return this._assets.some(a => a.id === id); }
    hasNorad(n)   { return this._assets.some(a => a.noradId === n); }
    count()       { return this._assets.length; }
    isFull()      { return this._assets.length >= MAX_ASSETS; }
    findById(id)  { return this._assets.find(a => a.id === id) || null; }

    onChange(fn) {
        this._subs.add(fn);
        try { fn(this.list()); } catch (_) {}
        return () => this._subs.delete(fn);
    }

    _notify() {
        const list = this.list();
        for (const fn of this._subs) {
            try { fn(list); } catch (_) {}
        }
    }

    /**
     * Add a satellite by NORAD catalog ID. Async — the asset is inserted
     * immediately with status='pending' so the UI can render a loading
     * row, and the entry flips to 'ready' (or 'error') once the TLE
     * fetch resolves. Returns { ok: bool, reason?, id }.
     */
    async addNorad(noradIdRaw, { bcM2PerKg } = {}) {
        const noradId = parseInt(noradIdRaw, 10);
        if (!Number.isInteger(noradId) || noradId <= 0)
            return { ok: false, reason: 'invalid-id' };
        if (this.hasNorad(noradId))
            return { ok: false, reason: 'already-added', id: `norad:${noradId}` };
        if (this.isFull())
            return { ok: false, reason: 'fleet-full' };

        const asset = {
            id:        `norad:${noradId}`,
            noradId,
            name:      `#${noradId}`,
            line1:     null,
            line2:     null,
            bcM2PerKg: Number.isFinite(bcM2PerKg) ? bcM2PerKg : _defaultBcFor(noradId),
            status:    'pending',
            err:       null,
            addedAt:   Date.now(),
        };
        this._assets.push(asset);
        _save(this._assets);
        this._notify();

        await this._resolveNorad(asset);
        return asset.status === 'ready'
            ? { ok: true, id: asset.id }
            : { ok: false, reason: asset.err || 'fetch-failed', id: asset.id };
    }

    async _resolveNorad(asset) {
        // Cancel any in-flight resolve for this id (defensive — caller
        // should normally not double-call).
        this._inflight.get(asset.id)?.abort?.();
        const ctrl = new AbortController();
        this._inflight.set(asset.id, ctrl);
        try {
            const tle = await fetchNoradTle(asset.noradId, { signal: ctrl.signal });
            if (!tle) {
                asset.status = 'error';
                asset.err = 'celestrak fetch failed';
            } else {
                asset.line1  = tle.line1;
                asset.line2  = tle.line2;
                asset.name   = tle.name || asset.name;
                asset.status = 'ready';
                asset.err    = null;
            }
        } catch (e) {
            if (e?.name !== 'AbortError') {
                asset.status = 'error';
                asset.err    = e?.message || 'fetch error';
            }
        } finally {
            this._inflight.delete(asset.id);
        }
        _save(this._assets);
        this._notify();
        return asset;
    }

    /**
     * Add one or more satellites from a pasted TLE block (2- or 3-line).
     * Returns { ok, added: number, skipped: number, reasons: object }.
     * Skipped reasons: 'fleet-full', 'already-added', 'unparsed'.
     */
    addTleBlock(text, { bcM2PerKg } = {}) {
        const parsed = parseTleBlock(text);
        if (parsed.length === 0) return { ok: false, added: 0, skipped: 0, reasons: { unparsed: 1 } };

        let added = 0, skipped = 0;
        const reasons = { 'fleet-full': 0, 'already-added': 0 };
        for (const p of parsed) {
            if (this.isFull()) { reasons['fleet-full']++; skipped++; continue; }
            const id = _idForAsset(p);
            if (this.has(id))  { reasons['already-added']++; skipped++; continue; }
            this._assets.push({
                id,
                noradId:   p.noradId ?? null,
                name:      p.name,
                line1:     p.line1,
                line2:     p.line2,
                bcM2PerKg: Number.isFinite(bcM2PerKg) ? bcM2PerKg : _defaultBcFor(p.noradId),
                status:    'ready',
                err:       null,
                addedAt:   Date.now(),
            });
            added++;
        }
        _save(this._assets);
        this._notify();
        return { ok: added > 0, added, skipped, reasons };
    }

    /**
     * Bulk-add the top-N TLEs from a CelesTrak group. `max` defaults to the
     * remaining headroom in the fleet. Returns the same shape as addTleBlock.
     */
    async bulkAddGroup(group, max) {
        const headroom = MAX_ASSETS - this._assets.length;
        if (headroom <= 0) return { ok: false, added: 0, skipped: 0, reasons: { 'fleet-full': 1 } };
        const want = Math.min(headroom, Number.isFinite(max) ? max : headroom);

        const tles = await fetchGroup(group, want);
        if (tles.length === 0) return { ok: false, added: 0, skipped: 0, reasons: { 'fetch-failed': 1 } };

        let added = 0, skipped = 0;
        const reasons = { 'fleet-full': 0, 'already-added': 0 };
        for (const t of tles) {
            if (this.isFull()) { reasons['fleet-full']++; skipped++; continue; }
            const id = _idForAsset(t);
            if (this.has(id))  { reasons['already-added']++; skipped++; continue; }
            this._assets.push({
                id,
                noradId:   t.noradId ?? null,
                name:      t.name,
                line1:     t.line1,
                line2:     t.line2,
                bcM2PerKg: _defaultBcFor(t.noradId),
                status:    'ready',
                err:       null,
                addedAt:   Date.now(),
            });
            added++;
        }
        _save(this._assets);
        this._notify();
        return { ok: added > 0, added, skipped, reasons };
    }

    setBc(id, bcM2PerKg) {
        const asset = this.findById(id);
        if (!asset || !Number.isFinite(bcM2PerKg) || bcM2PerKg <= 0) return false;
        asset.bcM2PerKg = bcM2PerKg;
        _save(this._assets);
        this._notify();
        return true;
    }

    /** Force a fresh CelesTrak pull for a NORAD-anchored asset. */
    async refresh(id) {
        const asset = this.findById(id);
        if (!asset || !asset.noradId) return false;
        asset.status = 'pending';
        this._notify();
        await this._resolveNorad(asset);
        return asset.status === 'ready';
    }

    remove(id) {
        const idx = this._assets.findIndex(a => a.id === id);
        if (idx < 0) return false;
        this._inflight.get(id)?.abort?.();
        this._inflight.delete(id);
        this._assets.splice(idx, 1);
        _save(this._assets);
        this._notify();
        return true;
    }

    clear() {
        for (const ctrl of this._inflight.values()) ctrl.abort?.();
        this._inflight.clear();
        this._assets.length = 0;
        _save(this._assets);
        this._notify();
    }
}

function _defaultBcFor(noradId) {
    if (noradId && DEFAULT_BC_BY_NORAD[noradId]) return DEFAULT_BC_BY_NORAD[noradId];
    return DEFAULT_BC;
}
