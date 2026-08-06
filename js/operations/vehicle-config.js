import {
    configFromProfile, sanitizeVehicleConfig, suggestVehicleProfile,
} from './vehicle-scenarios.js';

const STORAGE_KEY = 'pp-ops-vehicle-config-v1';

function load() {
    try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
        return raw && typeof raw === 'object' ? raw : {};
    } catch (_) { return {}; }
}

function save(value) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch (_) {}
}

export class VehicleConfigStore {
    constructor() {
        this._values = new Map();
        this._subs = new Set();
        for (const [id, value] of Object.entries(load())) {
            const noradId = Number(id);
            if (Number.isFinite(noradId)) this._values.set(noradId, sanitizeVehicleConfig(value));
        }
    }

    get(noradId) {
        const value = this._values.get(Number(noradId));
        return value ? { ...value } : null;
    }

    ensure(noradId, hint = {}) {
        const id = Number(noradId);
        if (!Number.isFinite(id)) return null;
        const existing = this.get(id);
        if (existing) return existing;
        const value = configFromProfile(suggestVehicleProfile(hint));
        this.set(id, value);
        return this.get(id);
    }

    set(noradId, value) {
        const id = Number(noradId);
        if (!Number.isFinite(id)) return null;
        const next = sanitizeVehicleConfig(value);
        this._values.set(id, next);
        this._persist();
        this._notify(id);
        return this.get(id);
    }

    reset(noradId, profileId) {
        return this.set(noradId, configFromProfile(profileId));
    }

    remove(noradId) {
        const id = Number(noradId);
        if (!this._values.delete(id)) return false;
        this._persist();
        this._notify(id);
        return true;
    }

    list() {
        return [...this._values.entries()].map(([noradId, config]) => ({ noradId, config: { ...config } }));
    }

    onChange(fn) {
        this._subs.add(fn);
        return () => this._subs.delete(fn);
    }

    _persist() {
        save(Object.fromEntries(this._values));
    }

    _notify(noradId) {
        const value = this.get(noradId);
        for (const fn of this._subs) {
            try { fn({ noradId, config: value }); } catch (_) {}
        }
    }
}
