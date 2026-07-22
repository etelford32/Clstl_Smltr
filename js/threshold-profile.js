/**
 * threshold-profile.js — ONE per-user threshold line for the whole
 * space-weather console (SPACE_WEATHER_DASHBOARD_PLAN.md §8, phase D2).
 *
 * Profile shape: { kp, minBzNt, dstNt, leoAltKm }. Set your line once —
 * every consumer honors it: the status band (Kp-cell escalation + the
 * ⚙ editor lives there), the Stage (heat-shell altitude, oval-median
 * emphasis), and — the ALERT-SENDER HANDOFF — the account alert stack:
 * saving the Kp line also writes `user_profiles.aurora_kp_threshold`
 * through auth.updateProfile(), the SAME column js/alert-engine.js,
 * account.html, and the alert products already read. One line, one
 * column, no forks.
 *
 * The plan's §8 shape lists gScale alongside kp; gScale is fully
 * determined by kp (G1 = Kp 5 … G5 = Kp 9), so it is DERIVED here
 * (gScaleForKp), never stored — a stored copy could contradict kp.
 *
 * Storage: localStorage `pp-threshold-profile`. First load seeds kp from
 * the signed-in profile's aurora_kp_threshold (via the pp_auth mirror —
 * works even when Supabase is cold, same belt-and-suspenders as the
 * gate). Every save dispatches 'threshold-profile-changed' on window.
 *
 * Pure logic up top (node-tested by tests/threshold-profile.mjs); the
 * storage/auth glue is guarded for non-DOM imports.
 */

export const PROFILE_DEFAULTS = Object.freeze({
    kp: 5,          // your Kp line (G1) — the alert-handoff field
    minBzNt: -10,   // sustained southward Bz you care about
    dstNt: -50,     // storm-depth line (moderate storm)
    leoAltKm: 550,  // the drag altitude you fly at
});

const CLAMP = Object.freeze({
    kp: [0, 9], minBzNt: [-60, 0], dstNt: [-600, 0], leoAltKm: [200, 2000],
});

export const STORAGE_KEY = 'pp-threshold-profile';
export const CHANGE_EVENT = 'threshold-profile-changed';

/** G-scale (0–5) for a Kp value: G1 = Kp 5 … G5 = Kp 9 (NOAA table). */
export function gScaleForKp(kp) {
    if (!Number.isFinite(kp)) return 0;
    return Math.max(0, Math.min(5, Math.floor(kp) - 4));
}

/** Clamp/complete an untrusted profile doc. Always returns a full doc. */
export function normalizeProfile(raw) {
    const out = { ...PROFILE_DEFAULTS };
    if (raw && typeof raw === 'object') {
        for (const k of Object.keys(PROFILE_DEFAULTS)) {
            const v = Number(raw[k]);
            if (Number.isFinite(v)) {
                const [lo, hi] = CLAMP[k];
                out[k] = Math.min(hi, Math.max(lo, v));
            }
        }
    }
    return out;
}

export function profilesEqual(a, b) {
    return JSON.stringify(normalizeProfile(a)) === JSON.stringify(normalizeProfile(b));
}

/* ── Storage + handoff (browser only) ─────────────────────────────────── */

/**
 * Load the profile. When no local doc exists yet, the Kp line seeds from
 * the signed-in account's aurora_kp_threshold so the dashboard and the
 * alert stack start in agreement.
 */
export function loadProfile() {
    if (typeof localStorage === 'undefined') return { ...PROFILE_DEFAULTS };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return normalizeProfile(JSON.parse(raw));
    } catch {}
    const seed = { ...PROFILE_DEFAULTS };
    try {
        const authRaw = localStorage.getItem('pp_auth') || sessionStorage.getItem('pp_auth');
        const acct = authRaw ? JSON.parse(authRaw) : null;
        if (Number.isFinite(Number(acct?.aurora_kp_threshold))) {
            seed.kp = Number(acct.aurora_kp_threshold);
        }
    } catch {}
    return normalizeProfile(seed);
}

/**
 * Persist + broadcast + hand off. The auth write is fail-quiet and
 * fire-and-forget: with a live Supabase session it lands in
 * user_profiles.aurora_kp_threshold; in cold/mock states it merges into
 * the local auth mirror and syncs on the next real session.
 */
export function saveProfile(raw) {
    const doc = normalizeProfile(raw);
    if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(doc)); } catch {}
    }
    if (typeof window !== 'undefined') {
        try {
            window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: doc }));
        } catch {}
        import('./auth.js')
            .then(({ auth }) => {
                if (auth.isSignedIn()) {
                    return auth.updateProfile({ aurora_kp_threshold: doc.kp });
                }
            })
            .catch(() => {});
    }
    return doc;
}
