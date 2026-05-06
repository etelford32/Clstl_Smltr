#!/usr/bin/env node
/**
 * dev-server.mjs — Local development server for Clstl_Smltr
 *
 * Serves static files AND runs the Vercel Edge Functions locally by dynamically
 * importing them.  Node.js 18+ ships `fetch`, `Request`, `Response` as globals,
 * so the edge-function files work without modification.
 *
 * Usage:
 *   node dev-server.mjs          # port 3000
 *   PORT=8080 node dev-server.mjs
 *
 * Set NASA_API_KEY env var to use your key (falls back to DEMO_KEY).
 *   NASA_API_KEY=your_key node dev-server.mjs
 */

import { createServer }         from 'node:http';
import { readFileSync }         from 'node:fs';
import { readFile, stat }       from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const ROOT = fileURLToPath(new URL('.', import.meta.url));

// ── .env.local loader (tiny shim, no dotenv dependency) ──────────────────────
// Lets the smoke-test runbook be a single command instead of a paragraph of
// `export FOO=...`. Reads .env.local from the project root if present;
// existing process.env values win (so CI/explicit overrides aren't clobbered).
try {
    const envPath = join(ROOT, '.env.local');
    const raw = readFileSync(envPath, 'utf8');
    let count = 0;
    for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const key = t.slice(0, eq).trim();
        let val   = t.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[key] === undefined) {
            process.env[key] = val;
            count++;
        }
    }
    if (count) console.log(`[dev-server] loaded ${count} vars from .env.local`);
} catch (_) { /* no .env.local — fine */ }

// ── MIME types ────────────────────────────────────────────────────────────────
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.wasm': 'application/wasm',
    '.ttf':  'font/ttf',
    '.woff': 'font/woff',
    '.woff2':'font/woff2',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt':  'text/plain; charset=utf-8',
    '.md':   'text/markdown; charset=utf-8',
};

// ── API route → edge function file (relative to project root) ─────────────────
// Vercel auto-routes /api/**.js via file-based convention in production; this
// table mirrors that for local dev. Keep it in sync when adding endpoints —
// a missing entry here is the main reason a route 404s locally but works in
// prod, which makes smoke-testing harder than it needs to be.
const API_ROUTES = {
    '/api/solar-wind/wind-speed':  'api/solar-wind/wind-speed.js',
    '/api/solar-wind/latest':      'api/solar-wind/latest.js',
    '/api/solar-wind/ingest':      'api/solar-wind/ingest.js',
    '/api/noaa/kp-1m':             'api/noaa/kp-1m.js',
    '/api/noaa/xray':              'api/noaa/xray.js',
    '/api/noaa/protons':           'api/noaa/protons.js',
    '/api/noaa/electrons':         'api/noaa/electrons.js',
    '/api/noaa/aurora':            'api/noaa/aurora.js',
    '/api/noaa/alerts':            'api/noaa/alerts.js',
    '/api/noaa/dst':               'api/noaa/dst.js',
    '/api/noaa/flares':            'api/noaa/flares.js',
    '/api/noaa/regions':           'api/noaa/regions.js',
    '/api/noaa/radio-flux':        'api/noaa/radio-flux.js',
    '/api/noaa/forecast-3day':     'api/noaa/forecast-3day.js',
    '/api/donki/cme':              'api/donki/cme.js',
    '/api/donki/flares':           'api/donki/flares.js',
    '/api/donki/gst':              'api/donki/gst.js',
    '/api/donki/sep':              'api/donki/sep.js',
    '/api/donki/notifications':    'api/donki/notifications.js',
    '/api/launches/upcoming':      'api/launches/upcoming.js',
    '/api/weather/grid':           'api/weather/grid.js',
    '/api/weather/forecast':       'api/weather/forecast.js',
    '/api/lightning/strikes':      'api/lightning/strikes.js',
    '/api/nws/convective':         'api/nws/convective.js',
    '/api/storms':                 'api/storms.js',

    // ── Auth / billing / invites / class / contact ────────────────────────
    // These are the user-facing edge functions (not data-pipeline). Vercel's
    // file-based routing handles them in prod; the dev server needs explicit
    // entries here for local smoke tests of the signup → checkout → roster
    // → student-invite flow to reach the handlers instead of 404'ing.
    '/api/stripe/checkout':        'api/stripe/checkout.js',
    '/api/stripe/portal':          'api/stripe/portal.js',
    '/api/stripe/webhook':         'api/stripe/webhook.js',
    '/api/invites/send':           'api/invites/send.js',
    '/api/class/invite':           'api/class/invite.js',
    '/api/class/roster':           'api/class/roster.js',
    '/api/contact/enterprise':     'api/contact/enterprise.js',
    '/api/contact/feedback':       'api/contact/feedback.js',
};

// Cache imported edge-function modules (stateless, so caching is safe)
const _moduleCache = new Map();

async function loadEdgeFn(relPath) {
    if (_moduleCache.has(relPath)) return _moduleCache.get(relPath);
    const absUrl = pathToFileURL(join(ROOT, relPath)).href;
    const mod    = await import(absUrl);
    _moduleCache.set(relPath, mod);
    return mod;
}

// ── Horizons proxy (pass-through; Node.js has no CORS restriction) ────────────

async function handleHorizons(rawUrl, nodeRes) {
    const incoming    = new URL(rawUrl, `http://localhost:${PORT}`);
    const upstreamURL = `https://ssd.jpl.nasa.gov/api/horizons.api?${incoming.searchParams}`;
    try {
        const up   = await fetch(upstreamURL, { headers: { Accept: 'application/json' } });
        const body = await up.text();
        nodeRes.writeHead(up.status, {
            'Content-Type':               up.headers.get('Content-Type') ?? 'application/json',
            'Cache-Control':              'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
        });
        nodeRes.end(body);
    } catch (err) {
        nodeRes.writeHead(503, { 'Content-Type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'upstream_unavailable', detail: err.message }));
    }
}

// ── Handle an /api/* request ──────────────────────────────────────────────────

async function handleApi(pathname, rawUrl, nodeRes, nodeReq) {
    const fnPath = API_ROUTES[pathname];
    if (!fnPath) {
        nodeRes.writeHead(404, { 'Content-Type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'not_found', path: pathname }));
        return;
    }

    try {
        const mod     = await loadEdgeFn(fnPath);
        const handler = mod.default;
        if (typeof handler !== 'function') throw new Error('Edge function has no default export');

        // Build a Web API Request that mirrors the inbound Node request:
        // method, headers, AND body. The original implementation only
        // passed the URL — fine for GETs to data-pipeline endpoints but
        // breaks POST / DELETE flows (every auth/billing/class endpoint).
        const fullUrl = `http://localhost:${PORT}${rawUrl}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(nodeReq.headers)) {
            if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
            else if (v != null)   headers.set(k, v);
        }
        // Strip hop-by-hop headers that Fetch refuses.
        ['host', 'connection', 'transfer-encoding'].forEach(h => headers.delete(h));

        const method = (nodeReq.method || 'GET').toUpperCase();
        const init   = { method, headers };
        if (method !== 'GET' && method !== 'HEAD') {
            // Read the request body off the IncomingMessage stream.
            init.body = await new Promise((resolve, reject) => {
                const chunks = [];
                nodeReq.on('data',  c => chunks.push(c));
                nodeReq.on('end',   () => resolve(Buffer.concat(chunks)));
                nodeReq.on('error', reject);
            });
            // duplex required for Node fetch with a body.
            init.duplex = 'half';
        }

        const request  = new Request(fullUrl, init);
        const response = await handler(request);

        // Relay status, headers, and body back to the Node response.
        const outHeaders = {};
        response.headers.forEach((v, k) => { outHeaders[k] = v; });
        outHeaders['Access-Control-Allow-Origin']  = outHeaders['Access-Control-Allow-Origin']  ?? '*';
        outHeaders['Access-Control-Allow-Methods'] = outHeaders['Access-Control-Allow-Methods'] ?? 'GET,POST,DELETE,OPTIONS';
        outHeaders['Access-Control-Allow-Headers'] = outHeaders['Access-Control-Allow-Headers'] ?? 'Authorization,Content-Type';
        nodeRes.writeHead(response.status, outHeaders);
        const body = Buffer.from(await response.arrayBuffer());
        nodeRes.end(body);

    } catch (err) {
        console.error(`[dev-server] API error ${pathname}:`, err.message);
        nodeRes.writeHead(500, { 'Content-Type': 'application/json' });
        nodeRes.end(JSON.stringify({ error: 'handler_error', detail: err.message, path: pathname }));
    }
}

// ── Handle static file requests ───────────────────────────────────────────────

async function handleStatic(pathname, nodeRes) {
    // Safety: prevent directory traversal
    const safePath = resolve(ROOT, '.' + pathname);
    if (!safePath.startsWith(ROOT)) {
        nodeRes.writeHead(403);
        nodeRes.end('Forbidden');
        return;
    }

    let filePath = safePath;
    try {
        const s = await stat(filePath);
        if (s.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
        // stat failed — file doesn't exist (404 sent below)
    }

    try {
        const buf  = await readFile(filePath);
        const ext  = extname(filePath).toLowerCase();
        const mime = MIME[ext] ?? 'application/octet-stream';
        const headers = { 'Content-Type': mime };
        // COOP/COEP for the predictions console: lets the page allocate
        // SharedArrayBuffer (crossOriginIsolated === true) so the
        // satellite tracker's propagation worker can write directly
        // into the GPU-bound position attribute. `credentialless` is
        // the cross-origin-tolerant variant — strips credentials on
        // cross-origin fetches (jsdelivr / unpkg textures don't need
        // them) instead of demanding a CORP header from every CDN.
        // Mirrors the corresponding `headers` block in vercel.json.
        if (pathname === '/operations.html') {
            headers['Cross-Origin-Opener-Policy']   = 'same-origin';
            headers['Cross-Origin-Embedder-Policy'] = 'credentialless';
        }
        nodeRes.writeHead(200, headers);
        nodeRes.end(buf);
    } catch {
        nodeRes.writeHead(404, { 'Content-Type': 'text/plain' });
        nodeRes.end(`404 Not Found: ${pathname}`);
    }
}

// ── Main server ───────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
    try {
        const { pathname } = new URL(req.url, `http://localhost:${PORT}`);

        // OPTIONS pre-flight (CORS) — must echo all the methods the
        // edge functions accept, otherwise the browser blocks POST /
        // DELETE before the handler even runs.
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'GET,HEAD,POST,DELETE,OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            });
            res.end();
            return;
        }

        if (pathname.startsWith('/api/') || pathname.startsWith('/v1/')) {
            // /v1/* → rewrite to /api/* (mirrors vercel.json rewrites)
            const apiPath = pathname.startsWith('/v1/')
                ? pathname.replace('/v1/', '/api/')
                : pathname;
            // Special case: Horizons is a plain proxy (not an edge fn module)
            if (apiPath === '/api/horizons') {
                await handleHorizons(req.url, res);
            } else {
                await handleApi(apiPath, req.url, res, req);
            }
        } else {
            await handleStatic(pathname, res);
        }
    } catch (err) {
        console.error('[dev-server] Unhandled error:', err);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

server.listen(PORT, () => {
    console.log('');
    console.log('  Clstl_Smltr dev server');
    console.log(`  → http://localhost:${PORT}`);
    console.log(`  → http://localhost:${PORT}/space-weather.html`);
    console.log('');
    console.log('  API routes served via local edge functions (NOAA upstream)');
    if (!process.env.NASA_API_KEY) {
        console.log('  ⚠  NASA_API_KEY not set — DONKI endpoints use DEMO_KEY (rate-limited)');
        console.log('     Set it: NASA_API_KEY=your_key node dev-server.mjs');
    }
    console.log('');
});

server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
        console.error(`  ✗ Port ${PORT} in use. Try: PORT=3001 node dev-server.mjs`);
    } else {
        console.error('  ✗ Server error:', err.message);
    }
    process.exit(1);
});
