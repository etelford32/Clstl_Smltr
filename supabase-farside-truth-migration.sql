-- ═══════════════════════════════════════════════════════════════
-- Parker Physics — Far-Side Watch ground truth (run in Supabase SQL Editor)
-- ═══════════════════════════════════════════════════════════════
-- Phase 5 / Tier 2 (see FAR_SIDE_WATCH_NEXT_STEPS.md). The validation MOAT
-- needs a ground-truth emergence record to backtest against: which far-side
-- signatures actually became NOAA-numbered active regions at the east limb,
-- when they crossed, and how flare-productive they were.
--
-- The backtest harness (js/farside/farside-validate.js) scores stored far-side
-- detections (public.farside_maps) against these rows: detection rate, median
-- lead time, false-alarm rate, ETA accuracy.
--
-- This table is PUBLIC-READ on purpose — it is published validation data (no
-- PII, no internal feed), and the on-page "Validation backtest" panel reads it.
-- Writes are service-role only (seeded here + an optional NOAA backfill job).
--
-- Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.farside_truth (
    id                  BIGSERIAL    PRIMARY KEY,
    case_id             TEXT         UNIQUE NOT NULL,      -- stable key, e.g. 'ar13664'
    noaa_region         INT,                              -- NOAA AR number (nullable)
    label               TEXT         NOT NULL,
    east_limb_crossing  TIMESTAMPTZ  NOT NULL,            -- when it rotated into Earth view
    carrington_lon      DOUBLE PRECISION,
    carrington_lat      DOUBLE PRECISION,
    flare_productive    BOOLEAN,
    source              TEXT         NOT NULL DEFAULT 'manual',  -- 'noaa' | 'manual'
    notes               TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS farside_truth_crossing_idx
    ON public.farside_truth (east_limb_crossing DESC);

ALTER TABLE public.farside_truth ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS farside_truth_public_read ON public.farside_truth;
CREATE POLICY farside_truth_public_read
    ON public.farside_truth FOR SELECT
    TO anon, authenticated
    USING (true);

-- Seed the canonical validation cases. ON CONFLICT keeps re-runs idempotent and
-- lets a later NOAA backfill enrich rows without clobbering manual edits.
INSERT INTO public.farside_truth
    (case_id, noaa_region, label, east_limb_crossing, carrington_lon, carrington_lat, flare_productive, source, notes)
VALUES
    ('ar13664', 13664, 'AR13664 — Gannon G5 (May 2024)', '2024-05-02T00:00:00Z', 270, 17, TRUE, 'manual',
     'Produced the X-class flares + CMEs that drove the May 2024 superstorm.'),
    ('farside-2026-05', NULL, 'Late-May 2026 far-side region', '2026-05-28T00:00:00Z', 132, -12, NULL, 'manual',
     'Recent far-side signature — live validation target.')
ON CONFLICT (case_id) DO NOTHING;

COMMENT ON TABLE public.farside_truth IS
    'Far-Side Watch ground-truth emergence record (Tier 2). Public-read published '
    'validation data; service-role writes. Backtested by js/farside/farside-validate.js.';
