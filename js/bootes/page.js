/**
 * bootes/page.js — state, controls and wiring for bootes-void.html
 * ═══════════════════════════════════════════════════════════════════════════
 * The only module on the page that touches the DOM and the only one that owns
 * mutable state. It computes nothing itself: every physical number comes from
 * js/bootes-void-model.js, every structure from js/bootes-web-model.js, every
 * published input from js/bootes-void-data.js, and it renders them through
 * bootes/scene.js and bootes/charts.js.
 *
 * ONE RECOMPUTE, ONE SOURCE OF TRUTH. `recompute()` rebuilds the entire
 * derived state from the four controls and then pushes it out. Nothing else
 * writes a number to the DOM, and nothing caches a physical quantity across
 * calls. That is deliberate and it is the reason the bias slider can move the
 * ISW amplitude, the lensing SNR and the influence radius in one gesture
 * without any of them being able to fall out of step — the alternative,
 * per-panel incremental updates, is how a page ends up quoting an outflow from
 * one bias and a mass deficit from another.
 *
 * THE DOM CONTRACT is `data-bv="<key>"` for a readout and `data-bv-chart` for
 * a canvas. Keys are looked up once at init; a key present in the markup but
 * never written, or written but absent from the markup, is caught by
 * `tests/bootes-void-page.mjs`, which parses the HTML and diffs the two sets.
 * That gate exists because a readout that silently never updates looks exactly
 * like one showing a value that happens not to have changed.
 *
 * PERFORMANCE. `influenceProfile` is the expensive call — it evaluates the
 * web's ~800-particle sum over 48 directions × ~50 radii, about 2 M force
 * evaluations, which lands around 80 ms. That is fine for a control release
 * and far too slow for a drag, so the sliders are debounced and the page draws
 * a "computing" state rather than dropping frames. Do not move this into the
 * render loop.
 */

import {
    COSMOLOGY, C_KMS, GYR_S,
    createVoidProfile, splitProfile, compensationFraction, wallMassMsun,
    matterContrastFromGalaxy, galaxyContrastFromMatter,
    radialVelocityKms, velocityDivergence, enclosedMassExcessMsun,
    gravityKmsPerGyr, voidGravityVector, tidalEigenvalues, voidTidalTensor,
    symmetricEigen, apparentEllipticity, rsdQuadrupoleRatio,
    deltaSigma, tangentialShear, lensingSNR, iswTemperatureShiftK,
    influenceProfile, angularDiameterDistanceMpc, growthRate, toRedshiftSpace,
} from '../bootes-void-model.js';
import {
    createCosmicWeb, sampleTracers, filamentAlignment,
} from '../bootes-web-model.js';
import {
    BOOTES_VOID, PROFILE_PRESETS, BIAS_RANGE, DEFAULT_BIAS, ANCHOR_ACCURACY,
    voidRedshift, voidDistanceMpc, effectiveRadiusMpc, countBasedDeficit,
    losUnitFromVoid, resolvedAnchors,
} from '../bootes-void-data.js';
import { createBootesScene } from './scene.js';
import {
    drawDensity, drawVelocity, drawContinuity, drawInfluence,
    drawRsd, drawLensing, drawIsw, drawCompensation,
} from './charts.js';

const DEG = 180 / Math.PI;

/** Field modes. `key` is the radio value; `legend` is printed under the stage. */
export const FIELD_MODES = Object.freeze({
    velocity: {
        label: 'Peculiar velocity',
        unit: 'km/s',
        legend: 'Outflow from the void. Not a push — less inward pull from the empty side.',
    },
    gravityA: {
        label: 'Gravity — real universe',
        unit: 'km/s per Gyr',
        legend: 'Model A: the void deficit plus the clumped wall around it.',
    },
    gravityB: {
        label: 'Gravity — no Boötes',
        unit: 'km/s per Gyr',
        legend: 'Model B: the same wall, with the underdensity filled to cosmic mean.',
    },
    delta: {
        label: 'Δg — the void’s own contribution',
        unit: 'km/s per Gyr',
        legend: 'A minus B. This is the field that exists only because Boötes is empty.',
    },
    tidal: {
        label: 'Tidal compression axis',
        unit: '4πGρ̄',
        legend: 'Principal compression direction e₁ of the total tidal field. '
            + 'An axis, not a vector — the arrowhead has no meaning.',
    },
});

const num = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const sci = (v, digits = 2) => (Number.isFinite(v) ? v.toExponential(digits) : '—');

export function initBootesPage(root = document) {
    // ── DOM handles ─────────────────────────────────────────────────────────
    // A key maps to a LIST of elements, not to one. Several quantities are
    // deliberately shown twice — the mass deficit appears in the headline strip
    // and again in the compensation card, the velocity threshold three times —
    // and a Map of key→element silently keeps only the last one, leaving the
    // others frozen on their placeholder em-dash forever. That shipped in the
    // first build of this page and looked exactly like a value that had not
    // been computed yet. `tests/bootes-void-page.mjs` now diffs the markup's
    // key set against the set this module writes, in both directions.
    const outputs = new Map();
    root.querySelectorAll('[data-bv]').forEach(el => {
        const key = el.getAttribute('data-bv');
        if (!outputs.has(key)) outputs.set(key, []);
        outputs.get(key).push(el);
    });
    const charts = new Map();
    root.querySelectorAll('[data-bv-chart]').forEach(el => {
        charts.set(el.getAttribute('data-bv-chart'), el);
    });
    const written = new Set();
    const set = (key, value) => {
        written.add(key);
        const els = outputs.get(key);
        if (els) for (const el of els) el.textContent = value;
    };

    const canvas = root.querySelector('#bv-stage');
    const scene = canvas ? createBootesScene(canvas) : null;
    const fallback = root.querySelector('#bv-stage-fallback');
    if (!scene && fallback) fallback.hidden = false;

    // ── Controls ────────────────────────────────────────────────────────────
    const state = {
        preset: 'hsw-supervoid',
        bias: DEFAULT_BIAS,
        clumpiness: 0.65,
        seed: 20260907,
        mode: 'delta',
        redshiftSpace: false,
        velocityThresholdKms: 50,
        layers: { tracers: true, web: true, shell: true, field: true, markers: true },
    };

    const anchors = resolvedAnchors();
    const losUnit = losUnitFromVoid();
    const Z = voidRedshift();
    const rEff = effectiveRadiusMpc();

    // ── Sample points for the 3D vector field ───────────────────────────────
    //
    // Shells of Fibonacci-distributed directions rather than a Cartesian grid.
    // A grid puts most of its samples in the corners of the box, which for a
    // spherical problem means most of the arrows land where nothing happens,
    // and leaves the wall — the one region where the answer changes — sampled
    // by whichever cells happen to intersect it.
    const FIELD_SHELLS = [0.25, 0.5, 0.75, 1.0, 1.3, 1.7, 2.2];
    const FIELD_DIRS = 86;
    const fieldPoints = (() => {
        const golden = Math.PI * (3 - Math.sqrt(5));
        const pts = [];
        for (const frac of FIELD_SHELLS) {
            const r = rEff * frac;
            for (let i = 0; i < FIELD_DIRS; i++) {
                const y = 1 - (i / (FIELD_DIRS - 1)) * 2;
                const ring = Math.sqrt(Math.max(0, 1 - y * y));
                const th = golden * i;
                pts.push([
                    Math.cos(th) * ring * r, y * r, Math.sin(th) * ring * r,
                ]);
            }
        }
        return pts;
    })();

    let derived = null;
    let pending = null;

    function buildProfile() {
        const preset = PROFILE_PRESETS[state.preset] ?? PROFILE_PRESETS['hsw-supervoid'];
        const deltaC = matterContrastFromGalaxy(preset.centralGalaxyContrast, state.bias);
        return createVoidProfile({
            deltaC,
            rvMpc: rEff,
            rsMpc: rEff * preset.rsFraction,
            alpha: preset.alpha,
            beta: preset.beta,
        });
    }

    function recompute() {
        const profile = buildProfile();
        const { deficit, wall } = splitProfile(profile);
        const web = createCosmicWeb({
            voidProfile: profile, anchors, seed: state.seed,
            clumpiness: state.clumpiness, z: Z,
        });
        const tracers = sampleTracers({
            voidProfile: profile, web, count: 2400, bias: state.bias, seed: state.seed + 17,
        });
        const influence = influenceProfile(deficit, web.externalGravityAt, {
            z: Z, directions: 48, stepMpc: 8,
            velocityThresholdKms: state.velocityThresholdKms,
        });
        const alignVoid = filamentAlignment({ voidProfile: profile, web, which: 'void', axis: 1 });
        const alignWeb = filamentAlignment({ voidProfile: profile, web, which: 'web', axis: 1 });

        derived = { profile, deficit, wall, web, tracers, influence, alignVoid, alignWeb };
        paintReadouts();
        paintCharts();
        paintScene();
    }

    // ── Readouts ────────────────────────────────────────────────────────────
    function paintReadouts() {
        const { profile, deficit, web, influence, alignVoid, alignWeb } = derived;
        const preset = PROFILE_PRESETS[state.preset];
        const dA = angularDiameterDistanceMpc(Z);

        // Geometry and provenance.
        set('rEffHinv', `${BOOTES_VOID.effectiveRadiusHinvMpc} h⁻¹ Mpc`);
        set('rEffMpc', `${num(rEff, 1)} Mpc`);
        set('distance', `${num(voidDistanceMpc(), 0)} Mpc`);
        set('redshift', num(Z, 4));
        set('angularRadius', `${num(rEff / dA * DEG, 1)}°`);
        set('h', num(COSMOLOGY.h, 4));
        set('anchorAccuracy', `±${ANCHOR_ACCURACY.positionDeg}° · ±${ANCHOR_ACCURACY.redshift} in z`);

        // The bias step and its consequences — the page's dominant systematic.
        set('bias', num(state.bias, 2));
        set('deltaGCore', num(preset.centralGalaxyContrast, 2));
        set('deltaMCore', num(profile.params.deltaC, 3));
        set('presetNote', preset.note);

        // The two deficits that disagree, side by side and unreconciled.
        const dIntM = profile.integratedAt(rEff);
        set('deltaMeanMatter', num(dIntM, 3));
        set('deltaMeanGalaxy', num(galaxyContrastFromMatter(dIntM, state.bias), 3));
        set('countDeficit', num(countBasedDeficit(), 3));
        set('countGalaxies', `${BOOTES_VOID.galaxiesObserved} vs ≈${BOOTES_VOID.galaxiesExpectedAtMeanDensity}`);

        // Mass budget and compensation.
        const massDef = enclosedMassExcessMsun(profile.rMaxMpc, deficit);
        set('massDeficit', `${num(massDef / 1e15, 1)} × 10¹⁵ M☉`);
        set('wallMass', `${num(wallMassMsun(profile) / 1e15, 1)} × 10¹⁵ M☉`);
        const C = compensationFraction(profile);
        set('compensation', num(C, 3));
        set('compensationVerdict', C < 1
            ? `under-compensated by ${num((1 - C) * 100, 0)} % — the wall never repays the deficit, `
              + 'so Δ(<r) approaches zero from below and the void keeps pulling outward'
            : 'over-compensated — Φ changes sign in the outskirts and the ISW prediction inverts');

        // Test 1 — the outflow.
        let peakV = 0;
        let peakR = 0;
        for (let r = 1; r < profile.rMaxMpc; r += 1) {
            const v = radialVelocityKms(r, profile, { z: Z });
            if (v > peakV) { peakV = v; peakR = r; }
        }
        set('peakOutflow', `${num(peakV, 0)} km/s`);
        set('peakOutflowRadius', `${peakR} Mpc  (${num(peakR / rEff, 2)} R_eff)`);
        set('outflowAt40', `${num(radialVelocityKms(40, profile, { z: Z }), 0)} km/s`);
        set('growthRate', num(growthRate(Z), 3));

        // Test 3 — the tidal signature at the wall.
        const e = tidalEigenvalues(rEff, profile);
        set('tidalRadial', num(e.radial, 3));
        set('tidalTangential', num(e.tangential, 3));
        set('tidalReading', e.radial > 0 && e.tangential < 0
            ? 'compressive radially, stretching tangentially — matter is being squeezed into the wall'
            : 'the wall signature has inverted; check the profile');

        // Test 4 — the counterfactual and the reach.
        const shareAt = (r) => influence.shareProfile.reduce((best, s) =>
            Math.abs(s.radiusMpc - r) < Math.abs(best.radiusMpc - r) ? s : best);
        const atEff = shareAt(rEff);
        const atTwo = shareAt(rEff * 2);
        set('shareAtEff', `${num(atEff.median * 100, 0)} %  [${num(atEff.p16 * 100, 0)}–${num(atEff.p84 * 100, 0)}]`);
        set('shareAtTwo', `${num(atTwo.median * 100, 0)} %  [${num(atTwo.p16 * 100, 0)}–${num(atTwo.p84 * 100, 0)}]`);
        set('velocityHorizon', influence.velocityHorizonMpc
            ? `${influence.velocityHorizonMpc} Mpc  (${num(influence.velocityHorizonMpc / rEff, 2)} R_eff)`
            : 'beyond the modelled range');
        set('velocityThreshold', `${state.velocityThresholdKms} km/s`);
        set('crossoverFraction', `${num(influence.crossover.fraction * 100, 0)} %`);
        set('crossoverRadius', influence.crossover.medianMpc
            ? `${influence.crossover.medianMpc} Mpc`
            : 'no crossover inside the modelled range');
        set('deltaGAtEff', `${num(gravityKmsPerGyr(rEff, deficit, { z: Z }), 1)} km/s per Gyr`);

        // Test 5 — alignment, with its control.
        set('alignVoidMean', num(alignVoid.meanAbsCos, 3));
        set('alignVoidZ', `${alignVoid.z >= 0 ? '+' : ''}${num(alignVoid.z, 2)} σ`);
        set('alignVoidVerdict', Math.abs(alignVoid.z) < 2
            ? 'no significant alignment — the void’s tidal field alone does not orient this web'
            : (alignVoid.z < 0
                ? 'filaments lie preferentially PERPENDICULAR to the void’s compression axis, '
                  + 'i.e. tangentially in the wall — the alignment the void predicts'
                : 'filaments lie preferentially ALONG the void’s compression axis, which is '
                  + 'the opposite of the prediction'));
        set('alignWebZ', `${alignWeb.z >= 0 ? '+' : ''}${num(alignWeb.z, 1)} σ`);
        set('alignN', String(alignVoid.n));
        set('alignSigma', num(Math.sqrt((1 / 12) / Math.max(1, alignVoid.n)), 3));

        // Test 6 — redshift space.
        const eps = apparentEllipticity(rEff * 0.5, profile, { z: Z });
        set('rsdEpsilon', num(eps, 3));
        set('rsdReading', eps > 1
            ? `the void appears ${num((eps - 1) * 100, 0)} % elongated along the sightline`
            : 'the void appears squashed — check the outflow sign');
        set('rsdQuadrupole', num(rsdQuadrupoleRatio(rEff * 0.6, profile, { z: Z, bias: state.bias }), 3));
        set('rsdBeta', num(growthRate(Z) / state.bias, 3));

        // Test 7 — lensing, and the honest null.
        let peakDS = 0;
        let peakDSR = 0;
        let bestSNR = 0;
        for (let r = 10; r < rEff * 2.2; r += 5) {
            const ds = deltaSigma(r, profile);
            if (Math.abs(ds) > Math.abs(peakDS)) { peakDS = ds; peakDSR = r; }
            bestSNR = Math.max(bestSNR, lensingSNR(r, profile, {
                zLens: Z, zSource: 0.9, annulusWidthMpc: 20, galaxiesPerArcmin2: 10,
            }));
        }
        set('lensingPeak', `${num(peakDS / 1e12, 2)} M☉/pc²  at ${peakDSR} Mpc`);
        set('lensingShear', sci(tangentialShear(peakDSR, profile, { zLens: Z, zSource: 0.9 }), 2));
        set('lensingSnr', num(bestSNR, 1));
        set('lensingVerdict', bestSNR < 3
            ? 'not a detection. A single void — even this one — is at best a marginal '
              + 'shear measurement, which is exactly why the literature stacks thousands of them'
            : 'marginally detectable in a deep survey, if one covered this part of the sky');

        // Test 8 — ISW.
        const isw = iswTemperatureShiftK(0, profile, { z: Z }) * 1e6;
        set('iswCentral', `${num(isw, 2)} µK`);
        set('iswVerdict', Math.abs(isw) < 10
            ? 'a few µK against ~70 µK of primary CMB fluctuation on these scales — '
              + 'predicted, not detectable on its own'
            : 'unusually large; check the compensation');
        set('iswSign', isw < 0 ? 'a COLD spot' : 'a HOT spot — which would mean Φ changed sign');

        // Model provenance, stated in the numbers panel and not only in prose.
        set('seed', String(state.seed));
        set('clumpiness', num(state.clumpiness, 2));
        set('webParticles', String(web.particles.length));
        set('webFilaments', String(web.filaments.length));
    }

    // ── Charts ──────────────────────────────────────────────────────────────
    function paintCharts() {
        const { profile, deficit, influence } = derived;
        const rMax = rEff * 2.6;
        const radii = [];
        for (let r = 0; r <= rMax; r += rMax / 220) radii.push(r);

        const c = (key) => charts.get(key);
        if (c('density')) {
            drawDensity(c('density'), {
                radii,
                delta: radii.map(r => profile.deltaAt(r)),
                integrated: radii.map(r => profile.integratedAt(r)),
                rEff, rs: profile.params.rsMpc,
            });
        }
        if (c('velocity')) {
            drawVelocity(c('velocity'), {
                radii,
                linear: radii.map(r => radialVelocityKms(r, profile, { z: Z, linear: true })),
                quasi: radii.map(r => radialVelocityKms(r, profile, { z: Z })),
                rEff, threshold: state.velocityThresholdKms,
            });
        }
        if (c('continuity')) {
            drawContinuity(c('continuity'), {
                radii,
                delta: radii.map(r => profile.deltaAt(r)),
                divergence: radii.map(r => velocityDivergence(r, profile, { z: Z })),
                rEff,
            });
        }
        if (c('compensation')) {
            drawCompensation(c('compensation'), {
                radii,
                cumulativeMass: radii.map(r => enclosedMassExcessMsun(r, profile) / 1e15),
                rEff, rs: profile.params.rsMpc,
            });
        }
        if (c('influence')) {
            drawInfluence(c('influence'), {
                shareProfile: influence.shareProfile,
                rEff, horizonMpc: influence.velocityHorizonMpc,
            });
        }
        if (c('rsd')) {
            const rs = radii.filter(r => r > 5);
            drawRsd(c('rsd'), {
                radii: rs,
                epsilon: rs.map(r => apparentEllipticity(r, profile, { z: Z })),
                quadrupole: rs.map(r => rsdQuadrupoleRatio(r, profile, { z: Z, bias: state.bias })),
                rEff,
            });
        }
        if (c('lensing')) {
            const rs = [];
            for (let r = 8; r < rEff * 2.4; r += rEff * 2.4 / 60) rs.push(r);
            drawLensing(c('lensing'), {
                radii: rs,
                deltaSigma: rs.map(r => deltaSigma(r, profile) / 1e12),
                snr: rs.map(r => lensingSNR(r, profile, {
                    zLens: Z, zSource: 0.9, annulusWidthMpc: 20, galaxiesPerArcmin2: 10,
                })),
                rEff,
            });
        }
        if (c('isw')) {
            const dA = angularDiameterDistanceMpc(Z);
            const bs = [];
            for (let b = 0; b < rEff * 2.6; b += rEff * 2.6 / 50) bs.push(b);
            drawIsw(c('isw'), {
                degrees: bs.map(b => b / dA * DEG),
                microK: bs.map(b => iswTemperatureShiftK(b, profile, { z: Z }) * 1e6),
                thetaEff: rEff / dA * DEG,
            });
        }
    }

    // ── Scene ───────────────────────────────────────────────────────────────
    function fieldVectorAt(pos) {
        const { profile, deficit, web } = derived;
        switch (state.mode) {
            case 'velocity': {
                const r = Math.hypot(pos[0], pos[1], pos[2]);
                if (r < 1e-6) return [0, 0, 0];
                const v = radialVelocityKms(r, profile, { z: Z });
                return [v * pos[0] / r, v * pos[1] / r, v * pos[2] / r];
            }
            case 'gravityB':
                return web.externalGravityAt(pos);
            case 'delta':
                return voidGravityVector(pos, [0, 0, 0], deficit, { z: Z });
            case 'tidal': {
                const tv = voidTidalTensor(pos, [0, 0, 0], deficit);
                const tw = web.externalTidalAt(pos);
                const { values, vectors } = symmetricEigen(tv.map((v, i) => v + tw[i]));
                const e1 = vectors[0];
                const m = Math.abs(values[0]);
                return [e1[0] * m, e1[1] * m, e1[2] * m];
            }
            case 'gravityA':
            default: {
                const gv = voidGravityVector(pos, [0, 0, 0], deficit, { z: Z });
                const gw = web.externalGravityAt(pos);
                return [gv[0] + gw[0], gv[1] + gw[1], gv[2] + gw[2]];
            }
        }
    }

    function paintScene() {
        if (!scene) return;
        const { profile, web, tracers } = derived;
        scene.buildShell(rEff, profile.params.rsMpc);
        scene.buildWeb(web);
        scene.buildMarkers(anchors, losUnit, rEff);

        // Redshift space is applied to the TRACERS only, because it is an
        // observational effect on measured positions — the mass distribution
        // itself does not move. Displacing the web too would be drawing a
        // universe in which structures are where their redshifts put them.
        const rsMap = state.redshiftSpace
            ? (t) => toRedshiftSpace(t.offsetMpc, profile, losUnit, { z: Z })
            : null;
        scene.buildTracers(tracers, { redshiftSpace: rsMap });

        const samples = fieldPoints.map(p => ({ position: p, vector: fieldVectorAt(p) }));
        let maxMag = 0;
        for (const s of samples) {
            maxMag = Math.max(maxMag, Math.hypot(s.vector[0], s.vector[1], s.vector[2]));
        }
        scene.buildField(samples, maxMag);

        const mode = FIELD_MODES[state.mode];
        const shown = state.mode === 'velocity'
            ? `${num(maxMag, 0)} km/s`
            : state.mode === 'tidal'
                ? `${num(maxMag, 3)} × 4πGρ̄`
                : `${num(maxMag * GYR_S / 1000, 1)} km/s per Gyr`;
        set('fieldMode', mode.label);
        set('fieldLegend', mode.legend);
        set('fieldMax', shown);

        for (const [name, on] of Object.entries(state.layers)) scene.setLayerVisible(name, on);
    }

    // ── Control wiring ──────────────────────────────────────────────────────
    //
    // Debounced because `recompute` is ~100 ms and a slider fires far faster
    // than that. The busy flag is set synchronously so the page can say it is
    // working rather than appearing to have frozen mid-drag.
    let busyTimer = null;
    function scheduleRecompute() {
        root.querySelector('#bv-busy')?.removeAttribute('hidden');
        clearTimeout(busyTimer);
        busyTimer = setTimeout(() => {
            recompute();
            root.querySelector('#bv-busy')?.setAttribute('hidden', '');
        }, 90);
    }

    root.querySelectorAll('[data-bv-control]').forEach(el => {
        const key = el.getAttribute('data-bv-control');
        const handler = () => {
            if (key === 'preset') state.preset = el.value;
            else if (key === 'bias') { state.bias = Number(el.value); set('bias', num(state.bias, 2)); }
            else if (key === 'clumpiness') {
                state.clumpiness = Number(el.value);
                set('clumpiness', num(state.clumpiness, 2));
            } else if (key === 'threshold') {
                state.velocityThresholdKms = Number(el.value);
                set('velocityThreshold', `${state.velocityThresholdKms} km/s`);
            } else if (key === 'mode') {
                state.mode = el.value;
                if (derived) paintScene();
                return;                                   // no physics changed
            } else if (key === 'redshiftSpace') {
                state.redshiftSpace = el.checked;
                if (derived) paintScene();
                return;
            } else if (key === 'autorotate') {
                scene?.setAutoRotate(el.checked);
                return;
            } else if (key.startsWith('layer:')) {
                const layer = key.slice(6);
                state.layers[layer] = el.checked;
                scene?.setLayerVisible(layer, el.checked);
                return;
            }
            scheduleRecompute();
        };
        el.addEventListener('input', handler);
        el.addEventListener('change', handler);
    });

    root.querySelector('#bv-reroll')?.addEventListener('click', () => {
        // A visible, deliberate re-roll. The seed is printed next to the
        // result so a reader can tell model variance from a control they moved.
        state.seed = (state.seed * 1103515245 + 12345) % 2147483647;
        scheduleRecompute();
    });
    root.querySelector('#bv-reframe')?.addEventListener('click', () => scene?.frameAll(rEff));

    const onResize = () => {
        scene?.resize();
        if (derived) paintCharts();
    };
    globalThis.addEventListener('resize', onResize);

    recompute();
    scene?.frameAll(rEff);

    // Test hook, in the shape the rest of this repo uses.
    const api = {
        get state() { return { ...state }; },
        get derived() { return derived; },
        recompute,
        setControl(key, value) {
            if (key in state) state[key] = value;
            scheduleRecompute();
        },
        outputs: () => [...outputs.keys()],
        written: () => [...written],
        dispose() {
            globalThis.removeEventListener('resize', onResize);
            clearTimeout(busyTimer);
            scene?.dispose();
        },
    };
    globalThis.__bootesLab = api;
    return api;
}
