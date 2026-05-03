/**
 * preview-mode.js — Lightweight UI strip for ?preview=1 iframe embeds
 *
 * When a sim page is loaded inside a viewport iframe (with ?preview=1 in the
 * URL or while embedded under the home-page origin), we hide all chrome
 * (nav, HUD panels, control buttons, footers) and let the simulation canvas
 * fill the frame so the home page can render an actual live preview.
 *
 * Activated as early as possible by setting <html data-preview> before the
 * stylesheet kicks in to avoid a flash of full UI.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const flagged = params.get('preview') === '1';
  const framed = window.self !== window.top;
  if (!flagged && !framed) return;

  const html = document.documentElement;
  html.setAttribute('data-preview', '1');

  const css = `
    html[data-preview],
    html[data-preview] body { background:#000 !important; overflow:hidden !important; }
    html[data-preview] body { margin:0 !important; padding:0 !important; }
    html[data-preview] nav,
    html[data-preview] .nav,
    html[data-preview] .skip-link,
    html[data-preview] header.site-header,
    html[data-preview] footer,
    html[data-preview] #hud,
    html[data-preview] .hud,
    html[data-preview] .cv-strip,
    html[data-preview] .cv-btn,
    html[data-preview] #btn-panel-open,
    html[data-preview] .sim-controls,
    html[data-preview] .sim-controls-grid,
    html[data-preview] .sap,
    html[data-preview] .control-panel,
    html[data-preview] .controls,
    html[data-preview] .panel,
    html[data-preview] .hud-panel,
    html[data-preview] .legend,
    html[data-preview] .alert-panel,
    html[data-preview] .toast,
    html[data-preview] .modal,
    html[data-preview] .modal-overlay,
    html[data-preview] .tier-gate,
    html[data-preview] .upsell,
    html[data-preview] .live-status-bar,
    html[data-preview] .nav-bar,
    html[data-preview] .topbar,
    html[data-preview] .toolbar,
    html[data-preview] .sidebar { display:none !important; }
    html[data-preview] main { padding:0 !important; margin:0 !important; }
    html[data-preview] #canvas-wrap,
    html[data-preview] .canvas-wrap,
    html[data-preview] #stage,
    html[data-preview] .stage {
      position:fixed !important; inset:0 !important;
      width:100vw !important; height:100vh !important;
      max-width:none !important; max-height:none !important;
      border:0 !important; border-radius:0 !important;
    }
    html[data-preview] canvas {
      width:100% !important; height:100% !important;
      display:block !important;
    }
  `;
  const style = document.createElement('style');
  style.id = 'preview-mode-styles';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  // Block pointer / keyboard input — previews are non-interactive.
  document.addEventListener('DOMContentLoaded', () => {
    document.body && document.body.style.setProperty('pointer-events', 'none', 'important');
  }, { once: true });

  // Tell the parent page we're ready so it can fade-in over the canvas poster.
  window.addEventListener('load', () => {
    try { window.parent && window.parent.postMessage({ type: 'preview-ready' }, '*'); } catch (_) {}
  }, { once: true });
})();
