/**
 * debris-feed.js — Space debris metadata enrichment pipeline
 * ═══════════════════════════════════════════════════════════════════════
 * Fetches satellite/debris metadata from Space-Track.org via proxy
 * to enrich CelesTrak TLE data with:
 *   - Object type (PAYLOAD, ROCKET BODY, DEBRIS, UNKNOWN)
 *   - Owner country code
 *   - RCS size (SMALL, MEDIUM, LARGE)
 *   - Launch date
 *   - Decay date (if re-entered)
 *
 * This data is used by the satellite ECS to color-code and filter
 * objects by type, and to distinguish active payloads from debris.
 *
 * Fires: CustomEvent 'debris-metadata-update' on document
 *   detail: { metadata: Map<noradId, MetadataObj>, stats }
 *
 * Usage:
 *   const debris = new DebrisFeed();
 *   const meta = await debris.fetchGroup('starlink');
 *   // meta is a Map<noradId, { object_type, country, rcs_size, ... }>
 */

const ST_ENDPOINT = '/api/spacetrack/metadata';
const CACHE_MS    = 6 * 60 * 60 * 1000;  // 6 hours (matches proxy cache)

export class DebrisFeed {
    constructor() {
        /** @type {Map<number, object>} NORAD ID → metadata */
        this._metadata = new Map();
        this._lastFetch = new Map();  // group → timestamp
    }

    get metadata() { return this._metadata; }

    /**
     * Fetch metadata for a satellite group.
     * Returns a Map<noradId, metadata> merged into the global cache.
     */
    async fetchGroup(group, limit = 500) {
        // Skip if recently fetched
        const lastTime = this._lastFetch.get(group) ?? 0;
        if (Date.now() - lastTime < CACHE_MS) return this._metadata;

        try {
            const res = await fetch(
                `${ST_ENDPOINT}?group=${group}&limit=${limit}`,
                { signal: AbortSignal.timeout(20000) }
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            if (data.error) {
                console.warn('[DebrisFeed] Space-Track error:', data.detail);
                return this._metadata;
            }

            // Merge into global cache
            for (const sat of (data.satellites ?? [])) {
                this._metadata.set(sat.norad_id, {
                    name:        sat.name,
                    object_type: sat.object_type,
                    country:     sat.country,
                    rcs_size:    sat.rcs_size,
                    launch_date: sat.launch_date,
                    decay_date:  sat.decay_date,
                });
            }

            this._lastFetch.set(group, Date.now());
            this._dispatch(data.satellites ?? []);
            return this._metadata;
        } catch (err) {
            console.warn(`[DebrisFeed] Fetch failed for ${group}:`, err.message);
            return this._metadata;
        }
    }

    /**
     * Fetch metadata for a specific NORAD ID.
     */
    async fetchNorad(noradId) {
        if (this._metadata.has(noradId)) return this._metadata.get(noradId);

        try {
            const res = await fetch(
                `${ST_ENDPOINT}?norad=${noradId}`,
                { signal: AbortSignal.timeout(10000) }
            );
            if (!res.ok) return null;
            const data = await res.json();
            const sat = data.satellites?.[0];
            if (!sat) return null;

            const meta = {
                name:        sat.name,
                object_type: sat.object_type,
                country:     sat.country,
                rcs_size:    sat.rcs_size,
                launch_date: sat.launch_date,
                decay_date:  sat.decay_date,
            };
            this._metadata.set(sat.norad_id, meta);
            return meta;
        } catch {
            return null;
        }
    }

    /**
     * Get metadata for a NORAD ID (from cache only, no fetch).
     */
    get(noradId) {
        return this._metadata.get(noradId) ?? null;
    }

    /**
     * Get debris statistics from cached metadata.
     */
    get stats() {
        let payloads = 0, rocketBodies = 0, debris = 0, unknown = 0;
        const countries = new Set();

        for (const [, m] of this._metadata) {
            switch (m.object_type) {
                case 'PAYLOAD':     payloads++; break;
                case 'ROCKET BODY': rocketBodies++; break;
                case 'DEBRIS':      debris++; break;
                default:            unknown++; break;
            }
            if (m.country) countries.add(m.country);
        }

        return { payloads, rocketBodies, debris, unknown, countries: countries.size, total: this._metadata.size };
    }

    _dispatch(satellites) {
        document.dispatchEvent(new CustomEvent('debris-metadata-update', {
            detail: { metadata: this._metadata, stats: this.stats, count: satellites.length },
        }));
    }
}

/**
 * Object type → visual color for satellite markers.
 */
export function debrisTypeColor(objectType) {
    switch (objectType) {
        case 'PAYLOAD':     return 0x00ffcc;  // active payload = cyan-green
        case 'ROCKET BODY': return 0xff8844;  // spent rocket = orange
        case 'DEBRIS':      return 0xff3333;  // debris = red
        default:            return 0x888888;  // unknown = grey
    }
}

/**
 * RCS size → marker size multiplier.
 */
export function rcsSizeMultiplier(rcsSize) {
    switch (rcsSize) {
        case 'LARGE':  return 1.5;
        case 'MEDIUM': return 1.0;
        case 'SMALL':  return 0.6;
        default:       return 0.8;
    }
}

/**
 * Country code → flag emoji (subset of common space-faring nations).
 */
export function countryFlag(code) {
    const flags = {
        US: '🇺🇸', CIS: '🇷🇺', PRC: '🇨🇳', JPN: '🇯🇵', ESA: '🇪🇺',
        IND: '🇮🇳', FR: '🇫🇷', UK: '🇬🇧', GER: '🇩🇪', IT: '🇮🇹',
        CA: '🇨🇦', KOR: '🇰🇷', ISR: '🇮🇱', BRAZ: '🇧🇷', AU: '🇦🇺',
    };
    return flags[code] || '🏳️';
}
