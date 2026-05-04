/**
 * launch-history.js — Historical launch achievements + timeline.
 *
 * Two responsibilities, kept in one module because they share the same
 * curated dataset:
 *
 *   1. Achievement Runs panel — top-level "story" cards highlighting major
 *      program-scale milestones (Apollo, Shuttle, Artemis, Falcon 9 reuse,
 *      Crew Dragon, Falcon Heavy, Starship). One tab per program. Each
 *      program lists its headline flights with dates + one-line "why it
 *      matters" notes.
 *
 *   2. Historic Launches timeline — chronological strip rendering every
 *      milestone flight in a single horizontally-scrollable rail, color
 *      coded by program. Click a marker to scroll its program tab into
 *      view in the achievements panel above.
 *
 * Data source: public mission histories (NASA HQ, NASA SP-4012, SpaceX
 * press kits, Wikipedia program articles). Dates are launch dates UTC.
 */

// ── Data ─────────────────────────────────────────────────────────────────────
// Each program lists its iconic flights. Color is the brand-ish accent used
// for both the achievement card stripe and the timeline marker.

export const PROGRAMS = [
    {
        id: 'mercury_gemini',
        operator: 'NASA',
        name: 'Mercury & Gemini',
        years: '1961–1966',
        color: '#9bd',
        tagline: 'Putting Americans into orbit and proving rendezvous.',
        flights: [
            { date: '1961-05-05', name: 'Freedom 7',     note: 'First American in space — Alan Shepard, suborbital.' },
            { date: '1962-02-20', name: 'Friendship 7',  note: 'First American to orbit Earth — John Glenn, three orbits.' },
            { date: '1965-06-03', name: 'Gemini IV',     note: 'First U.S. spacewalk — Ed White, 23 minutes EVA.' },
            { date: '1965-12-15', name: 'Gemini VI-A',   note: 'First crewed rendezvous — station-keeping with Gemini VII.' },
            { date: '1966-03-16', name: 'Gemini VIII',   note: 'First docking of two spacecraft (Agena target vehicle).' },
        ],
    },
    {
        id: 'apollo',
        operator: 'NASA',
        name: 'Apollo',
        years: '1968–1972',
        color: '#fb6',
        tagline: 'Crewed lunar exploration on the Saturn V.',
        flights: [
            { date: '1968-12-21', name: 'Apollo 8',  note: 'First crewed lunar orbit — Earthrise photograph.' },
            { date: '1969-07-16', name: 'Apollo 11', note: 'First crewed lunar landing — Armstrong & Aldrin at Tranquility Base.' },
            { date: '1970-04-11', name: 'Apollo 13', note: 'Successful failure — crew returned safely after O₂ tank rupture.' },
            { date: '1971-07-26', name: 'Apollo 15', note: 'First Lunar Roving Vehicle, J-mission science focus.' },
            { date: '1972-12-07', name: 'Apollo 17', note: 'Final Apollo landing — last humans on the Moon (to date).' },
        ],
    },
    {
        id: 'shuttle',
        operator: 'NASA',
        name: 'Space Shuttle',
        years: '1981–2011',
        color: '#fc7',
        tagline: 'Reusable orbiter — 135 missions, ISS construction, Hubble servicing.',
        flights: [
            { date: '1981-04-12', name: 'STS-1 Columbia',     note: 'First flight of a reusable crewed spacecraft.' },
            { date: '1990-04-24', name: 'STS-31 Discovery',   note: 'Hubble Space Telescope deployment.' },
            { date: '1995-06-27', name: 'STS-71 Atlantis',    note: 'First Shuttle–Mir docking — 100th U.S. crewed flight.' },
            { date: '1998-12-04', name: 'STS-88 Endeavour',   note: 'Unity node launch — start of ISS assembly.' },
            { date: '2009-05-11', name: 'STS-125 Atlantis',   note: 'Final Hubble servicing mission (SM4).' },
            { date: '2011-07-08', name: 'STS-135 Atlantis',   note: 'Final Shuttle flight — end of the 30-year program.' },
        ],
    },
    {
        id: 'artemis',
        operator: 'NASA',
        name: 'Artemis',
        years: '2022–',
        color: '#f86',
        tagline: 'Return to the Moon — SLS + Orion + HLS.',
        flights: [
            { date: '2022-11-16', name: 'Artemis I', note: 'Uncrewed Orion + SLS test, distant retrograde lunar orbit.' },
            { date: '2026-04-01', name: 'Artemis II', note: 'First crewed Orion — lunar flyby (planned).' },
            { date: '2027-09-01', name: 'Artemis III', note: 'First crewed lunar landing since 1972 (planned, HLS Starship).' },
        ],
    },
    {
        id: 'falcon9',
        operator: 'SpaceX',
        name: 'Falcon 9',
        years: '2010–',
        color: '#0cc',
        tagline: 'Routine orbital reusability — first booster relandings, ISS resupply, Starlink.',
        flights: [
            { date: '2010-06-04', name: 'Falcon 9 v1.0 maiden', note: 'First flight of Falcon 9 (Dragon C1 qualification).' },
            { date: '2012-05-22', name: 'CRS-1 Demo (COTS-2)',  note: 'First commercial spacecraft to berth with the ISS.' },
            { date: '2015-12-22', name: 'Falcon 9 Flight 20',   note: 'First successful first-stage landing on land (LZ-1).' },
            { date: '2016-04-08', name: 'CRS-8',                note: 'First successful droneship landing (OCISLY).' },
            { date: '2017-03-30', name: 'SES-10',               note: 'First reflight of an orbital-class booster (B1021).' },
            { date: '2019-05-24', name: 'Starlink v0.9',        note: 'First operational Starlink launch — 60 satellites.' },
        ],
    },
    {
        id: 'falcon_heavy',
        operator: 'SpaceX',
        name: 'Falcon Heavy',
        years: '2018–',
        color: '#9cf',
        tagline: 'Triple-core heavy-lift on reusable Falcon hardware.',
        flights: [
            { date: '2018-02-06', name: 'FH Demo (Starman)', note: 'Maiden flight — Tesla Roadster on heliocentric trajectory; dual-booster RTLS.' },
            { date: '2019-04-11', name: 'Arabsat-6A',        note: 'First operational FH; first triple-core recovery.' },
            { date: '2022-11-01', name: 'USSF-44',           note: 'First direct-to-GEO insertion for FH (DoD payload).' },
            { date: '2023-10-13', name: 'Psyche',            note: 'NASA asteroid mission — first interplanetary FH launch.' },
        ],
    },
    {
        id: 'crew_dragon',
        operator: 'SpaceX',
        name: 'Crew Dragon',
        years: '2020–',
        color: '#fff',
        tagline: 'Commercial human spaceflight — restoring U.S. crew launch capability.',
        flights: [
            { date: '2020-05-30', name: 'Demo-2 (Endeavour)', note: 'First crewed orbital flight from U.S. soil since STS-135.' },
            { date: '2020-11-15', name: 'Crew-1 (Resilience)', note: 'First operational ISS crew rotation on a commercial spacecraft.' },
            { date: '2021-09-15', name: 'Inspiration4',       note: 'First all-civilian orbital mission.' },
            { date: '2024-09-10', name: 'Polaris Dawn',       note: 'First commercial spacewalk; highest crewed Earth orbit since Apollo.' },
        ],
    },
    {
        id: 'starship',
        operator: 'SpaceX',
        name: 'Starship',
        years: '2023–',
        color: '#fa3',
        tagline: 'Fully reusable super-heavy — methalox, tower catch, in-flight relight.',
        flights: [
            { date: '2023-04-20', name: 'IFT-1', note: 'First integrated Starship + Super Heavy launch — RUD at T+4 min.' },
            { date: '2023-11-18', name: 'IFT-2', note: 'First successful hot-staging; ship lost during ascent.' },
            { date: '2024-03-14', name: 'IFT-3', note: 'First on-orbit cruise + reentry attempt; payload door + propellant transfer demos.' },
            { date: '2024-06-06', name: 'IFT-4', note: 'First soft splashdown of both stages.' },
            { date: '2024-10-13', name: 'IFT-5', note: 'First Mechazilla tower catch of Super Heavy.' },
        ],
    },
];

// Flatten + sort all flights for the timeline view.
export function allFlightsChronological() {
    const rows = [];
    for (const p of PROGRAMS) {
        for (const f of p.flights) {
            rows.push({ ...f, program: p });
        }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
}

// ── Render: Achievement Runs panel ───────────────────────────────────────────

function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' :
        c === '"' ? '&quot;' : '&#39;'
    ));
}

function fmtDate(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function programCardHtml(p) {
    return `
        <article class="lh-program" data-program="${escHtml(p.id)}" style="border-left-color:${p.color}">
            <header class="lh-program-hd">
                <div>
                    <div class="lh-program-op">${escHtml(p.operator)} · ${escHtml(p.years)}</div>
                    <h3 class="lh-program-name" style="color:${p.color}">${escHtml(p.name)}</h3>
                </div>
                <div class="lh-program-count">${p.flights.length} flights</div>
            </header>
            <p class="lh-program-tag">${escHtml(p.tagline)}</p>
            <ul class="lh-flights">
                ${p.flights.map(f => `
                    <li class="lh-flight" data-date="${escHtml(f.date)}">
                        <span class="lh-flight-date">${escHtml(fmtDate(f.date))}</span>
                        <div class="lh-flight-body">
                            <div class="lh-flight-name">${escHtml(f.name)}</div>
                            <div class="lh-flight-note">${escHtml(f.note)}</div>
                        </div>
                    </li>
                `).join('')}
            </ul>
        </article>
    `;
}

export function renderAchievements(root) {
    if (!root) return;
    const operators = ['ALL', ...new Set(PROGRAMS.map(p => p.operator))];
    root.innerHTML = `
        <div class="lh-tabs" role="tablist">
            ${operators.map((op, i) => `
                <button type="button" class="lh-tab ${i === 0 ? 'lh-tab--on' : ''}" data-op="${escHtml(op)}">${escHtml(op)}</button>
            `).join('')}
        </div>
        <div class="lh-programs">
            ${PROGRAMS.map(programCardHtml).join('')}
        </div>
    `;

    const tabs = root.querySelectorAll('.lh-tab');
    tabs.forEach(t => t.addEventListener('click', () => {
        tabs.forEach(x => x.classList.remove('lh-tab--on'));
        t.classList.add('lh-tab--on');
        const op = t.dataset.op;
        root.querySelectorAll('.lh-program').forEach(card => {
            const cid = card.dataset.program;
            const p = PROGRAMS.find(x => x.id === cid);
            const show = op === 'ALL' || (p && p.operator === op);
            card.style.display = show ? '' : 'none';
        });
    }));
}

// ── Render: Timeline strip ───────────────────────────────────────────────────
// Horizontal rail, time-proportional layout. The rail spans from the earliest
// flight to ~today + a buffer for upcoming Artemis flights. Marker offset is
// (date − minDate) / (maxDate − minDate) so multi-decade programs distribute
// naturally. Each marker is colored by program.

export function renderTimeline(root) {
    if (!root) return;
    const flights = allFlightsChronological();
    if (!flights.length) { root.innerHTML = ''; return; }

    const toMs = iso => new Date(iso + 'T00:00:00Z').getTime();
    const minMs = toMs(flights[0].date);
    const maxMs = Math.max(toMs(flights[flights.length - 1].date), Date.now() + 30 * 86400 * 1000);
    const span = maxMs - minMs;
    const pct = ms => ((ms - minMs) / span * 100).toFixed(2);

    // Decade grid lines for legibility
    const minYear = new Date(minMs).getUTCFullYear();
    const maxYear = new Date(maxMs).getUTCFullYear();
    const decades = [];
    for (let y = Math.ceil(minYear / 10) * 10; y <= maxYear; y += 10) {
        decades.push({ year: y, ms: toMs(`${y}-01-01`) });
    }

    root.innerHTML = `
        <div class="lh-tl-scroll">
            <div class="lh-tl-rail">
                <div class="lh-tl-axis"></div>
                ${decades.map(d => `
                    <div class="lh-tl-decade" style="left:${pct(d.ms)}%">
                        <span class="lh-tl-decade-lbl">${d.year}s</span>
                    </div>
                `).join('')}
                ${flights.map((f, i) => {
                    const left = pct(toMs(f.date));
                    const lane = i % 4;     // staggered vertical lanes so labels don't collide
                    return `
                        <button type="button" class="lh-tl-marker lh-tl-lane-${lane}"
                                style="left:${left}%; --c:${f.program.color}"
                                data-date="${escHtml(f.date)}"
                                data-program="${escHtml(f.program.id)}"
                                title="${escHtml(f.program.name)} — ${escHtml(f.name)} (${escHtml(fmtDate(f.date))})">
                            <span class="lh-tl-dot"></span>
                            <span class="lh-tl-lbl">
                                <span class="lh-tl-lbl-name">${escHtml(f.name)}</span>
                                <span class="lh-tl-lbl-date">${escHtml(fmtDate(f.date))}</span>
                            </span>
                        </button>
                    `;
                }).join('')}
            </div>
        </div>
    `;

    root.querySelectorAll('.lh-tl-marker').forEach(m => {
        m.addEventListener('click', () => {
            const pid = m.dataset.program;
            const card = document.querySelector(`.lh-program[data-program="${CSS.escape(pid)}"]`);
            if (card) {
                document.querySelectorAll('.lh-tab').forEach(t => {
                    t.classList.toggle('lh-tab--on', t.dataset.op === 'ALL');
                });
                document.querySelectorAll('.lh-program').forEach(c => { c.style.display = ''; });
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.classList.add('lh-program--flash');
                setTimeout(() => card.classList.remove('lh-program--flash'), 1400);
            }
        });
    });
}
