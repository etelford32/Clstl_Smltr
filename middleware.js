/**
 * middleware.js — Vercel Edge Middleware.
 *
 * One responsibility:
 *
 *  1. Canonical host. This middleware is the SINGLE owner of the
 *     www → apex redirect for the entire site. The equivalent rule was
 *     removed from vercel.json so there is exactly one source of truth —
 *     two overlapping redirects previously fought and broke the homepage.
 *     It runs on every path (see `config.matcher`), so the document AND
 *     all of its relative-URL assets resolve to the same origin; ES module
 *     loads are never split cross-origin.
 *
 * Homepage A/B split — CONCLUDED 2026-07. The `home_redesign` experiment
 * shipped its winner directly as index.html ("one engine, widening
 * apertures" redesign), so `/` always serves index.html and the 50/50
 * rewrite to home-v2.html was removed. home-v2.html remains on disk but is
 * no longer routed from `/`. Stale `pp_home_v` cookies are inert — nothing
 * reads them anymore (js/experiments.js `home_redesign` is paused and no
 * page calls assign('home_redesign')). Do not reintroduce a page-level
 * assign for it: the cookie mapping would record exposures against a page
 * that no longer varies.
 */

import { next } from '@vercel/edge';

// Run on every path. The host canonicalization must cover assets too, not
// just the document — otherwise a www visitor gets the page on one origin
// while its modules 307 to the other (cross-origin, blocks ES modules).
export const config = { matcher: '/(.*)' };

const WWW_HOST = 'www.parkersphysics.com';
const APEX_HOST = 'parkersphysics.com';

export default function middleware(req) {
  const url = new URL(req.url);

  // Sole www → apex canonicalization, for every path. Detect via the
  // Host header (reliable); build Location from path+query only —
  // req.url's host/proto are not dependable in the edge runtime, so we
  // never echo them back into Location (that was the loop/break risk).
  const host = (req.headers.get('host') || url.hostname || '').toLowerCase();
  if (host === WWW_HOST) {
    return new Response(null, {
      status: 308,
      headers: { Location: `https://${APEX_HOST}${url.pathname}${url.search}` },
    });
  }

  return next();
}
