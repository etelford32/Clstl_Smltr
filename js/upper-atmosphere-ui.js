/**
 * upper-atmosphere-ui.js — Controls, plots, and state for upper-atmosphere.html
 * ═══════════════════════════════════════════════════════════════════════════
 * Wires three HTML range inputs (altitude / F10.7 / Ap) + a storm-preset
 * chip row to the physics surrogate (upper-atmosphere-engine.js) and the
 * 3D scene (upper-atmosphere-globe.js), and paints two raw-canvas plots:
 *
 *   • Density profile  — log₁₀(ρ) vs altitude, with a horizontal
 *     crosshair at the currently selected altitude.
 *   • Composition stack — per-species number-density fraction vs altitude,
 *     stacked areas in the canonical species order.
 *
 * No chart library — all drawing is plain CanvasRenderingContext2D, same
 * convention as solar-live-canvas.js / forecast-timeline-canvas. Plots
 * are DPI-aware and resize with the panel.
 */

import {
    SPECIES,
    stormPresets,
    exosphereTempK,
    dominantSpecies,
    layerAt,
    ATMOSPHERIC_LAYERS,
    SATELLITE_REFERENCES,
    fetchProfile,
    fetchLiveIndices,
} from './upper-atmosphere-engine.js';
import { ATMOSPHERIC_LAYER_SCHEMA } from './upper-atmosphere-layers.js';
import { layerPhysics } from './upper-atmosphere-physics.js';
import { DEBRIS_FAMILIES } from './debris-catalog.js';
import { CONSTELLATIONS } from './constellation-catalog.js';
import {
    probabilityOfCollision, pcRisk, recommendDeltaV,
    formatDeltaV, deltaVToFuelKg,
} from './collision-avoidance.js';
import { buildAnalyticsBundle }
    from './upper-atmosphere-space-weather-analytics.js';

// ── Palette (matches the globe's density ramp in spirit) ────────────────────
const SPECIES_COLORS = {
    N2: '#3b7fff',
    O2: '#4cc7ff',
    NO: '#7fe0a0',
    O:  '#ffb347',
    N:  '#c078ff',
    He: '#ff6d87',
    H:  '#ffe06b',
};

const SPECIES_LABELS = {
    N2: 'N₂', O2: 'O₂', NO: 'NO', O: 'O', N: 'N', He: 'He', H: 'H',
};

// Same altitude band as the globe shells + profile.
const ALT_MIN = 80;
const ALT_MAX = 2000;

export class UpperAtmosphereUI {
    /**
     * @param {object} opts
     * @param {object} opts.engine     the engine module namespace
     * @param {object} opts.globe      AtmosphereGlobe instance
     * @param {object} opts.elements   { altInput, f107Input, apInput,
     *                                   altVal, f107Val, apVal,
     *                                   presetRow, densityCanvas,
     *                                   compCanvas, stats, summary }
     */
    constructor({ engine, globe, elements, useBackend = true }) {
        this.engine = engine;
        this.globe = globe;
        this.el = elements;
        this.useBackend = useBackend;

        this.state = { f107: 150, ap: 15, altitude: 400 };
        this._refreshInflight = null;
        this._refreshTimer = null;

        this._bindInputs();
        this._renderPresets();
        this._renderLayerLegend();
        this._renderLayerControls();
        this._bindFieldModeRadio();
        this._bindLiveButton();
        this._bindSourcePill();
        this._bindSwpcEventBus();
        this._bindCameraControls();
        this._bindTleFreshnessBus();
        this._bindResize();
        this._paintSourcePill();
        // Initial paint of the TLE-freshness pill — mostly so the
        // pulsing "fetching" state shows on first paint instead of
        // appearing on the first refresh().
        this._paintTleFreshness();
        // Push climatology defaults so the magnetopause / bow shock /
        // streamers all light up at first paint instead of sitting on a
        // hard-coded uniform value.
        this._applySolarWindToGlobe();
        this._paintSolarWindStats();
        this.refresh();
        this._startCameraHUDLoop();
    }

    // ── Camera HUD ──────────────────────────────────────────────────────────
    // Wires the orbit/fly toggle + Visit ISS button + the live readout
    // panel that samples the engine at the camera's current altitude. The
    // readout updates on a 4-Hz tick instead of every frame so a 60 fps
    // user doesn't pay 60× the engine cost for a panel they aren't even
    // necessarily looking at.

    _bindCameraControls() {
        const { camOrbitBtn, camFlyBtn, camIssBtn } = this.el;
        const setMode = (mode) => {
            const m = this.globe.setCameraMode?.(mode) || mode;
            camOrbitBtn?.classList.toggle('ua-cam-on', m === 'orbit');
            camFlyBtn  ?.classList.toggle('ua-cam-on', m === 'fly');
            if (this.el.camMode) this.el.camMode.textContent = m;
            if (this.el.camHint) {
                this.el.camHint.textContent = m === 'fly'
                    ? 'WASD move · Q/E down/up · Shift fast · drag to look'
                    : 'drag to rotate · scroll to zoom';
            }
        };
        camOrbitBtn?.addEventListener('click', () => setMode('orbit'));
        camFlyBtn  ?.addEventListener('click', () => setMode('fly'));
        camIssBtn  ?.addEventListener('click', () => {
            // Switching to fly mode + flying the camera at the ISS gives
            // a good "explorable" first impression — the user can take
            // over with WASD afterward.
            setMode('fly');
            this.globe.flyToISS?.();
        });
    }

    /**
     * Tick the HUD readout at 4 Hz, reading camera altitude from the
     * globe and re-sampling local physics from the engine. Decoupled
     * from refresh() so the HUD stays correct as the user flies around
     * without having to spam the full slider-driven refresh.
     *
     * Also re-paints the satellite drag-analysis panel — its altitudes
     * change every frame as probes orbit, so a static refresh-only
     * paint would show stale values for every satellite with non-zero
     * eccentricity. 4 Hz is plenty smooth for a side panel.
     */
    _startCameraHUDLoop() {
        const tick = () => {
            this._paintCameraHUD();
            this._paintSatelliteDrag();
            this._paintConjunctionWatch();
            this._paintAvoidancePanel();
        };
        clearInterval(this._camHUDTimer);
        this._camHUDTimer = setInterval(tick, 250);
        // Family panel + constellation toggles repaint less often —
        // they only change when the debris sample loads or the user
        // flips a toggle.
        this._renderDebrisFamilies();
        this._renderConstellationToggles();
        window.addEventListener('ua-debris-update', () => this._renderDebrisFamilies());
        tick();
    }

    /**
     * Paint the conjunction-watch panel from the globe's pairwise
     * screener cache. Each row carries the pair's current centre-to-
     * centre separation, predicted TCA distance + eta, and a
     * watch/alert/critical class that drives the row's tinting.
     *
     * Row tinting thresholds match the globe's chord coloring:
     *   crit   < 10 km
     *   alert  < 50 km
     *   watch  < 200 km
     *   muted  >= 200 km
     */
    _paintConjunctionWatch() {
        const box = this.el.conjunctionBox;
        if (!box) return;
        const pairs = this.globe?.getConjunctionAnalysis?.() ?? [];
        if (!pairs.length) {
            box.innerHTML = '<div class="ua-dim" style="font-size:.7rem">no probe pairs to screen</div>';
            return;
        }
        // Cap visible row count so a debris-heavy snapshot doesn't
        // unroll a massive list. Asset-asset pairs always show; we
        // append the closest debris threats up to a budget.
        const MAX_ROWS = 12;
        const assetPairs = pairs.filter(p => p.kind === 'asset-asset');
        const debrisPairs = pairs.filter(p => p.kind === 'asset-debris');
        const displayed = assetPairs.concat(debrisPairs).slice(0, MAX_ROWS);

        const html = displayed.map(p => {
            const cls = p.tcaDistKm < 10  ? 'ua-conj-row--crit'
                      : p.tcaDistKm < 50  ? 'ua-conj-row--alert'
                      : p.tcaDistKm < 200 ? 'ua-conj-row--watch'
                      : '';
            const tcaCol = p.tcaDistKm < 10  ? '#ff3060'
                         : p.tcaDistKm < 50  ? '#ff8a3a'
                         : p.tcaDistKm < 200 ? '#ffcc60'
                         : '#9ab';
            const tcaText = p.tcaDistKm > 9999
                ? p.tcaDistKm.toExponential(2)
                : p.tcaDistKm.toFixed(p.tcaDistKm < 100 ? 1 : 0);
            const currText = p.currDistKm.toFixed(p.currDistKm < 100 ? 1 : 0);
            const etaMin = p.tcaTimeSec / 60;
            const etaText = etaMin < 1 ? 'now'
                           : etaMin < 60 ? `${etaMin.toFixed(0)}m`
                           : `${(etaMin / 60).toFixed(1)}h`;
            // Truncate long debris names so the layout stays tidy.
            const bShort = p.bName.length > 22 ? p.bName.slice(0, 21) + '…' : p.bName;
            const aShort = p.aName.length > 22 ? p.aName.slice(0, 21) + '…' : p.aName;
            // For asset-debris pairs, look up the family + size meta
            // so the row badge reads "FY-1C SMALL" instead of bare DEB.
            // The globe stores debris by id; we recover the index by id.
            let famBadge = '';
            let pcText   = '';
            if (p.kind === 'asset-debris') {
                const debrisIdx = (this.globe?._debris || []).findIndex(d => d.spec.id === p.bId);
                const meta = this.globe?.getDebrisMetaByIndex?.(debrisIdx);
                if (meta?.family) {
                    const sizeTag = meta.size?.class
                        ? `<span style="opacity:.7">${meta.size.class.toUpperCase()}</span>`
                        : '';
                    famBadge = `
                        <span style="color:${meta.family.color};font-size:.58rem;font-weight:700;letter-spacing:.04em"
                              title="${meta.family.name}">
                            ${this._shortFamilyTag(meta.family.id)}
                            ${sizeTag}
                        </span>`;
                }
                // Quick Pc preview right in the row so the user sees
                // the magnitude without opening the avoidance panel.
                const { pc } = probabilityOfCollision({
                    missKm: p.tcaDistKm,
                    tcaSec: p.tcaTimeSec,
                    kind:   'asset-debris',
                });
                const pcRisk_ = pcRisk(pc);
                pcText = `<span class="ua-conj-pc" style="color:${pcRisk_.color}"
                                title="Probability of Collision (Foster 1D, σ scales with TCA)">
                            Pc ≈ ${pc.toExponential(1)}
                          </span>`;
            }
            return `
              <div class="ua-conj-row ${cls}" title="${p.aName} ↔ ${p.bName}${p.bNorad ? ' · NORAD ' + p.bNorad : ''}">
                <span class="ua-conj-pair">
                    <span class="ua-conj-dot" style="background:${p.aColor};color:${p.aColor}"></span>
                    <span>${aShort}</span>
                    <span class="ua-conj-link">↔</span>
                    <span class="ua-conj-dot" style="background:${p.bColor};color:${p.bColor}"></span>
                    <span>${bShort}</span>
                    ${famBadge}
                </span>
                <span class="ua-conj-meta">
                    <span>now ${currText} km</span>
                    ${pcText}
                </span>
                <span class="ua-conj-tca" style="color:${tcaCol}">
                    ${tcaText} km
                    <span class="ua-conj-eta">in ${etaText}</span>
                </span>
              </div>
            `;
        }).join('');
        // Footer when we truncated.
        const trailing = pairs.length > displayed.length
            ? `<div class="ua-dim" style="font-size:.62rem;margin-top:4px;text-align:right">+${pairs.length - displayed.length} more pairs screened</div>`
            : '';
        box.innerHTML = html + trailing;
    }

    // ── Debris family roll-up ────────────────────────────────────────────
    //
    // Aggregates the loaded debris sample by source-event family and
    // renders a compact bar / count list. Each row shows the family
    // name + year, a colored swatch, the in-sample count, and the
    // catalog-wide tracked-fragment estimate so users can extrapolate
    // from the visualization-grade sample to operational scale.

    /**
     * Map debris-family id → 4-character row badge for the conjunction
     * panel. Mirror the family name's mnemonic so users can scan rows.
     */
    _shortFamilyTag(id) {
        const m = {
            'fengyun-1c':            'FY-1C',
            'cosmos-iridium-2009':   'IR-33',
            'cosmos-1408':           'C1408',
            'mission-shakti':        'SHKTI',
            'long-march-6a':         'CZ-6A',
            'noaa-breakups':         'NOAA',
            'rocket-bodies':         'R/B',
            'generic-debris':        'DEB',
            'unknown':               'UNK',
        };
        return m[id] || 'DEB';
    }

    _renderDebrisFamilies() {
        const box = this.el.debrisFamilies;
        if (!box) return;
        const families = this.globe?.getDebrisFamilyBreakdown?.() ?? [];
        if (!families.length) {
            box.innerHTML = '<div class="ua-dim" style="font-size:.7rem">'
                          + 'waiting for debris catalog…</div>';
            return;
        }
        const totalSample = families.reduce((s, f) => s + f.count, 0);
        // Total catalog-wide tracked debris across the registry — for
        // the "showing X of Y tracked" framing.
        const totalCatalog = DEBRIS_FAMILIES.reduce((s, f) => s + (f.tracked || 0), 0);
        const html = families.map(({ family, count, mediumEnergyMJ }) => {
            const pct = (100 * count / totalSample).toFixed(0);
            const yr  = family.year ? ` · ${family.year}` : '';
            const energyTxt = mediumEnergyMJ > 0
                ? `<span style="color:#cc9">${(mediumEnergyMJ / 1000).toFixed(1)} GJ Σ</span>`
                : '';
            return `
              <div class="ua-fam-row" title="${family.summary}">
                <span class="ua-fam-swatch" style="background:${family.color}"></span>
                <span class="ua-fam-name">${family.name}${yr}</span>
                <span class="ua-fam-count">${count}</span>
                <span class="ua-fam-bar">
                  <span class="ua-fam-bar-fill"
                        style="width:${pct}%; background:${family.color}"></span>
                </span>
                <span class="ua-fam-energy">${energyTxt}</span>
              </div>`;
        }).join('');
        const footer = `
          <div class="ua-dim" style="font-size:.6rem;margin-top:6px;line-height:1.4">
            Showing ${totalSample} of ~${totalCatalog.toLocaleString()} tracked
            objects in the LEO debris registry. Σ energy is sample-only,
            kinetic at 14 km/s closing speed.
          </div>`;
        box.innerHTML = html + footer;
    }

    // ── Collision avoidance recommendations ──────────────────────────────
    //
    // For the closest active threat (asset-debris pair under 50 km TCA),
    // compute the recommended evasion Δv via Clohessy-Wiltshire and
    // report the operational decision. The thresholds are conservative
    // versions of CCSDS-recommended COLA tiers:
    //
    //   < 1 km miss → maneuver (red)
    //   < 5 km miss → consider maneuver (amber)
    //   < 50 km miss → monitor (yellow)
    //   ≥ 50 km miss → nominal (green)
    //
    // Δv recommendations assume a circular reference orbit; the model
    // returns the cheapest in-track impulse needed to clear a 5-km
    // safety margin given the current TCA lookahead. Real ops would
    // also screen the post-burn trajectory for secondary conjunctions —
    // we don't here.

    _paintAvoidancePanel() {
        const box = this.el.avoidanceBox;
        if (!box) return;
        const pairs = this.globe?.getConjunctionAnalysis?.() ?? [];
        if (!pairs.length) {
            box.innerHTML = '<div class="ua-dim" style="font-size:.7rem">'
                          + 'no conjunctions to evaluate.</div>';
            return;
        }

        // Pull the top 3 threats: prefer asset-debris (the operational
        // case) but fall back to asset-asset if no debris pair has
        // crossed the screening threshold yet.
        const threats = pairs
            .filter(p => p.tcaDistKm < 200)
            .slice(0, 3);

        if (!threats.length) {
            box.innerHTML = `
              <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;
                          background:rgba(96,200,144,.10);border-radius:6px;
                          border:1px solid rgba(96,200,144,.3)">
                <span style="color:#80c890;font-weight:700">●</span>
                <span style="font-size:.74rem;color:#a4d8b0">Nominal — no
                pairs within 200 km TCA.</span>
              </div>`;
            return;
        }

        const cards = threats.map(p => {
            const altKm = (this.globe?._satProbes?.[p.aId]?.spec?.altitudeKm) ?? 500;
            const { pc } = probabilityOfCollision({
                missKm: p.tcaDistKm,
                tcaSec: p.tcaTimeSec,
                kind:   p.kind,
            });
            const risk = pcRisk(pc);
            const rec = recommendDeltaV({
                altKm,
                tcaSec:        p.tcaTimeSec,
                currentMissKm: p.tcaDistKm,
                targetMissKm:  5,
            });
            const fuelG = deltaVToFuelKg(rec.dvInTrackMS) * 1000;
            // For asset-debris, surface the family + size so the user
            // sees what they're avoiding.
            let famLine = '';
            if (p.kind === 'asset-debris') {
                const idx = (this.globe?._debris || []).findIndex(d => d.spec.id === p.bId);
                const meta = this.globe?.getDebrisMetaByIndex?.(idx);
                if (meta?.family) {
                    famLine = `
                      <div class="ua-av-fam" style="color:${meta.family.color}">
                        ${meta.family.name}
                        ${meta.size?.class ? `· ${meta.size.class} (${meta.size.rangeM})` : ''}
                        ${meta.size?.massKg ? `· ~${meta.size.massKg} kg` : ''}
                      </div>`;
                }
            }
            const action = !rec.feasible ? 'TCA too close — shelter / orient'
                          : rec.dvInTrackMS === 0
                            ? 'Current miss exceeds 5 km — no action'
                            : `Burn ${formatDeltaV(rec.dvInTrackMS)} prograde`;
            // Direction explanation: positive Δv in-track shifts the
            // asset along-track (raising orbit slightly + delaying TCA);
            // negative Δv (retrograde) lowers + advances. Either works
            // — we report the magnitude.
            return `
              <div class="ua-av-card" style="border-left:3px solid ${risk.color}">
                <div class="ua-av-head">
                  <span class="ua-av-pair">
                    ${p.aName} <span style="opacity:.6">↔</span> ${p.bName}
                  </span>
                  <span class="ua-av-tier" style="background:${risk.color}20;color:${risk.color}">
                    ${risk.label.toUpperCase()}
                  </span>
                </div>
                ${famLine}
                <div class="ua-av-stats">
                  <span title="Predicted miss distance at TCA">
                    miss <b>${p.tcaDistKm.toFixed(2)} km</b>
                  </span>
                  <span title="Probability of collision (Foster 1D)">
                    Pc <b>${pc.toExponential(2)}</b>
                  </span>
                  <span title="Time-to-closest-approach in simulated orbital seconds">
                    TCA <b>${(p.tcaTimeSec / 60).toFixed(0)} min</b>
                  </span>
                </div>
                <div class="ua-av-action">
                  <span class="ua-av-action-icon" style="color:${risk.color}">▸</span>
                  ${action}
                </div>
                <div class="ua-av-meta">
                  in-track Δv <b>${formatDeltaV(rec.dvInTrackMS)}</b>
                  · radial Δv ${formatDeltaV(rec.dvRadialMS)}
                  · lead ${(rec.leadSec / 60).toFixed(0)} min
                  ${fuelG > 0 ? `· fuel ~${fuelG.toFixed(1)} g (Hall, Isp 1500 s)` : ''}
                </div>
              </div>`;
        }).join('');
        box.innerHTML = cards + `
          <div class="ua-dim" style="font-size:.6rem;margin-top:6px;line-height:1.4">
            Δv from Clohessy-Wiltshire on a circular reference orbit;
            Pc via Foster 1D with σ ∝ TCA lookahead. Visualization-grade
            — operational COLA needs CDM-derived covariance.
          </div>`;
    }

    // ── Constellation toggles ────────────────────────────────────────────
    //
    // Render the constellation registry as a row of toggle chips.
    // Each chip flips visibility on the globe's overlay cloud for that
    // constellation; clouds are lazily built on first enable. MEO
    // constellations are flagged so the user knows they live well
    // outside the camera's default zoom.

    _renderConstellationToggles() {
        const box = this.el.constellationToggles;
        if (!box) return;
        const html = CONSTELLATIONS.map(c => {
            const meoTag = c.meo ? ' · MEO' : '';
            return `
              <button type="button"
                      class="ua-cn-chip"
                      data-cn-id="${c.id}"
                      style="--cn-c:${c.color}"
                      title="${c.summary}">
                <span class="ua-cn-swatch" style="background:${c.color}"></span>
                <span class="ua-cn-name">${c.name}</span>
                <span class="ua-cn-meta">${c.countActive}${meoTag}</span>
              </button>`;
        }).join('');
        box.innerHTML = html + `
          <div class="ua-dim" style="font-size:.6rem;margin-top:6px;line-height:1.4;flex-basis:100%">
            Visualization-grade Walker overlays. Click to render a
            representative sample of ${CONSTELLATIONS.reduce((s,c)=>s+c.sampleCount,0)}
            dots across all constellations.
          </div>`;
        box.querySelectorAll('.ua-cn-chip').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.cnId;
                const on = !btn.classList.contains('ua-cn-on');
                btn.classList.toggle('ua-cn-on', on);
                this.globe?.setConstellationVisible?.(id, on);
            });
        });
    }

    // ── TLE freshness pill ─────────────────────────────────────────────────

    /**
     * Listen for ua-tle-update events fired by the globe's
     * _fetchLiveTLEs(). The event detail is { total, live, fetchedAt }
     * — we use that to repaint the freshness pill from "fetching…"
     * to "live · X ago" (or "fallback" if every fetch failed).
     *
     * Also schedule a 60-s repaint so the "X ago" text stays current
     * as time advances (without forcing a network refetch).
     */
    _bindTleFreshnessBus() {
        window.addEventListener('ua-tle-update', () => this._paintTleFreshness());
        window.addEventListener('ua-debris-update', () => this._paintDebrisPill());
        clearInterval(this._tleAgeTimer);
        this._tleAgeTimer = setInterval(() => this._paintTleFreshness(), 60_000);
        this._paintDebrisPill();
    }

    _paintDebrisPill() {
        const pill  = this.el.debrisPill;
        const label = this.el.debrisLabel;
        if (!pill || !label) return;
        const n = this.globe?.getDebrisCount?.() ?? 0;
        if (n === 0) {
            pill.className = 'ua-tle-pill ua-tle-pill--pending';
            label.textContent = 'fetching debris…';
        } else {
            pill.className = 'ua-tle-pill ua-tle-pill--live';
            label.textContent = `${n} debris tracked · LEO`;
        }
    }

    _paintTleFreshness() {
        const pill  = this.el.tleFreshness;
        const label = this.el.tleLabel;
        if (!pill || !label) return;

        const summary = this.globe?.getTleSummary?.();
        // Keep CSS class names in sync with upper-atmosphere.html.
        const setKind = (kind) => {
            pill.className = `ua-tle-pill ua-tle-pill--${kind}`;
        };

        if (!summary) {
            setKind('pending');
            label.textContent = 'fetching TLEs…';
            return;
        }
        const { total, live, fetchedAt } = summary;
        const ageS = Math.max(0, (Date.now() - fetchedAt) / 1000);
        const agoStr = _ageString(ageS);

        if (live === 0) {
            setKind('fallback');
            label.textContent = `fallback elements · 0 / ${total} live`;
        } else if (live < total) {
            setKind('partial');
            label.textContent = `live ${live} / ${total} · ${agoStr}`;
        } else {
            setKind('live');
            label.textContent = `live TLEs · ${total} sats · ${agoStr}`;
        }
    }

    /**
     * Render the per-satellite drag-analysis rows. Pulls a snapshot
     * from globe.getSatelliteDragAnalysis() (sorted by q descending)
     * and lays out one row per satellite with a horizontal q-bar so
     * users see "ISS feels 10× more drag than Iridium" at a glance.
     *
     * Click on a row flies the camera to that satellite — same path
     * the canvas-click on a probe sprite uses.
     */
    _paintSatelliteDrag() {
        const box = this.el.satDrag;
        if (!box) return;
        const states = this.globe.getSatelliteDragAnalysis?.() || [];
        if (states.length === 0) {
            box.innerHTML = '<div class="ua-dim" style="font-size:.7rem">no orbital satellites tracked</div>';
            return;
        }
        // Use the highest q in the snapshot to scale the bars so the
        // ranking is visible even when all values are tiny.
        const maxQ = states.reduce((m, s) => Math.max(m, s.qPa ?? 0), 1e-12);
        const html = states.map(s => {
            const colour   = s.color || '#0cc';
            const qmPaText = Number.isFinite(s.qmPa) ? s.qmPa.toFixed(2) : '—';
            const altText  = Number.isFinite(s.altKm) ? `${s.altKm.toFixed(0)} km` : '—';
            const noradTxt = s.noradId ? `NORAD ${s.noradId}` : '';
            const inclTxt  = Number.isFinite(s.inclinationDeg) ? `${s.inclinationDeg.toFixed(1)}°` : '';
            const liveTxt  = s.tleSource === 'live' ? '● live' : '○ fallback';
            const liveCol  = s.tleSource === 'live' ? '#0cc'   : '#c87';
            const meta     = [noradTxt, inclTxt].filter(Boolean).join(' · ')
                          + ` · <span style="color:${liveCol}">${liveTxt}</span>`;
            const fillPct  = Math.max(2, Math.min(100, ((s.qPa ?? 0) / maxQ) * 100));
            return `
                <div class="ua-sat-row" data-sat-id="${s.id}" title="Click to fly the camera to ${s.name}">
                    <span class="ua-sat-dot" style="background:${colour};color:${colour}"></span>
                    <span class="ua-sat-name">
                        <span class="ua-sat-title">${s.name}</span>
                        <span class="ua-sat-meta">${meta}</span>
                    </span>
                    <span class="ua-sat-alt">${altText}</span>
                    <span class="ua-sat-q" style="color:${colour}">${qmPaText}<span style="color:#556;font-weight:400"> mPa</span></span>
                    <span class="ua-sat-q-bar"><span class="ua-sat-q-fill" style="width:${fillPct}%;background:${colour}"></span></span>
                </div>
            `;
        }).join('');
        // innerHTML is fine here — values come from engine + spec
        // (no user-supplied strings). Re-attach click handlers each
        // re-paint since we rewrite the DOM.
        box.innerHTML = html;
        box.querySelectorAll('.ua-sat-row').forEach(row => {
            row.addEventListener('click', () => {
                const id = row.dataset.satId;
                if (!id) return;
                // Switch to fly mode if we're still in orbit so the
                // camera-anim lands somewhere useful instead of being
                // clamped back to the planet centre.
                if (this.globe.getCameraMode?.() === 'orbit') {
                    this.globe.setCameraMode?.('fly');
                    if (this.el.camOrbitBtn) this.el.camOrbitBtn.classList.remove('ua-cam-on');
                    if (this.el.camFlyBtn)   this.el.camFlyBtn  .classList.add('ua-cam-on');
                    if (this.el.camMode)     this.el.camMode.textContent = 'fly';
                }
                this.globe.flyToSatellite?.(id);
            });
        });
    }

    _paintCameraHUD() {
        const { camAlt, camLayer, camRho, camT, camKn } = this.el;
        if (!camAlt) return;
        const sample = this.globe.getCameraSampleAtState?.({
            f107: this.state.f107, ap: this.state.ap,
        });
        if (!sample) return;

        const altKm = sample.altitudeKm;
        camAlt.textContent = Number.isFinite(altKm)
            ? `${altKm.toFixed(0)} km`
            : '—';

        if (sample.outOfDomain) {
            camLayer.textContent = altKm < 80 ? '< sim domain' : '—';
            camRho.textContent = '—';
            camT.textContent   = '—';
            camKn.textContent  = '—';
            return;
        }

        const layerName = sample.layer?.name || '—';
        const layerHi   = sample.layer
            ? `#${sample.layer.colorHigh.toString(16).padStart(6, '0')}`
            : '#0cc';
        camLayer.innerHTML = `<span class="ua-cam-layer-tag" style="color:${layerHi};border-color:${layerHi}66">${layerName}</span>`;
        camRho.textContent = sample.ρ.toExponential(2) + ' kg/m³';
        camT.textContent   = `${sample.T.toFixed(0)} K`;
        camKn.textContent  = Number.isFinite(sample.knudsen)
            ? (sample.knudsen >= 100 ? sample.knudsen.toExponential(1)
              : sample.knudsen.toFixed(2))
            : '∞';
    }

    // ── Data-source pill ────────────────────────────────────────────────────

    _bindSourcePill() {
        const pill = this.el.sourcePill;
        if (!pill) return;
        // Two states: 'auto' (try backend, client-fallback) and
        // 'client' (force client surrogate, no network). The pill label
        // reflects whichever model actually answered.
        pill.addEventListener('click', () => {
            this.useBackend = !this.useBackend;
            this._paintSourcePill();
            this.refresh();
        });
    }

    _paintSourcePill() {
        const pill = this.el.sourcePill;
        if (!pill) return;
        const model = this.profile?.model || 'client';
        const { cls, label, tip } = _pillFor(model, this.useBackend);
        pill.className = `ua-source-pill ${cls}`
            + (this.useBackend ? '' : ' ua-source--forced');
        pill.querySelector('.ua-source-label').textContent = label;
        pill.title = tip;
    }

    // ── Live-indices wiring ─────────────────────────────────────────────────

    async _bindLiveButton() {
        const btn = this.el.liveBtn;
        const statusEl = this.el.liveStatus;
        if (!btn) return;
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            if (statusEl) statusEl.textContent = 'fetching…';
            try {
                const live = await fetchLiveIndices();
                if (!live) throw new Error('no data');
                this.setState({ f107: live.f107Sfu, ap: live.ap });
                if (statusEl) {
                    const ts = new Date().toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit',
                    });
                    statusEl.textContent =
                        `live · ${live.source} · ${ts}`;
                }
                if (this.el.summary) {
                    this.el.summary.innerHTML =
                        `<strong>Live NOAA conditions</strong> <span class="ua-dim">· ${live.source}</span>`
                        + `<br>F10.7 ${live.f107Sfu.toFixed(1)} SFU · Ap ${live.ap.toFixed(0)}`
                        + (Number.isFinite(live.kp) ? ` (from Kp ${live.kp.toFixed(1)})` : '');
                }
            } catch (err) {
                if (statusEl) statusEl.textContent = 'unavailable — CORS or offline';
            } finally {
                btn.disabled = false;
            }
        });
    }

    /**
     * Wire the "Field overlay" radio row to the globe's vector-field
     * controller. Three values match LayerVectorField.setMode():
     * 'off' | 'temperature' | 'radiation'.
     */
    _bindFieldModeRadio() {
        const row = document.getElementById('ua-field-mode');
        if (!row) return;
        // Reflect the globe's initial state (off) into the DOM.
        const initial = this.globe.getVectorFieldMode?.() ?? 'off';
        for (const inp of row.querySelectorAll('input[name=ua-field-mode]')) {
            inp.checked = inp.value === initial;
            inp.addEventListener('change', () => {
                if (!inp.checked) return;
                this.globe.setVectorFieldMode?.(inp.value);
            });
        }
    }

    _bindSwpcEventBus() {
        // If the host page boots SpaceWeatherFeed (e.g. the user also has
        // space-weather.html open in a parent frame), soak up values
        // passively to keep the source-chip honest. Does NOT override user
        // slider positions.
        window.addEventListener('swpc-update', (e) => {
            const d = e?.detail;
            if (!d) return;
            this._liveBusValues = {
                f107:    d.solar_activity?.f107_sfu ?? null,
                kp:      d.geomagnetic?.kp ?? d.kp ?? null,
                bz:      d.solar_wind?.bz      ?? d.bz      ?? null,
                speed:   d.solar_wind?.speed   ?? d.speed   ?? null,
                density: d.solar_wind?.density ?? d.density ?? null,
            };
            this._applySolarWindToGlobe();
            this._paintSolarWindStats();
            this._paintSpaceWeatherAnalytics();
        });
    }

    // Push the latest solar-wind plasma state to the globe + the side
    // panel. Called whenever swpc-update fires, when the user clicks the
    // live-NOAA button, or once on boot with climatology defaults so the
    // surfaces don't sit at a default value forever.
    _applySolarWindToGlobe() {
        const sw = this._liveBusValues || {};
        this.globe.setSolarWind({
            speed:   Number.isFinite(sw.speed)   ? sw.speed   : 400,
            density: Number.isFinite(sw.density) ? sw.density : 5,
            bz:      Number.isFinite(sw.bz)      ? sw.bz      : 0,
        });
    }

    _paintSolarWindStats() {
        const box = this.el.solarWindStats;
        if (!box) return;
        const sw = this._liveBusValues || {};
        const speed   = Number.isFinite(sw.speed)   ? sw.speed   : 400;
        const density = Number.isFinite(sw.density) ? sw.density : 5;
        const bz      = Number.isFinite(sw.bz)      ? sw.bz      : 0;
        const live    = Number.isFinite(sw.speed) || Number.isFinite(sw.density);
        const pdyn    = 1.67e-6 * density * speed * speed;          // nPa
        // Magnetopause / bow-shock standoff comes from the globe's last
        // setSolarWind() call so the panel and the 3D scene agree.
        const mp = this.globe._swGeometry?.mp;
        const bs = this.globe._swGeometry?.bs;

        box.innerHTML = `
          <div class="ua-stat">
              <span class="ua-stat-k">v_sw</span>
              <span class="ua-stat-v">${speed.toFixed(0)}</span>
              <span class="ua-stat-u">km/s</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">n</span>
              <span class="ua-stat-v">${density.toFixed(1)}</span>
              <span class="ua-stat-u">cm⁻³</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">Bz</span>
              <span class="ua-stat-v" style="color:${bz < 0 ? '#ff7a90' : '#9cf'}">${bz >= 0 ? '+' : ''}${bz.toFixed(1)}</span>
              <span class="ua-stat-u">nT</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">Pdyn</span>
              <span class="ua-stat-v">${pdyn.toFixed(2)}</span>
              <span class="ua-stat-u">nPa</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">MP</span>
              <span class="ua-stat-v">${mp ? mp.r0.toFixed(1) : '—'}</span>
              <span class="ua-stat-u">R⊕</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">BS</span>
              <span class="ua-stat-v">${bs ? bs.r0.toFixed(1) : '—'}</span>
              <span class="ua-stat-u">R⊕ ${live ? '· live' : '· clim'}</span>
          </div>
        `;
    }

    // ── Public ──────────────────────────────────────────────────────────────

    setState(partial) {
        Object.assign(this.state, partial);
        // Reflect back to DOM sliders.
        if ('f107' in partial && this.el.f107Input)
            this.el.f107Input.value = String(this.state.f107);
        if ('ap' in partial && this.el.apInput)
            this.el.apInput.value = String(this.state.ap);
        if ('altitude' in partial && this.el.altInput)
            this.el.altInput.value = String(this.state.altitude);
        this.refresh();
    }

    /**
     * Recompute profile + redraw everything. Safe to call any time;
     * slider-driven calls are debounced (_scheduleRefresh) so we don't
     * spam the backend while dragging.
     */
    refresh() {
        const { f107, ap, altitude } = this.state;

        // Update labels immediately (don't wait for the async fetch).
        if (this.el.altVal)  this.el.altVal.textContent  = `${Math.round(altitude)} km`;
        if (this.el.f107Val) this.el.f107Val.textContent = `${Math.round(f107)} SFU`;
        if (this.el.apVal)   this.el.apVal.textContent   = String(Math.round(ap));

        // Drive the globe state immediately (aurora, ring position).
        // If the host page is broadcasting live Bz via swpc-update, hand
        // it through so the aurora shader uses real southward-IMF forcing
        // instead of the Ap-derived proxy.
        const liveBz = this._liveBusValues?.bz;
        this.globe.setState({
            f107, ap,
            bz: Number.isFinite(liveBz) ? liveBz : null,
        });
        this.globe.setAltitude(altitude);

        // Local sample first — so the plots respond on every frame while
        // dragging. If a backend profile arrives later, we overwrite and
        // redraw once.
        const local = this.engine.sampleProfile({
            f107Sfu: f107, ap,
            minKm: ALT_MIN, maxKm: ALT_MAX, nPoints: 180,
        });
        this.profile = _annotateProfile(local);
        this.globe.setProfile(this.profile);
        this._drawDensityProfile();
        this._drawComposition();
        this._paintStats();
        this._paintLayerControls();
        this._paintSourcePill();
        this._paintSpaceWeatherAnalytics();
        this._paintMesosphereStatus();

        // Notify trajectory analyzer that ρ profile has changed so any
        // open analysis re-runs against the new state.
        try {
            window.dispatchEvent(new CustomEvent('ua-profile-update', {
                detail: { f107: this.state.f107, ap: this.state.ap }
            }));
        } catch (_) { /* SSR / no-window — ignore */ }

        if (this.useBackend) this._scheduleBackendRefresh();
    }

    /**
     * Paint the operator-grade space-weather analytics panel — turns
     * the (F10.7, Ap, Bz) state into actionable headlines: SWPC G-tier,
     * Dst, drag forecast, HF blackout score, GIC threat, polar-cap
     * absorption, NLC visibility, aurora-edge latitude.
     */
    _paintSpaceWeatherAnalytics() {
        const box = this.el.swAnalytics;
        if (!box) return;
        const { f107, ap } = this.state;
        const sw = this._liveBusValues || {};
        const a = buildAnalyticsBundle({
            f107, ap,
            bz:        Number.isFinite(sw.bz) ? sw.bz : 0,
            monthIdx:  new Date().getUTCMonth(),
            hemisphere:'N',
        });

        const dragRow = `
            <div class="ua-sw-row" style="border-left-color:${a.gStorm.color}">
                <span class="ua-sw-k">drag</span>
                <span class="ua-sw-v" style="color:${a.gStorm.color}">
                    +${a.drag.excessPct.toFixed(0)} %
                </span>
                <span class="ua-sw-tail">
                    T∞ ${a.drag.Tinf_K.toFixed(0)} K<br>
                    ISS ${a.drag.issFuelKgDay.toFixed(1)} kg/d
                </span>
                <span class="ua-sw-bar"><span class="ua-sw-bar-fill"
                    style="width:${Math.min(100, Math.max(2, a.drag.excessPct * 0.4 + 2)).toFixed(0)}%;
                           background:${a.gStorm.color}"></span></span>
            </div>`;

        const stormRow = `
            <div class="ua-sw-row" style="border-left-color:${a.gStorm.color}">
                <span class="ua-sw-k">storm</span>
                <span class="ua-sw-v" style="color:${a.gStorm.color}">
                    ${a.gStorm.tier}
                    <span class="ua-sw-tag" style="background:${a.gStorm.color}22;color:${a.gStorm.color}">
                        ${a.gStorm.label}
                    </span>
                </span>
                <span class="ua-sw-tail">Ap ${ap}</span>
            </div>`;

        const dstColor = a.dst < -250 ? '#ff3060' :
                         a.dst < -100 ? '#ff8050' :
                         a.dst < -50  ? '#ffcc60' :
                                        '#80c890';
        const dstRow = `
            <div class="ua-sw-row" style="border-left-color:${dstColor}">
                <span class="ua-sw-k">Dst proxy</span>
                <span class="ua-sw-v" style="color:${dstColor}">
                    ${a.dst.toFixed(0)} nT
                </span>
                <span class="ua-sw-tail">ring current</span>
            </div>`;

        const hfPct  = (a.hf.score * 100).toFixed(0);
        const hfColor= a.hf.score > 0.7 ? '#ff5070' :
                       a.hf.score > 0.4 ? '#ffaa50' :
                       a.hf.score > 0.2 ? '#ffcc60' : '#80c890';
        const rTag = a.hf.rTier
            ? `<span class="ua-sw-tag" style="background:${hfColor}22;color:${hfColor}">${a.hf.rTier.tier}</span>`
            : '';
        const hfRow = `
            <div class="ua-sw-row" style="border-left-color:${hfColor}">
                <span class="ua-sw-k">HF abs</span>
                <span class="ua-sw-v" style="color:${hfColor}">${hfPct} %${rTag}</span>
                <span class="ua-sw-tail">D-region<br>F10.7 + auroral</span>
                <span class="ua-sw-bar"><span class="ua-sw-bar-fill"
                    style="width:${hfPct}%;background:${hfColor}"></span></span>
            </div>`;

        const gicRow = `
            <div class="ua-sw-row" style="border-left-color:${a.gic.color}">
                <span class="ua-sw-k">GIC risk</span>
                <span class="ua-sw-v" style="color:${a.gic.color}">
                    ${a.gic.tier.toUpperCase()}
                </span>
                <span class="ua-sw-tail">dB/dt ≈ ${a.gic.dBdt.toFixed(0)} nT/min</span>
            </div>`;

        const pcaRow = `
            <div class="ua-sw-row" style="border-left-color:${a.pca.color}">
                <span class="ua-sw-k">PCA</span>
                <span class="ua-sw-v" style="color:${a.pca.color}">
                    ${a.pca.tier.toUpperCase()}
                </span>
                <span class="ua-sw-tail">${
                    a.pca.active ? `&gt; ${a.pca.latDeg}° lat` : 'no SEP cap'
                }</span>
            </div>`;

        const nlcColor = a.nlc > 0.6 ? '#9eecff' :
                         a.nlc > 0.2 ? '#80b8c8' : '#556';
        const nlcRow = `
            <div class="ua-sw-row" style="border-left-color:${nlcColor}">
                <span class="ua-sw-k">NLC viz</span>
                <span class="ua-sw-v" style="color:${nlcColor}">
                    ${(a.nlc * 100).toFixed(0)} %
                </span>
                <span class="ua-sw-tail">summer<br>mesopause</span>
            </div>`;

        const aurRow = `
            <div class="ua-sw-row" style="border-left-color:#ff60c0">
                <span class="ua-sw-k">aurora</span>
                <span class="ua-sw-v" style="color:#ff80d0">
                    ≥ ${a.auroraEdgeDeg.toFixed(0)}°
                </span>
                <span class="ua-sw-tail">equatorward<br>edge (geomag)</span>
            </div>`;

        box.innerHTML = stormRow + dstRow + dragRow + hfRow + gicRow + pcaRow + nlcRow + aurRow;
    }

    /**
     * Render a status row for each phenomena overlay (NLC, EEJ, AE, Sq).
     * Mostly informational — this panel doesn't toggle the overlays
     * (the globe drives them from setState), but it tells the user what
     * they're looking at on the 3D scene.
     */
    _paintMesosphereStatus() {
        const box = this.el.mesosphereBox;
        if (!box) return;
        const { f107, ap } = this.state;
        const monthIdx = new Date().getUTCMonth();

        // NLC seasonality — match the globe's calculation.
        const nlcWindow = (peakM) => {
            const d = Math.abs(((monthIdx - peakM + 12) % 12));
            const dist = Math.min(d, 12 - d);
            return Math.max(0, Math.cos(dist / 1.5 * Math.PI / 2));
        };
        const nlcN = nlcWindow(5.7);
        const nlcS = nlcWindow(11.7);
        const nlcOn = Math.max(nlcN, nlcS) > 0.15;

        const eejBase = Math.min(1, Math.max(0, (f107 - 70) / 200));
        const aeNorm  = Math.min(1, ap / 100);
        const sqBase  = Math.min(1, Math.max(0, (f107 - 70) / 180))
                      / (1 + ap / 80);

        const fmtPct = v => `${(v * 100).toFixed(0)}%`;
        const tag = (v) => v > 0.5
            ? `<span class="ua-meso-state" style="color:#0fc">ACTIVE</span>`
            : v > 0.15
            ? `<span class="ua-meso-state" style="color:#fc6">faint</span>`
            : `<span class="ua-meso-state" style="color:#556">off</span>`;

        const rows = [
            {
                color: '#9eecff',
                name:  'Noctilucent clouds',
                meta:  `83 km · summer mesopause · NH ${fmtPct(nlcN)} / SH ${fmtPct(nlcS)}`,
                active: nlcOn,
                v: Math.max(nlcN, nlcS),
            },
            {
                color: '#c0ff60',
                name:  'Equatorial electrojet',
                meta:  `110 km · dayside EUV current · F10.7 driver ${fmtPct(eejBase)}`,
                active: eejBase > 0.05,
                v: eejBase,
            },
            {
                color: '#ff6dd2',
                name:  'Auroral electrojets',
                meta:  `110 km · ±67° lat · Ap-driven · ${fmtPct(aeNorm)}`,
                active: aeNorm > 0.10,
                v: aeNorm,
            },
            {
                color: '#fff0a8',
                name:  'Sq vortex pair',
                meta:  `110 km · noon ±30° lat · quiet-time dynamo · ${fmtPct(sqBase)}`,
                active: sqBase > 0.10,
                v: sqBase,
            },
            {
                color: '#ffd890',
                name:  'Sporadic meteor flux',
                meta:  '80-100 km · ~10 t/day worldwide · always on',
                active: true,
                v: 1,
            },
        ];

        box.innerHTML = rows.map(r => `
            <div class="ua-meso-row${r.active ? '' : ' ua-meso--off'}">
                <span class="ua-meso-dot" style="background:${r.color};color:${r.color}"></span>
                <span>
                    <span class="ua-meso-name" style="color:${r.color}">${r.name}</span>
                    <span class="ua-meso-meta">${r.meta}</span>
                </span>
                ${tag(r.v)}
            </div>
        `).join('');
    }

    _scheduleBackendRefresh() {
        clearTimeout(this._refreshTimer);
        this._refreshTimer = setTimeout(() => this._fetchAndMerge(), 220);
    }

    async _fetchAndMerge() {
        // Cancel an in-flight request if the user has moved on.
        this._refreshInflight?.abort?.();
        const controller = new AbortController();
        this._refreshInflight = controller;
        const { f107, ap } = this.state;
        try {
            const remote = await fetchProfile({
                f107Sfu: f107, ap,
                minKm: ALT_MIN, maxKm: ALT_MAX, nPoints: 160,
                signal: controller.signal,
            });
            // If the user has already changed state again since this
            // request started, drop the stale result.
            if (this.state.f107 !== f107 || this.state.ap !== ap) return;
            if (remote?.samples?.length) {
                this.profile = _annotateProfile(remote);
                this.globe.setProfile(this.profile);
                this._drawDensityProfile();
                this._drawComposition();
                this._paintStats();
                this._paintLayerControls();
                this._paintSourcePill();
            }
        } catch (_) {
            // fetchProfile already handled the fallback internally
        } finally {
            if (this._refreshInflight === controller) this._refreshInflight = null;
        }
    }

    // ── Input wiring ────────────────────────────────────────────────────────

    _bindInputs() {
        const wire = (el, key, cast) => {
            if (!el) return;
            el.value = String(this.state[key]);
            el.addEventListener('input', () => {
                this.state[key] = cast(el.value);
                this.refresh();
            });
        };
        wire(this.el.altInput,  'altitude', Number);
        wire(this.el.f107Input, 'f107',     Number);
        wire(this.el.apInput,   'ap',       Number);
    }

    _renderPresets() {
        const row = this.el.presetRow;
        if (!row) return;
        row.innerHTML = '';
        for (const p of stormPresets) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'ua-chip';
            btn.textContent = p.name;
            btn.title = `${p.date} — F10.7 ${p.f107} SFU, Ap ${p.ap}\n\n${p.summary}`;
            btn.dataset.presetId = p.id;
            btn.addEventListener('click', () => {
                this.setState({ f107: p.f107, ap: p.ap });
                row.querySelectorAll('.ua-chip').forEach(c => c.classList.remove('ua-chip--on'));
                btn.classList.add('ua-chip--on');
                if (this.el.summary) {
                    this.el.summary.innerHTML =
                        `<strong>${p.name}</strong> <span class="ua-dim">· ${p.date}</span><br>${p.summary}`;
                }
            });
            row.appendChild(btn);
        }
    }

    _bindResize() {
        const redraw = () => {
            this._drawDensityProfile();
            this._drawComposition();
        };
        new ResizeObserver(redraw).observe(this.el.densityCanvas);
        new ResizeObserver(redraw).observe(this.el.compCanvas);
    }

    // ── Plots ───────────────────────────────────────────────────────────────

    _drawDensityProfile() {
        const c = this.el.densityCanvas;
        if (!c || !this.profile) return;
        const ctx = _prepareCanvas(c);

        const W = c.clientWidth, H = c.clientHeight;
        const pad = { l: 72, r: 14, t: 24, b: 36 };
        const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

        // Axis extents.
        const samples = this.profile.samples;
        const rhos = samples.map(s => Math.log10(Math.max(s.rho, 1e-25)));
        const maxLR = Math.ceil(Math.max(...rhos));
        const minLR = Math.floor(Math.min(...rhos));
        const altMin = ALT_MIN, altMax = ALT_MAX;

        const xOf = (logRho) => pad.l + ((logRho - minLR) / (maxLR - minLR)) * plotW;
        const yOf = (alt)    => pad.t + (1 - (alt - altMin) / (altMax - altMin)) * plotH;

        // Background.
        ctx.fillStyle = 'rgba(12,7,30,0.85)';
        ctx.fillRect(0, 0, W, H);

        // ─── Atmospheric-layer bands (behind everything else) ────────────
        const layers = this.profile.layers || ATMOSPHERIC_LAYERS;
        for (const L of layers) {
            const top = Math.max(L.minKm, altMin);
            const bot = Math.min(L.maxKm, altMax);
            if (bot <= altMin || top >= altMax) continue;
            const yTop = yOf(bot);
            const yBot = yOf(top);
            ctx.fillStyle = _alpha(L.color, 0.10);
            ctx.fillRect(pad.l, yTop, plotW, yBot - yTop);
            // Thin dividing line at each boundary.
            ctx.strokeStyle = _alpha(L.color, 0.35);
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(pad.l, yBot); ctx.lineTo(pad.l + plotW, yBot);
            ctx.stroke();

            // Layer label — vertical tick on the far-left gutter.
            const midY = (yTop + yBot) / 2;
            ctx.fillStyle = _alpha(L.color, 0.85);
            ctx.font = '10px system-ui, sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            if (yBot - yTop > 24) {
                ctx.fillText(L.name, pad.l - 8, midY);
            }
        }

        // ─── Altitude axis (grid + labels inside the plot area) ─────────
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.fillStyle = '#889';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let a = 0; a <= 2000; a += 500) {
            const y = yOf(a);
            if (y < pad.t - 1 || y > H - pad.b + 1) continue;
            ctx.beginPath();
            ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y);
            ctx.strokeStyle = 'rgba(255,255,255,0.06)';
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.fillText(`${a}`, W - pad.r - 2, y - 6);
        }
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let lr = minLR; lr <= maxLR; lr++) {
            const x = xOf(lr);
            ctx.beginPath();
            ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b);
            ctx.strokeStyle = 'rgba(255,255,255,0.04)';
            ctx.stroke();
            ctx.fillStyle = '#889';
            ctx.fillText(`10^${lr}`, x, H - pad.b + 4);
        }

        // ─── Satellite reference ticks ──────────────────────────────────
        const sats = this.profile.satellites || SATELLITE_REFERENCES;
        ctx.font = '9px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        for (const S of sats) {
            if (S.altitudeKm < altMin || S.altitudeKm > altMax) continue;
            const y = yOf(S.altitudeKm);
            ctx.strokeStyle = S.color;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.65;
            ctx.beginPath();
            ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + 8, y);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = S.color;
            ctx.textAlign = 'left';
            ctx.fillText(`${S.name}`, pad.l + 11, y);
        }

        // Title.
        ctx.fillStyle = '#cdf';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('mass density ρ  (kg/m³, log₁₀)', pad.l, 4);
        ctx.textAlign = 'right';
        ctx.fillText('altitude (km)', pad.l - 4, 4);

        // Density curve.
        ctx.strokeStyle = '#0cf';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let i = 0; i < samples.length; i++) {
            const x = xOf(rhos[i]);
            const y = yOf(samples[i].altitudeKm);
            i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.stroke();

        // Current-altitude crosshair.
        const yCur = yOf(this.state.altitude);
        ctx.strokeStyle = 'rgba(0,255,230,0.75)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yCur); ctx.lineTo(W - pad.r, yCur);
        ctx.stroke();
        ctx.setLineDash([]);

        // Crosshair label.
        const rhoHere = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu: this.state.f107,
            ap: this.state.ap,
        }).rho;
        ctx.fillStyle = '#0ff';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
            `ρ = ${rhoHere.toExponential(2)} kg/m³`,
            W - pad.r - 4, yCur - 3,
        );

        // Frame.
        ctx.strokeStyle = 'rgba(0,200,200,0.35)';
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);
    }

    _drawComposition() {
        const c = this.el.compCanvas;
        if (!c || !this.profile) return;
        const ctx = _prepareCanvas(c);

        const W = c.clientWidth, H = c.clientHeight;
        const pad = { l: 56, r: 90, t: 24, b: 36 };
        const plotW = W - pad.l - pad.r, plotH = H - pad.t - pad.b;

        const samples = this.profile.samples;
        const altMin = ALT_MIN, altMax = ALT_MAX;
        const xOf = (frac) => pad.l + frac * plotW;
        const yOf = (alt)  => pad.t + (1 - (alt - altMin) / (altMax - altMin)) * plotH;

        // Background.
        ctx.fillStyle = 'rgba(12,7,30,0.85)';
        ctx.fillRect(0, 0, W, H);

        // Axis labels.
        ctx.fillStyle = '#889';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let a = 0; a <= 2000; a += 250) {
            const y = yOf(a);
            if (y < pad.t - 1 || y > H - pad.b + 1) continue;
            ctx.fillText(`${a}`, pad.l - 6, y);
        }

        // Build stacked cumulative arrays per species.
        const cumulative = samples.map(s => {
            const cum = {};
            let running = 0;
            for (const sp of SPECIES) {
                running += s.fractions[sp];
                cum[sp] = running;
            }
            return { alt: s.altitudeKm, cum };
        });

        // Draw bands back-to-front. We plot [0, f_N2, f_N2+f_O2, …, 1] and
        // fill each band between successive cumulative curves.
        let prevKey = null;
        for (const sp of SPECIES) {
            ctx.fillStyle = SPECIES_COLORS[sp];
            ctx.globalAlpha = 0.88;
            ctx.beginPath();
            // Top edge: current cumulative. Bottom edge: previous cumulative.
            for (let i = 0; i < cumulative.length; i++) {
                const s = cumulative[i];
                const x = xOf(s.cum[sp]);
                const y = yOf(s.alt);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            for (let i = cumulative.length - 1; i >= 0; i--) {
                const s = cumulative[i];
                const base = prevKey == null ? 0 : s.cum[prevKey];
                ctx.lineTo(xOf(base), yOf(s.alt));
            }
            ctx.closePath();
            ctx.fill();
            prevKey = sp;
        }
        ctx.globalAlpha = 1;

        // Crosshair at current altitude + dominant species tick.
        const yCur = yOf(this.state.altitude);
        ctx.strokeStyle = 'rgba(0,255,230,0.85)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, yCur); ctx.lineTo(W - pad.r, yCur);
        ctx.stroke();
        ctx.setLineDash([]);

        // Legend, right of plot.
        let legY = pad.t;
        ctx.font = '11px system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        const currentFrac = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu: this.state.f107,
            ap: this.state.ap,
        }).fractions;
        for (const sp of SPECIES) {
            ctx.fillStyle = SPECIES_COLORS[sp];
            ctx.fillRect(W - pad.r + 8, legY - 6, 12, 12);
            ctx.fillStyle = '#cde';
            ctx.fillText(SPECIES_LABELS[sp], W - pad.r + 24, legY);
            ctx.fillStyle = '#8a9';
            const pct = (currentFrac[sp] * 100).toFixed(
                currentFrac[sp] < 0.001 ? 4 : currentFrac[sp] < 0.01 ? 3 : 1
            );
            ctx.fillText(`${pct}%`, W - pad.r + 48, legY);
            legY += 18;
        }

        // Title.
        ctx.fillStyle = '#cdf';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('composition stack  (fraction)', pad.l, 4);

        // X-axis labels (0.0, 0.5, 1.0).
        ctx.fillStyle = '#889';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
            ctx.fillText(f.toFixed(2), xOf(f), H - pad.b + 4);
        }
        ctx.strokeStyle = 'rgba(0,200,200,0.35)';
        ctx.strokeRect(pad.l, pad.t, plotW, plotH);
    }

    _paintStats() {
        const box = this.el.stats;
        if (!box) return;
        const s = this.engine.density({
            altitudeKm: this.state.altitude,
            f107Sfu:    this.state.f107,
            ap:         this.state.ap,
        });
        const T_inf = exosphereTempK(this.state.f107, this.state.ap);
        const dom = dominantSpecies(this.state.altitude);
        const L   = layerAt(this.state.altitude);
        const src = this.profile?.model || "client";

        const domPct = (s.fractions[dom] * 100).toFixed(1);
        const mBarAmu = (s.mBar / 1.66054e-27).toFixed(2);

        box.innerHTML = `
          <div class="ua-stat">
              <span class="ua-stat-k">layer</span>
              <span class="ua-stat-v" style="color:${L?.color || '#cdf'}">${L?.name || '—'}</span>
              <span class="ua-stat-u" title="source model">${_sourceLabel(src)}</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">ρ</span>
              <span class="ua-stat-v">${s.rho.toExponential(3)}</span>
              <span class="ua-stat-u">kg/m³</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">n_total</span>
              <span class="ua-stat-v">${s.nTotal.toExponential(3)}</span>
              <span class="ua-stat-u">m⁻³</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">T∞</span>
              <span class="ua-stat-v">${Math.round(T_inf)}</span>
              <span class="ua-stat-u">K</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">H</span>
              <span class="ua-stat-v">${Number.isFinite(s.H_km) ? s.H_km.toFixed(1) : '—'}</span>
              <span class="ua-stat-u">km</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">m̄</span>
              <span class="ua-stat-v">${mBarAmu}</span>
              <span class="ua-stat-u">amu</span>
          </div>
          <div class="ua-stat">
              <span class="ua-stat-k">dominant</span>
              <span class="ua-stat-v" style="color:${SPECIES_COLORS[dom]}">${SPECIES_LABELS[dom]}</span>
              <span class="ua-stat-u">${domPct}%</span>
          </div>
        `;
    }

    // ── Layer legend (static, rendered once in constructor) ─────────────────

    _renderLayerLegend() {
        const el = this.el.layerLegend;
        if (!el) return;
        el.innerHTML = '';
        for (const L of ATMOSPHERIC_LAYERS) {
            const row = document.createElement('div');
            row.className = 'ua-layer-row';
            row.title = L.description;
            const range = L.maxKm > 1000 ? `${L.minKm}–${L.maxKm >= 10000 ? '∞' : L.maxKm} km` : `${L.minKm}–${L.maxKm} km`;
            row.innerHTML = `
                <span class="ua-layer-dot" style="background:${L.color}"></span>
                <span class="ua-layer-name">${L.name}</span>
                <span class="ua-layer-range">${range}</span>
            `;
            el.appendChild(row);
        }
    }

    // ── Per-layer control panel (toggles + live mini-stats) ─────────────────
    //
    // One row per atmospheric regime in the simulator (5 layers from
    // Mesosphere → Outer Exosphere). Each row carries:
    //
    //   • toggle checkbox  → globe.setLayerVisible(id, bool)
    //   • coloured swatch  → matches the gradient shell's outer hue
    //   • layer name + altitude band
    //   • live mini-stats: ρ, T, dominant species, Knudsen + regime
    //   • pulsing "live" dot that fires on every refresh() so the user
    //     can confirm the simulator is actively responding to inputs

    _renderLayerControls() {
        const el = this.el.layerControls;
        if (!el) return;
        el.innerHTML = '';
        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            const high = `#${L.colorHigh.toString(16).padStart(6, '0')}`;
            const low  = `#${L.colorLow .toString(16).padStart(6, '0')}`;
            const row = document.createElement('div');
            row.className = 'ua-lc-row';
            row.dataset.layerId = L.id;
            row.title = L.description;
            row.innerHTML = `
                <label class="ua-lc-head">
                    <input type="checkbox" class="ua-lc-toggle" data-layer-id="${L.id}" checked>
                    <span class="ua-lc-swatch"
                          style="background:linear-gradient(45deg,${low},${high});
                                 box-shadow:0 0 8px ${high}88"></span>
                    <span class="ua-lc-title">
                        <span class="ua-lc-name">${L.name}</span>
                        <span class="ua-lc-band">${L.minKm}–${L.maxKm} km</span>
                    </span>
                    <span class="ua-lc-pulse" data-layer-id="${L.id}"
                          title="pulses on every refresh">●</span>
                </label>
                <div class="ua-lc-stats" data-layer-id="${L.id}">
                    <span class="ua-lc-stat">
                        <span class="ua-lc-k">ρ</span>
                        <span class="ua-lc-v" data-stat="rho">–</span>
                    </span>
                    <span class="ua-lc-stat">
                        <span class="ua-lc-k">T</span>
                        <span class="ua-lc-v" data-stat="T">–</span>
                    </span>
                    <span class="ua-lc-stat">
                        <span class="ua-lc-k">dom</span>
                        <span class="ua-lc-v" data-stat="dom">–</span>
                    </span>
                    <span class="ua-lc-stat">
                        <span class="ua-lc-k">Kn</span>
                        <span class="ua-lc-v" data-stat="kn">–</span>
                    </span>
                    <span class="ua-lc-regime" data-stat="regime">–</span>
                </div>
            `;
            el.appendChild(row);
        }

        // Wire toggles after DOM is in place.
        el.querySelectorAll('.ua-lc-toggle').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = cb.dataset.layerId;
                this.globe.setLayerVisible?.(id, cb.checked);
                // Reflect the disabled state on the row itself for
                // visual feedback even before the next refresh().
                const row = el.querySelector(`.ua-lc-row[data-layer-id="${id}"]`);
                if (row) row.classList.toggle('ua-lc-row--off', !cb.checked);
            });
        });

        // First paint of mini-stats (in case profile already arrived).
        this._paintLayerControls();
    }

    /**
     * Refresh per-layer mini-stats from the current state. Cheap; runs
     * once per refresh(), not per frame.
     */
    _paintLayerControls() {
        const el = this.el.layerControls;
        if (!el) return;
        const { f107, ap } = this.state;
        for (const L of ATMOSPHERIC_LAYER_SCHEMA) {
            const phys = layerPhysics(L, { f107Sfu: f107, ap });
            const row = el.querySelector(`.ua-lc-stats[data-layer-id="${L.id}"]`);
            if (!row) continue;
            const set = (sel, v) => {
                const e = row.querySelector(`[data-stat="${sel}"]`);
                if (e) e.textContent = v;
            };
            set('rho', phys.ρ.toExponential(2) + ' kg/m³');
            set('T',   `${phys.T.toFixed(0)} K`);
            set('dom', phys.dominant);
            set('kn',  Number.isFinite(phys.knudsen)
                ? (phys.knudsen >= 100 ? phys.knudsen.toExponential(1)
                  : phys.knudsen.toFixed(2))
                : '∞');
            set('regime', phys.regime);
            // Colour the regime badge by its physics class.
            const regimeEl = row.querySelector('[data-stat="regime"]');
            if (regimeEl) {
                regimeEl.className = `ua-lc-regime ua-lc-regime--${phys.regime}`;
            }
        }
        this._pulseLayerLive();
    }

    /** Briefly highlight every layer's "live" dot on a refresh tick. */
    _pulseLayerLive() {
        const el = this.el.layerControls;
        if (!el) return;
        el.querySelectorAll('.ua-lc-pulse').forEach(dot => {
            dot.classList.remove('ua-lc-pulse--fire');
            // restart animation: force reflow, re-add the class
            void dot.offsetWidth;
            dot.classList.add('ua-lc-pulse--fire');
        });
    }
}

// ── Utility ─────────────────────────────────────────────────────────────────

function _prepareCanvas(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width  = Math.max(1, Math.floor(w * dpr));
        canvas.height = Math.max(1, Math.floor(h * dpr));
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
}

function _annotateProfile(p) {
    if (!p) return p;
    return {
        ...p,
        layers:     p.layers     || ATMOSPHERIC_LAYERS,
        satellites: p.satellites || SATELLITE_REFERENCES,
    };
}

function _alpha(cssColor, a) {
    // Accepts "#rgb", "#rrggbb", or "rgb(...)" / "rgba(...)".
    if (!cssColor) return `rgba(255,255,255,${a})`;
    if (cssColor.startsWith('#')) {
        let r, g, b;
        if (cssColor.length === 4) {
            r = parseInt(cssColor[1] + cssColor[1], 16);
            g = parseInt(cssColor[2] + cssColor[2], 16);
            b = parseInt(cssColor[3] + cssColor[3], 16);
        } else {
            r = parseInt(cssColor.slice(1, 3), 16);
            g = parseInt(cssColor.slice(3, 5), 16);
            b = parseInt(cssColor.slice(5, 7), 16);
        }
        return `rgba(${r},${g},${b},${a})`;
    }
    return cssColor;   // leave anything else untouched
}

function _sourceLabel(model) {
    if (!model) return 'client';
    if (model === 'SPARTA-lookup')    return 'SPARTA';
    if (model === 'SPARTA-bootstrap') return 'SPARTA·boot';
    if (model === 'NRLMSISE-00')      return 'MSIS';
    if (model === 'exp-fallback')     return 'fallback';
    if (model === 'client-fallback')  return 'client*';
    if (model === 'client')           return 'client';
    return model;
}

/**
 * Map a model string + mode to a pill class / label / tooltip.
 *   cls      CSS class (ua-source--{client,fallback,backend,sparta})
 *   label    short user-visible text
 *   tip      hover tooltip
 */
function _pillFor(model, useBackend) {
    const mode = useBackend ? 'Auto' : 'Client only';
    switch (model) {
        case 'SPARTA-lookup':
            return {
                cls: 'ua-source--sparta',
                label: `SPARTA · ${mode}`,
                tip: 'Backend answered from a precomputed SPARTA DSMC lookup table. Highest-fidelity source. Click to toggle Auto / Client-only.',
            };
        case 'SPARTA-bootstrap':
            return {
                cls: 'ua-source--bootstrap',
                label: `SPARTA·boot · ${mode}`,
                tip: 'Backend served an MSIS-seeded bootstrap table (grid is populated but rows have not yet been refined by a SPARTA run). Click to toggle.',
            };
        case 'NRLMSISE-00':
            return {
                cls: 'ua-source--backend',
                label: `MSIS · ${mode}`,
                tip: 'Backend answered from NRLMSISE-00. SPARTA tables not yet populated. Click to toggle Auto / Client-only.',
            };
        case 'exp-fallback':
            return {
                cls: 'ua-source--fallback',
                label: `Backend fallback · ${mode}`,
                tip: 'Backend is alive but NRLMSISE-00 and SPARTA both unavailable; server is on its exponential fallback. Click to toggle.',
            };
        case 'client-fallback':
            return {
                cls: 'ua-source--fallback',
                label: `Client fallback · ${mode}`,
                tip: 'Backend unreachable; page is running its in-browser surrogate. Click to toggle.',
            };
        default:
            return {
                cls: 'ua-source--client',
                label: `Client · ${mode}`,
                tip: useBackend
                    ? 'In-browser surrogate (no backend reachable or configured yet). Click to toggle.'
                    : 'In-browser surrogate — backend calls disabled. Click to re-enable Auto mode.',
            };
    }
}

/**
 * Compact "N s/m/h ago" formatter for the TLE freshness pill.
 * Caps at hours since CelesTrak refreshes every ~8h — anything
 * older than that and the user should see the unit clearly.
 */
function _ageString(seconds) {
    if (seconds < 60)   return `${Math.round(seconds)}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    return `${(seconds / 3600).toFixed(1)}h ago`;
}
