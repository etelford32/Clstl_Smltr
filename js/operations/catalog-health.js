/**
 * Catalogue Coverage Health
 *
 * Turns normalized GP records plus per-group ingestion metadata into an
 * operator-facing readiness summary. "Coverage" is deliberately scoped to
 * selected CelesTrak layers: it is not a claim of full public-catalogue or
 * sensor-network completeness.
 */

import { provStore } from './provenance.js';

const DAY_MS = 86400000;

function finite(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function round(value, places = 2) {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

function median(sorted) {
    if (!sorted.length) return null;
    const i = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

/** Pure health calculation, exported for validation and downstream APIs. */
export function buildCatalogHealth({
    records = [],
    groups = [],
    capacity = 50000,
    activeLayerCount = groups.length,
    nowMs = Date.now(),
} = {}) {
    const unique = new Map();
    for (const record of records) {
        const id = finite(record?.norad_id);
        if (Number.isInteger(id) && id > 0 && !unique.has(id)) unique.set(id, record);
    }
    const catalog = [...unique.values()];
    const ages = [];
    const formats = new Map();
    let sixPlusDigitCount = 0;
    let maxCatalogId = null;

    for (const record of catalog) {
        const id = Number(record.norad_id);
        if (id >= 100000) sixPlusDigitCount++;
        maxCatalogId = maxCatalogId == null ? id : Math.max(maxCatalogId, id);
        const format = String(record.source_format || (record.line1 ? 'tle' : 'unknown'));
        formats.set(format, (formats.get(format) || 0) + 1);
        const epochMs = finite(record.epoch_ms) ?? Date.parse(record.epoch);
        if (Number.isFinite(epochMs)) ages.push(Math.max(0, (nowMs - epochMs) / DAY_MS));
    }
    ages.sort((a, b) => a - b);

    const freshUnder24h = ages.filter(age => age < 1).length;
    const aging1To3d = ages.filter(age => age >= 1 && age <= 3).length;
    const staleOver3d = ages.filter(age => age > 3).length;
    const missingEpoch = catalog.length - ages.length;
    const loadingGroups = groups.filter(group => group.status === 'loading').length;
    const failedGroups = groups.filter(group => group.status === 'error').length;
    const partialGroups = groups.filter(group => group.status === 'partial').length;
    const rejectedCount = groups.reduce((sum, group) => sum + Math.max(0, finite(group.rejectedCount) ?? 0), 0);
    const subgroupFailures = groups.reduce((sum, group) => sum + Math.max(0, finite(group.subgroupFailures) ?? 0), 0);
    const fetchedTimes = groups
        .map(group => Date.parse(group.fetched))
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
    const capacityUsedPct = capacity > 0 ? catalog.length / capacity * 100 : null;

    let state = 'healthy';
    let reason = 'Selected layers loaded with fresh mean elements.';
    if (loadingGroups > 0 && catalog.length === 0) {
        state = 'loading';
        reason = 'Waiting for selected catalogue layers.';
    } else if (failedGroups > 0 && failedGroups === groups.length && groups.length > 0) {
        state = 'failed';
        reason = 'Every selected catalogue layer failed to load.';
    } else if (failedGroups > 0 || partialGroups > 0 || rejectedCount > 0 || subgroupFailures > 0) {
        state = 'partial';
        reason = 'Some selected records or subgroups are unavailable.';
    } else if (catalog.length >= capacity && capacity > 0) {
        state = 'limited';
        reason = 'Tracker capacity reached; selected-layer coverage may be truncated.';
    } else if (catalog.length > 0 && staleOver3d > catalog.length / 2) {
        state = 'stale';
        reason = 'Most loaded elements are older than three days.';
    } else if (loadingGroups > 0) {
        state = 'loading';
        reason = 'Loaded records are usable while more selected layers arrive.';
    } else if (catalog.length === 0) {
        state = 'empty';
        reason = 'No selected catalogue records are loaded.';
    }

    return {
        state,
        reason,
        scope: 'selected-layers',
        activeLayerCount,
        groupCount: groups.length,
        loadedCount: catalog.length,
        capacity,
        capacityUsedPct: round(capacityUsedPct, 1),
        maxCatalogId,
        sixPlusDigitCount,
        formats: Object.fromEntries(formats),
        epochCount: ages.length,
        missingEpoch,
        freshUnder24h,
        aging1To3d,
        staleOver3d,
        freshPct: catalog.length ? round(freshUnder24h / catalog.length * 100, 1) : 0,
        medianAgeDays: round(median(ages), 3),
        oldestAgeDays: round(ages.at(-1), 3),
        loadingGroups,
        failedGroups,
        partialGroups,
        rejectedCount,
        subgroupFailures,
        oldestFetchAgeHours: fetchedTimes.length
            ? round(Math.max(0, nowMs - fetchedTimes[0]) / 3600000, 2)
            : null,
        newestFetched: fetchedTimes.length ? new Date(fetchedTimes.at(-1)).toISOString() : null,
        groups,
    };
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
}

function fmtCount(value) {
    return Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
}

function fmtAge(days) {
    if (!Number.isFinite(days)) return '—';
    if (days < 1 / 24) return `${Math.max(0, Math.round(days * 1440))}m`;
    if (days < 1) return `${(days * 24).toFixed(days < 0.1 ? 1 : 0)}h`;
    return `${days.toFixed(days < 10 ? 1 : 0)}d`;
}

function groupStatus(group) {
    if (group.status === 'error') return 'failed';
    if (group.status === 'loading') return 'loading';
    if (group.status === 'partial') return 'partial';
    return 'ready';
}

function renderHealth(host, health) {
    const totalAges = health.freshUnder24h + health.aging1To3d + health.staleOver3d + health.missingEpoch;
    const width = count => totalAges ? Math.max(0, count / totalAges * 100) : 0;
    const formats = Object.entries(health.formats)
        .map(([name, count]) => `${name.toUpperCase()} ${fmtCount(count)}`)
        .join(' · ') || 'No records';
    const groupRows = health.groups.map(group => `
        <div class="op-cat-group op-cat-group--${groupStatus(group)}">
            <span class="op-cat-group-dot" aria-hidden="true"></span>
            <span class="op-cat-group-name">${escapeHtml(group.label || group.id)}</span>
            <span class="op-cat-group-state">${groupStatus(group)}</span>
        </div>`).join('');

    host.innerHTML = `
        <div class="op-cat-head op-cat-head--${health.state}" role="status" aria-live="polite">
            <span class="op-cat-state-dot" aria-hidden="true"></span>
            <span><b>${escapeHtml(health.state)}</b><small>${escapeHtml(health.reason)}</small></span>
            <span class="op-cat-format">OMM</span>
        </div>
        <div class="op-cat-grid">
            <div><span>Loaded unique</span><b data-prov-key="catalog.coverage.loaded">${fmtCount(health.loadedCount)}</b></div>
            <div><span>Median epoch age</span><b data-prov-key="catalog.coverage.epoch_age">${fmtAge(health.medianAgeDays)}</b></div>
            <div><span>Six+ digit IDs</span><b data-prov-key="catalog.coverage.extended_ids">${fmtCount(health.sixPlusDigitCount)}</b></div>
            <div><span>Max catalogue ID</span><b>${fmtCount(health.maxCatalogId)}</b></div>
        </div>
        <div class="op-cat-agebar" title="Element epoch age: green <24 h, amber 1–3 d, red >3 d, gray missing">
            <i class="op-cat-age-fresh" style="width:${width(health.freshUnder24h)}%"></i>
            <i class="op-cat-age-aging" style="width:${width(health.aging1To3d)}%"></i>
            <i class="op-cat-age-stale" style="width:${width(health.staleOver3d)}%"></i>
            <i class="op-cat-age-missing" style="width:${width(health.missingEpoch)}%"></i>
        </div>
        <div class="op-cat-legend">
            <span><i class="fresh"></i>&lt;24h ${fmtCount(health.freshUnder24h)}</span>
            <span><i class="aging"></i>1–3d ${fmtCount(health.aging1To3d)}</span>
            <span><i class="stale"></i>&gt;3d ${fmtCount(health.staleOver3d)}</span>
        </div>
        <div class="op-cat-meta">
            <span>${escapeHtml(formats)}</span>
            <span>${health.activeLayerCount} selected layer${health.activeLayerCount === 1 ? '' : 's'} · ${health.capacityUsedPct ?? 0}% of local capacity</span>
            ${health.rejectedCount || health.subgroupFailures
                ? `<span class="op-cat-warning">${fmtCount(health.rejectedCount)} rejected · ${fmtCount(health.subgroupFailures)} subgroup failures</span>`
                : ''}
        </div>
        <div class="op-cat-groups">${groupRows || '<span class="op-cat-none">No selected layers.</span>'}</div>
        <p class="op-cat-scope">Coverage = selected CelesTrak layers retained locally. It is not full public-catalogue or sensor coverage.</p>`;
}

function groupInputs(fleet) {
    return fleet.layers()
        .filter(layer => fleet.isOn(layer.id))
        .map(layer => {
            const info = fleet.tracker.getGroupInfo(layer.group);
            const subgroupFailures = (info?.subgroups || []).filter(item => item.status === 'error').length;
            let status = fleet.isLoading(layer.id) ? 'loading' : info?.error ? 'error' : 'ready';
            if (status === 'ready' && (subgroupFailures > 0 || Number(info?.rejectedCount) > 0)) status = 'partial';
            return {
                id: layer.id,
                group: layer.group,
                label: layer.label,
                status,
                fetched: info?.fetched ?? null,
                sourceFormat: info?.sourceFormat ?? null,
                upstreamCount: info?.upstreamCount ?? null,
                rejectedCount: info?.rejectedCount ?? 0,
                subgroupFailures,
            };
        });
}

function recordsForGroups(tracker, groups) {
    const records = [];
    for (const group of groups) records.push(...tracker.getTlesByGroup(group.group));
    return records;
}

/** Mount the live health panel. Returns a small inspect/dispose controller. */
export function mountCatalogHealth({ host, fleet }) {
    if (!host || !fleet?.tracker) return { snapshot: () => null, dispose() {} };
    let current = null;

    const render = () => {
        const groups = groupInputs(fleet);
        current = buildCatalogHealth({
            records: recordsForGroups(fleet.tracker, groups),
            groups,
            activeLayerCount: groups.length,
            capacity: fleet.tracker.getCatalogCapacity(),
        });
        renderHealth(host, current);

        const cacheState = ['stale', 'failed', 'partial', 'limited'].includes(current.state) ? 'stale' : 'live';
        const source = 'CelesTrak GP OMM via /api/celestrak/tle';
        provStore.set('catalog.coverage.loaded', {
            value: current.loadedCount, unit: 'objects', source,
            fetchedAt: current.newestFetched, validAt: current.newestFetched,
            model: 'SGP4', cacheState,
            description: 'Unique normalized GP records in the currently selected layer scope.',
        });
        provStore.set('catalog.coverage.epoch_age', {
            value: current.medianAgeDays, unit: 'days', source,
            fetchedAt: current.newestFetched, validAt: new Date().toISOString(),
            model: 'CCSDS OMM', cacheState,
            description: 'Median time since the element-set epoch across selected unique records.',
        });
        provStore.set('catalog.coverage.extended_ids', {
            value: current.sixPlusDigitCount, unit: 'objects', source,
            fetchedAt: current.newestFetched, validAt: current.newestFetched,
            model: 'CCSDS OMM', cacheState,
            description: 'Objects whose catalogue identifiers cannot be represented in the legacy five-column TLE field.',
        });
    };

    const unsubscribe = fleet.onChange(render);
    const timer = setInterval(render, 60000);
    return {
        snapshot: () => current,
        render,
        dispose() {
            clearInterval(timer);
            unsubscribe?.();
        },
    };
}
