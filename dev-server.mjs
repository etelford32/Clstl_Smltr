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
import { readFile, stat }       from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const ROOT = fileURLToPath(new URL('.', import.meta.url));

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

async function handleApi(pathname, rawUrl, nodeRes) {
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

        // Build a Web API Request object (Node 18+ has this built-in)
        const fullUrl = `http://localhost:${PORT}${rawUrl}`;
        const request = new Request(fullUrl);

        const response = await handler(request);

        // Relay headers and body to the Node IncomingMessage response
        const ct    = response.headers.get('Content-Type') ?? 'application/json';
        const cc    = response.headers.get('Cache-Control') ?? 'no-cache';
        const body  = await response.text();

        nodeRes.writeHead(response.status, {
            'Content-Type':               ct,
            'Cache-Control':              cc,
            'Access-Control-Allow-Origin': '*',
        });
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
        nodeRes.writeHead(200, { 'Content-Type': mime });
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

        // OPTIONS pre-flight (CORS)
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin':  '*',
                'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
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
                await handleApi(apiPath, req.url, res);
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
