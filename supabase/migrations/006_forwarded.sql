-- =============================================================================
--  Migration 006: messages.forwarded
--  Marks an outgoing message that was forwarded from another conversation, so
--  the dashboard can show a small "↪ Forwarded" tag on that bubble. This is a
--  DASHBOARD-only label — the Cloud API can't set WhatsApp's native "Forwarded"
--  marker, so the recipient's phone shows a normal message.
--  Run in the Supabase SQL Editor. Idempotent.
-- =============================================================================

alter table public.messages
  add column if not exists forwarded boolean not null default false;
