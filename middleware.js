/**
 * middleware.js — Vercel Edge Middleware: homepage A/B split.
 *
 * Owns the `home_redesign` experiment's traffic split. For requests to `/`
 * it picks an arm 50/50, pins the choice in the `pp_home_v` cookie so a
 * visitor stays sticky, and internally rewrites to the variant's HTML
 * (the address bar stays `/`):
 *
 *     control  → pp_home_v=index  → index.html      (legacy homepage)
 *     redesign → pp_home_v=v2     → home-v2.html    (new homepage)
 *
 * The cookie is intentionally NOT HttpOnly: js/experiments.js reads it for
 * the `home_redesign` experiment so the variant it records always matches
 * the page that was actually served. QA deep links keep working — a
 * `?exp_home_redesign=` query (control|redesign or index|v2) forces the
 * arm and re-pins the cookie, mirroring experiments.js's `?exp_` overrides.
 *
 * When the test concludes, flip the default arm here (or pin everyone to
 * `v2`) to make home-v2 the canonical homepage.
 */

import { next, rewrite } from '@vercel/edge';

export const config = { matcher: '/' };

const COOKIE = 'pp_home_v';
const ONE_YEAR = 60 * 60 * 24 * 365;

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

// Accepts experiments.js variant ids (control|redesign) and the raw cookie
// values (index|v2). Returns the canonical cookie value or null.
function normalizeArm(v) {
  if (v === 'index' || v === 'control') return 'index';
  if (v === 'v2' || v === 'redesign') return 'v2';
  return null;
}

function cookieHeader(value) {
  return `${COOKIE}=${value}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax; Secure`;
}

export default function middleware(req) {
  const url = new URL(req.url);

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
    arm = crypto.getRandomValues(new Uint8Array(1))[0] < 128 ? 'index' : 'v2';
    pin = true;                       // first visit — assign + pin
  }

  const headers = pin ? { 'set-cookie': cookieHeader(arm) } : undefined;

  return arm === 'v2'
    ? rewrite(new URL('/home-v2.html', req.url), headers ? { headers } : undefined)
    : next(headers ? { headers } : undefined);
}
