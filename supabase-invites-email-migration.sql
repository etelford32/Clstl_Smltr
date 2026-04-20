-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Email-based invite flow
-- ═══════════════════════════════════════════════════════════════
-- Paste into the Supabase SQL Editor AFTER supabase-schema.sql.
-- Idempotent: ALTER TABLE … ADD COLUMN IF NOT EXISTS, DROP POLICY
-- IF EXISTS, CREATE OR REPLACE FUNCTION.
--
-- What this enables:
--   1. Admins can target a specific email with an invite code
--      (invited_email column).
--   2. Each invite tracks sent_at and accepted_at so the dashboard
--      can show conversion rates and resend history.
--   3. Invite codes are no longer publicly enumerable: the
--      "Public can validate invite codes" policy is dropped and
--      signup validation goes through a SECURITY DEFINER RPC
--      (validate_invite) that returns only the plan tier — never
--      max_uses, used_count, or the full row.
--   4. Email-targeted invites require a matching email at redeem
--      time; bulk codes (invited_email IS NULL) work as before.
-- ═══════════════════════════════════════════════════════════════


-- ── 1. Schema additions ───────────────────────────────────────
-- These columns are nullable so existing bulk codes remain valid
-- without backfill. created_by (already present) records who
-- issued the code; for email invites that's also the inviter.

ALTER TABLE public.invite_codes
    ADD COLUMN IF NOT EXISTS invited_email TEXT,
    ADD COLUMN IF NOT EXISTS sent_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS accepted_at   TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_invite_codes_invited_email
    ON public.invite_codes (lower(invited_email))
 WHERE invited_email IS NOT NULL;


-- ── 2. Lock SELECT to admins ──────────────────────────────────
-- Drop the public SELECT policy. Anonymous signup validation now
-- uses validate_invite() (defined below). The admin "FOR ALL"
-- policy from supabase-schema.sql still grants admins full access.

DROP POLICY IF EXISTS "Public can validate invite codes"
    ON public.invite_codes;


-- ── 3. validate_invite() RPC ──────────────────────────────────
-- Replaces direct table SELECT during signup. Returns the invite
-- id, plan tier, and (if any) the targeted email — but NEVER the
-- usage counters or the inviter's id. SECURITY DEFINER lets it
-- read past the admin-only RLS policy on invite_codes.
--
-- For an email-targeted invite (invited_email IS NOT NULL), the
-- caller must pass a matching email. This makes invite links act
-- as a 2-factor token: holding the code is not enough, you also
-- need the email it was sent to.
--
-- For a bulk invite (invited_email IS NULL), email is ignored.

CREATE OR REPLACE FUNCTION public.validate_invite(
    p_code  TEXT,
    p_email TEXT DEFAULT NULL
)
RETURNS TABLE (
    invite_id     UUID,
    plan          TEXT,
    invited_email TEXT,
    is_targeted   BOOLEAN
) AS $$
    SELECT
        id,
        plan,
        invited_email,
        invited_email IS NOT NULL
      FROM public.invite_codes
     WHERE code = upper(trim(p_code))
       AND active = true
       AND used_count < max_uses
       AND (expires_at IS NULL OR expires_at > now())
       AND (
           invited_email IS NULL
        OR (p_email IS NOT NULL AND lower(invited_email) = lower(trim(p_email)))
       );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Anyone (including anon) can call this. The function itself is
-- the throttle: returns no rows for an invalid / expired / wrong-
-- email invite. Code space is 32^8 ≈ 10^12, brute-forcing is
-- infeasible at any reasonable RPC rate.
GRANT EXECUTE ON FUNCTION public.validate_invite(TEXT, TEXT) TO anon, authenticated;


-- ── 4. redeem_invite() — atomic, email-aware ───────────────────
-- Extended from the supabase-schema.sql version. Now:
--   * accepts an optional p_email to enforce email-targeted invites
--   * sets accepted_at on the FIRST successful redeem
--   * returns BOOLEAN (true = redeemed, false = rejected) instead
--     of VOID, so callers can detect the failure mode without
--     re-querying. Existing clients that ignore the return are
--     unaffected.

CREATE OR REPLACE FUNCTION public.redeem_invite(
    invite_id UUID,
    p_email   TEXT DEFAULT NULL
) RETURNS BOOLEAN AS $$
DECLARE
    v_active        BOOLEAN;
    v_max_uses      INT;
    v_used_count    INT;
    v_expires_at    TIMESTAMPTZ;
    v_invited_email TEXT;
BEGIN
    SELECT active, max_uses, used_count, expires_at, invited_email
      INTO v_active, v_max_uses, v_used_count, v_expires_at, v_invited_email
      FROM public.invite_codes
     WHERE id = invite_id
     FOR UPDATE;

    IF NOT FOUND THEN                                  RETURN false; END IF;
    IF NOT v_active THEN                               RETURN false; END IF;
    IF v_used_count >= v_max_uses THEN                 RETURN false; END IF;
    IF v_expires_at IS NOT NULL
       AND v_expires_at <= now() THEN                  RETURN false; END IF;
    IF v_invited_email IS NOT NULL
       AND (p_email IS NULL
         OR lower(v_invited_email) <> lower(trim(p_email))) THEN
                                                       RETURN false;
    END IF;

    UPDATE public.invite_codes
       SET used_count  = used_count + 1,
           accepted_at = COALESCE(accepted_at, now())
     WHERE id = invite_id;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION public.redeem_invite(UUID, TEXT) TO anon, authenticated;


-- ═══════════════════════════════════════════════════════════════
-- Verification queries — paste after running
-- ═══════════════════════════════════════════════════════════════
-- 1. Confirm new columns exist:
--      SELECT column_name, data_type
--        FROM information_schema.columns
--       WHERE table_schema = 'public' AND table_name = 'invite_codes'
--       ORDER BY ordinal_position;
--    Expect invited_email / sent_at / accepted_at among the rows.
--
-- 2. Confirm the public SELECT policy is gone:
--      SELECT policyname FROM pg_policies
--       WHERE schemaname = 'public' AND tablename = 'invite_codes';
--    Expect ONLY "Admins manage invites" (no "Public can validate ...").
--
-- 3. Test validate_invite from the SQL editor (which runs as service
--    role, bypassing GRANTs but the function logic still applies):
--      INSERT INTO public.invite_codes (code, plan, invited_email)
--      VALUES ('TESTABCD', 'free', 'test@example.com');
--      SELECT * FROM public.validate_invite('TESTABCD', 'test@example.com');
--      -- Expect 1 row.
--      SELECT * FROM public.validate_invite('TESTABCD', 'wrong@example.com');
--      -- Expect 0 rows (email mismatch).
--      SELECT * FROM public.validate_invite('TESTABCD', NULL);
--      -- Expect 0 rows (targeted invite, no email).
--      DELETE FROM public.invite_codes WHERE code = 'TESTABCD';
-- ═══════════════════════════════════════════════════════════════
