// Cross-validation harness: dump JS-engine density at a fixed grid so
// the Python port in jacchia_residuals.py can be diffed against it.
// Invoked by tests/jacchia_parity_test.py.
import { density, exosphereTempK, batesTemperature } from "../../js/upper-atmosphere-engine.js";

const altitudes = [120, 200, 300, 420, 600, 1000, 1500];
const f107s     = [70, 150, 250];
const aps       = [4, 39, 200];

const out = [];
for (const alt of altitudes) {
    for (const f107 of f107s) {
        for (const ap of aps) {
            const r = density({ altitudeKm: alt, f107Sfu: f107, ap });
            out.push({
                alt_km: alt, f107_sfu: f107, ap,
                t_inf_K: exosphereTempK(f107, ap),
                t_local_K: batesTemperature(alt, exosphereTempK(f107, ap)),
                rho_kg_m3: r.rho,
            });
        }
    }
}
process.stdout.write(JSON.stringify(out));
