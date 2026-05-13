/**
 * satellite-pills.js — Shared status-pill renderer for satellite
 * profile cards.
 *
 * The operations console has three surfaces that present "this is the
 * sat under your cursor": the hover tooltip (`globe-picker.js`), the
 * right-click / long-press menu header (also `globe-picker.js`), and
 * the orbit inspector header (`orbit-inspector.js`). Before this
 * module each surface decided independently what to show, so the same
 * Envisat read as "envisat · 770 km" in one place and "27386 ·
 * Defunct (recovered from name)" nowhere else.
 *
 * `computePills(sat, ctx)` returns the canonical pill list given a
 * satellite record + a context bag (tracker, globe, fleet
 * membership, F10.7/Ap from provenance). `renderPills(pills, opts)`
 * turns that into HTML. The CSS lives in `operations.html` under
 * `.op-pill` / `.op-pills`.
 *
 * Pill taxonomy — ordered so the most actionable badges land first
 * once they fire:
 *
 *   reentry-now / -soon / -watch  danger | warn   "Reentry < 1 d", "Reentry 4 d", "Decay 22 d"
 *   conjunction                   danger          "Conjunction"
 *   eclipse                       info            "In eclipse"
 *   fleet                         accent          "★ in fleet"
 *   regime  (LEO/MEO/GEO/HEO)     neutral         "LEO"
 *   defunct                       muted           "Defunct"
 *   tumbling                      muted           "Tumbling"
 *
 * The compute function is defensive: each pill is independently
 * gated on whether its inputs are present, so the caller can pass
 * a partial ctx and just get whatever is computable.
 */

import { decayWithSigma } from './decision-deck.js';
import { provStore }      from './provenance.js';
import { annotate as annotateDebris } from '../debris-catalog.js';

// Regime cut-offs (km above mean Earth radius).
const ALT_LEO_MAX = 2000;
const ALT_MEO_MAX = 30000;
const GEO_ALT     = 35786;
const GEO_BAND    = 1500;        // ±km around the GEO altitude

// Reentry urgency thresholds (days).
const REENTRY_IMMINENT_DAYS = 1;
const REENTRY_SOON_DAYS     = 7;
const REENTRY_WATCH_DAYS    = 30;

// Earth radius shared by the eclipse math — must match the value the
// SGP4 propagator uses (WGS-72) since position comes from there.
const RE_KM = 6378.135;

// Groups the rocket-body / debris models tag their satellites with.
// Treated as "defunct" for pill purposes — these have no active
// mission, by design.
const DEFUNCT_GROUPS = new Set([
    'sl-16-rb',
    'sl-8-rb',
    'envisat',
    'debris',
    'fengyun-1c-debris',
    'cosmos-1408-debris',
    'iridium-33-debris',
    'cosmos-2251-debris',
]);

// Subset of the defunct groups whose 3D renderer animates a tumble.
// Keeps the pill text honest with what the operator sees on the globe.
const TUMBLING_GROUPS = new Set([
    'sl-8-rb',
    'envisat',
]);

// Defunct objects that aren't caught by group membership (e.g. live
// "debris" group hasn't been toggled on). Names from the TLE catalog.
// Keep tight — false positives here would mark active assets as
// defunct.
const NAME_LOOKS_DEFUNCT = /(?:^|\s)(R\/B|DEB)(?:\s|\(|$)/i;

function regimePill(alt) {
    if (!Number.isFinite(alt)) return null;
    if (alt < ALT_LEO_MAX) {
        return {
            id:    'regime-leo',
            label: 'LEO',
            tone:  'neutral',
            title: `Low Earth Orbit (< ${ALT_LEO_MAX} km)`,
        };
    }
    if (Math.abs(alt - GEO_ALT) < GEO_BAND) {
        return {
            id:    'regime-geo',
            label: 'GEO',
            tone:  'neutral',
            title: `Geostationary band (${GEO_ALT - GEO_BAND}–${GEO_ALT + GEO_BAND} km)`,
        };
    }
    if (alt < ALT_MEO_MAX) {
        return {
            id:    'regime-meo',
            label: 'MEO',
            tone:  'neutral',
            title: `Medium Earth Orbit (${ALT_LEO_MAX}–${ALT_MEO_MAX} km)`,
        };
    }
    return {
        id:    'regime-heo',
        label: 'HEO',
        tone:  'neutral',
        title: 'High / highly-elliptical orbit',
    };
}

function isDefunct(sat) {
    if (!sat) return false;
    if (sat.group && DEFUNCT_GROUPS.has(sat.group)) return true;
    if (sat.name && NAME_LOOKS_DEFUNCT.test(sat.name)) return true;
    return false;
}

function isTumbling(sat) {
    if (!sat) return false;
    if (sat.group && TUMBLING_GROUPS.has(sat.group)) return true;
    return false;
}

/**
 * Eclipse check shared with the Starlink renderer: sat is in Earth
 * shadow when the sat→Sun line passes within Earth-radius of the
 * origin AND the sat is on the anti-sun side of Earth.
 *
 * `pos` is scene-space coords (Earth at origin, radius = `earthR`);
 * `sun` is the unit Sun direction in the same frame.
 */
function isEclipsed(pos, sun, earthR) {
    if (!pos || !sun) return false;
    const { x, y, z } = pos;
    const sx = sun.x, sy = sun.y, sz = sun.z;
    const pDotSun = x * sx + y * sy + z * sz;
    if (pDotSun >= 0) return false;
    const r2 = x * x + y * y + z * z;
    const d2 = r2 - pDotSun * pDotSun;
    return d2 < earthR * earthR;
}

/**
 * Reentry pill from a lifetime-in-days number. Three urgency
 * tiers: imminent (red, < 1 d), soon (red/orange, < 7 d), watch
 * (amber, < 30 d). Beyond that the orbit is considered stable for
 * card-glance purposes and no pill fires.
 */
function reentryPillFromDays(days) {
    if (!Number.isFinite(days)) return null;
    if (days < REENTRY_IMMINENT_DAYS) {
        const hours = Math.max(1, Math.round(days * 24));
        return {
            id:    'reentry-now',
            label: `Reentry < ${hours} h`,
            tone:  'danger',
            title: 'Atmospheric reentry imminent — perigee inside the upper-atmosphere drag regime.',
        };
    }
    if (days < REENTRY_SOON_DAYS) {
        return {
            id:    'reentry-soon',
            label: `Reentry ${days.toFixed(1)} d`,
            tone:  'danger',
            title: 'Reentry expected within a week.',
        };
    }
    if (days < REENTRY_WATCH_DAYS) {
        return {
            id:    'reentry-watch',
            label: `Decay ${Math.round(days)} d`,
            tone:  'warn',
            title: 'Reentry expected within a month — decay watch.',
        };
    }
    return null;
}

/**
 * Pull F10.7 / Ap from the provenance store and call decayWithSigma
 * to estimate lifetime. Returns lifetime in days or null when the
 * inputs aren't available or the orbit is effectively stable.
 *
 * The same call is made by orbit-inspector for the drag/decay
 * panel, so pill + inspector stay in lockstep.
 */
function lifetimeDaysFromTle(tle) {
    if (!tle) return null;
    const f107  = provStore.get?.('idx.f107')?.value;
    const ap    = provStore.get?.('idx.ap')?.value;
    if (!Number.isFinite(f107) || !Number.isFinite(ap)) return null;
    const sigF107 = provStore.get?.('idx.f107')?.sigma ?? 0;
    const sigAp   = provStore.get?.('idx.ap')?.sigma   ?? 0;
    try {
        const r = decayWithSigma(tle, f107, sigF107, ap, sigAp);
        const d = r?.lifetime_days;
        return Number.isFinite(d) ? d : null;
    } catch (_) {
        return null;
    }
}

/**
 * Compute the canonical pill list for a satellite given the live
 * context. Order is intentional: most actionable / urgent badges
 * first, taxonomic ones last, so renderers can clip a tail and still
 * lead with the right thing.
 *
 * ctx fields (all optional — each pill self-gates):
 *   tracker         the SatelliteTracker — used for position lookup
 *   globe           OperationsGlobe — getSunDirection() / getEarthRadius()
 *   inFleet         boolean
 *   inConjunction   boolean — true if this NORAD appears in the
 *                   current screener output
 *   includeReentry  default true; pass false to skip the
 *                   F10.7/Ap-dependent decay model (hot-path callers
 *                   that already know the answer)
 */
export function computePills(sat, ctx = {}) {
    const pills = [];
    if (!sat) return pills;

    const tle  = sat.tle;
    const norad = tle?.norad_id ?? sat.norad_id;

    // ── Reentry — high urgency, leads the list when it fires.
    if (ctx.includeReentry !== false) {
        const days = lifetimeDaysFromTle(tle);
        const p = reentryPillFromDays(days);
        if (p) pills.push(p);
    }

    // ── Conjunction — surfaces the screener's most recent finding.
    if (ctx.inConjunction) {
        pills.push({
            id:    'conjunction',
            label: 'Conjunction',
            tone:  'danger',
            title: 'Appears in the most recent conjunction screening pass.',
        });
    }

    // ── Eclipse — geometry-only, cheap. Computed from the tracker's
    // current scene-space position and the globe's sun direction.
    const pos = (ctx.tracker && Number.isFinite(norad))
        ? ctx.tracker.getPositionXYZ?.(norad)
        : null;
    const sun = ctx.globe?.getSunDirection?.();
    const earthR = ctx.globe?.getEarthRadius?.() ?? 1;
    if (pos && sun && isEclipsed(pos, sun, earthR)) {
        pills.push({
            id:    'eclipse',
            label: 'In eclipse',
            tone:  'info',
            title: 'Currently in Earth\'s shadow — no direct sunlight on the spacecraft.',
        });
    }

    // ── In fleet — accent pill so it pops on the inspector header
    // where the user's mental anchor is "my stuff vs. everything else".
    if (ctx.inFleet) {
        pills.push({
            id:    'fleet',
            label: '★ in fleet',
            tone:  'accent',
            title: 'Member of your operations fleet.',
        });
    }

    // ── Regime — always present when altitude is known. Operators
    // use it as a coarse "where in the sky is this" anchor.
    const altKm = Number.isFinite(sat.alt) ? sat.alt
                : Number.isFinite(tle?.apogee_km) && Number.isFinite(tle?.perigee_km)
                    ? (tle.apogee_km + tle.perigee_km) / 2
                    : null;
    const rp = regimePill(altKm);
    if (rp) pills.push(rp);

    // ── Size class — sourced from debris-catalog.annotate(), which
    // already runs for every probe on the upper-atmosphere globe.
    // Gated on family.id !== 'unknown' so we don't bluff a size for
    // active payloads (Starlink, GPS, …): for those the classifier
    // falls through to the generic "medium" heuristic which would
    // misrepresent objects we have no real size opinion on.
    //
    // For attributed objects (rocket bodies, ASAT fragments, NOAA
    // breakups, named cloud events) we surface:
    //   - large  → `warn`    catastrophic on impact, ~800 kg median
    //   - medium → `neutral` 10 cm–1 m, mission-killing
    //   - small  → `muted`   1–10 cm, lethal but small RCS
    try {
        const annot = annotateDebris({
            name:    sat.name ?? tle?.name,
            noradId: norad,
        });
        const family = annot?.family;
        const size   = annot?.size;
        if (family && family.id !== 'unknown' && size) {
            const cls = size.class;
            const label = cls === 'large'  ? 'Large'
                        : cls === 'medium' ? 'Medium'
                        :                    'Small';
            const tone  = cls === 'large'  ? 'warn'
                        : cls === 'medium' ? 'neutral'
                        :                    'muted';
            pills.push({
                id:    `size-${cls}`,
                label,
                tone,
                title: `${size.rangeM} · ~${size.massKg} kg · RCS ≈ ${size.rcsM2} m² · ${family.name}.`,
            });
        }
    } catch (_) { /* annotate is best-effort — skip pill on any failure */ }

    // ── Defunct / tumbling — taxonomic, last in the list.
    if (isDefunct(sat)) {
        pills.push({
            id:    'defunct',
            label: 'Defunct',
            tone:  'muted',
            title: 'No active mission — rocket body, debris fragment, or end-of-life spacecraft.',
        });
    }
    if (isTumbling(sat)) {
        pills.push({
            id:    'tumbling',
            label: 'Tumbling',
            tone:  'muted',
            title: 'Uncontrolled attitude state — orientation drifts on every orbit.',
        });
    }

    return pills;
}

function escapeAttr(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

/**
 * Render the pill list to an HTML string. Empty list → empty string
 * (so callers can splice the result into a template unconditionally).
 *
 * opts.max — clip the list to this many pills (rest are dropped).
 *            Order is preserved, so the most urgent badges survive.
 * opts.compact — drop the `title` attribute on each pill, used in the
 *            tooltip where the surface itself is already a tooltip.
 */
export function renderPills(pills, opts = {}) {
    if (!pills || pills.length === 0) return '';
    const list = (typeof opts.max === 'number')
        ? pills.slice(0, opts.max)
        : pills;
    const titleAttr = opts.compact ? '' : ' title="';
    const titleEnd  = opts.compact ? '' : '"';
    const html = list.map(p => {
        const cls = `op-pill op-pill--${escapeAttr(p.tone)} op-pill--${escapeAttr(p.id)}`;
        const title = opts.compact ? '' : `${titleAttr}${escapeAttr(p.title || p.label)}${titleEnd}`;
        return `<span class="${cls}"${title}>${escapeAttr(p.label)}</span>`;
    }).join('');
    return `<div class="op-pills">${html}</div>`;
}
