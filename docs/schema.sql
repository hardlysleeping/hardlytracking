-- HardlyTracking entitlements: one boolean, one date, and who may touch them.
--
-- The reader is free and stays free. What is sold is automatic cross-device
-- sync, as one entitlement (`cloud_sync`), at one monthly and one yearly Stripe
-- price. This file is the entire backend of that sale.
--
-- The rule the rest of the system is built around: a signed-in client can READ
-- its own entitlement and can never WRITE one. `cloud_sync` is written by the
-- billing service, which holds the service-role key and therefore bypasses RLS.
-- If a client could write this table, the app could grant itself the feature it
-- sells, and every payment check downstream would be decoration.
--
-- Apply with `supabase db push`, or paste into the SQL editor of the project.
-- Safe to re-run: every statement is `if not exists` or a drop-and-create.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. The entitlement
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.entitlements (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  cloud_sync  boolean not null default false,
  -- Where the grant came from: 'stripe' today, 'manual' for a comped account.
  -- Never read by the app to decide anything; it is for humans and for support.
  source      text,
  -- The last moment the grant is honoured. Null means "no date", which is only
  -- ever true of a manual grant: Stripe always has a period end to give us.
  -- Grace after a failed payment is expressed here as a date three days out,
  -- with cloud_sync still true, because there is no third state column.
  expires_at  timestamptz,
  updated_at  timestamptz not null default now()
);

comment on table public.entitlements is
  'One row per reader who has ever owned cross-device sync. Written by the Stripe webhook only.';

alter table public.entitlements enable row level security;

-- A reader may read their own row, and only their own.
drop policy if exists "read own entitlement" on public.entitlements;
create policy "read own entitlement"
  on public.entitlements
  for select
  to authenticated
  using (auth.uid() = user_id);

-- The grant, stated rather than inherited. Supabase's default privileges hand
-- `authenticated` access to the public schema, and a policy on a table nobody was
-- granted answers "permission denied" instead of "no rows". Say it here so the
-- promise holds on a project created with different defaults.
revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;

-- No insert, update or delete grant, and no policy for any of them, on purpose.
-- With RLS enabled and no write policy, every client-side write is refused —
-- including a hand-crafted PATCH, and including a client that guesses the row.
-- The webhook writes with the service-role key, which bypasses RLS. If this table
-- ever becomes writable by `authenticated`, the app can grant itself the paid
-- feature, so the refusal is the feature's only real enforcement point.
revoke insert, update, delete on public.entitlements from anon, authenticated;

-- Keep `updated_at` honest without trusting the writer's clock.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists entitlements_touch on public.entitlements;
create trigger entitlements_touch
  before update on public.entitlements
  for each row execute function public.touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The link: which Stripe customer is which reader
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This table is the only thing that makes a payment attributable, and it is
-- written in exactly one place: checkout creation, with a user id taken from a
-- verified Supabase JWT. The webhook reads it and never writes it. A webhook body
-- can name any customer id and any user id; a row written here cannot.

create table if not exists public.stripe_customers (
  user_id            uuid primary key references auth.users (id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at         timestamptz not null default now()
);

comment on table public.stripe_customers is
  'Stripe customer to reader, written at checkout creation with the reader''s JWT. Read by the webhook.';

alter table public.stripe_customers enable row level security;

-- A reader may read their own link row and nothing else. The app has little use
-- for it, but "which customer am I" is the reader's own business and answering it
-- needs no elevation.
drop policy if exists "read own stripe customer" on public.stripe_customers;
create policy "read own stripe customer"
  on public.stripe_customers
  for select
  to authenticated
  using (auth.uid() = user_id);

revoke all on public.stripe_customers from anon, authenticated;
grant select on public.stripe_customers to authenticated;
-- Same refusal as above, for the same reason: a client that could rewrite this
-- row could point its own account at somebody else's subscription, or point its
-- subscription at somebody else's account.
revoke insert, update, delete on public.stripe_customers from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. The memory: every event id ever applied
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Stripe delivers at least once and out of order. The primary key on the event id
-- is what makes a replay a no-op even if two deliveries race; the service also
-- compares `created_at` against the newest event for the same subscription, so a
-- late `subscription.deleted` cannot revoke a subscription that has since been
-- renewed.

create table if not exists public.stripe_events (
  event_id        text primary key,
  subscription_id text,
  -- Stripe's own `event.created`, in seconds since the epoch — not a wall clock
  -- of ours. It is only ever compared with other Stripe timestamps, and a local
  -- clock a minute fast would make every delivery look stale.
  created_at      bigint not null,
  applied_at      timestamptz not null default now()
);

comment on table public.stripe_events is
  'Every Stripe event id ever applied, so a replay is a no-op. Service role only.';

create index if not exists stripe_events_subscription_idx
  on public.stripe_events (subscription_id, created_at desc);

alter table public.stripe_events enable row level security;
-- No policies at all, and no grants: not readable and not writable by any client.
-- Nothing in the app has any business knowing which events have arrived.

revoke all on public.stripe_events from anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- What is deliberately absent
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No trigger, no function and no RPC that writes `entitlements` from a client
-- call. The only writer is the billing service, holding the service-role key. A
-- `security definer` helper granted to `authenticated` would be a second door
-- into the same room, and the room holds the thing being sold.
