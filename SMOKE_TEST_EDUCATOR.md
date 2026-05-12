# Smoke Test — Educator Class-Seat Flow

End-to-end manual verification that the class-seat invite path works
without involving Stripe. Run this before flipping on Stripe for
educators or pushing the wedge to production.

**Time:** ~10 minutes. **You'll need:** two browser windows (one
signed-in as you, one incognito); access to a throwaway email you
control; and the SUPABASE/RESEND env vars in `.env.local`.

---

## 0. Prerequisites

- [ ] `supabase-bootstrap-fresh.sql` has been applied to your Supabase
      project (you saw the success NOTICE for `etelford32@gmail.com`).
- [ ] You can sign in to the dashboard as `etelford32@gmail.com` and
      see "Superadmin Access" on the subscription card.
- [ ] `.env.local` exists at the repo root with at least:

      ```
      SUPABASE_URL=https://aijsboodkivnhzfstvdq.supabase.co
      SUPABASE_SERVICE_KEY=<service_role key from Supabase dashboard>
      RESEND_API_KEY=<resend key — optional, see step 3>
      APP_URL=http://localhost:3000
      ```

- [ ] `node dev-server.mjs` starts without errors.

---

## 1. Confirm the Class Roster panel renders

1. Open `http://localhost:3000/dashboard.html` while signed in as
   `etelford32@gmail.com`.
2. Look for the **Class Roster** card under the subscription strip
   (between subscription card and the location card).

**Expect:** Card title reads `Class Roster · Enterprise`. KPI strip
shows `0 / 1000 seats used` and `1000 seats available`. Empty-state
text: "No students yet — invite one above."

**If missing:**
- Card stays hidden when `auth.getPlan()` returns 'free'. Confirm
  the bootstrap actually promoted you (`SELECT plan, role FROM
  user_profiles WHERE email='etelford32@gmail.com';` — expect
  `enterprise / superadmin`).
- Check the browser console for a 4xx from `/api/class/roster`.

---

## 2. Send a class invite

1. In the panel's invite row, type a throwaway email you control
   (e.g. `you+student@gmail.com`).
2. Click **Send invite**.

**Expect:**
- Status line under the input flashes green: `✓ Invite sent to
  you+student@gmail.com.`
- Within ~400ms the panel reloads; **Pending invites** section appears
  with one row showing the masked email + a code (e.g. `K2X9PQRA`)
  + a `Pending` pill.
- Browser network tab shows `POST /api/class/invite` → `200`.

**If `RESEND_API_KEY` isn't set:** The invite row still gets created
(check Supabase `invite_codes` table). The endpoint returns a 500
with the magic link in the response body — copy it from the network
panel and use it directly in step 4. The **Pending invites** UI
won't refresh automatically in this case; click the Refresh button
or hard-reload the page.

---

## 3. Confirm the email landed (optional)

If `RESEND_API_KEY` is set: check the throwaway inbox. The email
subject is `You've been added to a Parkers Physics class`. Body
includes a magic-link button and the raw code.

If you skipped Resend: pull the link from the API response, or run
this query in Supabase SQL Editor:

```sql
SELECT code, invited_email, sent_at
  FROM public.invite_codes
 WHERE is_class_seat = TRUE
 ORDER BY sent_at DESC NULLS LAST
 LIMIT 1;
```

Build the link as
`http://localhost:3000/signup?code=<code>&email=<invited_email>`.

---

## 4. Sign up the student in incognito

1. Open the magic link in an **incognito** window (so you don't
   collide with your superadmin session).
2. Form should auto-fill the invite code + email. Status under the
   invite-code field reads:

   > `✓ Valid class invite — joins your instructor's roster, no card
   > required`

3. Fill first name, last name, password (≥8 chars), check terms.
4. Click **Create Account**.

**Expect:**
- Form switches to the success view. Message: `Welcome! You've joined
  a Parkers Physics Enterprise class. Open your dashboard →`
- Within 2.5s, the page redirects to `/dashboard.html`.
- The new student dashboard's subscription card reads:
  `Class member · Enterprise — Access provided by your instructor —
  no card on file.` (No Manage Billing button. No Upgrade button.)

**Stripe must NOT be hit:** confirm in network tab there is no
`POST /api/stripe/checkout` request. The signup flow's
`goToCheckout` flag should be false because `classSeatApplied=true`.

---

## 5. Confirm the parent's roster updated

1. Switch back to your signed-in superadmin window.
2. Reload `/dashboard.html`.

**Expect:**
- Class Roster card shows `1 / 1000 seats used`.
- **Active students** section lists one row with the student's
  display name + masked email + `joined Apr 2026`. The Pending row
  is gone.

---

## 6. Confirm activation events fired

In Supabase SQL Editor:

```sql
SELECT user_id, event, plan, metadata, created_at
  FROM public.activation_events
 WHERE created_at > now() - interval '5 minutes'
 ORDER BY created_at;
```

**Expect at least three rows:**
- `signup` (your own user_id, plan=`enterprise`) — fires on every
  dashboard load, idempotent.
- `signup` (the student's user_id, plan=`free`) — student's first
  dashboard load.
- `student_joined` (the student's user_id, plan=`free`,
  metadata=`{"parent_plan":"enterprise","source":"magic_link"}`).
- Optional: `invite_sent` (your user_id, plan=`enterprise`,
  metadata=`{"kind":"class_seat"}`).
- Optional: `first_sim_opened` if the student clicked any sim card.

---

## 7. Confirm the admin Activation tab populates

1. Open `http://localhost:3000/admin.html` (still signed in as
   superadmin).
2. Click the **Activation** tab.

**Expect:**
- **Activation Funnel** table shows two rows: one for `enterprise`
  plan, one for `free` plan. Each shows signup count + counts for
  any subsequent events.
- **Daily Activation Events** chart shows at least one bar for today.
- **Educator / Institution Roster Health** KPI tiles read
  `1` seated account, `1000` total seats, `1` filled, `1` healthy
  (if you fall in the ≥80% bucket — at 1/1000 it'll show 0; that's
  fine, the math is correct).
- Educator roster table lists `etelford32@gmail.com` with fill rate.

---

## 8. Cleanup (optional)

To re-run the smoke test from scratch, free the seat and remove the
test student:

1. In the Class Roster panel, click **Remove** on the student row.
2. Confirm the seat returns (`0 / 1000 seats used`).
3. To delete the test account entirely, run the
   account-deletion runbook in `DEPLOYMENT.md` (`delete_user_data`
   RPC + `auth.admin.deleteUser`).

---

## What this test does NOT cover

- **Stripe checkout for the educator-tier purchase itself.** This
  flow only verifies seat invites under an already-provisioned
  educator account. Wire Stripe (next sprint) and re-run this with a
  fresh `etelford32@gmail.com`-style account purchasing the
  Educator tier through `/signup?plan=educator`.
- **Email deliverability.** Resend's send is fire-and-forget; if
  Resend rate-limits or DKIM isn't verified, the email may land in
  spam. Check Resend's dashboard for delivery status.
- **CSP / iframe embed permission for the educator's school site.**
  Schema flag exists; middleware enforcement is a follow-up sprint.
