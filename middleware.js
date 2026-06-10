/**
 * middleware.js — Vercel Edge Middleware.
 *
 * Two responsibilities, in order:
 *
 *  1. Canonical host. This middleware is the SINGLE owner of the
 *     www → apex redirect for the entire site. The equivalent rule was
 *     removed from vercel.json so there is exactly one source of truth —
 *     two overlapping redirects previously fought and broke the homepage.
 *     It runs on every path (see `config.matcher`), so the document AND
 *     all of its relative-URL assets resolve to the same origin; ES module
 *     loads are never split cross-origin.
 *
 *  2. Homepage A/B split (only for `/`). Picks the `home_redesign` arm
 *     evenly across three arms, pins it in the `pp_home_v` cookie so a
 *     visitor stays sticky, and internally rewrites to the variant's HTML
 *     (address bar stays `/`):
 *
 *         control  → pp_home_v=index  → index.html     (legacy homepage)
 *         redesign → pp_home_v=v2     → home-v2.html   (operator-first)
 *         signup   → pp_home_v=v3     → home-v3.html   (signup-first)
 *
 * The cookie is intentionally NOT HttpOnly: js/experiments.js reads it for
 * the `home_redesign` experiment so the variant it records always matches
 * the page that was actually served. QA deep links keep working — a
 * `?exp_home_redesign=` query (control|redesign|signup or index|v2|v3)
 * forces the arm and re-pins the cookie, mirroring experiments.js's
 * `?exp_` overrides.
 *
 * Visitors already pinned to `index` or `v2` keep their arm (sticky
 * cookie); only NEW visitors enter the three-way split, so adding the v3
 * arm does not reshuffle anyone mid-test.
 *
 * When the test concludes, pin everyone to the winning arm here.
 */

import { next, rewrite } from '@vercel/edge';

// Run on every path. The host canonicalization must cover assets too, not
// just the document — otherwise a www visitor gets the page on one origin
// while its modules 307 to the other (cross-origin, blocks ES modules).
export const config = { matcher: '/(.*)' };

const COOKIE = 'pp_home_v';
const ONE_YEAR = 60 * 60 * 24 * 365;
const WWW_HOST = 'www.parkersphysics.com';
const APEX_HOST = 'parkersphysics.com';

function readCookie(req, name) {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Accepts experiments.js variant ids (control|redesign|signup) and the raw
// cookie values (index|v2|v3). Returns the canonical cookie value or null.
function normalizeArm(v) {
  if (v === 'index' || v === 'control') return 'index';
  if (v === 'v2' || v === 'redesign') return 'v2';
  if (v === 'v3' || v === 'signup') return 'v3';
  return null;
}

function cookieHeader(value) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax; Secure`;
}

export default function middleware(req) {
  const url = new URL(req.url);

  // 1. Sole www → apex canonicalization, for every path. Detect via the
  //    Host header (reliable); build Location from path+query only —
  //    req.url's host/proto are not dependable in the edge runtime, so we
  //    never echo them back into Location (that was the loop/break risk).
  const host = (req.headers.get('host') || url.hostname || '').toLowerCase();
  if (host === WWW_HOST) {
    return new Response(null, {
      status: 308,
      headers: { Location: `https://${APEX_HOST}${url.pathname}${url.search}` },
    });
  }

  // 2. A/B split is homepage-only. Every other path passes straight
  //    through (middleware still ran — just to enforce the host rule).
  if (url.pathname !== '/') return next();

  const forced = normalizeArm(url.searchParams.get('exp_home_redesign'));
  const existing = normalizeArm(readCookie(req, COOKIE));

  let arm;
  let pin;
  if (forced) {
    arm = forced;
    pin = true;                       // QA deep link — re-pin so it sticks
  } else if (existing) {
    arm = existing;
    pin = false;                      // returning visitor — already sticky
  } else {
    // Even three-way split. 256 doesn't divide by 3 — the ≤0.4% remainder
    // bias toward `index` is noise relative to any lift worth shipping.
    const roll = crypto.getRandomValues(new Uint8Array(1))[0];
    arm = roll < 85 ? 'index' : roll < 170 ? 'v2' : 'v3';
    pin = true;                       // first visit — assign + pin
  }

  const headers = pin ? { 'set-cookie': cookieHeader(arm) } : undefined;

  if (arm === 'v2' || arm === 'v3') {
    return rewrite(new URL(`/home-${arm}.html`, req.url), headers ? { headers } : undefined);
  }
  return next(headers ? { headers } : undefined);
}
