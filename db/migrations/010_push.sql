-- =============================================================================
--  Migration 010: notifications on a phone or a closed tab (lib/push.js)
--
--  push_subscriptions: one row per device that switched notifications on.
--    seen_at is refreshed each time that device opens the inbox; a device not
--    seen for 7 days (the session lifetime) stops getting pushes.
--  push_keys: the single key pair this inbox signs its pushes with. The app
--    creates it on first use.
--
--  Idempotent. Until this runs the inbox hides the bell and keeps working.
--  Rollback: DROP TABLE wa.push_subscriptions, wa.push_keys;
-- =============================================================================

CREATE TABLE IF NOT EXISTS wa.push_subscriptions (
  endpoint    text PRIMARY KEY,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  seen_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa.push_keys (
  id          int PRIMARY KEY CHECK (id = 1),
  public_key  text NOT NULL,
  private_key text NOT NULL,
  subject     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON wa.push_subscriptions TO wa_app;
GRANT SELECT, INSERT ON wa.push_keys TO wa_app;
