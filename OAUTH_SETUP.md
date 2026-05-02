# OAuth setup — Google + Apple

End-to-end runbook for enabling third-party sign-in. Two providers are
in scope: Google (shipping in the same commit as this doc) and Apple
(staged — code paths exist, the provider button is hidden behind a
single `SOCIAL_PROVIDERS` flag in `js/config.js` until the Supabase
side is configured and a real iOS launch is on the calendar).

The code side is generic across providers; all the work below is
account/console configuration that has to happen outside the repo.

---

## Architecture refresher

```
[ Browser ]
  ↓ click "Continue with Google"
  ↓ supabase.auth.signInWithOAuth({ provider:'google',
  ↓   options: { redirectTo: '<APP_URL>/auth-callback.html' } })
  ↓
[ accounts.google.com ]    ← user authorises
  ↓
[ Supabase /auth/v1/callback ]   ← Supabase exchanges the code,
  ↓                                creates auth.users row if new,
  ↓                                fires our handle_new_user trigger
  ↓
[ <APP_URL>/auth-callback.html#access_token=… ]
  ↓ supabase-js auto-detects the hash, hydrates the session
  ↓ auth-callback.html:
  ↓   - new user?  → stamp pp_welcome_pending, log 'signup',
  ↓                   POST /api/welcome/send
  ↓   - returning? → log 'signin_succeeded'
  ↓ window.location.href = '/dashboard.html'
[ /dashboard.html ]   ← welcome wizard fires for new users
```

The callback page is the only application-level addition; everything
else routes through the existing welcome-email + activation
infrastructure.

---

## Google — full sequence

### 1. Google Cloud Console (one-time per project)

1. Open https://console.cloud.google.com → pick your project (or
   create one named e.g. `parker-physics-prod`).
2. **APIs & Services → OAuth consent screen**:
   * User Type: **External**.
   * App name: `Parker Physics`.
   * User support email: a real human inbox.
   * App logo: 120×120 transparent PNG of the brand mark
     (use `ParkersPhysics_logo2.jpg` resized).
   * Authorised domains: `parkerphysics.com`.
   * Developer contact email: same as support.
   * Scopes: keep the defaults (`openid`, `email`, `profile`).
   * Test users: add your own email + 2–3 collaborator emails so the
     app can be tested while in "Testing" status.
   * Publish status: **In production** when you're ready to take live
     traffic. Until then the consent screen warns external users that
     the app isn't verified, which scares them off.

3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   * Application type: **Web application**.
   * Name: `Supabase OAuth (prod)`.
   * Authorised JavaScript origins:
     * `https://<project-ref>.supabase.co`
     * `https://parkerphysics.com`
     * `https://parkersphysics.com` (the alternate spelling we own)
   * Authorised redirect URIs:
     * `https://<project-ref>.supabase.co/auth/v1/callback`
     * (NOT `https://parkerphysics.com/auth-callback.html` — Google
       only sees Supabase, never our domain.)
   * Click Create. Copy the **Client ID** and **Client secret** that
     appear in the dialog. Treat the secret as a credential.

### 2. Supabase dashboard

1. Open https://supabase.com/dashboard/project/<project-ref> →
   **Authentication → Providers → Google**.
2. Toggle **Enable Sign in with Google** ON.
3. Paste:
   * Client ID (from Google Cloud step 3)
   * Client Secret (from Google Cloud step 3)
4. Leave "Skip nonce check" OFF.
5. The **Callback URL (for OAuth)** field shows
   `https://<project-ref>.supabase.co/auth/v1/callback`. Verify this
   matches the redirect URI you put in Google Cloud step 3 exactly.
6. **Authentication → URL Configuration**:
   * **Site URL**: `https://parkerphysics.com`
   * **Redirect URLs** allow-list: add
     * `https://parkerphysics.com/auth-callback.html`
     * `https://parkerphysics.com/auth-callback.html?**`
     * `http://localhost:3000/auth-callback.html` (dev only)
   * Without these the OAuth redirect comes back as
     `https://parkerphysics.com/?error=invalid_redirect`.
7. Save.

### 3. Apply the database migration

```bash
psql "$SUPABASE_DB_URL" -f supabase-oauth-trigger-migration.sql
```

This refreshes the `handle_new_user` trigger to extract the display
name from the metadata shapes Google + Apple actually return
(`full_name`, `name`, `given_name`+`family_name`) instead of just
`name`. Existing email-password signups keep working because `name`
remains in the fallback chain.

### 4. Flip the feature flag (already on)

`js/config.js` ships with `SOCIAL_PROVIDERS = ['google']`. The
`Continue with Google` button only renders for providers in that
array, so the feature is already live the moment the steps above are
done.

### 5. Smoke test

1. Open an incognito window, hit `/signin.html`.
2. Click `Continue with Google`. Authorise with one of the test users
   you added in step 1.
3. You should land on `/auth-callback.html`, see "Signing you in…"
   for ~1s, then bounce to `/dashboard.html`.
4. The welcome wizard should auto-open.
5. In Supabase SQL editor:
   ```sql
   SELECT id, email, raw_user_meta_data, created_at
     FROM auth.users
    WHERE email = '<your-test-email>';
   SELECT * FROM public.user_profiles WHERE id = '<that-id>';
   SELECT * FROM public.activation_events
    WHERE user_id = '<that-id>' ORDER BY created_at;
   ```
   You should see one auth.users row, one user_profiles row with the
   display name from Google, and `signup` + `welcome_email_sent`
   activation events.

---

## Apple — staged

The code is provider-agnostic. To turn Apple on:

1. Apple Developer account (paid, $99/yr) → Certificates, Identifiers
   & Profiles → register a new **Services ID** (`com.parkerphysics.signin`).
2. Configure **Sign in with Apple** on the Services ID; add
   `https://<project-ref>.supabase.co/auth/v1/callback` as the Return
   URL.
3. Generate a **Sign in with Apple key** (.p8 file). Copy the Key ID,
   Team ID, and the contents of the .p8.
4. Supabase dashboard → Authentication → Providers → **Apple** →
   paste the Services ID, Team ID, Key ID, and the .p8 contents.
   Save.
5. In `js/config.js` change:
   ```js
   export const SOCIAL_PROVIDERS = Object.freeze(['google']);
   ```
   to:
   ```js
   export const SOCIAL_PROVIDERS = Object.freeze(['google', 'apple']);
   ```
6. Apple's privacy proxy means the user's email may be hidden behind
   `<random>@privaterelay.appleid.com`. The handle_new_user trigger
   already handles this — display_name falls through to the email
   local-part if no `name` / `full_name` is provided. Surface a
   short "your alias forwards to your real email" hint somewhere
   in `/account` once Apple is on.

---

## Rollback

If something breaks in production:

1. **Supabase dashboard** → Authentication → Providers → Google →
   toggle OFF. Existing OAuth sessions remain valid (they're plain
   JWTs); only NEW sign-in attempts will be blocked.
2. Or, **client-side** kill switch: change `js/config.js` to
   `SOCIAL_PROVIDERS = []`. The buttons stop rendering; password
   signin keeps working. Lighter than touching Supabase.
3. The DB trigger update in `supabase-oauth-trigger-migration.sql`
   is backwards-compatible — email-password signups keep working
   regardless. No rollback migration needed.
