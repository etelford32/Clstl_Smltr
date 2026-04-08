-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Stripe Billing Schema
-- ═══════════════════════════════════════════════════════════════
-- Run in Supabase SQL Editor AFTER supabase-schema.sql + supabase-admin.sql.
--
-- Adds:
--   1. Stripe columns to user_profiles
--   2. billing_invoices table
--   3. payment_events audit log
--   4. RLS policies for billing data

-- ── 1. Extend user_profiles with Stripe fields ─────────────────────────────

ALTER TABLE public.user_profiles
    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
    ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'none'
        CHECK (subscription_status IN ('none', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'trialing')),
    ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_profiles_stripe_customer
    ON public.user_profiles(stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ── 2. Billing invoices ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.billing_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    stripe_invoice_id TEXT UNIQUE NOT NULL,
    stripe_subscription_id TEXT,
    amount_cents INTEGER NOT NULL,
    currency TEXT DEFAULT 'usd',
    plan_at_invoice TEXT,
    status TEXT NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
    hosted_invoice_url TEXT,
    pdf_url TEXT,
    paid_at TIMESTAMPTZ,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own invoices"
    ON public.billing_invoices FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Admins can view all invoices"
    ON public.billing_invoices FOR SELECT
    USING (public.is_admin());

-- Service role inserts (from webhook handler)
CREATE POLICY "Service role can insert invoices"
    ON public.billing_invoices FOR INSERT
    WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_invoices_user
    ON public.billing_invoices(user_id, created_at DESC);

-- ── 3. Payment events audit log ─────────────────────────────────────────────
-- Every Stripe webhook event is logged here for debugging + idempotency.

CREATE TABLE IF NOT EXISTS public.payment_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    stripe_event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    data JSONB DEFAULT '{}',
    processed BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.payment_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view payment events"
    ON public.payment_events FOR SELECT
    USING (public.is_admin());

CREATE POLICY "Service role can insert events"
    ON public.payment_events FOR INSERT
    WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_payment_events_type
    ON public.payment_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_events_stripe
    ON public.payment_events(stripe_event_id);

-- ── 4. Helper: get plan from Stripe subscription status ─────────────────────
-- Used by webhook handler to determine correct plan after payment events.

CREATE OR REPLACE FUNCTION public.sync_stripe_subscription(
    p_user_id UUID,
    p_stripe_customer_id TEXT,
    p_stripe_subscription_id TEXT,
    p_subscription_status TEXT,
    p_plan TEXT,
    p_current_period_end TIMESTAMPTZ,
    p_cancel_at_period_end BOOLEAN DEFAULT false
)
RETURNS VOID AS $$
BEGIN
    UPDATE public.user_profiles SET
        stripe_customer_id = p_stripe_customer_id,
        stripe_subscription_id = p_stripe_subscription_id,
        subscription_status = p_subscription_status,
        plan = p_plan,
        current_period_end = p_current_period_end,
        cancel_at_period_end = p_cancel_at_period_end,
        updated_at = now()
    WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ══════════════════════════════════════════════════════════════════
-- Run order:
--   1. supabase-schema.sql       (core tables)
--   2. supabase-admin.sql        (admin roles + is_admin())
--   3. supabase-analytics.sql    (analytics + sessions)
--   4. supabase-billing.sql      (THIS FILE — Stripe integration)
-- ══════════════════════════════════════════════════════════════════
