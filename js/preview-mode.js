/**
 * preview-mode.js — Lightweight UI strip for ?preview=1 iframe embeds
 *
 * Activated when the page is loaded with ?preview=1 in the URL or detected
 * inside an iframe. Sets <html data-preview="1"> as early as possible, then
 * promotes the [data-preview-stage] element (or the largest canvas's nearest
 * div) to fixed-fullscreen and walks the body tree hiding every node that is
 * neither the stage, an ancestor of the stage, nor a descendant of the stage.
 *
 * No interactivity is allowed inside a preview — pointer-events are killed.
 */
(function () {
  const params = new URLSearchParams(window.location.search);
  const flagged = params.get('preview') === '1';
  let framed = false;
  try { framed = window.self !== window.top; } catch (_) { framed = true; }
  if (!flagged && !framed) return;

  const html = document.documentElement;
  html.setAttribute('data-preview', '1');

  // Inline style block: kicks in immediately so there's no flash of the full UI.
  const css = `
    html[data-preview], html[data-preview] body {
      background:#000 !important;
      overflow:hidden !important;
      margin:0 !important;
      padding:0 !important;
    }
    html[data-preview] .preview-stage {
      position:fixed !important; inset:0 !important;
      width:100vw !important; height:100vh !important;
      max-width:none !important; max-height:none !important;
      margin:0 !important; padding:0 !important;
      border:0 !important; border-radius:0 !important;
      transform:none !important;
      background:#000 !important;
      z-index:1 !important;
    }
    html[data-preview] .preview-stage > canvas,
    html[data-preview] .preview-stage canvas {
      width:100% !important; height:100% !important;
      display:block !important;
    }
    /* Hide common floating chrome inside the stage (HUD, toolbars, time-warp) */
    html[data-preview] .preview-stage .hud,
    html[data-preview] .preview-stage #hud,
    html[data-preview] .preview-stage .helio-live-hud,
    html[data-preview] .preview-stage .helio-timewarp,
    html[data-preview] .preview-stage .cv-strip,
    html[data-preview] .preview-stage .cv-btn,
    html[data-preview] .preview-stage button,
    html[data-preview] .preview-stage [class*="legend"],
    html[data-preview] .preview-stage #scroll-hint,
    html[data-preview] .preview-stage .panel,
    html[data-preview] .preview-stage [data-minimize],
    html[data-preview] .preview-stage .panel-header,
    html[data-preview] .preview-stage .alert-banner {
      display:none !important;
    }
  `;
  const style = document.createElement('style');
  style.id = 'preview-mode-styles';
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);

  function findStage() {
    let stage = document.querySelector('[data-preview-stage]');
    if (stage) return stage;

    // Fallback: largest <canvas> wrapped in its nearest <div>.
    let best = null, bestArea = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const w = c.width || c.clientWidth || 0;
      const h = c.height || c.clientHeight || 0;
      const a = w * h;
      if (a > bestArea) { bestArea = a; best = c; }
    }
    return best?.closest('div') || best;
  }

  // Hide every node in the body subtree that is NOT the stage, an ancestor
  // of the stage, or a descendant of the stage.
  function hideExceptStage(stage, root) {
    if (!root) return;
    for (const child of Array.from(root.children)) {
      if (child === stage) continue;
      if (child.tagName === 'SCRIPT' || child.tagName === 'STYLE' ||
          child.tagName === 'LINK' || child.tagName === 'TEMPLATE') continue;
      if (child.contains(stage)) {
        // ancestor — keep visible, recurse to hide its non-stage descendants
        hideExceptStage(stage, child);
      } else {
        child.style.setProperty('display', 'none', 'important');
      }
    }
  }

  function promote() {
    const body = document.body;
    if (!body) return;
    body.style.setProperty('pointer-events', 'none', 'important');

    const stage = findStage();
    if (!stage) return;

    stage.classList.add('preview-stage');
    hideExceptStage(stage, body);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', promote, { once: true });
  } else {
    promote();
  }
  // Re-run after load: late scripts often inject panels / nav.
  window.addEventListener('load', () => setTimeout(promote, 250), { once: true });
  setTimeout(() => { if (html.hasAttribute('data-preview')) promote(); }, 1500);
  setTimeout(() => { if (html.hasAttribute('data-preview')) promote(); }, 4000);

  // Tell the parent iframe wrapper we're ready so it can fade in.
  window.addEventListener('load', () => {
    try { window.parent && window.parent.postMessage({ type: 'preview-ready' }, '*'); } catch (_) {}
  }, { once: true });
})();
