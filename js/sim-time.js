/**
 * sim-time.js — Simulation time controller for the Celestial Simulator
 * ═══════════════════════════════════════════════════════════════════════
 * Manages virtual simulation time that can be paused, sped up, slowed,
 * or scrubbed to any date. Decouples rendering from wall-clock time.
 *
 * Time modes:
 *   LIVE    — simTime = Date.now() (real-time, default)
 *   PLAY    — simTime advances at timeScale × real speed
 *   PAUSED  — simTime frozen at current position
 *
 * Usage:
 *   import { SimTime } from './js/sim-time.js';
 *   const simTime = new SimTime();
 *   // In animate loop:
 *   const now = simTime.tick(dt);  // returns Date at virtual time
 *   // Controls:
 *   simTime.setSpeed(10);      // 10× real-time
 *   simTime.pause();
 *   simTime.play();
 *   simTime.goLive();
 *   simTime.setDate(new Date('2025-09-15'));
 */

export class SimTime {
    constructor() {
        this._mode = 'LIVE';       // LIVE | PLAY | PAUSED
        this._speed = 1.0;         // time scale multiplier
        this._simMs = Date.now();  // current virtual time in ms
        this._listeners = [];
    }

    /** Current virtual time as a Date */
    get now() { return new Date(this._simMs); }

    /** Current virtual time in epoch ms */
    get ms() { return this._simMs; }

    /** Current mode: 'LIVE', 'PLAY', or 'PAUSED' */
    get mode() { return this._mode; }

    /** Current speed multiplier */
    get speed() { return this._speed; }

    /** Is the simulation running in real-time? */
    get isLive() { return this._mode === 'LIVE'; }

    /** Is the simulation paused? */
    get isPaused() { return this._mode === 'PAUSED'; }

    /**
     * Advance simulation time by dt seconds (call once per frame).
     * @param {number} dt  Wall-clock delta in seconds
     * @returns {Date} Current simulation time
     */
    tick(dt) {
        if (this._mode === 'LIVE') {
            this._simMs = Date.now();
        } else if (this._mode === 'PLAY') {
            this._simMs += dt * 1000 * this._speed;
        }
        // PAUSED: no change
        return this.now;
    }

    /** Set playback speed (negative = reverse time) */
    setSpeed(s) {
        this._speed = s;
        if (this._mode === 'LIVE' && s !== 1.0) {
            this._mode = 'PLAY';
        }
        this._notify();
    }

    /** Pause the simulation */
    pause() {
        if (this._mode === 'LIVE') this._simMs = Date.now();
        this._mode = 'PAUSED';
        this._notify();
    }

    /** Resume playback at current speed */
    play() {
        if (this._mode === 'PAUSED' || this._mode === 'LIVE') {
            this._mode = 'PLAY';
        }
        this._notify();
    }

    /** Return to real-time */
    goLive() {
        this._mode = 'LIVE';
        this._speed = 1.0;
        this._simMs = Date.now();
        this._notify();
    }

    /** Jump to a specific date */
    setDate(date) {
        this._simMs = date.getTime();
        if (this._mode === 'LIVE') this._mode = 'PAUSED';
        this._notify();
    }

    /** Offset from current position by hours */
    offsetHours(h) {
        this._simMs += h * 3600000;
        if (this._mode === 'LIVE') this._mode = 'PAUSED';
        this._notify();
    }

    /** Register a change listener */
    onChange(fn) { this._listeners.push(fn); }

    _notify() {
        for (const fn of this._listeners) fn(this);
    }
}

/** Speed presets for the UI */
export const SPEED_PRESETS = [
    { label: '1×',     value: 1 },
    { label: '10×',    value: 10 },
    { label: '60×',    value: 60 },
    { label: '1h/s',   value: 3600 },
    { label: '1d/s',   value: 86400 },
    { label: '-1×',    value: -1 },
    { label: '-60×',   value: -60 },
    { label: '-1d/s',  value: -86400 },
];
