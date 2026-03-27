/**
 * extended-feeds.js — re-export barrel (deprecated)
 *
 * This file now re-exports from the three independent modules.
 * Import directly from the source modules instead:
 *
 *   import { SohoFeed, SOHO_IMAGES, STEREO_IMAGES } from './soho-feed.js';
 *   import { HorizonsFeed, HORIZONS_BODIES }         from './horizons-extended.js';
 *   import { NeoFeed }                               from './neo-feed.js';
 */

export { SohoFeed, SOHO_IMAGES, STEREO_IMAGES } from './soho-feed.js';
export { HorizonsFeed, HORIZONS_BODIES }         from './horizons-extended.js';
export { NeoFeed }                               from './neo-feed.js';
