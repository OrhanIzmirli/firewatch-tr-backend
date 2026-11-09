-- Migration 020: a device with no stored location gets every region's alerts
-- only if the user asked for the whole country.
--
-- alert_scope defaults to 'all', so 'all' alone cannot tell a choice from a
-- default. This column records the choice. Existing rows start as false: a
-- device with a location keeps matching by distance, and a device without
-- one stops receiving alerts for regions nobody asked for.
--
-- Additive and safe to run twice.
BEGIN;

ALTER TABLE fcm_tokens
  ADD COLUMN IF NOT EXISTS all_regions_opt_in BOOLEAN NOT NULL DEFAULT false;

COMMIT;
