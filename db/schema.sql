-- =============================================================================
--  wa-webhook schema for Aurora PostgreSQL, in its own schema `wa` inside the
--  existing `byteplus` database.
--
--  RLS IS DELIBERATELY ABSENT. Aurora has no PostgREST and no anon role, so
--  RLS protects nothing here, while RLS-enabled-with-zero-policies makes reads
--  return 0 rows with a NULL error and makes UPDATEs match 0 rows and report
--  success. Both are silent. lib/boot.js probes for exactly that at startup.
--
--  Reconciled against the live database on 2026-08-17 via the PostgREST
--  OpenAPI spec, which exposes column names, types, nullability, DEFAULTS, the
--  primary keys and the foreign key. Every default below was READ, not assumed,
--  including `deleted DEFAULT false` (migration 004 was reverted in code but
--  never dropped from the database).
--
--  Not exposed by that route, and therefore taken from supabase/schema.sql plus
--  migrations 002-007: the FK's ON DELETE CASCADE, the index definitions and
--  the trigger. All three are CREATED fresh here rather than restored, so the
--  source's versions matter only for the G4 parity diff, not for building this.
--  A real `pg_dump --schema-only` is still worth diffing when available, and is
--  required anyway for the phase 4 and 5 data copy.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS wa;

-- ---------------------------------------------------------------------------
--  conversations: one row per WhatsApp user (keyed by their wa_id / phone)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa.conversations (
  wa_id                   text PRIMARY KEY,
  phone_number_id         text,
  profile_name            text,
  last_message_text       text,
  last_message_at         timestamptz,
  last_message_direction  text,
  unread_count            integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
--  messages: one row per message, inbound or outbound.
--  Column order matches the LIVE database, not supabase/schema.sql.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa.messages (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  wa_message_id   text UNIQUE,                    -- webhook idempotency; NULLABLE
  wa_id           text NOT NULL REFERENCES wa.conversations(wa_id) ON DELETE CASCADE,
  direction       text NOT NULL,
  type            text NOT NULL DEFAULT 'text',
  body            text,
  media_meta      jsonb,
  status          text,
  error           text,
  wa_timestamp    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  media_path      text,
  media_status    text,
  reaction        text,
  -- migration 004 was reverted in code (da92fdd) but its columns were never
  -- dropped from the live database, so they must be carried or a data-only
  -- restore fails on the COPY column list.
  deleted         boolean NOT NULL DEFAULT false,
  deleted_by      text,
  deleted_at      timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  forwarded       boolean NOT NULL DEFAULT false,
  client_key      text
);

CREATE INDEX IF NOT EXISTS messages_wa_id_created_idx ON wa.messages (wa_id, created_at);
CREATE INDEX IF NOT EXISTS messages_wa_id_updated_idx ON wa.messages (wa_id, updated_at);

-- Outbound send idempotency. The WHERE predicate is load-bearing: without it
-- reserve() never sees a 23505 and the ops dashboard double-sends billable
-- templates with no log output at all.
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_key_unique_idx
  ON wa.messages (client_key) WHERE client_key IS NOT NULL;

-- L7.4: the conversations list sorts on this on every 4s poll, per open tab.
CREATE INDEX IF NOT EXISTS conversations_last_message_at_idx
  ON wa.conversations (last_message_at DESC NULLS LAST);

-- L7.4: drives the stuck-media recovery sweep in lib/recovery.js.
CREATE INDEX IF NOT EXISTS messages_media_status_created_idx
  ON wa.messages (media_status, created_at) WHERE media_path IS NOT NULL;

-- Bump updated_at on every UPDATE. Drop this and inserts still work, so new
-- messages still appear, but reactions and delivery ticks never do: the
-- incremental poll filters on updated_at > since.
CREATE OR REPLACE FUNCTION wa.touch_messages_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_set_updated_at ON wa.messages;
CREATE TRIGGER messages_set_updated_at
  BEFORE UPDATE ON wa.messages
  FOR EACH ROW EXECUTE FUNCTION wa.touch_messages_updated_at();

-- ---------------------------------------------------------------------------
--  login_attempts: durable rate limiting for POST /api/login.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa.login_attempts (
  id            bigserial PRIMARY KEY,
  ip            text NOT NULL,
  attempted_at  timestamptz NOT NULL DEFAULT now(),
  success       boolean NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_ip_attempted_idx
  ON wa.login_attempts (ip, attempted_at);
