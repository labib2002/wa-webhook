-- =============================================================================
--  Migration 003: message reactions
--  A reaction is an emoji a user applies to one of OUR messages. We store it on
--  the target message row (the one whose wa_message_id the reaction references).
--  Run in the Supabase SQL Editor. Idempotent.
-- =============================================================================

alter table public.messages
  add column if not exists reaction text;   -- emoji reacted by the customer, or null
