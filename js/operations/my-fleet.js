/**
 * my-fleet.js — Anonymous fleet store for the Operations console.
 *
 * Holds up to MAX_ASSETS NORAD IDs. Soft-saves to localStorage on every
 * change so a refresh doesn't blow away the user's work. Asset TLEs
 * resolve asynchronously: we add the ID immediately (UI shows "loading")
 * then fetch via tracker.loadNorad() — anything already loaded by the
 * fleet module's constellation toggles is reused without a refetch.
 *
 * Subscribers receive the current asset list on subscribe and on every
 * mutation. Asset shape:
 *
 *   {
 *     noradId: number,
 *     name:    string,                    // best-known label, falls back to "#<id>"
 *     tle:     TLE | null,                // null while loading
 *     status:  'pending' | 'ready' | 'error',
 *   }
 *
 * Anonymous-only for now. Persistence to a real Supabase `fleets` table
 * for signed-in PRO users is a follow-up sprint — the change-event
 * surface stays the same so the deck doesn't have to rewire.
 */

const STORAGE_KEY = 'pp-ops-fleet-v1';
const MAX_ASSETS  = 10;

function loadIds() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        if (!Array.isArray(raw)) return [];
        return raw.map(n => parseInt(n, 10)).filter(Number.isInteger).slice(0, MAX_ASSETS);
    } catch { return []; }
}

function saveIds(ids) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_ASSETS)));
    } catch {}
}

export class MyFleet {
    constructor(tracker) {
        this.tracker = tracker;
        this._assets = [];
        this._subs   = new Set();

        // Restore from localStorage. We push assets through the same
        // _addInternal path that any user add() goes through so the
        // fetch + ready-state flow is identical.
        const ids = loadIds();
        for (const id of ids) this._addInternal(id, { persist: false });
    }

    /** Snapshot of the current asset list. */
    list()         { return this._assets.slice(); }
    has(noradId)   { return this._assets.some(a => a.noradId === noradId); }
    count()        { return this._assets.length; }
    isFull()       { return this._assets.length >= MAX_ASSETS; }

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
     * Add a NORAD ID to the fleet. Resolves to:
     *   { ok: true,  id }
     *   { ok: false, reason: 'invalid-id' | 'already-added' | 'fleet-full' | 'fetch-failed' }
     *
     * The fleet emits change events both when the asset is first
     * inserted (status: 'pending') and again when its TLE resolves.
     */
    async add(noradIdRaw) {
        const id = parseInt(noradIdRaw, 10);
        if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: 'invalid-id' };
        if (this.has(id))                     return { ok: false, reason: 'already-added' };
        if (this.isFull())                    return { ok: false, reason: 'fleet-full' };

        const asset = await this._addInternal(id, { persist: true });
        return asset.status === 'ready' ? { ok: true, id } : { ok: false, reason: 'fetch-failed', id };
    }

    async _addInternal(id, { persist }) {
        const asset = {
            noradId: id,
            name:    `#${id}`,
            tle:     null,
            status:  'pending',
        };
        this._assets.push(asset);
        if (persist) saveIds(this._assets.map(a => a.noradId));
        this._notify();

        // First check if the asset is already in the tracker catalog
        // (constellation/debris toggle already fetched it).
        let sat = this.tracker?.getSatellite?.(id) ?? null;

        if (!sat) {
            try {
                const tle = await this.tracker.loadNorad(id);
                if (tle) sat = this.tracker.getSatellite(id);
            } catch (_) { /* fall through to error state */ }
        }

        if (sat?.tle) {
            asset.name   = sat.tle.name || sat.name || `#${id}`;
            asset.tle    = sat.tle;
            asset.status = 'ready';
        } else {
            asset.status = 'error';
        }
        this._notify();
        return asset;
    }

    remove(noradId) {
        const idx = this._assets.findIndex(a => a.noradId === noradId);
        if (idx < 0) return false;
        this._assets.splice(idx, 1);
        saveIds(this._assets.map(a => a.noradId));
        this._notify();
        return true;
    }

    clear() {
        this._assets.length = 0;
        saveIds([]);
        this._notify();
    }

    static MAX_ASSETS = MAX_ASSETS;
}
