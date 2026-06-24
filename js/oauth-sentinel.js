/**
 * oauth-sentinel.js — catch-and-recover for OAuth / OTP tokens that land
 * on the wrong page.
 *
 * Background (the production bug this exists for): Supabase returns the
 * session in the URL hash (`#access_token=…`) to whatever redirect URL it
 * resolved. If that resolution falls back to the Site-URL root — e.g. a
 * missing redirect-allow-list entry, or the `?from=` query not matching a
 * pattern — the token lands on a normal page like `/` instead of
 * `/auth-callback.html`, and is silently dropped. The user never gets
 * signed in, and we had ZERO telemetry for it.
 *
 * This module is imported by nav.js, so it runs on every page that mounts
 * the nav. As early as possible it:
 *   1. detects an OAuth/OTP payload (or error) sitting in the hash of a
 *      page that is NOT the callback,
 *   2. records a telemetry signal — so the misland shows up on the admin
 *      "Top auth failures" + auth-funnel cards instead of being invisible,
 *   3. forwards to /auth-callback.html (preserving the hash), which knows
 *      how to hydrate the session and route the user.
 *
 * Net effect: the bug becomes visible AND self-heals.
 */
import { telemetry } from './telemetry.js';
import { funnel } from './auth-funnel.js';

(function oauthSentinel() {
    try {
        const path = window.location.pathname || '';
        // The real callback page owns its own hash — never act there. (It
        // also doesn't mount the nav, so this is belt-and-suspenders.)
        if (/\/auth-callback\.html$/.test(path)) return;

        const rawHash = (window.location.hash || '').replace(/^#/, '');
        if (!rawHash) return;

        // A bare in-page anchor (#section) is not an auth payload — only act
        // on the Supabase fragment shapes.
        const hp = new URLSearchParams(rawHash);
        const hasToken = hp.has('access_token');
        const hasError = hp.has('error') || hp.has('error_description');
        const linkType = hp.get('type');
        // Email links (magic-link, recovery, signup-confirm, invite) also
        // arrive as hash payloads only the callback knows how to finish.
        const isEmailLink = ['magiclink', 'recovery', 'signup', 'invite', 'email_change']
            .includes(linkType || '');

        if (!hasToken && !hasError && !isEmailLink) return;

        const meta = {
            source: 'oauth_sentinel',
            landed_path: path,
            type: linkType || null,
            had_token: hasToken,
            error: hasError ? (hp.get('error') || null) : null,
            error_description: hasError ? (hp.get('error_description') || null) : null,
        };

        // Fire-and-forget on BOTH surfaces: recordAuthFailure feeds the admin
        // "Top auth failures" card; funnel.step stitches into the auth funnel
        // so a spike is visible next to the real-user flow.
        try { telemetry.recordAuthFailure('oauth_redirect_misland', meta); } catch {}
        try { funnel.step('oauth_redirect_misland', meta); } catch {}

        // Forward to the real callback, preserving the hash (tokens/error live
        // there). location.replace keeps this bounce out of back-button
        // history. The short delay gives the telemetry beacon a moment to
        // flush before navigation tears down this page.
        const dest = `/auth-callback.html?from=recovered_misland#${rawHash}`;
        setTimeout(() => { try { window.location.replace(dest); } catch {} }, 200);
    } catch {
        /* a sentinel must never break page load */
    }
})();
