/**
 * satellite-game-overlays.js — DOM panel mount/unmount + HUD binding.
 *
 * Each phase is a `<section class="phase-panel" data-phase="...">`. This
 * controller swaps which one is visible and writes HUD values into the
 * `[data-hud]` / `[data-bind]` slots on every store update. Click delegation
 * funnels every `[data-action]`, `[data-mode]`, `[data-ship]`, `[data-vec]`,
 * `[data-warp]` into a single onAction handler that lives in the entry file.
 */
import { gameStore, PHASES } from './satellite-game-store.js';

export class OverlayController {
  constructor(root, { onAction }) {
    this.root = root;
    this.onAction = onAction;
    this.panels = new Map();
    root.querySelectorAll('.phase-panel').forEach((el) => {
      this.panels.set(el.dataset.phase, el);
    });

    this._handleClick = this._handleClick.bind(this);
    root.addEventListener('click', this._handleClick);

    this.activePhase = null;
    this._fadeTimer = null;
  }

  showPhase(phase) {
    if (this.activePhase === phase) return;

    const prev = this.activePhase ? this.panels.get(this.activePhase) : null;
    const next = this.panels.get(phase);

    if (prev) {
      prev.classList.remove('active');
      clearTimeout(this._fadeTimer);
      this._fadeTimer = setTimeout(() => { prev.hidden = true; }, 260);
    }

    if (next) {
      next.hidden = false;
      requestAnimationFrame(() => next.classList.add('active'));
    }

    this.activePhase = phase;
  }

  updateHud(flight) {
    const hud = this.panels.get(PHASES.FLIGHT);
    if (!hud || hud.hidden) return;

    set(hud, '[data-hud="alt"]', `${Math.round(flight.altKm)} km`);
    set(hud, '[data-hud="peap"]', `${Math.round(flight.peKm)} / ${Math.round(flight.apKm)}`);
    set(hud, '[data-hud="dv"]', `${Math.round(flight.dvLeft)} m/s`);
    set(hud, '[data-hud="t"]', formatElapsed(flight.elapsed));
    set(hud, '[data-hud="warp"]', String(flight.warp));
    set(hud, '[data-hud="score"]', flight.score.toLocaleString());
    set(hud, '[data-hud="throttle"]', `${Math.round(flight.throttle * 100)}%`);

    hud.querySelectorAll('.vec-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.vec === flight.vector);
    });
    hud.querySelectorAll('.warp-btn').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.warp) === flight.warp);
    });
    const burnBtn = hud.querySelector('.burn-btn');
    if (burnBtn) burnBtn.classList.toggle('burning', flight.burning);

    const stormEl = hud.querySelector('#storm-warn');
    if (stormEl) {
      if (flight.stormPeakEta != null) {
        stormEl.hidden = false;
        set(hud, '[data-hud="storm-eta"]', formatElapsed(flight.stormPeakEta));
      } else {
        stormEl.hidden = true;
      }
    }
  }

  updateBriefing(mission) {
    const panel = this.panels.get(PHASES.BRIEFING);
    if (!panel) return;
    set(panel, '[data-bind="mission-id"]', mission.id ? `${mission.id} · briefing` : 'briefing');
    set(panel, '[data-bind="mission-title"]', mission.title);
    if (mission.f107) set(panel, '[data-bind="f107"]', mission.f107);
    if (mission.ap) set(panel, '[data-bind="ap"]', mission.ap);
  }

  updateResolution(result) {
    const panel = this.panels.get(PHASES.RESOLUTION);
    if (!panel || !result) return;
    if (result.summary) set(panel, '[data-bind="resolution-summary"]', result.summary);
    if (result.score != null) set(panel, '[data-bind="final-score"]', result.score.toLocaleString());
    if (result.delta) set(panel, '[data-bind="score-delta"]', result.delta);
    if (result.coach) set(panel, '[data-bind="coach-line"]', result.coach);
  }

  setSelectedMode(mode) {
    const panel = this.panels.get(PHASES.GAME_TYPE);
    if (!panel) return;
    panel.querySelectorAll('.mode-card').forEach((card) => {
      const selected = card.dataset.mode === mode;
      card.classList.toggle('primary', selected);
      card.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }

  setSelectedShip(shipId) {
    const panel = this.panels.get(PHASES.SHIP_SELECT);
    if (!panel) return;
    panel.querySelectorAll('.ship-row').forEach((row) => {
      row.classList.toggle('active', row.dataset.ship === shipId);
    });
  }

  _handleClick(e) {
    const actionEl = e.target.closest('[data-action]');
    if (actionEl) {
      this.onAction({ kind: 'action', name: actionEl.dataset.action, el: actionEl });
      return;
    }
    const modeEl = e.target.closest('[data-mode]');
    if (modeEl) {
      this.onAction({ kind: 'mode', value: modeEl.dataset.mode });
      return;
    }
    const shipEl = e.target.closest('[data-ship]');
    if (shipEl) {
      this.onAction({ kind: 'ship', value: shipEl.dataset.ship });
      return;
    }
    const vecEl = e.target.closest('[data-vec]');
    if (vecEl) {
      this.onAction({ kind: 'vec', value: vecEl.dataset.vec });
      return;
    }
    const warpEl = e.target.closest('[data-warp]');
    if (warpEl) {
      this.onAction({ kind: 'warp', value: Number(warpEl.dataset.warp) });
    }
  }
}

function set(root, sel, value) {
  const el = root.querySelector(sel);
  if (el && el.textContent !== value) el.textContent = value;
}

function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}
