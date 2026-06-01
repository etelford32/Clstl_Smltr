/**
 * js/farside-watch.js — page controller for far-side-watch.html.
 *
 * Wires the modular far-side package (js/farside/*) into the page:
 *   feed → detect → track → emergence ETA → render + watch-list + alerts.
 *
 * Gating model ("gated for sign-ups"): the page is a public PREVIEW — anyone
 * can see the map and the top forecast. Live detections, the full watch list,
 * the alert trigger, and CSV/REST export unlock on sign-up (operator-grade
 * export is the Advanced tier). Nothing here hard-paywalls the preview, in
 * line with the B2G/request-access pivot.
 */

import { auth } from './auth.js';
import {
    getLatestMap, getMapSeries, getStoredFrames,
    detectSignatures,
    farSideWatchList, farSideWatchListFromFrames,
    dispatchEmergenceAlerts,
    renderFlatMap, renderTopDown,
    SOURCES, VALIDATION_CASES,
} from './farside/index.js';

const $ = (id) => document.getElementById(id);

let _state = { map: null, dets: [], watch: [], signedIn: false, pro: false };

function fmtDate(iso) {
    try { return new Date(iso).toUTCString().replace(':00 GMT', ' UTC').replace('GMT', 'UTC'); }
    catch { return iso; }
}
function fmtDay(iso) {
    try { return new Date(iso).toISOString().slice(0, 10); } catch { return iso; }
}

function paintCanvases() {
    const { map, dets, watch } = _state;
    if (!map) return;
    const flat = $('fsw-flat'), top = $('fsw-topdown');
    if (flat) renderFlatMap(flat, map, { tracks: watch, showLimbs: true });
    if (top) renderTopDown(top, map, { tracks: watch });
}

function renderWatchList() {
    const host = $('fsw-watchlist');
    if (!host) return;
    const { watch, signedIn } = _state;
    $('fsw-count').textContent = String(watch.length);

    if (!watch.length) {
        host.innerHTML = `<p class="fsw-empty">No far-side signatures above threshold in the current map.</p>`;
        return;
    }

    // Preview gating: signed-out users see the single soonest emergence; the
    // rest are blurred behind the sign-up CTA.
    const visible = signedIn ? watch : watch.slice(0, 1);
    const hidden = signedIn ? [] : watch.slice(1);

    const row = (t) => `
      <div class="fsw-track ${t.strong ? 'fsw-track--strong' : ''}">
        <div class="fsw-track-hd">
          <span class="fsw-eta">${t.etaDays < 0.05 ? 'at limb' : '~' + t.etaDays.toFixed(1) + ' d'}</span>
          <span class="fsw-track-pos">L${t.lon.toFixed(0)}° · lat ${t.lat.toFixed(0)}°</span>
          ${t.strong ? '<span class="fsw-chip fsw-chip--strong">STRONG</span>' : ''}
          ${t.validationCase ? '<span class="fsw-chip fsw-chip--val">VALIDATION</span>' : ''}
        </div>
        <div class="fsw-track-meta">
          emerges <b>${fmtDate(t.emergenceUTC)}</b> ±${t.etaBandDays.toFixed(1)} d
          · strength ${t.latestStrength.toFixed(2)}
          · trend ${t.trend >= 0 ? '▲' : '▼'} ${Math.abs(t.trend).toFixed(2)}
          · conf ${(t.confidence * 100).toFixed(0)}%
          · seen ${t.frames}×
          ${t.validationCase ? `<br><span class="fsw-val-note">↳ ${t.validationCase.label}</span>` : ''}
        </div>
      </div>`;

    host.innerHTML = visible.map(row).join('')
        + (hidden.length
            ? `<div class="fsw-gate-inline">
                 <div class="fsw-gate-blur">${hidden.map(row).join('')}</div>
                 <div class="fsw-gate-cta">
                   <p><b>${hidden.length}</b> more far-side ${hidden.length === 1 ? 'region' : 'regions'} tracked.</p>
                   <p class="fsw-gate-sub">Sign up free to unlock the full watch list, the "rotating into view" alert, and CSV/REST export.</p>
                   <a class="fsw-btn fsw-btn--primary" href="/signup.html?from=far-side-watch">Sign up →</a>
                   <a class="fsw-btn" href="/signin.html?from=far-side-watch">Sign in</a>
                 </div>
               </div>`
            : '');
}

function renderValidation() {
    const host = $('fsw-validation');
    if (!host) return;
    host.innerHTML = VALIDATION_CASES.map((c) => {
        const matched = _state.watch.find((t) => t.validationCase?.id === c.id);
        return `
        <div class="fsw-val ${matched ? 'fsw-val--hit' : ''}">
          <div class="fsw-val-hd">${matched ? '✓' : '○'} ${c.label}</div>
          <div class="fsw-val-meta">
            E-limb crossing ${fmtDay(c.eastLimbCrossingUTC)}
            · Carrington L${c.carringtonLon}°, lat ${c.carringtonLat}°
            ${matched ? `· <b>flagged ${matched.etaDays.toFixed(1)} d out</b>` : '· awaiting backtest'}
          </div>
        </div>`;
    }).join('');
}

function setSourcePill(map) {
    const pill = $('fsw-source-pill');
    if (!pill) return;
    if (map.synthetic) {
        pill.textContent = '⚠ SYNTHETIC — pipeline preview';
        pill.className = 'fsw-pill fsw-pill--synthetic';
    } else {
        pill.textContent = `● LIVE — ${SOURCES[map.source]?.label ?? map.source}`;
        pill.className = 'fsw-pill fsw-pill--live';
    }
    $('fsw-updated').textContent = fmtDate(map.timestamp);
    $('fsw-l0').textContent = `L0 ${map.L0.toFixed(1)}° · B0 ${map.B0.toFixed(1)}°`;
}

function toCSV(watch) {
    const head = 'lon_carrington,lat,eta_days,eta_band_days,emergence_utc,strength,trend,confidence,frames,strong,validation_case';
    const rows = watch.map((t) => [
        t.lon.toFixed(2), t.lat.toFixed(2), t.etaDays.toFixed(3), t.etaBandDays.toFixed(3),
        t.emergenceUTC, t.latestStrength.toFixed(3), t.trend.toFixed(3),
        t.confidence.toFixed(3), t.frames, t.strong ? 1 : 0, t.validationCase?.id ?? '',
    ].join(','));
    return [head, ...rows].join('\n');
}

function wireControls() {
    const exportBtn = $('fsw-export');
    if (exportBtn) {
        exportBtn.addEventListener('click', () => {
            if (!_state.signedIn) { location.href = '/signup.html?from=far-side-watch'; return; }
            const blob = new Blob([toCSV(_state.watch)], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `far-side-watch_${fmtDay(_state.map.timestamp)}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        });
    }

    const alertBtn = $('fsw-alert-toggle');
    if (alertBtn) {
        alertBtn.addEventListener('click', () => {
            if (!_state.signedIn) { location.href = '/signup.html?from=far-side-watch'; return; }
            const fired = dispatchEmergenceAlerts(_state.watch, { force: true });
            alertBtn.textContent = fired.length
                ? `🔔 ${fired.length} alert${fired.length > 1 ? 's' : ''} sent`
                : '🔔 No region inside the lead window';
            setTimeout(() => { alertBtn.textContent = '🔔 Test emergence alert'; }, 3200);
        });
    }

    window.addEventListener('resize', () => paintCanvases(), { passive: true });
}

export async function initFarSideWatch() {
    try { await auth.ready(); } catch (_) {}
    _state.signedIn = !!auth.isSignedIn?.();
    _state.pro = !!auth.isPro?.();

    // Reflect gate state on the page chrome.
    document.body.classList.toggle('fsw-signedin', _state.signedIn);
    const exportBtn = $('fsw-export');
    if (exportBtn && !_state.signedIn) exportBtn.title = 'Sign up to export';

    wireControls();

    // Latest map for rendering: real stored grid if the cron has populated one,
    // else a labelled synthetic field.
    const map = await getLatestMap('gong');
    _state.map = map;
    _state.dets = detectSignatures(map);

    // Watch list: prefer the cron's stored detection history; fall back to
    // detecting a synthetic series when nothing is stored yet.
    const frames = await getStoredFrames('gong');
    if (frames && frames.length) {
        _state.watch = farSideWatchListFromFrames(frames);
    } else {
        _state.watch = farSideWatchList(await getMapSeries('gong'));
    }

    setSourcePill(map);
    paintCanvases();
    renderWatchList();
    renderValidation();

    // Fire emergence alerts once for signed-in users (de-duped in the module).
    if (_state.signedIn) dispatchEmergenceAlerts(_state.watch);

    // Try to drop the upstream image in as a backdrop; hide on failure.
    const img = $('fsw-img');
    if (img) {
        img.addEventListener('error', () => { img.style.display = 'none'; });
        img.src = SOURCES.gong.endpoint;
    }
}
