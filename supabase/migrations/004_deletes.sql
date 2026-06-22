-- =============================================================================
--  Migration 004: message deletion / revoke tombstones
--  A deleted message is kept as a tombstone (audit trail). We clear its body
--  and remove the bucket file, but keep the row with who/when/how it went.
--  Run in the Supabase SQL Editor. Idempotent.
-- =============================================================================

alter table public.messages
  add column if not exists deleted     boolean not null default false,
  add column if not exists deleted_by  text,   -- 'agent' | 'customer'
  add column if not exists deleted_at  timestamptz;
