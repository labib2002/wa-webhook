-- =============================================================================
--  WhatsApp dashboard schema
--  Paste this whole file into the Supabase SQL Editor (one run) and execute.
--  Safe to re-run: everything is "if not exists" / idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
--  conversations: one row per WhatsApp user (keyed by their wa_id / phone)
-- ---------------------------------------------------------------------------
create table if not exists public.conversations (
  wa_id                   text primary key,             -- the user's WhatsApp id (their phone number)
  phone_number_id         text,                         -- MY business number that received the message
  profile_name            text,                         -- contacts[].profile.name (may be null)
  last_message_text       text,                         -- preview shown in the list (or a placeholder e.g. "📷 Image")
  last_message_at         timestamptz,                  -- drives list sort order (most recent on top)
  last_message_direction  text,                         -- 'in' | 'out'
  unread_count            integer not null default 0,   -- incremented on inbound, reset when the agent opens the chat
  created_at              timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
--  messages: one row per message, inbound or outbound
-- ---------------------------------------------------------------------------
create table if not exists public.messages (
  id              bigint generated always as identity primary key,
  wa_message_id   text unique,                           -- WhatsApp's message id; UNIQUE => webhook is idempotent
  wa_id           text not null references public.conversations(wa_id) on delete cascade,
  direction       text not null,                         -- 'in' | 'out'
  type            text not null default 'text',          -- text | image | audio | document | sticker | location | ...
  body            text,                                  -- text content, or a human label for non-text ("📷 Image")
  media_meta      jsonb,                                 -- { id, mime_type, filename, ... } for non-text (nullable)
  media_path      text,                                  -- object path inside the storage bucket (after download)
  media_status    text,                                  -- null | 'pending' | 'stored' | 'failed' | 'unsupported'
  reaction        text,                                  -- emoji the customer reacted with (on our message), or null
  status          text,                                  -- out: sent|delivered|read|failed   in: 'received'
  error           text,                                  -- failure reason surfaced to the UI (nullable)
  wa_timestamp    timestamptz,                           -- event time reported by WhatsApp
  created_at      timestamptz not null default now()
);

-- Fast thread fetch + ordering.
create index if not exists messages_wa_id_created_idx
  on public.messages (wa_id, created_at);

-- ---------------------------------------------------------------------------
--  Row Level Security.
--  RLS is ENABLED with NO permissive policies, so the public/anon key cannot
--  read or write any row. The server uses the service_role key (which bypasses
--  RLS) for ALL data access; the anon key is never shipped to the browser.
--  The dashboard stays live via smart polling through the passcode-gated API
--  (see README "Realtime vs polling"), so no row data is ever exposed to a
--  low-privilege key. This is deny-by-default for customer PII.
-- ---------------------------------------------------------------------------
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- (Intentionally no CREATE POLICY statements: deny-by-default for anon.)
