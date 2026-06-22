-- =============================================================================
--  Migration 005: messages.updated_at + auto-bump trigger
--  Lets the dashboard poll for ANY change to a message (new row, reaction,
--  status tick, delete) by fetching rows where updated_at > last-seen — not
--  just rows with a higher id. Run in the Supabase SQL Editor. Idempotent.
-- =============================================================================

alter table public.messages
  add column if not exists updated_at timestamptz not null default now();

-- Bump updated_at on every UPDATE (so reactions/status/deletes are caught even
-- when written by a plain .update()). INSERTs already get now() via the default.
create or replace function public.touch_messages_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists messages_set_updated_at on public.messages;
create trigger messages_set_updated_at
  before update on public.messages
  for each row execute function public.touch_messages_updated_at();

-- Index for the "changed since" poll.
create index if not exists messages_wa_id_updated_idx
  on public.messages (wa_id, updated_at);
