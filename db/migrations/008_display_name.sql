-- =============================================================================
--  Migration 008: conversations.display_name
--  The name an agent saves for a number in the inbox. WhatsApp never shares
--  the name a person is saved under, and every inbound message refreshes
--  profile_name with their WhatsApp profile name, so a saved name needs its own
--  column that the webhook never writes.
--
--  Run as wa_app (it owns the wa tables). Idempotent. Metadata only: no
--  default, so no table rewrite. The app degrades gracefully until this runs:
--  the list loads without saved names and renaming answers 503.
-- =============================================================================

ALTER TABLE wa.conversations
  ADD COLUMN IF NOT EXISTS display_name text;
