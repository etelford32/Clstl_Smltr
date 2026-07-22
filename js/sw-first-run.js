/**
 * sw-first-run.js — the post-signin first-run flow for the space-weather
 * dashboard (SPACE_WEATHER_DASHBOARD_PLAN.md §11, phase D2): persona →
 * location → threshold in ≤3 taps, then a staged reveal.
 *
 * Shows ONCE: skipped when 'sw-first-run-done' is set, when a personal
 * layout already exists (existing users are not onboarded), or in
 * preview mode. Each step writes through the REAL stores — the preset
 * layout into the personal layout store, the pin through
 * user-location.js saveUserLocation, the Kp line through
 * threshold-profile.js saveProfile (which also hands off to the account
 * alert threshold). The reveal is one reload with a sessionStorage flag
 * ('sw-first-run-reveal' = persona) that the Stage reads to fly to the
 * persona's home station — the attract-style landing on YOUR staging.
 *
 * Funnel: first_run_view → _persona → _location → _threshold → _done
 * through the auth-funnel channel, all fail-quiet.
 */

const DONE_KEY = 'sw-first-run-done';
export const REVEAL_KEY = 'sw-first-run-reveal';

const step = (stage, props = {}) => {
    import('./auth-funnel.js')
        .then((m) => m.funnel.step(stage, props))
        .catch(() => {});
};

const CSS = `
#sw-first-run { position: fixed; inset: 0; z-index: 9000;
    background: rgba(3,1,14,.92); backdrop-filter: blur(6px);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
.fr-card { width: 420px; max-width: 94vw; background: var(--sw-surface-raised, rgba(16,24,48,.97));
    border: 1px solid var(--sw-border-focus, rgba(0,198,255,.45)); border-radius: 14px;
    padding: 20px 22px; color: var(--sw-text, #cdd); font-family: 'Segoe UI', system-ui, sans-serif; }
.fr-card h3 { color: var(--sw-text-bright, #e8f4ff); font-size: 1.05rem; margin-bottom: 4px; }
.fr-card .fr-sub { font-size: .74rem; color: var(--sw-text-muted, #8b94ad); margin-bottom: 14px; }
.fr-options { display: grid; gap: 8px; }
.fr-options button { text-align: left; padding: 10px 12px; border-radius: 9px; cursor: pointer;
    background: var(--sw-surface-card, rgba(10,16,34,.66));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09)); color: var(--sw-text, #cdd);
    font: inherit; transition: border-color var(--sw-t-snap, .15s ease); }
.fr-options button:hover { border-color: var(--sw-accent, #4fc3f7); }
.fr-options b { color: var(--sw-text-bright, #e8f4ff); display: block; font-size: .85rem; }
.fr-options small { font-size: .68rem; color: var(--sw-text-muted, #8b94ad); }
.fr-row { display: flex; gap: 8px; margin-top: 6px; }
.fr-row input { flex: 1; min-width: 0; font: inherit; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--sw-border, rgba(255,255,255,.09)); background: rgba(0,10,26,.85);
    color: var(--sw-text-bright, #e8f4ff); }
.fr-row button, .fr-skip { font: 700 12px/1 system-ui; padding: 9px 14px; border-radius: 8px;
    cursor: pointer; border: 1px solid var(--sw-border-focus, rgba(0,198,255,.45));
    background: rgba(0,30,55,.85); color: var(--sw-text, #cdd); }
.fr-skip { display: block; margin: 12px auto 0; background: transparent;
    border-color: transparent; color: var(--sw-text-dim, #68718a); }
.fr-kp { display: flex; gap: 8px; }
.fr-kp button { flex: 1; padding: 12px 0; border-radius: 9px; cursor: pointer;
    font: 800 15px/1 system-ui; background: var(--sw-surface-card, rgba(10,16,34,.66));
    border: 1px solid var(--sw-border, rgba(255,255,255,.09)); color: var(--sw-text-bright, #e8f4ff); }
.fr-kp button:hover { border-color: var(--sw-accent, #4fc3f7); }
.fr-note { font-size: .62rem; color: var(--sw-text-dim, #68718a); margin-top: 10px; }
`;

export async function mountFirstRun(page = 'space-weather') {
    if (typeof document === 'undefined') return;
    try {
        if (document.documentElement.hasAttribute('data-preview')) return;
        if (localStorage.getItem(DONE_KEY)) return;
        if (localStorage.getItem(`pp-layout.${page}`)) {
            localStorage.setItem(DONE_KEY, '1');   // existing user — never onboard
            return;
        }
        const res = await fetch('data/layout-presets/space-weather.json', { cache: 'no-cache' });
        if (!res.ok) return;
        const presets = (await res.json()).presets || {};
        if (!Object.keys(presets).length) return;

        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        const overlay = document.createElement('div');
        overlay.id = 'sw-first-run';
        overlay.innerHTML = '<div class="fr-card"></div>';
        document.body.appendChild(overlay);
        const card = overlay.firstElementChild;
        step('first_run_view');

        let persona = null;

        const finish = () => {
            try { localStorage.setItem(DONE_KEY, '1'); } catch {}
            try { if (persona) sessionStorage.setItem(REVEAL_KEY, persona); } catch {}
            step('first_run_done', { persona });
            overlay.remove();
            // The staged reveal: boot fresh from the chosen preset; the
            // Stage reads the reveal flag and flies to your staging.
            setTimeout(() => location.reload(), 150);
        };

        const stepThreshold = () => {
            card.innerHTML = `
                <h3>Your Kp line</h3>
                <div class="fr-sub">When Kp reaches this, the console escalates and your
                aurora alerts fire. You can change it any time (⚙ on the status band).</div>
                <div class="fr-kp"></div>
                <div class="fr-note">Kp 5 = G1 storm — aurora reaches the northern-tier
                states; lower is chattier, higher is quieter.</div>`;
            const row = card.querySelector('.fr-kp');
            for (const kp of [4, 5, 6, 7]) {
                const b = document.createElement('button');
                b.textContent = `Kp ${kp}`;
                b.addEventListener('click', async () => {
                    try {
                        const m = await import('./threshold-profile.js');
                        m.saveProfile({ ...m.PROFILE_DEFAULTS, kp });
                    } catch {}
                    step('first_run_threshold', { kp });
                    finish();
                });
                row.appendChild(b);
            }
        };

        const stepLocation = () => {
            card.innerHTML = `
                <h3>Where do you watch from?</h3>
                <div class="fr-sub">Your pin drives the tonight call, My Sky, and the
                drive-ring distance to the oval.</div>
                <div class="fr-row">
                    <input type="search" placeholder="City or zip…" aria-label="Your location">
                    <button type="button">Set</button>
                </div>
                <button type="button" class="fr-skip">Skip for now</button>`;
            const input = card.querySelector('input');
            const go = async () => {
                const q = input.value.trim();
                if (!q) return;
                try {
                    const m = await import('./user-location.js');
                    const loc = await m.geocodeQuery(q);
                    m.saveUserLocation(loc);
                    step('first_run_location', { set: true });
                } catch { step('first_run_location', { set: false, failed: true }); }
                stepThreshold();
            };
            card.querySelector('.fr-row button').addEventListener('click', go);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
            card.querySelector('.fr-skip').addEventListener('click', () => {
                step('first_run_location', { set: false });
                stepThreshold();
            });
        };

        card.innerHTML = `
            <h3>Make this console yours</h3>
            <div class="fr-sub">Pick how you use space weather — it arranges the
            dashboard for you. Everything stays editable.</div>
            <div class="fr-options"></div>
            <button type="button" class="fr-skip">Keep the default layout</button>`;
        const opts = card.querySelector('.fr-options');
        for (const [key, p] of Object.entries(presets)) {
            const b = document.createElement('button');
            b.innerHTML = `<b>${p.label}</b><small>${p.blurb}</small>`;
            b.addEventListener('click', () => {
                persona = key;
                try {
                    localStorage.setItem(`pp-layout.${page}`, JSON.stringify(p.layout));
                } catch {}
                step('first_run_persona', { persona: key });
                stepLocation();
            });
            opts.appendChild(b);
        }
        card.querySelector('.fr-skip').addEventListener('click', () => {
            step('first_run_persona', { persona: null });
            stepLocation();
        });
    } catch (e) {
        console.warn('[first-run] disabled:', e);
        try { document.getElementById('sw-first-run')?.remove(); } catch {}
    }
}
