/**
 * js/farside/index.js — Far-Side Watch public surface.
 *
 * The whole far-side layer is modular by design so it can be dropped into the
 * Space-Weather dashboard and the Solar Physics Engine later without copy-paste.
 * Import from here:
 *
 *   import { getLatestMap, farSideWatchList, renderFlatMap } from './farside/index.js';
 *
 * Nothing in this package touches the DOM at import time or depends on the
 * site-wide feed loop — it is pure data + draw helpers plus the edge-proxy feed.
 */

export * from './carrington.js';
export * from './farside-config.js';
export * from './farside-feed.js';
export * from './farside-detect.js';
export * from './farside-track.js';
export * from './farside-alerts.js';
export * from './farside-render.js';
export * from './farside-validate.js';
