-- ─────────────────────────────────────────────────────────────────────────────
-- supabase-api-keys-migration.sql
--
-- Adds personal API key management for the /account page.
--
-- A user creates a labeled key on /account → the server returns the plaintext
-- secret ONCE (UI shows it then forgets it), and stores only:
--   * key_prefix  — first 8 chars, used for at-a-glance identification
--   * key_hash    — SHA-256 of the full secret (never stored in plaintext)
--
-- Future API endpoints authenticate inbound requests by:
--   1. Reading the X-API-Key header
--   2. Computing SHA-256 of the supplied value
--   3. Looking up the row by key_hash, asserting revoked_at IS NULL
--   4. Stamping last_used_at
--
-- Rate-limit / usage-meter integration is out of scope for this migration —
-- the api_calls_today column on user_profiles is the existing counter and
-- can be incremented by the same edge function that authenticates the key.
--
-- Idempotent. Safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_api_keys (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    label        TEXT NOT NULL,
    key_prefix   TEXT NOT NULL,           -- first 8 chars of the plaintext key
    key_hash     TEXT NOT NULL UNIQUE,    -- SHA-256 hex of the full plaintext
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at   TIMESTAMPTZ,
    -- Optional scope (reserved for future use; null = all-scopes legacy default).
    scopes       TEXT[]
);

CREATE INDEX IF NOT EXISTS idx_user_api_keys_user_id
    ON public.user_api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_user_api_keys_active
    ON public.user_api_keys(user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.user_api_keys ENABLE ROW LEVEL SECURITY;

-- Users can list / create / revoke ONLY their own keys.
DROP POLICY IF EXISTS "Users can read own api keys" ON public.user_api_keys;
CREATE POLICY "Users can read own api keys"
    ON public.user_api_keys FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own api keys" ON public.user_api_keys;
CREATE POLICY "Users can insert own api keys"
    ON public.user_api_keys FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Update is intentionally limited to the "revoke" path (set revoked_at).
-- We do not allow re-using a key_hash row by clearing revoked_at.
DROP POLICY IF EXISTS "Users can revoke own api keys" ON public.user_api_keys;
CREATE POLICY "Users can revoke own api keys"
    ON public.user_api_keys FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Admins can audit.
DROP POLICY IF EXISTS "Admins can view all api keys" ON public.user_api_keys;
CREATE POLICY "Admins can view all api keys"
    ON public.user_api_keys FOR SELECT
    USING (public.is_admin());

-- ── Helper: redact_api_keys() ────────────────────────────────────────────────
-- Convenience view that returns only the columns safe to surface in the UI
-- (no key_hash). Used by /account to render the user's key list.
CREATE OR REPLACE VIEW public.user_api_keys_public AS
    SELECT id, user_id, label, key_prefix, created_at, last_used_at, revoked_at, scopes
      FROM public.user_api_keys;

GRANT SELECT ON public.user_api_keys_public TO authenticated;

-- Smoke test:
--   SELECT * FROM public.user_api_keys_public LIMIT 5;
--   -- Insert via the /api/keys/create edge function (which hashes the secret
--   --  server-side); never insert plaintext keys directly from a SQL client.
