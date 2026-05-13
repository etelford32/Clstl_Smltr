/**
 * js/models-panel.js — render the "Forecast Models" panel.
 *
 * One-shot module: pulls /api/forecast/models on demand, renders a
 * compact list of active forecasters into a target element. No DOM
 * polling — the caller decides when to mount (typically once on page
 * load, then on tab/section expand).
 *
 * The panel exists to give visitors visible proof that the forecast
 * layer isn't just an Open-Meteo wrapper — there's a deterministic
 * Rust blender combining persistence, diurnal harmonics, AR(1) and
 * raw/bias-corrected NWP guidance behind each pixel. Educators get a
 * one-paragraph elevator pitch for each family.
 *
 * Plain-English descriptions are local (MODEL_COPY below) so they can
 * evolve faster than the Supabase registry's `notes` column. The
 * `notes` is shown on click-to-expand as the technical line.
 */

// Friendly copy keyed by model_id. Any unknown model_id falls back to
// the registry row's `name` + `notes` verbatim — so adding a model on
// the server doesn't require a client redeploy, just less-polished
// copy until we ship one.
const MODEL_COPY = Object.freeze({
    PERSIST: {
        icon:  '⏚',
        label: 'Persistence',
        blurb: 'Carries the last observed value forward, drifted by a slow bias correction.',
    },
    DIURNAL: {
        icon:  '☀',
        label: 'Diurnal Harmonic',
        blurb: 'Learns the day\'s rhythm from a Fourier fit, locked to the sun\'s altitude — so dawn means dawn, not "9 a.m."',
    },
    AR1: {
        icon:  '∿',
        label: 'AR(1) Residual',
        blurb: 'Once we strip out the daily cycle, the leftover tends to follow itself by an hour or two. This catches that.',
    },
    NWP: {
        icon:  '⛅',
        label: 'NWP (raw)',
        blurb: 'Direct guidance from the global numerical weather prediction models — GFS, ECMWF, ICON, GEM — without any post-processing.',
    },
    NWP_BC: {
        icon:  '⛅',
        label: 'NWP (bias-corrected)',
        blurb: 'The same NWP guidance, but we keep a running tab of how each model has been over- or under-shooting at this cell and correct accordingly.',
    },
    BLEND: {
        icon:  '⊕',
        label: 'Skill-Weighted Blend',
        blurb: 'Every hour, we score the other models against what actually happened and weight tomorrow\'s forecast in their favour proportionally.',
    },
});

const FAMILY_LABEL = Object.freeze({
    persistence:  'Baseline',
    diurnal:      'Baseline',
    statistical:  'Statistical',
    nwp:          'Numerical Weather Prediction',
    blend:        'Ensemble',
    ml:           'Machine learning',
    analog:       'Analog',
    unknown:      'Other',
});

let _cache = null;          // last successful payload (in-memory, per page)
let _inflight = null;       // de-dupe concurrent fetches

async function fetchModels() {
    if (_cache) return _cache;
    if (_inflight) return _inflight;
    _inflight = (async () => {
        try {
            const res = await fetch('/api/forecast/models', { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const body = await res.json();
            _cache = body;
            return body;
        } finally {
            _inflight = null;
        }
    })();
    return _inflight;
}

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class')      node.className = v;
        else if (k === 'text')  node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== false && v != null) {
            node.setAttribute(k, v);
        }
    }
    for (const child of children) {
        if (child == null) continue;
        node.appendChild(typeof child === 'string'
            ? document.createTextNode(child) : child);
    }
    return node;
}

function renderEmptyState(target) {
    target.replaceChildren(el('div', {
        class: 'models-empty',
        text:  'Loading model lineup…',
    }));
}

function renderError(target, message) {
    target.replaceChildren(
        el('div', { class: 'models-empty' },
            el('div', { text: 'Couldn\'t load model lineup.' }),
            el('div', {
                class: 'models-empty-detail',
                text:  message,
            }),
        ),
    );
}

function renderRow(model) {
    const copy = MODEL_COPY[model.model_id] || {
        icon:  '·',
        label: model.name || model.model_id,
        blurb: model.notes || '',
    };
    const family = FAMILY_LABEL[model.family] || model.family;

    const techDetail = el('div', { class: 'models-row-tech' },
        el('span', { class: 'models-row-family', text: family }),
        model.notes
            ? el('span', { class: 'models-row-notes', text: ' · ' + model.notes })
            : null,
    );

    const row = el('details', { class: 'models-row' },
        el('summary', { class: 'models-row-head' },
            el('span', { class: 'models-row-icon', text: copy.icon }),
            el('span', { class: 'models-row-name', text: copy.label }),
            el('span', { class: 'models-row-id',   text: model.model_id }),
        ),
        el('div', { class: 'models-row-body' },
            el('p',  { class: 'models-row-blurb', text: copy.blurb }),
            techDetail,
        ),
    );
    return row;
}

/**
 * Mount the panel into a target element. Idempotent — repeated calls
 * with the same target are safe and re-use the in-memory cache.
 *
 * @param {HTMLElement} target
 * @returns {Promise<{ refresh: Function }>}
 */
export async function mountModelsPanel(target) {
    if (!target) return { refresh: () => {} };

    renderEmptyState(target);

    async function render() {
        try {
            const body   = await fetchModels();
            const models = (body && Array.isArray(body.models)) ? body.models : [];
            if (models.length === 0) {
                target.replaceChildren(el('div', {
                    class: 'models-empty',
                    text:  'No active forecasters registered.',
                }));
                return;
            }
            const list = el('div', { class: 'models-list' },
                ...models.map(renderRow));
            const footer = el('div', { class: 'models-footer' },
                el('span', { text: `${models.length} active forecasters · ` }),
                el('a', {
                    href:   'https://en.wikipedia.org/wiki/Ensemble_forecasting',
                    target: '_blank',
                    rel:    'noopener',
                    text:   'What is ensemble forecasting?',
                }),
            );
            target.replaceChildren(list, footer);
        } catch (e) {
            renderError(target, String(e?.message || e));
        }
    }

    await render();

    return {
        refresh: () => { _cache = null; return render(); },
    };
}
