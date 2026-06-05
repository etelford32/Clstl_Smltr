/**
 * fleet-glyphs.js — L0 owned-fleet layer for the Operations globe.
 *
 * Workstream C, L0 tier: the operator's own assets (MyFleet, ≤10) get a
 * persistent reticle glyph and a selectable HTML label, always drawn and
 * always legible — immune to the LOD decimation/cull that thins the bulk
 * catalogue, because these are separate objects, not points in the cloud.
 *
 * Two parts per asset:
 *   - a 3D billboard reticle sprite at the asset's position. depthTest is
 *     on so Earth occludes it naturally; it is re-scaled each frame to a
 *     roughly constant on-screen size so it stays readable at any zoom.
 *   - an HTML chip (name + altitude) projected to screen, click-to-select.
 *     The chip hides when the asset is behind the globe or off-screen.
 *
 * Selection is shared with the rest of the console via the same bus the
 * deck and picker use (onSelect / onSelectChange), so a glyph, a fleet
 * row, and a globe dot all light the same asset.
 */

import * as THREE from 'three';

const EARTH_R_KM = 6371;

/** Procedural reticle: a ring with four tick marks. Shared by all glyphs. */
function makeReticleTexture() {
    const s = 64;
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, s, s);
    ctx.strokeStyle = 'rgba(180,255,240,0.95)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(s / 2, s / 2, s / 2 - 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineWidth = 3;
    for (const deg of [0, 90, 180, 270]) {
        const rad = (deg * Math.PI) / 180;
        const r1 = s / 2 - 17, r2 = s / 2 - 5;
        ctx.beginPath();
        ctx.moveTo(s / 2 + Math.cos(rad) * r1, s / 2 + Math.sin(rad) * r1);
        ctx.lineTo(s / 2 + Math.cos(rad) * r2, s / 2 + Math.sin(rad) * r2);
        ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
}

/** Segment/sphere occlusion: is P hidden behind the unit-ish Earth from C? */
function occludedByEarth(cam, p, R) {
    const cDotC = cam.x * cam.x + cam.y * cam.y + cam.z * cam.z;
    if (cDotC <= R * R) return false;            // camera under the surface (n/a)
    const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
    const a = dx * dx + dy * dy + dz * dz;
    const b = 2 * (cam.x * dx + cam.y * dy + cam.z * dz);
    const c = cDotC - R * R;
    const disc = b * b - 4 * a * c;
    if (disc <= 0) return false;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t > 0 && t < 1;
}

export class FleetGlyphs {
    /**
     * @param {OperationsGlobe} globe
     * @param {MyFleet} myFleet
     * @param {SatelliteTracker} tracker
     * @param {object} opts
     * @param {HTMLElement} opts.host            globe wrap element (label overlay parent)
     * @param {(id:number)=>void} opts.onSelect
     * @param {()=>number|null} opts.getSelectedId
     * @param {(fn:(id:number|null)=>void)=>void} opts.onSelectChange
     */
    constructor(globe, myFleet, tracker, opts = {}) {
        this.globe = globe;
        this.myFleet = myFleet;
        this.tracker = tracker;
        this.onSelect = opts.onSelect ?? (() => {});
        this.getSelectedId = opts.getSelectedId ?? (() => null);

        this._earthR = globe.getEarthRadius();
        this._tex = makeReticleTexture();
        this._entries = new Map();   // noradId → { sprite, chip, asset }
        this._scratch = new THREE.Vector3();
        this._cam = new THREE.Vector3();
        this._visible = opts.visible ?? true;

        // HTML label overlay — sits above the canvas, transparent to pointer
        // events except on the chips themselves so globe drag still works.
        this._layer = document.createElement('div');
        this._layer.className = 'op-fleet-glyph-layer';
        if (!this._visible) this._layer.style.display = 'none';
        (opts.host || document.body).appendChild(this._layer);

        this._offFleet = myFleet.onChange((list) => this._reconcile(list));
        this._offSel = opts.onSelectChange
            ? opts.onSelectChange((id) => this._applySelection(id))
            : null;
        this._offTick = globe.onTick(() => this._tick());
    }

    /** Add/remove sprites + chips to match the current fleet list. */
    _reconcile(list) {
        const want = new Set(list.map((a) => a.noradId));

        // Drop entries no longer in the fleet.
        for (const [id, e] of this._entries) {
            if (!want.has(id)) {
                this.globe.getScene().remove(e.sprite);
                e.sprite.material.dispose();
                e.chip.remove();
                this._entries.delete(id);
            }
        }

        // Add / refresh entries.
        for (const asset of list) {
            let e = this._entries.get(asset.noradId);
            if (!e) {
                const mat = new THREE.SpriteMaterial({
                    map: this._tex,
                    color: 0x9ffff0,
                    transparent: true,
                    depthTest: true,    // let Earth occlude the glyph
                    depthWrite: false,
                });
                const sprite = new THREE.Sprite(mat);
                sprite.renderOrder = 12;
                this.globe.getScene().add(sprite);

                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'op-fleet-glyph-chip';
                chip.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    this.onSelect(asset.noradId);
                });
                this._layer.appendChild(chip);

                e = { sprite, chip, asset };
                this._entries.set(asset.noradId, e);
            }
            e.asset = asset;
            // Chip text: name + NORAD; altitude filled per-frame once known.
            const nm = asset.name && asset.name !== `#${asset.noradId}` ? asset.name : `#${asset.noradId}`;
            chipLabel(e.chip, nm, asset.status);
        }
        this._applySelection(this.getSelectedId());
        this._tick();
    }

    _applySelection(selectedId) {
        for (const [id, e] of this._entries) {
            const on = id === selectedId;
            e.chip.classList.toggle('op-fleet-glyph-chip--sel', on);
            e.sprite.material.color.set(on ? 0x66ffe0 : 0x9ffff0);
            e._selected = on;
        }
    }

    _tick() {
        if (!this._visible) return;
        const cam = this.globe.camera;
        this._cam.copy(cam.position);
        const host = this._layer;
        const w = host.clientWidth, h = host.clientHeight;
        if (!w || !h) return;

        // Constant-ish on-screen glyph size: scale by distance to camera.
        const R = this._earthR;

        for (const [id, e] of this._entries) {
            const pos = this.tracker.getPositionXYZ(id, this._scratch);
            if (!pos || (pos.x === 0 && pos.y === 0 && pos.z === 0)) {
                e.sprite.visible = false;
                e.chip.style.display = 'none';
                continue;
            }
            e.sprite.position.set(pos.x, pos.y, pos.z);
            e.sprite.visible = true;
            const dist = this._cam.distanceTo(e.sprite.position);
            const k = (e._selected ? 0.05 : 0.038) * dist;
            e.sprite.scale.set(k, k, 1);

            // Altitude for the chip (scene units → km above Earth surface).
            const r = Math.hypot(pos.x, pos.y, pos.z);
            const altKm = Math.max(0, (r / R - 1) * EARTH_R_KM);
            chipAlt(e.chip, altKm);

            // Project to screen + hide when behind the globe or camera.
            this._scratch.set(pos.x, pos.y, pos.z).project(cam);
            const behindCam = this._scratch.z > 1;
            const occluded = occludedByEarth(this._cam, e.sprite.position, R);
            if (behindCam || occluded) {
                e.chip.style.display = 'none';
                continue;
            }
            const sx = (this._scratch.x * 0.5 + 0.5) * w;
            const sy = (-this._scratch.y * 0.5 + 0.5) * h;
            e.chip.style.display = '';
            e.chip.style.transform = `translate(-50%, calc(-100% - 10px)) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
        }
    }

    setVisible(on) {
        this._visible = !!on;
        this._layer.style.display = on ? '' : 'none';
        for (const e of this._entries.values()) e.sprite.visible = !!on;
        if (on) this._tick();
    }
    isVisible() { return this._visible; }

    dispose() {
        this._offTick?.();
        this._offFleet?.();
        this._offSel?.();
        for (const [, e] of this._entries) {
            this.globe.getScene().remove(e.sprite);
            e.sprite.material.dispose();
        }
        this._entries.clear();
        this._tex.dispose();
        this._layer.remove();
    }
}

/* ─── Chip DOM helpers (kept tiny; structure built once) ─────── */

function chipLabel(chip, name, status) {
    let nameEl = chip.querySelector('.op-fleet-glyph-name');
    if (!nameEl) {
        chip.innerHTML =
            '<span class="op-fleet-glyph-dot"></span>' +
            '<span class="op-fleet-glyph-name"></span>' +
            '<span class="op-fleet-glyph-alt"></span>';
        nameEl = chip.querySelector('.op-fleet-glyph-name');
    }
    nameEl.textContent = name;
    chip.classList.toggle('op-fleet-glyph-chip--pending', status === 'pending');
    chip.classList.toggle('op-fleet-glyph-chip--error', status === 'error');
}

function chipAlt(chip, altKm) {
    const altEl = chip.querySelector('.op-fleet-glyph-alt');
    if (altEl) altEl.textContent = `${Math.round(altKm)} km`;
}
