/**
 * vehicle-lab.js — editable spacecraft assumptions + five action branches.
 *
 * The workbench scales the existing atmosphere-driven decay rate by the
 * operator's configured C_D·A/m, then compares short-horizon policy branches.
 * It does not mutate the underlying TLE or claim a flight-ready maneuver.
 */

import { provStore } from './provenance.js';
import { decayWithSigma } from './decision-deck.js';
import { ballisticFromTle, msisRhoAt, onMsisReady } from './msis-drag.js';
import { localRateFromDecay } from './risk-analysis.js';
import {
    ATTITUDES, VEHICLE_PROFILES, ballisticCoefficient, compareVehicleActions,
    configFromProfile, getVehicleProfile, sanitizeVehicleConfig,
} from './vehicle-scenarios.js';

function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
}

function fmtKm(v) {
    if (!Number.isFinite(v)) return '—';
    return v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(1);
}

function fmtProp(v) {
    if (!Number.isFinite(v)) return '—';
    if (v < 0.001) return '<1 g';
    if (v < 1) return `${Math.round(v * 1000)} g`;
    return `${v.toFixed(v >= 10 ? 1 : 2)} kg`;
}

function fmtDuration(sec) {
    if (!Number.isFinite(sec)) return 'no thrust';
    if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
    if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
    return `${(sec / 3600).toFixed(1)} h`;
}

function field(id, label, value, unit, step = 'any', min = 0) {
    const minAttr = min == null ? '' : ` min="${min}"`;
    return `<label class="op-veh-field"><span>${label}</span><span class="op-veh-input"><input id="${id}" type="number"${minAttr} step="${step}" value="${value}"><em>${unit}</em></span></label>`;
}

export function mountVehicleLab({
    host, fleet, tracker, vehicleStore, maneuverPanel,
    getSelectedId = () => null, onSelectChange = () => () => {},
} = {}) {
    if (!host || !fleet || !tracker || !vehicleStore) return null;
    let selectedId = getSelectedId();
    let snapshot = null;

    function selectedAsset() {
        if (selectedId == null) return null;
        return fleet.list().find(a => a.noradId === Number(selectedId)) ?? null;
    }

    function baseRateFor(asset) {
        const rec = provStore.get(`decay.rate.${asset.noradId}`);
        if (Number.isFinite(rec?.value)) return rec.value;
        const f107 = provStore.get('idx.f107')?.value ?? 150;
        const sigF107 = provStore.get('idx.f107')?.sigma ?? 12;
        const ap = provStore.get('idx.ap')?.value ?? 15;
        const sigAp = provStore.get('idx.ap')?.sigma ?? 6;
        return localRateFromDecay(decayWithSigma(asset.tle, f107, sigF107, ap, sigAp));
    }

    function comparison(asset, config) {
        const f107 = provStore.get('idx.f107')?.value ?? 150;
        const ap = provStore.get('idx.ap')?.value ?? 15;
        const perigeeKm = asset.tle?.perigee_km;
        const rho0 = msisRhoAt(perigeeKm, f107, ap);
        const densityRatioAt = (deltaAltKm) => {
            const raised = msisRhoAt(perigeeKm + deltaAltKm, f107, ap);
            if (Number.isFinite(rho0) && rho0 > 0 && Number.isFinite(raised)) return raised / rho0;
            return Math.exp(-deltaAltKm / 55);
        };
        return compareVehicleActions({
            config,
            perigeeKm,
            baselineRateKmDay: baseRateFor(asset),
            baselineBallisticCoefficient: ballisticFromTle(asset.tle).bc,
            horizonHours: 72,
            densityRatioAt,
        });
    }

    function publish(asset, config, branches) {
        provStore.set(`vehicle.config.${asset.noradId}.bc`, {
            value: ballisticCoefficient(config, config.attitude),
            unit: 'm²/kg',
            source: 'operator-configured (Vehicle & Action Lab)',
            model: 'C_D·A/m',
            formula: 'B = C_D A_eff / m',
            inputs: [],
            cacheState: 'derived',
            validAt: new Date().toISOString(),
            description: `${asset.name} effective ballistic coefficient from the editable ${config.profileId} assumptions in ${config.attitude} attitude.`,
        });
        for (const branch of branches) {
            provStore.set(`vehicle.branch.${asset.noradId}.${branch.id}.perigee72h`, {
                value: branch.endPerigeeKm,
                unit: 'km perigee',
                source: 'derived (Vehicle & Action Lab)',
                model: 'NRLMSISE local ȧ scaling · two-body/Hohmann · Tsiolkovsky',
                formula: 'ȧ_vehicle = ȧ_TLE · [(C_D A/m)_vehicle / (C_D A/m)_TLE] · ρ(h)/ρ(h₀)',
                inputs: ['idx.f107', 'idx.ap', `decay.rate.${asset.noradId}`],
                cacheState: 'derived',
                validAt: new Date().toISOString(),
                description: `${branch.label} 72-hour perigee comparison for ${asset.name}. ` +
                    'Illustrative spacecraft assumptions and local-rate drag scaling; not a commanded maneuver.',
            });
        }
    }

    function render() {
        const asset = selectedAsset();
        if (!asset) {
            snapshot = null;
            host.innerHTML = `<div class="op-veh-empty">Select a ready fleet asset to assign a spacecraft design and compare actions.</div>`;
            return;
        }
        if (asset.status !== 'ready' || !asset.tle) {
            snapshot = null;
            host.innerHTML = `<div class="op-veh-empty">Waiting for ${esc(asset.name)} TLE data…</div>`;
            return;
        }

        const config = vehicleStore.ensure(asset.noradId, { name: asset.name });
        const profile = getVehicleProfile(config.profileId);
        const branches = comparison(asset, config);
        const active = branches.find(b => b.id === config.activeAction) ?? branches[0];
        snapshot = {
            validAt: new Date().toISOString(),
            selectedNoradId: asset.noradId,
            assetName: asset.name,
            config,
            branches,
            activeBranch: active,
        };
        publish(asset, config, branches);

        const profileOptions = VEHICLE_PROFILES.map(p =>
            `<option value="${p.id}"${p.id === config.profileId ? ' selected' : ''}>${esc(p.label)}</option>`
        ).join('');
        const attitudeOptions = ATTITUDES.map(a =>
            `<option value="${a.id}"${a.id === config.attitude ? ' selected' : ''}>${esc(a.label)}</option>`
        ).join('');

        const branchCards = branches.map(branch => {
            const isOn = branch.id === config.activeAction;
            const delta = branch.endPerigeeKm - branch.startPerigeeKm;
            const deltaText = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)} km vs now`;
            return `<button type="button" class="op-veh-branch${isOn ? ' op-veh-branch--on' : ''}${branch.feasible ? '' : ' op-veh-branch--bad'}"
                data-veh-action="${branch.id}" aria-pressed="${isOn}" title="Select this action for the on-orbit vehicle visual">
                <span class="op-veh-branch-name">${esc(branch.label)}</span>
                <strong>${fmtKm(branch.endPerigeeKm)} km</strong>
                <span class="op-veh-branch-delta">${deltaText}</span>
                <span class="op-veh-branch-metrics">
                    <span><em>Δv</em>${branch.dvMs.toFixed(branch.dvMs >= 10 ? 1 : 2)} m/s</span>
                    <span><em>prop</em>${fmtProp(branch.propellantUsedKg)}</span>
                    <span><em>burn</em>${fmtDuration(branch.burnSec)}</span>
                    <span><em>drag</em>${Math.abs(branch.rateKmDay * 1000).toFixed(Math.abs(branch.rateKmDay) < 0.1 ? 1 : 0)} m/d</span>
                </span>
                <span class="op-veh-feasible">${branch.feasible ? (branch.id === 'low-drag' ? 'attitude branch' : 'within configured propellant') : 'infeasible with configured propulsion'}</span>
            </button>`;
        }).join('');

        const bc = ballisticCoefficient(config, config.attitude);
        host.innerHTML = `
            <div class="op-veh-topline">
                <div><strong>${esc(asset.name)}</strong><span>#${asset.noradId} · illustrative template, fully editable</span></div>
                <div class="op-veh-bc"><span>C<sub>D</sub>A/m</span><strong>${bc.toExponential(2)} m²/kg</strong></div>
            </div>
            <div class="op-veh-selects">
                <label><span>Design</span><select id="op-veh-profile">${profileOptions}</select></label>
                <label><span>Attitude</span><select id="op-veh-attitude">${attitudeOptions}</select></label>
            </div>
            <details class="op-veh-assumptions">
                <summary>Physical &amp; propulsion assumptions</summary>
                <div class="op-veh-fields">
                    ${field('op-veh-mass', 'Wet mass', config.massKg, 'kg', '0.1')}
                    ${field('op-veh-cd', 'Drag coefficient Cᴅ', config.cd, '—', '0.01')}
                    ${field('op-veh-area-nom', 'Nominal area', config.areaNominalM2, 'm²', '0.001')}
                    ${field('op-veh-area-low', 'Low-drag area', config.areaLowDragM2, 'm²', '0.001')}
                    ${field('op-veh-area-sun', 'Broadside area', config.areaSunM2, 'm²', '0.001')}
                    ${field('op-veh-thrust', 'Thrust', config.thrustN, 'N', '0.001')}
                    ${field('op-veh-isp', 'Specific impulse', config.ispS, 's', '1')}
                    ${field('op-veh-prop', 'Usable propellant', config.propellantKg, 'kg', '0.01')}
                </div>
            </details>
            <div class="op-veh-actions">
                ${field('op-veh-raise', 'Raise target', config.raiseKm, 'km', '1')}
                ${field('op-veh-delay', 'Delay raise', config.delayHours, 'h', '1')}
                ${field('op-veh-dv', 'Maneuver T Δv', config.maneuverDvMs, 'm/s', '0.1', null)}
                <button type="button" id="op-veh-apply" class="op-veh-apply">Apply assumptions</button>
            </div>
            <div class="op-veh-compare-head"><span>72-hour action comparison</span><span>Select a column to animate the vehicle</span></div>
            <div class="op-veh-branches">${branchCards}</div>
            <div class="op-veh-caveat">${esc(profile.classLabel)} template · Local drag-rate scaling, Hohmann raise, rocket equation, and first-order tangential-burn energy. Verify in the operator FDS before action.</div>
        `;

        host.querySelector('#op-veh-profile')?.addEventListener('change', e => {
            vehicleStore.set(asset.noradId, configFromProfile(e.target.value, {
                raiseKm: config.raiseKm,
                delayHours: config.delayHours,
                maneuverDvMs: config.maneuverDvMs,
                activeAction: config.activeAction,
            }));
        });
        host.querySelector('#op-veh-attitude')?.addEventListener('change', e => {
            vehicleStore.set(asset.noradId, { ...config, attitude: e.target.value });
        });
        host.querySelector('#op-veh-apply')?.addEventListener('click', () => {
            const number = (id, fallback) => {
                const value = Number(host.querySelector(`#${id}`)?.value);
                return Number.isFinite(value) ? value : fallback;
            };
            vehicleStore.set(asset.noradId, sanitizeVehicleConfig({
                ...config,
                massKg: number('op-veh-mass', config.massKg),
                cd: number('op-veh-cd', config.cd),
                areaNominalM2: number('op-veh-area-nom', config.areaNominalM2),
                areaLowDragM2: number('op-veh-area-low', config.areaLowDragM2),
                areaSunM2: number('op-veh-area-sun', config.areaSunM2),
                thrustN: number('op-veh-thrust', config.thrustN),
                ispS: number('op-veh-isp', config.ispS),
                propellantKg: number('op-veh-prop', config.propellantKg),
                raiseKm: number('op-veh-raise', config.raiseKm),
                delayHours: number('op-veh-delay', config.delayHours),
                maneuverDvMs: number('op-veh-dv', config.maneuverDvMs),
            }));
        });
        host.querySelectorAll('[data-veh-action]').forEach(button => {
            button.addEventListener('click', () => {
                const activeAction = button.dataset.vehAction;
                vehicleStore.set(asset.noradId, { ...config, activeAction });
                if (activeAction === 'maneuver') {
                    maneuverPanel?.setDeltaV?.({ r: 0, t: config.maneuverDvMs, n: 0 });
                }
            });
        });
    }

    const offSel = onSelectChange(id => { selectedId = id; render(); });
    const offFleet = fleet.onChange(render);
    const offVehicle = vehicleStore.onChange(({ noradId }) => {
        if (Number(noradId) === Number(selectedId)) render();
    });
    const offProv = provStore.subscribe(key => {
        if (key === 'idx.f107' || key === 'idx.ap' || key === `decay.rate.${selectedId}`) render();
    });
    const offMsis = onMsisReady(render);
    render();

    return {
        getSnapshot: () => snapshot,
        selectAction(actionId) {
            const asset = selectedAsset();
            const config = asset ? vehicleStore.get(asset.noradId) : null;
            if (!asset || !config) return;
            vehicleStore.set(asset.noradId, { ...config, activeAction: actionId });
        },
        dispose() { offSel?.(); offFleet?.(); offVehicle?.(); offProv?.(); offMsis?.(); },
    };
}
