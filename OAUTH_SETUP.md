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

## Apple — full sequence

Apple's developer console is more layered than Google's. The order of
the steps below matters: an App ID has to exist BEFORE you can create
a Services ID that targets it, and you can't generate the signing key
until both exist. Doing the steps out of order produces "this
identifier is not associated with any service" errors that look like
bugs but are actually missing prerequisites.

### Pre-flight (one-time per organisation)

1. You need an **Apple Developer Program** membership ($99/yr).
   Personal account is fine for first launch; switch to an
   Organisation account before app-store distribution if it's a
   company offering.
2. You need a domain you can prove control of via DNS — the same one
   in `Site URL` on the Supabase side. We use `parkerphysics.com`.
3. Decide on your Bundle/Service identifier prefix now and stick with
   it. We use the reverse-DNS form `com.parkerphysics`. The Service
   ID in particular cannot be renamed, only deleted + recreated, and
   recreating breaks every issued JWT.

### 1. Apple Developer console — App ID

The "App ID" is the parent identifier. The Services ID we create in
step 2 references it.

1. Open https://developer.apple.com/account/resources/identifiers/list
2. Click **+** (top of the table), choose **App IDs** → Continue.
3. Type: **App** → Continue.
4. Description: `Parker Physics` (free-form; only shown to you).
5. Bundle ID: **Explicit**: `com.parkerphysics.app`.
6. **Capabilities** — scroll the long list, find **Sign in with Apple**
   and tick it. (No "Configure" needed at the App ID level — that
   happens on the Services ID.)
7. Continue → Register.

### 2. Apple Developer console — Services ID

The "Services ID" is what Supabase actually authenticates against —
it represents the *web* surface of the App ID we just created.

1. Same page → **+** → **Services IDs** → Continue.
2. Description: `Parker Physics web sign-in`.
3. Identifier: `com.parkerphysics.signin`.
   * NOT the same as the App ID; pick something distinct (we suffix
     `.signin`). Apple validates uniqueness across all Apple
     developer accounts globally — collisions force you to pick
     another suffix.
4. Continue → Register.
5. Click the new Services ID in the list to edit it.
6. Tick **Sign in with Apple** → click **Configure** next to it.
7. In the modal:
   * **Primary App ID**: pick `com.parkerphysics.app` (the App ID
     from step 1).
   * **Domains and Subdomains** (one per line):
     ```
     <project-ref>.supabase.co
     ```
     You only put the Supabase domain here — NOT
     `parkerphysics.com`, because the Apple → Supabase round-trip
     never touches our domain.
   * **Return URLs** (one per line):
     ```
     https://<project-ref>.supabase.co/auth/v1/callback
     ```
8. Save → Continue → Save again on the parent screen.
9. Apple is *very* particular about domain verification at the App
   ID layer for native apps; the **web** Services ID does NOT
   require uploading the apple-developer-domain-association file
   to your server, but the dialog mentions it. Ignore — only the
   App ID needs that, and only if you're shipping a native iOS app.

### 3. Apple Developer console — Sign in with Apple key (.p8)

The signing key is what Supabase uses to mint the client secret JWT
on every auth attempt. Apple does not let you re-download it — save
the .p8 file to a password manager on the spot.

1. https://developer.apple.com/account/resources/authkeys/list
2. **+** (top of table) → Key Name: `Parker Physics Sign in with Apple`.
3. Tick **Sign in with Apple** → click **Configure**.
4. In the modal: pick `com.parkerphysics.app` (the App ID from step 1)
   as the Primary App ID. Save.
5. Continue → Register → **Download**. The browser saves
   `AuthKey_<KEYID>.p8` (e.g. `AuthKey_AB1CD2EFGH.p8`).
6. **Right now**, before you close the page, copy:
   * **Key ID**: the 10-character string Apple shows on the next
     screen (e.g. `AB1CD2EFGH`).
   * **Team ID**: visible in the top-right of every developer console
     page (e.g. `1A2B3C4D5E`).
   * The contents of the .p8 file (cat it; it's plain text — a
     `-----BEGIN PRIVATE KEY-----` PEM block).

You now have four values to paste into Supabase:
   - Services ID (`com.parkerphysics.signin`)
   - Team ID (10 chars)
   - Key ID (10 chars)
   - `.p8` PEM contents (multi-line)

### 4. Supabase dashboard

1. https://supabase.com/dashboard/project/<project-ref> →
   **Authentication → Providers → Apple**.
2. Toggle **Enable Sign in with Apple** ON.
3. **Services ID**: `com.parkerphysics.signin`
4. **Team ID**: from step 3
5. **Key ID**: from step 3
6. **Secret Key (for OAuth)**: paste the entire .p8 file contents,
   including the `-----BEGIN PRIVATE KEY-----` and
   `-----END PRIVATE KEY-----` lines.
7. The **Callback URL (for OAuth)** field shows
   `https://<project-ref>.supabase.co/auth/v1/callback`. Verify this
   matches the Return URL you configured on the Services ID in step 2.
8. Save.
9. **Authentication → URL Configuration**: confirm
   `https://parkerphysics.com/auth-callback.html` is already in the
   Redirect URLs allow-list (it should be from the Google setup).

### 5. Flip the feature flag

Open `js/config.js` and change:
```js
export const SOCIAL_PROVIDERS = Object.freeze(['google']);
```
to:
```js
export const SOCIAL_PROVIDERS = Object.freeze(['google', 'apple']);
```

That's the only code change needed — `js/oauth-buttons.js` already
has the Apple brand button + click handler wired and waiting; the
flag gates whether it renders.

Commit, push, deploy.

### 6. Smoke test

1. Incognito window → `/signin.html`. The "Continue with Apple"
   button should appear below "Continue with Google".
2. Click it. You'll be redirected to `appleid.apple.com`. Sign in
   with the Apple ID of a developer-team member or a guest tester.
3. Apple's consent screen offers two options: share your real email
   or use a private relay address. Pick whichever; both work.
4. You should bounce back through `/auth-callback.html` and land on
   `/dashboard.html` with the welcome wizard open.
5. In Supabase SQL editor, confirm the user landed correctly:
   ```sql
   SELECT id, email, raw_user_meta_data, created_at
     FROM auth.users
    WHERE email LIKE '%@privaterelay.appleid.com'
       OR email = '<your-real-test-email>'
    ORDER BY created_at DESC LIMIT 1;
   ```
   For private-relay users `email` will look like
   `xyz123@privaterelay.appleid.com`. Forward to your real inbox is
   handled by Apple — your Resend welcome email will reach the user
   at their real address even though we never see it.

### Apple-specific gotchas we already handle

* **Name only sent on first auth** — Apple's privacy model only
  surfaces `user.user_metadata.name` on the *very first* OAuth
  consent. Subsequent sign-ins return no name. The
  `handle_new_user` trigger from
  `supabase-oauth-trigger-migration.sql` runs only on first auth
  (it's `AFTER INSERT ON auth.users`), so we capture the name when
  it's available. Returning users we never had a name for fall
  through to the email-local-part display name.
* **Private relay email churn** — if a user revokes their relay
  alias from `appleid.apple.com`, our welcome email starts bouncing.
  No action needed on our side; Resend's bounce handling will surface
  it as a delivery failure in the Resend dashboard. We don't track
  this in `auth_failures` because the failure is post-auth, not
  pre-auth.
* **No "Sign in with Apple" wording change** — Apple's HIG explicitly
  requires the literal phrase "Continue with Apple" or "Sign in with
  Apple" on the button. Our button uses "Continue with Apple" — do
  not change it without re-reading the HIG.

### Apple rollback

Same two paths as Google:
1. **Supabase dashboard** → Authentication → Providers → Apple →
   toggle OFF. Existing OAuth sessions stay valid; new sign-in
   attempts via Apple are blocked.
2. **Client-side**: revert `SOCIAL_PROVIDERS` to `['google']`. Button
   stops rendering on signin/signup pages instantly.

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
