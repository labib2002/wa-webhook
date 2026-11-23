-- =============================================================================
--  Migration 011: who answered, what still needs a reply, saved replies, and
--  devices tied to the passcode they signed up under.
--
--  messages.agent            the name the agent typed on their device, stored
--                            on each message they send.
--  conversations.done_at     when an agent marked the chat done. A chat needs a
--                            reply while the member wrote last and done_at is
--                            older than that message (or empty).
--  saved_replies             answers the team reuses, shared by every agent.
--  push_subscriptions.pass_mark  a mark of the passcode in force when the
--                            device signed up. After the passcode changes, a
--                            device with another mark gets no notifications.
--
--  Run as the backend's admin role (a member of wa_app), like 010.
--  Idempotent. Until this runs the inbox works as before: lib/features.js
--  finds each piece by itself within five minutes of it appearing.
--  Rollback:
--    ALTER TABLE wa.messages DROP COLUMN agent;
--    ALTER TABLE wa.conversations DROP COLUMN done_at;
--    ALTER TABLE wa.push_subscriptions DROP COLUMN pass_mark;
--    DROP TABLE wa.saved_replies;
-- =============================================================================

ALTER TABLE wa.messages ADD COLUMN IF NOT EXISTS agent text;
ALTER TABLE wa.conversations ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE wa.push_subscriptions ADD COLUMN IF NOT EXISTS pass_mark text;

CREATE TABLE IF NOT EXISTS wa.saved_replies (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title       text NOT NULL,
  body        text NOT NULL,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON wa.saved_replies TO wa_app;
