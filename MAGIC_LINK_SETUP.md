# Magic-link sign-in — operator runbook

End-to-end setup for the passwordless "Send me a sign-in link"
option on `/signin.html`. Two pieces:

1. Apply the SQL migration (one-time per project).
2. Paste the branded email template into the Supabase dashboard.

The code paths are already shipped — this doc only covers the
dashboard configuration that has to happen outside the repo.

---

## 1. Apply the SQL migration

Supabase Dashboard → SQL Editor → paste
[`supabase-magic-link-migration.sql`](supabase-magic-link-migration.sql)
→ Run.

What it does (idempotent):
* Adds `'signin_magic_link_requested'` to the
  `activation_events.event` CHECK constraint.
* Refreshes `auth_flow_metrics()` to expose the new event so the
  admin Auth flow card can render the magic-link request count +
  per-signin share.

Verify by signing in via magic link once, then in SQL Editor:

```sql
SELECT * FROM public.auth_flow_metrics(7);
-- Expect: a row with event='signin_magic_link_requested'.
```

---

## 2. Verify Supabase Auth settings

Supabase Dashboard → **Authentication → URL Configuration**:

* **Site URL**: `https://parkerphysics.com`
* **Redirect URLs** allow-list contains:
  ```
  https://parkerphysics.com/auth-callback.html
  https://parkerphysics.com/auth-callback.html?**
  http://localhost:3000/auth-callback.html
  ```

These are the same entries the Google + Apple OAuth setup needed.
If you've already shipped Google/Apple, no change required — the
magic-link callback uses the same `/auth-callback.html` page.

---

## 3. Verify Email-link expiry + rate limit

Supabase Dashboard → **Authentication → Providers → Email**
(or the provider list at **Sign In / Providers**):

* **Enable Email Provider**: ON
* **Confirm email**: ON (this is the password-signup confirm gate;
  unrelated to magic-link but should already be on)
* **Magic link** option: leave at the default. Supabase always
  supports `signInWithOtp` for users with confirmed emails; there
  is no separate toggle to flip.

Auth → **Rate Limits**:
* **Magic link / OTP per email**: default ~30 s between sends to
  the same address. Our UI cooldown is 60 s, so the user-facing
  Resend button will always be re-armed in time. Don't lower the
  Supabase value.

---

## 4. Paste the branded email template

Supabase Dashboard → **Authentication → Email Templates** →
**Magic Link** tab.

Replace the **Message body** field with the HTML below. Subject
line: `Your Parker Physics sign-in link` (no template variables —
the link itself goes in the body).

> The template uses Supabase's Liquid-style variables — `{{ .ConfirmationURL }}` is the magic link, `{{ .Email }}` is the user's address. Don't change those tokens.

```html
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0a14;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#cdd">
<div style="max-width:560px;margin:0 auto;padding:28px 22px">

  <div style="text-align:center;margin-bottom:22px">
    <span style="font-size:1.05rem;font-weight:800;background:linear-gradient(45deg,#ffd700,#ff8c00);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:.04em">Parker Physics</span>
  </div>

  <div style="background:#12111a;border:1px solid #2a2440;border-radius:12px;padding:26px 24px;margin-bottom:18px">
    <div style="font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#c77dff;font-weight:800;margin-bottom:14px">Sign in to your account</div>
    <h2 style="margin:0 0 12px;font-size:1.25rem;color:#fff;font-weight:700">Tap the button to sign in.</h2>
    <p style="margin:0 0 20px;font-size:.95rem;color:#aab;line-height:1.6">
      You requested a one-time sign-in link for <strong style="color:#fff">{{ .Email }}</strong>. The link works for one hour and can only be used once.
    </p>

    <div style="margin:18px 0">
      <a href="{{ .ConfirmationURL }}" style="display:inline-block;padding:13px 28px;background:linear-gradient(45deg,#ff8c00,#ffd700);color:#000;font-weight:700;border-radius:8px;text-decoration:none;font-size:.94rem">Sign in to Parker Physics →</a>
    </div>

    <div style="font-size:.78rem;color:#888;line-height:1.6;border-top:1px solid #2a2440;padding-top:16px;margin-top:18px">
      Trouble with the button? Copy and paste this URL into your browser:<br>
      <span style="color:#a080ff;word-break:break-all;font-family:'SFMono-Regular',Consolas,monospace;font-size:.74rem">{{ .ConfirmationURL }}</span>
    </div>

    <div style="font-size:.78rem;color:#666;line-height:1.6;margin-top:14px">
      Didn't ask for this? You can safely ignore this email — your account stays untouched and the link expires on its own.
    </div>
  </div>

  <p style="margin:0;font-size:.7rem;color:#556;text-align:center;line-height:1.5">
    Parker Physics · <a href="https://parkerphysics.com" style="color:#778;text-decoration:none">parkerphysics.com</a><br>
    Real-time space-weather + 17 interactive simulations.
  </p>

</div>
</body></html>
```

Save. The new template applies to the **next** magic-link request;
already-sent links keep their previous template (immaterial — the
recipient only sees one email per request).

---

## 5. Smoke test

1. Incognito window → `/signin.html`.
2. Click **"Send me a sign-in link instead"** (under the Sign In
   button). The form should switch — password field hides, button
   text becomes "Send sign-in link".
3. Enter your email → submit. The form should swap to the
   "Check your email" panel showing the address you entered.
4. Open the inbox. You should see the branded email with the
   "Sign in to Parker Physics" button. Click it.
5. You should land on `/auth-callback.html` for ~1 s, then bounce
   to `/dashboard.html` signed in.
6. SQL Editor:
   ```sql
   SELECT event, plan, metadata, created_at
     FROM public.activation_events
    WHERE user_id = '<your-uuid>'
    ORDER BY created_at DESC LIMIT 5;
   ```
   You should see:
   * `signin_magic_link_requested` row with
     `metadata.source = 'signin_form'` from step 3.
   * `signin_succeeded` row with `metadata.source = 'magic_link'`
     from step 5.

---

## 6. Resend behavior

* **UI cooldown**: 60 s on the in-page Resend button.
* **Supabase server cooldown**: ~30 s per email address.
* **Link TTL**: 1 hour (Supabase default; configurable in
  Auth → Email).

After clicking Resend the previous link is **not** invalidated —
both work until the older one expires or is consumed. Don't
panic-click; both links land you in the same place.

---

## 7. Anti-enumeration

`auth.signInWithMagicLink` is called with `shouldCreateUser: false`,
which means Supabase silently does nothing for unknown emails but
returns success regardless. The UI then shows "Check your email"
either way. Net effect: a stranger cannot enumerate registered
emails by submitting addresses to this form.

---

## 8. Rollback

If something breaks in production:

1. **Client-side kill switch**: in `signin.html`, hide the
   `#magic-toggle` button via CSS (`display:none`). The password
   form keeps working unmodified. Lighter than reverting the SQL
   migration.
2. **Server-side**: Supabase Dashboard → Authentication → Rate
   Limits → set the OTP rate to a value that effectively blocks
   sends. Not recommended unless there's an active abuse incident.
3. **DB**: the `signin_magic_link_requested` event is additive;
   no rollback migration needed. Old code keeps working.
