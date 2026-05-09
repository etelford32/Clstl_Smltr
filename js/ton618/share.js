// Tier 1C — URL state, screenshot, MP4/WebM record, iframe embed mode.
//
// Encodes the user's slider/toggle settings into window.location.hash so a
// single link round-trips the entire view. Decoding only writes keys that
// differ from defaults, so URLs stay short for typical scenes. Recording
// uses the canvas captureStream + MediaRecorder; PNG screenshots use
// canvas.toBlob. All side-effect-bearing setters are routed through the
// app API (so e.g. setSpin still slides the camera floor with r₊(a)).

// ── Share schema ──────────────────────────────────────────────────────
// Each row: { k: short URL key, p: state path, s: app setter (or null),
//             d: default, t: type ('f'|'i'|'b') }
// Order is irrelevant for correctness; alphabetic by short key for tidy URLs.
const SCHEMA = [
    // Camera
    { k: 'a',  p: 'spin',                s: 'setSpin',          d: 0,                  t: 'f' },
    { k: 'cF', p: 'cam.fovY',            s: null,                d: Math.PI / 3,        t: 'f' },
    { k: 'cP', p: 'cam.pitch',           s: null,                d: 0,                  t: 'f' },
    { k: 'cR', p: 'cam.roll',            s: null,                d: 0,                  t: 'f' },
    { k: 'co', p: 'cam.observerType',    s: null,                d: 0,                  t: 'i' },
    { k: 'cp', p: 'cam.phi',             s: null,                d: 0,                  t: 'f' },
    { k: 'cr', p: 'cam.r',               s: null,                d: 30,                 t: 'f' },
    { k: 'ct', p: 'cam.theta',           s: null,                d: Math.PI / 2 - 0.18, t: 'f' },
    { k: 'cy', p: 'cam.yaw',             s: null,                d: 0,                  t: 'f' },
    // Disk
    { k: 'di', p: 'diskInner',           s: 'setDiskInner',      d: 6.0,                t: 'f' },
    { k: 'do', p: 'diskOuter',           s: 'setDiskOuter',      d: 24.0,               t: 'f' },
    { k: 'dT', p: 'diskTInner',          s: 'setDiskTInner',     d: 12000,              t: 'f' },
    { k: 'dB', p: 'diskBrightness',      s: 'setDiskBrightness', d: 1.0,                t: 'f' },
    { k: 'dh', p: 'diskHOverR',          s: 'setDiskHOverR',     d: 0,                  t: 'f' },
    { k: 'dM', p: 'diskMode',            s: null,                d: 0,                  t: 'i' },
    { k: 'mr', p: 'mriStrength',         s: 'setMriStrength',    d: 0.6,                t: 'f' },
    { k: 'ns', p: 'nHotspots',           s: 'setNHotspots',      d: 1,                  t: 'i' },
    { k: 'hr', p: 'hotspotRadius',       s: 'setHotspotRadius',  d: 6.5,                t: 'f' },
    { k: 'as', p: 'animSpeed',           s: 'setAnimSpeed',      d: 1.0,                t: 'f' },
    { k: 'lr', p: 'lindbladRp',          s: 'setLindbladRp',     d: 12,                 t: 'f' },
    { k: 'wa', p: 'diskWarpAngle',       s: null,                d: 0,                  t: 'f' },
    { k: 'wp', p: 'diskWarpPsi',         s: null,                d: 0,                  t: 'f' },
    // Multi-component radiation
    { k: 'jb', p: 'jetVelocity',         s: 'setJetVelocity',    d: 0.95,               t: 'f' },
    { k: 'ja', p: 'jetAlpha',            s: 'setJetAlpha',       d: 0.7,                t: 'f' },
    { k: 'jo', p: 'jetOpen',             s: null,                d: 0.18,               t: 'f' },
    { k: 'ji', p: 'jetIntensity',        s: 'setJetIntensity',   d: 0.06,               t: 'f' },
    { k: 'cR', p: 'coronaRadius',        s: 'setCoronaRadius',   d: 10,                 t: 'f' },
    { k: 'ci', p: 'coronaIntensity',     s: 'setCoronaIntensity',d: 0.04,               t: 'f' },
    { k: 'wi', p: 'windIntensity',       s: 'setWindIntensity',  d: 0.04,               t: 'f' },
    { k: 'fi', p: 'feIntensity',         s: 'setFeIntensity',    d: 0.6,                t: 'f' },
    { k: 'm',  p: 'mdotRel',             s: 'setMdotRel',        d: 0.10,               t: 'f' },
    // LAB
    { k: 'Li', p: 'labIntensity',        s: 'setLabIntensity',   d: 0.85,               t: 'f' },
    { k: 'Lr', p: 'labRadiusKpc',        s: 'setLabRadiusKpc',   d: 460,                t: 'f' },
    { k: 'Ln', p: 'labInnerKpc',         s: 'setLabInnerKpc',    d: 8,                  t: 'f' },
    { k: 'La', p: 'labAlpha',            s: 'setLabAlpha',       d: 1.8,                t: 'f' },
    { k: 'Lc', p: 'labClump',            s: 'setLabClump',       d: 0.55,               t: 'f' },
    { k: 'Lf', p: 'labFilament',         s: 'setLabFilament',    d: 0.45,               t: 'f' },
    { k: 'Lm', p: 'labMechanism',        s: 'setLabMechanism',   d: 1,                  t: 'i' },
    { k: 'Lz', p: 'labZ',                s: 'setLabZ',           d: 2.219,              t: 'f' },
    { k: 'Lv', p: 'labOutflowKms',       s: 'setLabOutflow',     d: 600,                t: 'f' },
    { k: 'Lb', p: 'labOutflowBeta',      s: 'setLabOutflowBeta', d: 0.5,                t: 'f' },
    { k: 'LN', p: 'labLogNHI',           s: 'setLabLogNHI',      d: 20.5,               t: 'f' },
    { k: 'LT', p: 'labTempK',            s: 'setLabTempK',       d: 1.0e4,              t: 'f' },
    { k: 'Le', p: 'labNeufeld',          s: 'setLabNeufeld',     d: 0.7,                t: 'f' },
    { k: 'Lp', p: 'labPolMax',           s: 'setLabPolMax',      d: 0.12,               t: 'f' },
    // Cinematic (Tier 1A/1B)
    { k: 'bt', p: 'bloomThreshold',      s: 'setBloomThreshold', d: 1.2,                t: 'f' },
    { k: 'bk', p: 'bloomKnee',           s: 'setBloomKnee',      d: 0.6,                t: 'f' },
    { k: 'bs', p: 'bloomStrength',       s: 'setBloomStrength',  d: 1.0,                t: 'f' },
    { k: 'ex', p: 'exposureStops',       s: 'setExposureStops',  d: 0,                  t: 'f' },
    { k: 'ss', p: 'subringStrength',     s: 'setSubringStrength',d: 1.0,                t: 'f' },
    { k: 'sy', p: 'skyStrength',         s: 'setSkyStrength',    d: 1.0,                t: 'f' },
    // Toggles (compact 0/1)
    { k: 'tD', p: 'showDisk',            s: 'toggleDisk',        d: true,               t: 'b' },
    { k: 'tH', p: 'showHotspot',         s: 'toggleHotspot',     d: true,               t: 'b' },
    { k: 'tJ', p: 'showJets',            s: 'toggleJets',        d: true,               t: 'b' },
    { k: 'tC', p: 'showCorona',          s: 'toggleCorona',      d: false,              t: 'b' },
    { k: 'tW', p: 'showWind',            s: 'toggleWind',        d: false,              t: 'b' },
    { k: 'tF', p: 'showFeLine',          s: 'toggleFeLine',      d: false,              t: 'b' },
    { k: 'tA', p: 'animate',             s: 'toggleAnim',        d: true,               t: 'b' },
    { k: 'tL', p: 'showLab',             s: 'toggleLab',         d: false,              t: 'b' },
    { k: 'tP', p: 'showPolVectors',      s: 'togglePolVectors',  d: false,              t: 'b' },
    { k: 'td', p: 'labDoublePeak',       s: 'toggleDoublePeak',  d: true,               t: 'b' },
    { k: 'tR', p: 'showSubrings',        s: 'toggleSubrings',    d: true,               t: 'b' },
    { k: 'tB', p: 'bloomEnabled',        s: 'toggleBloom',       d: true,               t: 'b' },
    { k: 'tw', p: 'diskWarpOn',          s: 'toggleWarp',        d: false,              t: 'b' },
    { k: 'tl', p: 'showLindblad',        s: 'toggleLindblad',    d: false,              t: 'b' },
    { k: 'tg', p: 'showGrid',            s: 'toggleGrid',        d: false,              t: 'b' },
    { k: 'tp', p: 'showPhotonSphere',    s: 'togglePhotonSphere',d: false,              t: 'b' },
];

function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setPath(obj, path, val) {
    const parts = path.split('.');
    const last = parts.pop();
    const tgt = parts.reduce((o, k) => o[k], obj);
    if (tgt) tgt[last] = val;
}

function nearlyEqual(a, b, t) {
    if (t === 'f') return Math.abs(a - b) < 1e-4 * Math.max(1, Math.abs(b));
    return a === b;
}

function fmt(v, t) {
    if (t === 'b') return v ? '1' : '0';
    if (t === 'i') return String(v | 0);
    return Number(v).toPrecision(4).replace(/\.?0+$/, '').replace(/\.?0+e/, 'e');
}

function parse(raw, t) {
    if (t === 'b') return raw === '1' || raw === 'true';
    if (t === 'i') return Math.round(Number(raw));
    return Number(raw);
}

// ── Encode current state to a hash string (without #) ─────────────────
export function encodeState(state) {
    const out = [];
    for (const e of SCHEMA) {
        const v = getPath(state, e.p);
        if (v == null) continue;
        if (nearlyEqual(v, e.d, e.t)) continue;
        out.push(`${e.k}=${fmt(v, e.t)}`);
    }
    return out.join('&');
}

// ── Apply a hash string to the app (using setters where available) ────
export function applyHash(app, hash) {
    if (!hash) return;
    const trimmed = hash.startsWith('#') ? hash.slice(1) : hash;
    if (!trimmed) return;
    const params = new URLSearchParams(trimmed);
    for (const e of SCHEMA) {
        if (!params.has(e.k)) continue;
        const raw = params.get(e.k);
        const v = parse(raw, e.t);
        if (e.s && typeof app[e.s] === 'function') {
            // Use the setter; for booleans, only call toggle if state would change.
            if (e.t === 'b') {
                const cur = getPath(app.state, e.p);
                if (Boolean(cur) !== Boolean(v)) app[e.s]();
            } else {
                app[e.s](v);
            }
        } else {
            setPath(app.state, e.p, v);
        }
    }
    app.forceRender?.();
}

// ── Debounced sync of state → window.location.hash ────────────────────
export function installAutoSync(state, intervalMs = 750) {
    let pending = null;
    let last = '';
    const tick = () => {
        const h = encodeState(state);
        if (h !== last) {
            last = h;
            // Use replaceState so we don't pollute browser history.
            const url = new URL(window.location.href);
            url.hash = h;
            window.history.replaceState(null, '', url.toString());
        }
        pending = null;
    };
    const schedule = () => { if (pending == null) pending = setTimeout(tick, intervalMs); };
    return setInterval(schedule, intervalMs);
}

// ── Copy current shareable URL to clipboard ───────────────────────────
export async function copyShareLink(state) {
    const url = new URL(window.location.href);
    url.hash = encodeState(state);
    const s = url.toString();
    try {
        await navigator.clipboard.writeText(s);
        return { ok: true, url: s };
    } catch (e) {
        return { ok: false, url: s, error: e };
    }
}

// ── Screenshot: download canvas as PNG ────────────────────────────────
export function downloadScreenshot(canvas, prefix = 'ton618') {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${prefix}-${ts}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }, 'image/png');
}

// ── Video record: canvas captureStream → WebM/MP4 download ────────────
// Tries MP4 (Safari 14+, Chrome via WebCodecs) then falls back to WebM
// VP9 / VP8 — every modern browser supports at least one of these.
export function createRecorder(canvas, opts = {}) {
    const targetFps = opts.fps ?? 30;
    const candidates = [
        'video/mp4;codecs=avc1.42E01E',           // H.264 baseline (Safari + recent Chrome)
        'video/webm;codecs=vp9,opus',             // VP9 fallback
        'video/webm;codecs=vp8,opus',             // VP8 fallback
        'video/webm',                             // last-resort
    ];
    let mimeType = candidates.find((c) => MediaRecorder?.isTypeSupported?.(c));
    let recorder = null;
    let chunks = [];
    let state = 'idle';
    let startedAt = 0;

    function start() {
        if (state !== 'idle') return false;
        if (!mimeType) throw new Error('No supported MediaRecorder mimeType');
        const stream = canvas.captureStream(targetFps);
        recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
        chunks = [];
        recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
            const blob = new Blob(chunks, { type: mimeType });
            const ext = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = `ton618-${ts}.${ext}`;
            document.body.appendChild(a); a.click(); a.remove();
            URL.revokeObjectURL(url);
            chunks = []; state = 'idle';
        };
        recorder.start(250);
        state = 'recording';
        startedAt = performance.now();
        return true;
    }
    function stop() {
        if (state !== 'recording' || !recorder) return false;
        recorder.stop();
        state = 'stopping';
        return true;
    }
    function isRecording() { return state === 'recording'; }
    function elapsedSec() { return state === 'recording' ? (performance.now() - startedAt) / 1000 : 0; }
    function format() { return mimeType?.split(';')[0].split('/')[1] ?? '?'; }
    return { start, stop, isRecording, elapsedSec, format };
}

// ── Iframe-embed mode (?embed=1) ──────────────────────────────────────
export function isEmbedMode() {
    return new URLSearchParams(window.location.search).get('embed') === '1';
}
export function applyEmbedMode() {
    if (!isEmbedMode()) return false;
    document.body.classList.add('ton618-embed');
    return true;
}
