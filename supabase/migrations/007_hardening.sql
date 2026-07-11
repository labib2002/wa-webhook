-- =============================================================================
--  Migration 007: hardening (login rate limiting + outbound idempotency)
--  Run this in the Supabase SQL Editor (paste + execute), same as 002-006.
--  Idempotent: safe to re-run.
--
--  The app degrades gracefully until this runs: login limiting falls back to
--  an in-process limiter and idempotency keys are ignored (sends still work).
-- =============================================================================

-- ---------------------------------------------------------------------------
--  login_attempts: one row per POST /api/login attempt (success and failure),
--  so the rate limiter survives serverless restarts. Rows older than 24h are
--  pruned by the daily GET /api/cron/maintenance run.
-- ---------------------------------------------------------------------------
create table if not exists public.login_attempts (
  id            bigserial primary key,
  ip            text not null,
  attempted_at  timestamptz not null default now(),
  success       boolean not null
);

-- Powers the per-IP window count (and the global count via attempted_at).
create index if not exists login_attempts_ip_attempted_idx
  on public.login_attempts (ip, attempted_at);

-- Same posture as the other tables: RLS on with no policies, so the anon key
-- sees nothing; the server's service-role key bypasses RLS.
alter table public.login_attempts enable row level security;

-- ---------------------------------------------------------------------------
--  messages.client_key: optional caller-supplied idempotency key for outbound
--  sends (/api/send, /api/send-media, /api/service/send-template). UNIQUE
--  when present, so a retried request dedupes instead of double-sending.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column if not exists client_key text;

create unique index if not exists messages_client_key_unique_idx
  on public.messages (client_key)
  where client_key is not null;
