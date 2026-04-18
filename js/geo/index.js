/**
 * js/geo — barrel file. Import from here, not the individual modules.
 *
 *   import { geo, GeoCoords, GEO_GLSL, DEG, RAD } from './geo/index.js';
 */
export { GeoCoords, geo, DEG, RAD, TAU,
         EARTH_RADIUS_KM, AXIAL_TILT_RAD, SIDEREAL_DAY_SEC,
         GEOMAG_NORTH_LAT_2025, GEOMAG_NORTH_LON_2025 } from './coords.js';
export { default as geoDefault } from './coords.js';
export { GEO_GLSL } from './coords.glsl.js';
