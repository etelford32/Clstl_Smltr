/**
 * Air-quality frame staging cache.
 *
 * Mirrors WeatherHistory's storage rule: observations are durable, forecasts
 * are session-only. Persisting a model forecast across reloads risks showing
 * an obsolete model run; preliminary AirNow measurements remain valid as
 * historical observations and are safe to retain for the seven-day scrub.
 */

const DB_NAME = 'air_quality_frames_v1';
const DB_VERSION = 1;
const STORE = 'observations';
const MEMORY_MAX = 18;
const OBSERVATION_MAX = 48;

export class AirQualityFrameStore {
    constructor() {
        this._memory = new Map();
        this._db = null;
        this._dbOk = false;
    }

    async open() {
        if (typeof indexedDB === 'undefined') return this;
        try {
            this._db = await new Promise((resolve, reject) => {
                const request = indexedDB.open(DB_NAME, DB_VERSION);
                request.onupgradeneeded = event => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE)) {
                        db.createObjectStore(STORE, { keyPath: 'requestKey' });
                    }
                };
                request.onsuccess = event => resolve(event.target.result);
                request.onerror = () => reject(request.error);
            });
            this._dbOk = true;
        } catch (error) {
            console.warn('[AirQualityFrameStore] IndexedDB unavailable:', error.message);
        }
        return this;
    }

    async get(requestKey) {
        if (this._memory.has(requestKey)) {
            const frame = this._memory.get(requestKey);
            this._touch(requestKey, frame);
            return frame;
        }
        if (!this._dbOk) return null;
        try {
            const frame = await new Promise((resolve, reject) => {
                const request = this._db.transaction(STORE, 'readonly')
                    .objectStore(STORE).get(requestKey);
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => reject(request.error);
            });
            if (frame) this._touch(requestKey, frame);
            return frame;
        } catch {
            return null;
        }
    }

    async put(frame) {
        if (!frame?.requestKey) return;
        this._touch(frame.requestKey, frame);
        if (!this._dbOk || frame.provenance?.kind !== 'observation') return;
        try {
            await new Promise((resolve, reject) => {
                const tx = this._db.transaction(STORE, 'readwrite');
                tx.objectStore(STORE).put(frame);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            await this._prune();
        } catch (error) {
            console.warn('[AirQualityFrameStore] observation persist failed:', error.message);
        }
    }

    _touch(key, frame) {
        this._memory.delete(key);
        this._memory.set(key, frame);
        while (this._memory.size > MEMORY_MAX) {
            this._memory.delete(this._memory.keys().next().value);
        }
    }

    async _prune() {
        const rows = await new Promise((resolve, reject) => {
            const request = this._db.transaction(STORE, 'readonly')
                .objectStore(STORE).getAll();
            request.onsuccess = () => resolve(request.result ?? []);
            request.onerror = () => reject(request.error);
        });
        if (rows.length <= OBSERVATION_MAX) return;
        rows.sort((a, b) => Date.parse(a.retrievedAt) - Date.parse(b.retrievedAt));
        const remove = rows.slice(0, rows.length - OBSERVATION_MAX);
        await new Promise((resolve, reject) => {
            const tx = this._db.transaction(STORE, 'readwrite');
            const store = tx.objectStore(STORE);
            for (const frame of remove) store.delete(frame.requestKey);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    }
}

export default AirQualityFrameStore;
