/**
 * satellite-game-transitions.js — fade veil + camera-move orchestration.
 *
 * Two flavours: `fade()` blanks the screen for menu-to-menu swaps; `camera()`
 * holds while the scene controller runs an in-world camera tween (used for
 * briefing → flight so the launch reads as a continuous shot, not a cut).
 */
export class TransitionController {
  constructor(veilEl) {
    this.veil = veilEl;
    this.locked = false;
  }

  async fade(action, { duration = 220 } = {}) {
    if (this.locked) return;
    this.locked = true;
    try {
      this.veil.style.transitionDuration = `${duration}ms`;
      this.veil.classList.add('show');
      await wait(duration);
      await action();
      this.veil.classList.remove('show');
      await wait(duration);
    } finally {
      this.locked = false;
    }
  }

  async camera(action, { holdMs = 0 } = {}) {
    if (this.locked) return;
    this.locked = true;
    try {
      await action();
      if (holdMs) await wait(holdMs);
    } finally {
      this.locked = false;
    }
  }
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
