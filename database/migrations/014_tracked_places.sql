-- Migration 014 — "Takip ettiğim yerler" (tracked places), app 1.2.0
--
-- STRICTLY ADDITIVE: three new tables, nothing existing is altered.
-- The code that uses them checks to_regclass('public.tracked_places') first,
-- so deploying the code before this migration is harmless (the /api/places
-- routes answer 503 and the alert step skips).
--
-- Privacy rules (same as fcm_tokens, see src/utils/locationPrivacy.ts and the
-- hosted privacy policy):
--   * place coordinates are stored rounded to 2 decimals (~1 km); the CHECK
--     below makes a more precise value impossible to store;
--   * a device untouched for 90 days, or whose FCM token has been dead for
--     7 days, is deleted with all its places (ON DELETE CASCADE) by
--     jobs/privacyRetentionJob.ts;
--   * place_notifications rows are kept 30 days, only to guarantee one alert
--     per (place, incident).
--
-- ---------------------------------------------------------------------------
-- PRE-FLIGHT — expect three NULLs (none of the tables exist yet):
--
--   SELECT to_regclass('public.place_devices'),
--          to_regclass('public.tracked_places'),
--          to_regclass('public.place_notifications');
--
-- Take a Neon backup branch before applying to production.
-- ---------------------------------------------------------------------------

BEGIN;

-- One row per app install. There are no accounts: the app generates a random
-- install_id and secret, and only sha256(secret) is kept here. The FCM token
-- is the delivery address and changes over time; it is never the key.
CREATE TABLE IF NOT EXISTS place_devices (
  install_id        UUID PRIMARY KEY,
  secret_hash       BYTEA NOT NULL CHECK (octet_length(secret_hash) = 32),
  fcm_token         TEXT UNIQUE CHECK (fcm_token IS NULL OR length(fcm_token) BETWEEN 20 AND 4096),
  locale            TEXT NOT NULL DEFAULT 'tr' CHECK (locale IN ('tr', 'en')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_invalid_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_place_devices_last_seen
  ON place_devices (last_seen_at);

CREATE TABLE IF NOT EXISTS tracked_places (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id   UUID NOT NULL REFERENCES place_devices (install_id) ON DELETE CASCADE,
  name         VARCHAR(40) NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 40),
  latitude     NUMERIC(5, 2) NOT NULL CHECK (latitude BETWEEN 35 AND 43),
  longitude    NUMERIC(5, 2) NOT NULL CHECK (longitude BETWEEN 25 AND 45),
  -- Derived from the rounded numerics, so it can never be more precise.
  geom         geography(Point, 4326)
                 GENERATED ALWAYS AS (
                   ST_SetSRID(ST_MakePoint(longitude::double precision, latitude::double precision), 4326)::geography
                 ) STORED,
  radius_m     INTEGER NOT NULL CHECK (radius_m IN (5000, 10000, 25000)),
  notify_heat  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracked_places_install
  ON tracked_places (install_id);
CREATE INDEX IF NOT EXISTS idx_tracked_places_geom
  ON tracked_places USING GIST (geom);

-- One row per (place, incident) ever considered for an alert: the primary
-- key is what makes "one alert per incident" hold even when a run is
-- retried. kind leaves room for 1.3.0's risk/news alerts.
--
-- status:
--   new           just recorded, not yet handled (only inside one run)
--   sent          went out in a push (push_id, pushed_at set)
--   held          over the device's cap (3 pushes / 6 h); waits for the
--                 window to end, then goes out in one summary push
--   summarized    went out in that summary (push_id, pushed_at set)
--   undeliverable the device had no live FCM token; never sent
-- The cap counts pushes (distinct push_id), not rows: one push can carry
-- several new detections.
CREATE TABLE IF NOT EXISTS place_notifications (
  place_id   UUID NOT NULL REFERENCES tracked_places (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('heat')),
  ref_key    TEXT NOT NULL,
  install_id UUID NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new', 'sent', 'held', 'summarized', 'undeliverable')),
  push_id    UUID,
  pushed_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (place_id, kind, ref_key),
  CHECK ((status IN ('sent', 'summarized')) = (push_id IS NOT NULL AND pushed_at IS NOT NULL))
);

-- The per-device cap counts this device's pushes in the last few hours.
CREATE INDEX IF NOT EXISTS idx_place_notifications_device_pushes
  ON place_notifications (install_id, pushed_at DESC) WHERE push_id IS NOT NULL;
-- Held detections waiting for their summary.
CREATE INDEX IF NOT EXISTS idx_place_notifications_held
  ON place_notifications (install_id) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS idx_place_notifications_created
  ON place_notifications (created_at);

COMMIT;

-- ---------------------------------------------------------------------------
-- POST-CHECK — all three exist and are empty:
--
--   SELECT (SELECT count(*) FROM place_devices)       AS devices,
--          (SELECT count(*) FROM tracked_places)      AS places,
--          (SELECT count(*) FROM place_notifications) AS notifications;
--
-- ROLLBACK (only if nothing has been written yet that must be kept):
--
--   DROP TABLE IF EXISTS place_notifications, tracked_places, place_devices;
-- ---------------------------------------------------------------------------
