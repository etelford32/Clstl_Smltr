-- supabase-geomag-e2-kind-migration.sql
-- Applied to aijsboodkivnhzfstvdq as `geomag_indices_allow_e2_mev`
-- (2026-07-13) — committed here per the repo migration convention.
--
-- The sync-dataset cron (PR #926, api/cron/sync-dataset.js) archives
-- native-cadence GOES ≥2 MeV electron flux into geomag_indices as
-- kind 'e2_mev' (NOAA's rolling 1-day file forgets; the archive doesn't).
-- The original kind CHECK predated it and only allowed dst/kp, so every
-- cron run wrote the sw_geomag_dataset minutes fine and then failed at
-- the raw-archive step (SQLSTATE 23514, a 13-run failure streak on the
-- sync_dataset heartbeat). Extend the allowed kinds.
--
-- If a future kind is added, update BOTH this constraint and the writer
-- that emits it — the constraint is the schema-side record of every
-- raw-archive stream this table carries.

ALTER TABLE public.geomag_indices
  DROP CONSTRAINT geomag_indices_kind_check;

ALTER TABLE public.geomag_indices
  ADD CONSTRAINT geomag_indices_kind_check
  CHECK (kind = ANY (ARRAY['dst'::text, 'kp'::text, 'e2_mev'::text]));
