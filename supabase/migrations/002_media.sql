-- =============================================================================
--  Migration 002: media storage support
--  Run this in the Supabase SQL Editor if you already ran the original schema.
--  (Fresh installs get these columns from schema.sql already.)
--  Idempotent.
-- =============================================================================

alter table public.messages
  add column if not exists media_path   text,   -- object path inside the storage bucket
  add column if not exists media_status text;   -- null | 'pending' | 'stored' | 'failed' | 'unsupported'
