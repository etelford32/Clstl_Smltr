// ecs.js — a deliberately small entity-component-system used by the unified
// observatory (observatory.js). Entities are integer ids; components are
// per-name Maps of plain data; systems are objects with init/update run in
// registration order each tick. Shared singletons (camera, timeline, worker
// proxy, renderer) live in `world.res`.
//
// Small on purpose: three lanes and a handful of singletons don't need
// archetypes or query caching — they need explicit, inspectable data flow.

export class World {
    constructor() {
        this._nextId = 1;
        this._stores = new Map();     // componentName → Map<entity, data>
        this.systems = [];
        this.res = {};                // shared resources/singletons
    }

    entity() { return this._nextId++; }

    add(e, name, data) {
        let store = this._stores.get(name);
        if (!store) { store = new Map(); this._stores.set(name, store); }
        store.set(e, data);
        return data;
    }

    get(e, name) { return this._stores.get(name)?.get(e); }

    /** Map<entity, data> for one component (empty map if none). */
    store(name) {
        let s = this._stores.get(name);
        if (!s) { s = new Map(); this._stores.set(name, s); }
        return s;
    }

    /** Entities having ALL the named components. */
    query(...names) {
        const [first, ...rest] = names.map(n => this.store(n));
        const out = [];
        if (!first) return out;
        for (const e of first.keys()) {
            if (rest.every(s => s.has(e))) out.push(e);
        }
        return out;
    }

    system(s) { this.systems.push(s); s.init?.(this); return s; }

    tick(dt, wall) {
        for (const s of this.systems) s.update?.(this, dt, wall);
    }
}
