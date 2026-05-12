-- ──────────────────────────────────────────────────────────────────────
-- Feedback submissions — feature requests + bug reports from /feedback
-- Backs the public POST /api/contact/feedback endpoint. Anonymous insert
-- is allowed (the form is unauthenticated); admins read + update.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.feedback_submissions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind         TEXT NOT NULL CHECK (kind IN ('feature_request','bug_report','general')),
    page         TEXT,
    subject      TEXT NOT NULL,
    message      TEXT NOT NULL,
    email        TEXT,
    url          TEXT,
    source_ip    TEXT,
    user_agent   TEXT,
    status       TEXT DEFAULT 'new' CHECK (status IN ('new','triaged','in_progress','shipped','wont_fix','duplicate')),
    notes        TEXT,
    triaged_at   TIMESTAMPTZ,
    created_at   TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.feedback_submissions ENABLE ROW LEVEL SECURITY;

-- Public anonymous insert allowed (the feedback form is unauthenticated).
-- Length caps and email-shape validation are duplicated at the edge
-- function; this RLS check is the second line of defense.
DROP POLICY IF EXISTS "Public can submit feedback" ON public.feedback_submissions;
CREATE POLICY "Public can submit feedback"
    ON public.feedback_submissions FOR INSERT
    WITH CHECK (
        kind IN ('feature_request','bug_report','general')
        AND length(subject) BETWEEN 1 AND 160
        AND length(message) BETWEEN 1 AND 4000
        AND (page IS NULL OR length(page) <= 80)
        AND (email IS NULL OR (length(email) BETWEEN 5 AND 200 AND email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'))
        AND (url IS NULL OR length(url) <= 500)
        AND (user_agent IS NULL OR length(user_agent) <= 300)
    );

DROP POLICY IF EXISTS "Admins read feedback" ON public.feedback_submissions;
CREATE POLICY "Admins read feedback"
    ON public.feedback_submissions FOR SELECT
    USING (public.is_admin());

DROP POLICY IF EXISTS "Admins update feedback" ON public.feedback_submissions;
CREATE POLICY "Admins update feedback"
    ON public.feedback_submissions FOR UPDATE
    USING (public.is_admin());

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_created
    ON public.feedback_submissions(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_submissions_kind_status
    ON public.feedback_submissions(kind, status, created_at DESC);
