/**
 * vec-lite.js — the ~3 THREE.js primitives coords.js / trip-planner.js
 * actually use, with byte-identical math, and nothing else.
 *
 * WHY THIS EXISTS
 * coords.js is pure coordinate geometry and trip-planner.js does great-
 * circle slerp scratch math. Both only ever touched THREE.Vector3,
 * THREE.Vector2 and THREE.MathUtils.clamp — yet importing them pulled the
 * entire `three` module (a bare specifier) into every page's graph,
 * including the dashboard which renders no 3D. That bare specifier is
 * what required dashboard.html's import map, and a mis-ordered import map
 * is exactly what blanked the dashboard. Resolving these two files to
 * this local module removes `three` from the dashboard graph entirely,
 * so the bug class can't recur.
 *
 * Each method below is a line-for-line match of three@0.160's
 * implementation for the subset in use, so numerical results (and
 * coords.js's 1e-9 selfTest) are unchanged. Instances carry the
 * `isVector3` / `isVector2` brand so code that feature-detects real
 * THREE vectors (e.g. coords._extractVec3) still works when callers on
 * 3D pages pass genuine THREE.Vector3 objects across the boundary —
 * the interop surface is only .x/.y/.z plus .set/.copy.
 */

export class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    get isVector3() { return true; }

    set(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
        return this;
    }

    copy(v) {
        this.x = v.x;
        this.y = v.y;
        this.z = v.z;
        return this;
    }

    add(v) {
        this.x += v.x;
        this.y += v.y;
        this.z += v.z;
        return this;
    }

    addScaledVector(v, s) {
        this.x += v.x * s;
        this.y += v.y * s;
        this.z += v.z * s;
        return this;
    }

    multiplyScalar(s) {
        this.x *= s;
        this.y *= s;
        this.z *= s;
        return this;
    }

    dot(v) {
        return this.x * v.x + this.y * v.y + this.z * v.z;
    }

    lengthSq() {
        return this.x * this.x + this.y * this.y + this.z * this.z;
    }

    length() {
        return Math.sqrt(this.lengthSq());
    }

    normalize() {
        const l = this.length() || 1;
        this.x /= l;
        this.y /= l;
        this.z /= l;
        return this;
    }

    crossVectors(a, b) {
        const ax = a.x, ay = a.y, az = a.z;
        const bx = b.x, by = b.y, bz = b.z;
        this.x = ay * bz - az * by;
        this.y = az * bx - ax * bz;
        this.z = ax * by - ay * bx;
        return this;
    }

    distanceToSquared(v) {
        const dx = this.x - v.x;
        const dy = this.y - v.y;
        const dz = this.z - v.z;
        return dx * dx + dy * dy + dz * dz;
    }

    distanceTo(v) {
        return Math.sqrt(this.distanceToSquared(v));
    }

    toArray(array = [], offset = 0) {
        array[offset] = this.x;
        array[offset + 1] = this.y;
        array[offset + 2] = this.z;
        return array;
    }
}

export class Vector2 {
    constructor(x = 0, y = 0) {
        this.x = x;
        this.y = y;
    }

    get isVector2() { return true; }

    set(x, y) {
        this.x = x;
        this.y = y;
        return this;
    }

    copy(v) {
        this.x = v.x;
        this.y = v.y;
        return this;
    }

    toArray(array = [], offset = 0) {
        array[offset] = this.x;
        array[offset + 1] = this.y;
        return array;
    }
}

export const MathUtils = {
    // three@0.160 MathUtils.clamp, verbatim.
    clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    },
};
