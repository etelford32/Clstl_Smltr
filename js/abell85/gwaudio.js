// gwaudio.js — WebAudio sonification of the GW chirp, shared by the Abell 85
// lab (main.js) and the Black Hole Observatory (observatory.js).
//
// The oscillator tracks f_GW shifted up by GW_AUDIO_SHIFT (these binaries chirp
// at nanohertz; the shift factor is displayed in the UI so the sonification is
// honest), and the gain tracks log-strain. Everything is smoothed through
// setTargetAtTime so scrubbing doesn't click.

export const GW_AUDIO_SHIFT = 3e10;    // audio Hz per physical Hz — shown in the UI

export class GwAudio {
    constructor() { this.on = false; this.ctx = null; }

    /** Toggle on/off. Returns the new state (false if WebAudio unavailable). */
    toggle() {
        if (!this.on) {
            if (!this.ctx) {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return false;
                this.ctx = new AC();
                this.osc = this.ctx.createOscillator();
                this.osc.type = 'sine';
                this.gain = this.ctx.createGain();
                this.gain.gain.value = 0;
                this.osc.connect(this.gain).connect(this.ctx.destination);
                this.osc.start();
            }
            this.ctx.resume();
            this.on = true;
        } else {
            this.gain?.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
            this.on = false;
            setTimeout(() => { if (!this.on) this.ctx?.suspend(); }, 250);
        }
        return this.on;
    }

    /** Feed the current physical GW frequency (Hz) and strain each frame. */
    update(fgw, strain) {
        if (!this.on || !this.ctx) return;
        const t = this.ctx.currentTime;
        if (fgw > 0 && strain > 0) {
            const f = Math.min(Math.max(fgw * GW_AUDIO_SHIFT, 25), 2600);
            this.osc.frequency.setTargetAtTime(f, t, 0.08);
            const g = 0.2 * Math.min(Math.max((Math.log10(strain) + 17.5) / 4, 0), 1);
            this.gain.gain.setTargetAtTime(g, t, 0.1);
        } else {
            this.gain.gain.setTargetAtTime(0, t, 0.1);
        }
    }
}
