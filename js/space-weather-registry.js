/**
 * space-weather-registry.js — self-describing panel registry for the
 * space-weather dashboard (SPACE_WEATHER_DASHBOARD_PLAN.md §6, phase D1).
 *
 * PURE DATA + pure helpers — no DOM, no fetch. Node-tested by
 * tests/space-weather-registry.mjs, which cross-checks every entry here
 * against the actual `data-lab-panel` markup in space-weather.html (both
 * directions), so this file cannot silently drift from the page.
 *
 * D1 scope: the registry ADAPTS the legacy panels that already exist in
 * the page markup — it does not create panels. Layout Lab's gallery
 * drawer renders from this metadata, and the committed preset layouts
 * (data/layout-presets/space-weather.json) may only reference ids listed
 * here. Multi-instance panels and per-panel config schemas are D2 —
 * when they land, entries gain a `config` schema field; do not bolt
 * config onto D1 entries ad hoc.
 *
 * `zone` matches the page's `data-lab-zone` containers: 'main' (#sw-app)
 * or 'grid' (the data-card grid — itself a movable panel of 'main').
 * `family` groups the gallery drawer; `personas` feed preset authoring
 * and (later) the first-run flow. Both vocabularies are closed — the
 * node test enforces membership.
 *
 * D2 config sheets: entries MAY carry a `config` schema — an array of
 * typed fields the gallery drawer renders as a ⚙ sheet. Field shapes:
 *   { key, label, type: 'select', options: [...], default }
 *   { key, label, type: 'number', min, max, step?, default }
 *   { key, label, type: 'toggle', default }
 * Values persist in the per-page panel-config store (layout-lab.js —
 * OUTSIDE the layout doc, the same rationale as panel sizes: a config
 * tweak must survive layout switches and must never silently convert an
 * A/B-variant view into a personal layout). Consumers receive values
 * via window.__swPanelConfig + the 'sw-panel-config' event and OWN the
 * semantic validation of what they read.
 */

export const FAMILIES = Object.freeze({
    forecast:  'Forecast',
    live:      'Live now',
    sim:       'Simulation',
    trust:     'Trust & validation',
    reference: 'Reference',
});

export const PERSONAS = Object.freeze(
    ['chaser', 'operator', 'forecaster', 'educator', 'casual']);

export const PANELS = Object.freeze([
    // ── zone: main (#sw-app) ────────────────────────────────────────────
    { id: 'stage', zone: 'main', family: 'sim',
      title: 'The Stage — Sun→Earth corridor',
      blurb: 'The one-context 3D scene: kernel-driven CME ropes, ensemble ghosts and wavefronts, L1, and the breathing magnetopause, on the τ-timeline.',
      personas: ['chaser', 'operator', 'forecaster', 'educator', 'casual'],
      config: [
          { key: 'station', label: 'Default station', type: 'select', default: 'corridor',
            options: ['solar-watch', 'corridor', 'l1-approach', 'magnetosphere', 'my-sky', 'orbit-ops'] },
          { key: 'spirals', label: 'Parker-spiral dressing', type: 'toggle', default: true },
          { key: 'ghosts', label: 'Ensemble ghost ropes', type: 'number', min: 0, max: 14, step: 1, default: 14 },
      ] },
    { id: 'metrics-hero', zone: 'main', family: 'live',
      title: 'Live metrics strip',
      blurb: 'Solar wind speed, IMF Bz, Kp, and X-ray flux at a glance.',
      personas: ['chaser', 'operator', 'forecaster', 'casual'] },
    { id: 'helio-hero', zone: 'main', family: 'sim',
      title: 'Heliosphere simulation',
      blurb: 'The Sun→Earth 3D view with live + hypothetical scenario modes.',
      personas: ['educator', 'forecaster'] },
    { id: 'solar-system-info', zone: 'main', family: 'reference',
      title: 'Solar system simulation notes',
      blurb: 'What the heliosphere view shows and how to read it.',
      personas: ['educator'] },
    { id: 'transit', zone: 'main', family: 'live',
      title: 'Solar wind transit · Sun → L1 → Earth',
      blurb: 'Where the plasma passing L1 right now is on its way to Earth.',
      personas: ['operator', 'forecaster', 'educator'] },
    { id: 'cme-forecast', zone: 'main', family: 'forecast',
      title: 'CME propagation forecast',
      blurb: 'Drag-based arrival forecasts for active DONKI CMEs.',
      personas: ['operator', 'forecaster'] },
    { id: 'flux-rope-forecast', zone: 'main', family: 'forecast',
      title: 'CME flux-rope Bz forecast',
      blurb: 'Ensemble Bz fan from the flux-rope engine, assimilated on live L1 data.',
      personas: ['chaser', 'operator', 'forecaster'] },
    { id: 'earth-forecast', zone: 'main', family: 'forecast',
      title: 'Earth-side forecast',
      blurb: 'Consequences of today’s solar activity: aurora, radio, GPS, power.',
      personas: ['chaser', 'operator', 'forecaster', 'casual'] },
    { id: 'forecast-timeline', zone: 'main', family: 'forecast',
      title: '72-hour forecast timeline',
      blurb: 'Probabilistic Kp and impact windows for the next three days.',
      personas: ['chaser', 'operator', 'forecaster', 'casual'] },
    { id: 'globe', zone: 'main', family: 'sim',
      title: 'Sun · Earth · Moon · magnetosphere globe',
      blurb: '3D globe with the auroral oval, magnetopause, and CME propagation.',
      personas: ['chaser', 'educator', 'casual', 'forecaster'] },
    { id: 'data-grid', zone: 'main', family: 'live',
      title: 'Data card grid',
      blurb: 'The card grid below — hiding this hides every card in it.',
      personas: ['chaser', 'operator', 'forecaster', 'educator'] },
    { id: 'imagery', zone: 'main', family: 'live',
      title: 'Live solar imagery · SDO / LASCO',
      blurb: 'Latest disk and coronagraph frames.',
      personas: ['forecaster', 'educator', 'casual'] },
    { id: 'tables', zone: 'main', family: 'reference',
      title: 'Active regions & recent flares',
      blurb: 'NOAA active-region table and the 7-day GOES flare list.',
      personas: ['forecaster'] },
    { id: 'sources', zone: 'main', family: 'reference',
      title: 'Data sources',
      blurb: 'Every feed on this page, with cadence and provenance.',
      personas: ['forecaster', 'educator'] },
    { id: 'scorecard', zone: 'main', family: 'trust',
      title: 'Forecast validation — the receipts',
      blurb: 'The engine’s pinned hindcast numbers AND its documented miss — every figure test-enforced.',
      personas: ['operator', 'forecaster'] },

    // ── zone: grid (the data-card grid) ─────────────────────────────────
    { id: 'card-wind', zone: 'grid', family: 'live',
      title: 'Solar wind parameters',
      blurb: 'DSCOVR/ACE L1 plasma and field, 1-minute cadence.',
      personas: ['chaser', 'operator', 'forecaster'] },
    { id: 'card-storm-scale', zone: 'grid', family: 'live',
      title: 'Geomagnetic storm scale',
      blurb: 'NOAA Kp / G-scale plus radiation (SEP) events.',
      personas: ['chaser', 'operator', 'forecaster', 'casual'] },
    { id: 'card-cme-donki', zone: 'grid', family: 'live',
      title: 'Latest CME · NASA DONKI',
      blurb: 'Most recent CME analyses as they are catalogued.',
      personas: ['operator', 'forecaster'] },
    { id: 'card-ssw', zone: 'grid', family: 'trust',
      title: 'SSW forecast track record',
      blurb: 'Sudden-stratospheric-warming calls, scored against what happened.',
      personas: ['forecaster'] },
    { id: 'card-surface', zone: 'grid', family: 'forecast',
      title: 'Surface outlook',
      blurb: 'Stratosphere-to-troposphere coupling outlook.',
      personas: ['forecaster'] },
    { id: 'card-vortex', zone: 'grid', family: 'live',
      title: 'Stratospheric polar vortex',
      blurb: '60°N vortex state — the SSW precursor.',
      personas: ['forecaster'] },
    { id: 'card-polar-mag', zone: 'grid', family: 'live',
      title: 'Polar magnetic state',
      blurb: 'High-latitude ground magnetometer activity.',
      personas: ['chaser', 'forecaster'] },
    { id: 'card-gravity-wave', zone: 'grid', family: 'live',
      title: 'Gravity-wave activity',
      blurb: 'DSMC residual gravity-wave diagnostic.',
      personas: ['forecaster'] },
    { id: 'card-upper-atmosphere', zone: 'grid', family: 'live',
      title: 'Upper atmosphere · thermosphere',
      blurb: 'LEO-altitude density and temperature — the satellite-drag card.',
      personas: ['operator', 'forecaster'] },
    { id: 'card-earth-orbit', zone: 'grid', family: 'reference',
      title: 'Earth orbital state',
      blurb: 'VSOP87D on-device ephemeris for Earth.',
      personas: ['educator'] },
    { id: 'storm-log', zone: 'grid', family: 'trust',
      title: 'Personal storm log',
      blurb: 'Every crossing of YOUR Kp line, recorded while the console is open.',
      personas: ['chaser', 'operator'] },

    // ── Multi-instance panels (D2) ──────────────────────────────────────
    // No static markup — instances ('aurora-spot#n') are built at runtime
    // from <template id="aurora-spot-template"> by js/aurora-spot-card.js
    // via layout-lab's instantiate hook. The drift test checks the
    // template instead of a data-lab-panel, and presets do not list
    // multi-instance ids (instances are user-created).
    { id: 'aurora-spot', zone: 'grid', family: 'forecast', multiInstance: true,
      title: 'Aurora tonight — saved spot',
      blurb: 'GO / Maybe / No for one of your saved locations — add one card per spot.',
      personas: ['chaser'] },
]);

/* ── Pure helpers ─────────────────────────────────────────────────────── */

/** Map id → registry entry. */
export function byId() {
    return new Map(PANELS.map(p => [p.id, p]));
}

/** Registry entries for one zone, in registry (≈ authored) order. */
export function panelsForZone(zone) {
    return PANELS.filter(p => p.zone === zone);
}

/** Gallery model: entries grouped by family, in FAMILIES key order. */
export function galleryGroups() {
    const groups = [];
    for (const [key, label] of Object.entries(FAMILIES)) {
        const panels = PANELS.filter(p => p.family === key);
        if (panels.length) groups.push({ key, label, panels });
    }
    return groups;
}
