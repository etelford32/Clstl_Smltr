// bundle.js — Storm Observatory lane bundles: load, validate, sample.
//
// A lane bundle (data/storm/<id>.json, built by scripts/build-storm-bundle.mjs)
// is the additive sibling of the Gannon replay bundle: same honesty rules
// (`_is_placeholder`, `provenance`), plus the piece the observatory needs
// that the Gannon page doesn't — a full NRLMSISE-00 density GRID ρ(alt, t)
// computed offline with the event's REAL 3-hourly ap history, so the hot
// loop is table lookups only (exactly the Dehnen-closed-form move in the
// black-hole observatory).
//
// Schema (schema_version 1, kind "storm-observatory-lane"):
//   window        { start, end, step_minutes }        — hourly grid
//   t_peak_hours  hours from window.start of the ap maximum (the τ=0 anchor)
//   drivers       { ap:[…], f107:[…] }                — one value per grid step
//   density_grid  { alt_km:[…], log10_rho:[t][alt] }
//   truth?        { source, samples:[{t_hours, alt_km, rho}] }   — e.g. GRACE-FO
//   cohort?       [{name, a_km, e, incl_deg, raan_deg, argp_deg, m0_deg, bc}]
//
// DensityGrid samples bilinearly in (t, alt) on log10ρ and extrapolates
// beyond the altitude table by the local scale height (the bottom rows
// matter: reentry happens below the 150 km table edge).

export class DensityGrid {
    constructor(altKm, log10Rho, stepHours) {
        this.altKm = altKm;
        this.logRho = log10Rho;              // [t][alt]
        this.stepHours = stepHours;
        this.nT = log10Rho.length;
        this.nA = altKm.length;
    }

    /** log10 ρ at (altitude km, hours from window start), clamped in t. */
    _logAt(hKm, tHours) {
        const { altKm, logRho, nT, nA } = this;
        let ft = tHours / this.stepHours;
        ft = Math.min(Math.max(ft, 0), nT - 1);
        const i0 = Math.floor(ft), i1 = Math.min(i0 + 1, nT - 1);
        const wt = ft - i0;

        // altitude bracket (uniform table assumed but handled generically)
        let j = 0;
        while (j < nA - 2 && altKm[j + 1] < hKm) j++;
        const a0 = altKm[j], a1 = altKm[j + 1];
        // fa < 0 or > 1 extrapolates on the local log-slope = scale height
        const fa = (hKm - a0) / (a1 - a0);

        const row = (i) => logRho[i][j] + (logRho[i][j + 1] - logRho[i][j]) * fa;
        return row(i0) * (1 - wt) + row(i1) * wt;
    }

    /** Mass density (kg/m³). The result is quantized to float32: pow10 is
     *  the one transcendental in the drag hot path, and JS/Rust libm may
     *  disagree in the last f64 ULP — f32 rounding removes that divergence,
     *  which is what lets the WASM kernel stay BIT-EXACT with this engine
     *  (same trick as the black-hole observatory's f32 store/reload). */
    sample(hKm, tHours) {
        return Math.fround(Math.pow(10, this._logAt(Math.max(hKm, 80), tHours)));
    }
}

/** Validate + hydrate a lane bundle object (already-parsed JSON). */
export function hydrateBundle(raw) {
    if (raw.kind !== 'storm-observatory-lane' || raw.schema_version !== 1) {
        throw new Error(`not a storm lane bundle: ${raw.kind}/${raw.schema_version}`);
    }
    const g = raw.density_grid;
    if (!g?.alt_km?.length || !g?.log10_rho?.length ||
        g.log10_rho[0].length !== g.alt_km.length) {
        throw new Error('malformed density_grid');
    }
    const stepHours = raw.window.step_minutes / 60;
    const nT = g.log10_rho.length;
    if (raw.drivers.ap.length !== nT || raw.drivers.f107.length !== nT) {
        throw new Error('driver series length mismatch with grid');
    }
    return {
        id: raw.event,
        label: raw.label,
        placeholder: !!raw._is_placeholder,
        window: raw.window,
        stepHours,
        durationHours: (nT - 1) * stepHours,
        tPeakHours: raw.t_peak_hours,
        drivers: raw.drivers,
        grid: new DensityGrid(g.alt_km, g.log10_rho, stepHours),
        truth: raw.truth ?? null,
        cohort: raw.cohort ?? null,
        provenance: raw.provenance ?? {},
    };
}

export async function loadBundle(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`bundle fetch failed: ${url} → ${resp.status}`);
    return hydrateBundle(await resp.json());
}

// ── Scenario lane ─────────────────────────────────────────────────────────────
// The third lane is a HYBRID: it defaults to the quiet counterfactual, but its
// density history is composable from any base bundle plus three dials:
//
//   intensity α  — log-space interpolation between the QUIET grid and the base
//                  grid: logρ = logρ_quiet + α·(logρ_base − logρ_quiet).
//                  α=0 is exactly quiet, α=1 exactly the base event, α>1 an
//                  extrapolated "worse than observed" (tagged free/extrapolated).
//   onset shift  — slides the storm in τ (hours).
//   duration ×   — stretches the storm's time axis about its peak.
//
// Both grids must share the altitude table (the builder guarantees it). The
// quiet grid is padded/clamped in t, so scenarios longer than the quiet
// fixture stay defined.

export class ScenarioGrid {
    constructor(quiet, base, { alpha = 1, onsetShiftHours = 0, durationScale = 1 } = {}) {
        if (quiet.altKm.length !== base.altKm.length) {
            throw new Error('scenario grids must share an altitude table');
        }
        this.quiet = quiet;
        this.base = base;
        this.alpha = alpha;
        this.onset = onsetShiftHours;
        this.durScale = durationScale;
        this.tPeakBase = 0;          // set by makeScenario (peak-centred stretch)
        this.altKm = base.altKm;
        this.stepHours = base.stepHours;
        this.nT = base.nT;
    }

    /** log10 ρ of the composed scenario (used by the baker + sample). */
    logAt(hKm, tHours) {
        // stretch about the base peak, then shift
        const tBase = this.tPeakBase + (tHours - this.onset - this.tPeakBase) / this.durScale;
        const lq = this.quiet._logAt(Math.max(hKm, 80), tHours);
        const lb = this.base._logAt(Math.max(hKm, 80), tBase);
        return lq + this.alpha * (lb - lq);
    }

    sample(hKm, tHours) {
        return Math.fround(Math.pow(10, this.logAt(hKm, tHours)));
    }

    /** Bake to a flat DensityGrid over nT steps — the engines (JS reference
     *  and the WASM kernel) both consume BAKED tables, so a scenario dial
     *  change is a rebake + re-upload, and parity holds for every lane. */
    bake(nT) {
        const rows = [];
        for (let i = 0; i < nT; i++) {
            rows.push(this.altKm.map(h => this.logAt(h, i * this.stepHours)));
        }
        return new DensityGrid(this.altKm, rows, this.stepHours);
    }
}

/**
 * Compose the scenario lane from hydrated bundles.
 * @param quietBundle  hydrated quiet lane (α=0 reference)
 * @param baseBundle   hydrated event to draw the storm shape from
 */
export function makeScenario(quietBundle, baseBundle, dials = {}) {
    const grid = new ScenarioGrid(quietBundle.grid, baseBundle.grid, dials);
    grid.tPeakBase = baseBundle.tPeakHours;
    const alpha = dials.alpha ?? 1;
    return {
        id: 'scenario',
        label: alpha === 0
            ? `Scenario — quiet (${quietBundle.label})`
            : `Scenario — ${baseBundle.label} × ${alpha.toFixed(2)}`,
        placeholder: quietBundle.placeholder || baseBundle.placeholder,
        stepHours: baseBundle.stepHours,
        durationHours: baseBundle.durationHours * (dials.durationScale ?? 1),
        tPeakHours: baseBundle.tPeakHours * (dials.durationScale ?? 1) +
            (dials.onsetShiftHours ?? 0),
        drivers: baseBundle.drivers,      // displayed dimmed with the α badge
        grid,
        truth: null,                       // scenarios never claim truth
        cohort: null,
        provenance: {
            scenario: `α=${alpha} onset=${dials.onsetShiftHours ?? 0}h ` +
                `dur×${dials.durationScale ?? 1} — base ${baseBundle.id}, ` +
                `quiet ${quietBundle.id} (log-space interpolation; α>1 is ` +
                `extrapolation beyond the observed event)`,
        },
    };
}
