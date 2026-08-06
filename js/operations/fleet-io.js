/**
 * fleet-io.js — pure intake + export helpers for the Operations fleet flow.
 *
 * Public-GP mode is deliberately small (the caller owns the asset cap), but
 * an operator should still be able to paste the formats already sitting in a
 * console or spreadsheet: one NORAD per line, a comma-separated list, CSV with
 * a NORAD/catalog column, a JSON array, or ordinary two-line elements.
 *
 * This module has no DOM/browser dependency so the parser and report schema can
 * be pinned with a fast Node gate.
 */

const NORAD_KEYS = new Set([
    'norad', 'noradid', 'noradnumber', 'catalog', 'catalogid',
    'catalognumber', 'catid', 'satcat', 'satcatid', 'objectid',
]);

function validNorad(value) {
    const n = Number(String(value ?? '').trim().replace(/^#/, ''));
    return Number.isInteger(n) && n > 0 && n <= 999999999 ? n : null;
}

function csvCells(line) {
    const out = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') { cell += '"'; i++; }
            else quoted = !quoted;
        } else if (ch === ',' && !quoted) {
            out.push(cell.trim());
            cell = '';
        } else {
            cell += ch;
        }
    }
    out.push(cell.trim());
    return out;
}

function normaliseKey(key) {
    return String(key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function idsFromJson(value, add) {
    if (Array.isArray(value)) {
        for (const item of value) {
            if (typeof item === 'number' || typeof item === 'string') add(item);
            else idsFromJson(item, add);
        }
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (NORAD_KEYS.has(normaliseKey(key))) add(child);
        else if (child && typeof child === 'object') idsFromJson(child, add);
    }
}

/**
 * Parse operator-supplied fleet text.
 *
 * Returns { ids, rejectedLines, found, truncated }. `found` is the unique
 * count before the caller's cap is applied.
 */
export function parseNoradText(raw, { max = Infinity } = {}) {
    const text = String(raw ?? '').trim();
    if (!text) return { ids: [], rejectedLines: [], found: 0, truncated: 0 };

    const seen = new Set();
    const add = (value) => {
        const id = validNorad(value);
        if (id != null) seen.add(id);
        return id != null;
    };

    if (/^[\[{]/.test(text)) {
        try { idsFromJson(JSON.parse(text), add); }
        catch (_) { /* continue through the line parser */ }
    }

    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const rejectedLines = [];

    // Header-aware CSV: prefer the declared NORAD/SATCAT column so numeric
    // altitude, mass, or epoch fields cannot be mistaken for catalog IDs.
    let csvNoradIndex = -1;
    if (lines[0]?.includes(',')) {
        csvNoradIndex = csvCells(lines[0]).findIndex(c => NORAD_KEYS.has(normaliseKey(c)));
    }

    lines.forEach((line, index) => {
        if (csvNoradIndex >= 0) {
            if (index === 0) return;
            if (!add(csvCells(line)[csvNoradIndex])) rejectedLines.push(line);
            return;
        }

        // Standard TLE line 1/2. Both lines repeat the catalog ID and the Set
        // removes the duplicate.
        const tle = line.match(/^[12]\s+(\d{1,6})(?:[A-Z\s]|$)/);
        if (tle) { add(tle[1]); return; }

        const cells = line.split(/[,;\t]/).map(s => s.trim()).filter(Boolean);
        if (cells.length > 1 && cells.every(c => validNorad(c) != null)) {
            cells.forEach(add); // compact `25544,20580,43013` list
            return;
        }

        // One ID per line, or a no-header CSV row such as `ISS,25544`.
        if (add(line)) return;
        const likelyId = cells.find(c => /^#?\d{4,9}$/.test(c));
        if (likelyId && add(likelyId)) return;

        // JSON was already consumed above; do not report its structural lines
        // as rejects merely because they are not standalone IDs.
        if (!/^[\[{]/.test(text)) rejectedLines.push(line);
    });

    const all = [...seen];
    const cap = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : all.length;
    return {
        ids: all.slice(0, cap),
        rejectedLines,
        found: all.length,
        truncated: Math.max(0, all.length - cap),
    };
}

function csvEscape(value) {
    if (value == null) return '';
    const s = String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
}

/** Build the stable public-preview fleet briefing schema. */
export function buildFleetReport({
    assets = [],
    simTimeMs = Date.now(),
    scenarioHash = null,
    scenarioLabel = 'Live forecast',
    modelVersions = null,
    provenance = {},
    conjunctionRows = [],
    riskSnapshot = null,
    vehicleSnapshot = null,
} = {}) {
    const conjById = new Map(conjunctionRows.map(r => [r?.asset?.noradId, r?.conjs ?? []]));
    const riskById = new Map((riskSnapshot?.assetForecasts ?? []).map(r => [r?.asset?.noradId, r]));
    const encountersById = new Map();
    for (const encounter of riskSnapshot?.encounters ?? []) {
        const id = encounter?.primary?.noradId;
        if (!Number.isFinite(id)) continue;
        const list = encountersById.get(id) ?? [];
        list.push(encounter);
        encountersById.set(id, list);
    }
    const getRecord = (key) => provenance?.records?.[key] ?? provenance?.[key] ?? null;

    return {
        schema: 'parkersphysics.orbit-margin.fleet.v3',
        exportedAt: new Date().toISOString(),
        validAt: new Date(simTimeMs).toISOString(),
        scenarioHash,
        scenarioLabel,
        modelVersions,
        limitations: [
            'Public GP/OMM screening is triage-grade and is not a maneuver command.',
            'Public GP/OMM records do not include operator covariance; displayed uncertainty may be synthetic.',
            'Altitude horizons hold the current local drag rate constant and are sensitivity projections, not high-fidelity propagated ephemerides.',
            'Spacecraft design templates are illustrative assumptions; replace them with operator-controlled mass, area, attitude, and propulsion values.',
            'Verify candidate actions with the operator flight-dynamics system and current tracking data.',
        ],
        riskSummary: riskSnapshot?.summary ? {
            assetCount: riskSnapshot.summary.assetCount ?? 0,
            encounterCount: riskSnapshot.summary.encounterCount ?? 0,
            inside3SigmaCount: riskSnapshot.summary.inside3SigmaCount ?? 0,
            envelopeOverlapCount: riskSnapshot.summary.envelopeOverlapCount ?? 0,
            worstLoss72hM: finiteOrNull(riskSnapshot.summary.worstLoss72hM),
            dominantDebrisFamily: riskSnapshot.summary.dominantFamily?.name ?? null,
        } : null,
        vehicleComparison: vehicleSnapshot ? {
            validAt: vehicleSnapshot.validAt ?? null,
            selectedNoradId: vehicleSnapshot.selectedNoradId ?? null,
            assetName: vehicleSnapshot.assetName ?? null,
            config: vehicleSnapshot.config ?? null,
            activeBranch: vehicleSnapshot.activeBranch ?? null,
            branches: vehicleSnapshot.branches ?? [],
        } : null,
        assets: assets.map(asset => {
            const decay = getRecord(`decay.lifetime.${asset.noradId}`);
            const rate  = getRecord(`decay.rate.${asset.noradId}`);
            const conjs = conjById.get(asset.noradId) ?? [];
            const risk = riskById.get(asset.noradId);
            const vehicle = risk?.vehicleConfig ?? null;
            const horizon = (hours) => risk?.forecast?.horizons?.find(h => h.hours === hours);
            const encounters = encountersById.get(asset.noradId) ?? [];
            const highest = encounters.slice().sort((a, b) =>
                (b?.screen?.rank ?? 0) - (a?.screen?.rank ?? 0) ||
                (a?.screen?.missKm ?? Infinity) - (b?.screen?.missKm ?? Infinity))[0];
            return {
                noradId: asset.noradId,
                name: asset.name,
                status: asset.status,
                perigeeKm: finiteOrNull(asset.tle?.perigee_km),
                apogeeKm: finiteOrNull(asset.tle?.apogee_km),
                tleEpoch: asset.tle?.epoch ?? asset.tle?.epoch_date ?? null,
                decayLifetimeDays: finiteOrNull(decay?.value),
                decaySigmaDays: finiteOrNull(decay?.sigma),
                decayRateKmDay: finiteOrNull(rate?.value),
                perigeeForecast6hKm: finiteOrNull(horizon(6)?.perigeeKm),
                perigeeForecast24hKm: finiteOrNull(horizon(24)?.perigeeKm),
                perigeeForecast72hKm: finiteOrNull(horizon(72)?.perigeeKm),
                projectedLoss72hM: finiteOrNull(horizon(72)?.lossM),
                dragVsQuiet: finiteOrNull(risk?.forecast?.dragVsQuiet),
                vehicleProfileId: vehicle?.profileId ?? null,
                vehicleAttitude: vehicle?.attitude ?? null,
                vehicleMassKg: finiteOrNull(vehicle?.massKg),
                vehicleCd: finiteOrNull(vehicle?.cd),
                vehicleNominalAreaM2: finiteOrNull(vehicle?.areaNominalM2),
                vehicleLowDragAreaM2: finiteOrNull(vehicle?.areaLowDragM2),
                vehicleSunPointingAreaM2: finiteOrNull(vehicle?.areaSunM2),
                vehicleThrustN: finiteOrNull(vehicle?.thrustN),
                vehicleIspS: finiteOrNull(vehicle?.ispS),
                vehiclePropellantKg: finiteOrNull(vehicle?.propellantKg),
                activeAction: vehicle?.activeAction ?? null,
                conjunctionCount: conjs.length,
                closestMissKm: finiteOrNull(conjs[0]?.dist_km),
                closestTca: Number.isFinite(conjs[0]?.tca_ms)
                    ? new Date(conjs[0].tca_ms).toISOString()
                    : null,
                highestScreeningTier: highest?.screen?.tier ?? null,
                highestMissOverSyntheticSigma: finiteOrNull(highest?.screen?.missOverSigma),
                highestCombinedSyntheticSigmaKm: finiteOrNull(highest?.screen?.combinedSigmaKm),
                highestDebrisFamily: highest?.family?.name ?? null,
                highestEstimatedImpactEnergyMJ: finiteOrNull(highest?.energyMJ),
            };
        }),
    };
}

export function fleetReportToCsv(report) {
    const columns = [
        'norad_id', 'name', 'status', 'perigee_km', 'apogee_km',
        'decay_lifetime_days', 'decay_sigma_days', 'decay_rate_km_day',
        'perigee_6h_km', 'perigee_24h_km', 'perigee_72h_km',
        'projected_loss_72h_m', 'drag_vs_quiet',
        'vehicle_profile', 'vehicle_attitude', 'vehicle_mass_kg', 'vehicle_cd',
        'vehicle_nominal_area_m2', 'vehicle_low_drag_area_m2', 'vehicle_sun_area_m2',
        'vehicle_thrust_n', 'vehicle_isp_s', 'vehicle_propellant_kg', 'active_action',
        'conjunction_count', 'closest_miss_km', 'closest_tca',
        'highest_screening_tier', 'highest_miss_over_synthetic_sigma',
        'highest_combined_synthetic_sigma_km', 'highest_debris_family',
        'highest_estimated_impact_energy_mj',
        'scenario', 'valid_at', 'scenario_hash',
    ];
    const rows = (report?.assets ?? []).map(a => [
        a.noradId, a.name, a.status, a.perigeeKm, a.apogeeKm,
        a.decayLifetimeDays, a.decaySigmaDays, a.decayRateKmDay,
        a.perigeeForecast6hKm, a.perigeeForecast24hKm, a.perigeeForecast72hKm,
        a.projectedLoss72hM, a.dragVsQuiet,
        a.vehicleProfileId, a.vehicleAttitude, a.vehicleMassKg, a.vehicleCd,
        a.vehicleNominalAreaM2, a.vehicleLowDragAreaM2, a.vehicleSunPointingAreaM2,
        a.vehicleThrustN, a.vehicleIspS, a.vehiclePropellantKg, a.activeAction,
        a.conjunctionCount, a.closestMissKm, a.closestTca,
        a.highestScreeningTier, a.highestMissOverSyntheticSigma,
        a.highestCombinedSyntheticSigmaKm, a.highestDebrisFamily,
        a.highestEstimatedImpactEnergyMJ,
        report.scenarioLabel, report.validAt, report.scenarioHash,
    ]);
    return [columns, ...rows].map(row => row.map(csvEscape).join(',')).join('\n') + '\n';
}
