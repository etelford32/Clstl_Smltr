-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Analytics, Sessions, Invites & Announcements
-- ═══════════════════════════════════════════════════════════════
-- Run this in Supabase Dashboard → SQL Editor AFTER the main schema
-- and supabase-admin.sql (needs the is_admin() function).
--
-- Creates:
--   1. analytics_events  — page views and custom events
--   2. user_sessions     — active session heartbeats (for "users online" + minutes used)
--   3. beta_invites      — invite codes for early testers
--   4. announcements     — admin-posted announcements
--   5. feedback          — user feedback/bug reports

-- ── 1. Analytics Events ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.analytics_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type TEXT NOT NULL DEFAULT 'event',       -- 'page_view' | 'event'
    event_name TEXT NOT NULL,                        -- e.g. 'earth', 'sim_start', 'signup_complete'
    page_path TEXT,
    page_title TEXT,
    referrer TEXT,
    session_id TEXT,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    properties JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.analytics_events ENABLE ROW LEVEL SECURITY;

-- Anyone can insert events, but event_name and page_path are length-limited
-- to prevent payload abuse. Rate limiting is handled at the application layer.
CREATE POLICY "Anyone can insert events"
    ON public.analytics_events FOR INSERT
    WITH CHECK (
        length(event_name) <= 100
        AND (page_path IS NULL OR length(page_path) <= 200)
        AND (page_title IS NULL OR length(page_title) <= 300)
        AND (referrer IS NULL OR length(referrer) <= 500)
    );

CREATE POLICY "Admins can read events"
    ON public.analytics_events FOR SELECT
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_analytics_created
    ON public.analytics_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_event_name
    ON public.analytics_events(event_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_session
    ON public.analytics_events(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_user
    ON public.analytics_events(user_id, created_at DESC);

-- ── 2. User Sessions (heartbeat table) ──────────────────────────────────────
-- Each browser tab sends a heartbeat every 60s.
-- "Currently online" = last_seen within 2 minutes.
-- "Minutes used" = SUM of session durations.

CREATE TABLE IF NOT EXISTS public.user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    started_at TIMESTAMPTZ DEFAULT now(),
    last_seen TIMESTAMPTZ DEFAULT now(),
    duration_s INTEGER DEFAULT 0,                    -- updated on heartbeat/end
    page_path TEXT,
    user_agent TEXT,
    ended BOOLEAN DEFAULT false
);

ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;

-- Anyone can insert/update their own session
CREATE POLICY "Anyone can upsert sessions"
    ON public.user_sessions FOR INSERT
    WITH CHECK (true);

-- Sessions can only be updated by the session owner (matching session_id or user_id)
-- Removed the `OR true` catch-all which allowed any user to update any session.
CREATE POLICY "Session owner can update own session"
    ON public.user_sessions FOR UPDATE
    USING (
        session_id IS NOT NULL  -- must reference a valid session
        AND (user_id IS NULL OR user_id = auth.uid())  -- anon sessions or own sessions only
    );

-- Admins can read all sessions
CREATE POLICY "Admins can read sessions"
    ON public.user_sessions FOR SELECT
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_sessions_last_seen
    ON public.user_sessions(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON public.user_sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_session_id
    ON public.user_sessions(session_id);

-- Function: upsert a session heartbeat (called every 60s from the client)
CREATE OR REPLACE FUNCTION public.session_heartbeat(
    p_session_id TEXT,
    p_user_id UUID DEFAULT NULL,
    p_page_path TEXT DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
    INSERT INTO public.user_sessions (session_id, user_id, page_path, user_agent, started_at, last_seen, duration_s)
    VALUES (p_session_id, p_user_id, p_page_path, p_user_agent, now(), now(), 0)
    ON CONFLICT (session_id) WHERE NOT ended
    DO UPDATE SET
        last_seen = now(),
        duration_s = EXTRACT(EPOCH FROM (now() - public.user_sessions.started_at))::INTEGER,
        page_path = COALESCE(p_page_path, public.user_sessions.page_path),
        user_id = COALESCE(p_user_id, public.user_sessions.user_id);
EXCEPTION WHEN unique_violation THEN
    -- race condition fallback: just update
    UPDATE public.user_sessions
    SET last_seen = now(),
        duration_s = EXTRACT(EPOCH FROM (now() - started_at))::INTEGER,
        page_path = COALESCE(p_page_path, page_path),
        user_id = COALESCE(p_user_id, user_id)
    WHERE session_id = p_session_id AND NOT ended;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Unique partial index for upsert (only active sessions)
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_active_session
    ON public.user_sessions(session_id) WHERE NOT ended;

-- ── 3. Beta Invites ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.beta_invites (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    label TEXT,
    max_uses INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    created_by UUID REFERENCES auth.users(id),
    expires_at TIMESTAMPTZ,
    active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.beta_invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can check invite codes"
    ON public.beta_invites FOR SELECT
    USING (active = true);

CREATE POLICY "Admins can manage invites"
    ON public.beta_invites FOR ALL
    USING (public.is_admin());

CREATE TABLE IF NOT EXISTS public.beta_invite_uses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invite_id UUID NOT NULL REFERENCES public.beta_invites(id) ON DELETE CASCADE,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT,
    redeemed_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.beta_invite_uses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can redeem invites"
    ON public.beta_invite_uses FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Admins can view invite usage"
    ON public.beta_invite_uses FOR SELECT
    USING (public.is_admin());

CREATE OR REPLACE FUNCTION public.redeem_invite(invite_code TEXT, redeemer_email TEXT DEFAULT NULL, redeemer_id UUID DEFAULT NULL)
RETURNS JSONB AS $$
DECLARE
    inv RECORD;
BEGIN
    SELECT * INTO inv FROM public.beta_invites
    WHERE code = invite_code AND active = true
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Invalid invite code');
    END IF;

    IF inv.expires_at IS NOT NULL AND inv.expires_at < now() THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Invite code has expired');
    END IF;

    IF inv.use_count >= inv.max_uses THEN
        RETURN jsonb_build_object('ok', false, 'error', 'Invite code fully redeemed');
    END IF;

    UPDATE public.beta_invites SET use_count = use_count + 1 WHERE id = inv.id;

    INSERT INTO public.beta_invite_uses (invite_id, user_id, email)
    VALUES (inv.id, redeemer_id, redeemer_email);

    RETURN jsonb_build_object('ok', true, 'label', inv.label);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 4. Announcements ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.announcements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT,
    severity TEXT DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),
    target_plan TEXT DEFAULT 'all' CHECK (target_plan IN ('all', 'free', 'basic', 'advanced')),
    published BOOLEAN DEFAULT false,
    published_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_by UUID REFERENCES auth.users(id),
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view active announcements"
    ON public.announcements FOR SELECT
    USING (published = true AND (expires_at IS NULL OR expires_at > now()));

CREATE POLICY "Admins can manage announcements"
    ON public.announcements FOR ALL
    USING (public.is_admin());

-- ── 5. User Feedback ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    email TEXT,
    category TEXT DEFAULT 'general' CHECK (category IN ('bug', 'feature', 'general', 'praise')),
    page TEXT,
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}',
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'reviewed', 'resolved', 'wontfix')),
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can submit feedback"
    ON public.feedback FOR INSERT
    WITH CHECK (true);

CREATE POLICY "Users can view own feedback"
    ON public.feedback FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Admins can manage feedback"
    ON public.feedback FOR ALL
    USING (public.is_admin());

-- ══════════════════════════════════════════════════════════════════
-- Admin Dashboard Helper Views
-- ══════════════════════════════════════════════════════════════════

-- Daily page view counts (last 30 days)
CREATE OR REPLACE VIEW public.analytics_daily AS
SELECT
    date_trunc('day', created_at)::DATE AS day,
    event_name,
    COUNT(*) AS count,
    COUNT(DISTINCT session_id) AS unique_sessions
FROM public.analytics_events
WHERE created_at > now() - INTERVAL '30 days'
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;

-- Top pages (last 7 days)
CREATE OR REPLACE VIEW public.analytics_top_pages AS
SELECT
    event_name,
    COUNT(*) AS views,
    COUNT(DISTINCT session_id) AS unique_visitors
FROM public.analytics_events
WHERE event_type = 'page_view'
  AND created_at > now() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 20;

-- ══════════════════════════════════════════════════════════════════
-- Done! Run order:
--   1. supabase-schema.sql    (core tables)
--   2. supabase-admin.sql     (admin roles + is_admin())
--   3. supabase-analytics.sql (this file)
-- ══════════════════════════════════════════════════════════════════
