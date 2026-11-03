-- The community plugin catalogue: listings, versions, reports, installs — and the
-- rules that keep the server, not the uploader, the thing that decides.
--
-- The client (`src/api/community.ts`) states the contract this file has to make
-- true: "the uploader sends bytes and an idea, never a verdict". Everywhere that
-- sentence could be quietly broken by a clever client, it is broken here instead:
--
--   * a listing is born `pending`, and a trigger forces it, whatever the body said;
--   * a version is born `pending`, and only the service role — or the
--     admin-checked function at the bottom of this file — may move it anywhere else;
--   * a listing's id, owner and slug are immutable, so a package cannot be
--     re-pointed at somebody else's listing and a listing cannot change hands;
--   * a stored package's path, hash, size and manifest are immutable forever, so
--     `version` + `sha256` really is the identity of the bytes that will be installed;
--   * `suspended` and `revoked` versions are invisible to every caller except the
--     service role, which makes "uninstallable" a property of the row rather than
--     something each client is trusted to remember.
--
-- Why triggers as well as RLS: a policy decides which *rows* a role may touch, and
-- cannot say "you may edit your listing's description but not its status". A
-- `with check (status = 'pending')` on UPDATE would also freeze the status forever,
-- which is wrong — an owner must still be able to rename a published plugin. The
-- trigger draws the line per column, where it belongs.
--
-- The one thing no policy here can check is whether a human is a moderator: the
-- service role has no user id, so a trigger cannot ask. That question is asked
-- exactly once, in `community_publish_version()`, where `auth.uid()` still exists.
--
-- Apply with `supabase db push`, or paste into the project's SQL editor.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Who counts as "the server"?
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three kinds of session reach these tables:
--
--   authenticated / anon   a client holding a user token, or nothing at all. RLS applies.
--   service_role           the key the Edge Functions hold. Bypasses RLS, but NOT
--                          triggers — which is why the triggers must still recognise it.
--   the table owner        `postgres`: what a `security definer` function runs as, and
--                          what a psql or migration session runs as. Unreachable from
--                          PostgREST, which always does `set role anon|authenticated|…`.
--
-- So the triggers ask the narrow question they can answer: did this write arrive
-- through a channel a client cannot reach? A client can send any status it likes in a
-- body, but it cannot make itself `service_role` and it cannot become the table owner.

create or replace function public.community_request_role()
returns text
language sql
stable
set search_path = public
as $$
  -- PostgREST puts the whole JWT payload in `request.jwt.claims`; older gateways and
  -- direct sessions may only have the single claim. Both are read, neither is trusted
  -- for anything except "is this a server session".
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    nullif(current_setting('request.jwt.claim.role', true), '')
  );
$$;

comment on function public.community_request_role() is
  'The PostgREST role claim of the current session, or null for a direct database session.';

create or replace function public.community_is_service()
returns boolean
language sql
stable
set search_path = public
as $$
  -- Null means no claims at all: psql, a migration, or a definer function reached from
  -- one. Those sessions are already past every door, so they count as the server.
  select public.community_request_role() is null
      or public.community_request_role() in ('service_role', 'postgres', 'supabase_admin');
$$;

comment on function public.community_is_service() is
  'True for the service-role key and for direct database sessions; false for anon/authenticated.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Profiles — a name for the catalogue, kept out of auth.users
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.community_profiles (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  username     text not null unique check (username ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  display_name text not null check (length(display_name) between 1 and 64),
  avatar_url   text,
  -- `member` can submit and report; `moderator` is reserved for a future review queue;
  -- `admin` is the only role that may publish or revoke (see the function below).
  role         text not null default 'member' check (role in ('member', 'moderator', 'admin')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table public.community_profiles is
  'One row per person who submits or reports. Public fields only; the role is what publish-plugin checks.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Listings — the thing people browse
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.community_plugins (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.community_profiles (user_id) on delete cascade,
  -- The URL name, e.g. `reader-tools`. Chosen by the submitter, immutable afterwards.
  slug        text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  -- The manifest's own reverse-DNS id, e.g. `dev.example.reader-tools`. Kept so an
  -- update can be checked against the listing it claims to be an update of.
  plugin_id   text not null unique check (plugin_id ~ '^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$'),
  name        text not null check (length(name) between 1 and 80),
  description text not null default '' check (length(description) <= 2000),
  icon_url    text,
  -- `pending` (never reviewed, or withdrawn), `published` (browsable), `suspended`
  -- (hidden while something is wrong; only an admin brings it back, by publishing a
  -- version again). `revoked` lives on versions, not listings.
  status      text not null default 'pending' check (status in ('pending', 'published', 'suspended')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.community_plugins is
  'A plugin listing. Born pending; only the server changes status. Id, owner and slug are immutable.';

comment on column public.community_plugins.plugin_id is
  'The manifest id (reverse-DNS). An update must carry the same id, or it is a different plugin.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Versions — one immutable package each
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A row here is a claim about a file that already exists in the `community-plugins`
-- bucket. The hash is computed by the server from the bytes it received, never read
-- from the request; `storage_path` is built by the server from the plugin id and the
-- manifest version, never read from the request.

create table if not exists public.community_plugin_versions (
  id                 uuid primary key default gen_random_uuid(),
  plugin_id          uuid not null references public.community_plugins (id) on delete cascade,
  version            text not null
                       check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path       text not null unique
                       check (storage_path ~ '^[0-9a-f-]{36}/[0-9A-Za-z.+-]+\.htp$'),
  byte_size          integer not null check (byte_size > 0 and byte_size <= 10 * 1024 * 1024),
  manifest           jsonb not null check (jsonb_typeof(manifest) = 'object'),
  status             text not null default 'pending'
                       check (status in ('pending', 'published', 'suspended', 'revoked')),
  -- The verdict recorded by the `validate-plugin` function. `validation_ok is not true`
  -- is what stops a publish, in the database as well as in the function.
  validated_at       timestamptz,
  validation_ok      boolean,
  validation_problem text,
  created_at         timestamptz not null default now(),
  published_at       timestamptz,
  -- One version string per plugin: a second upload of 1.2.0 is a duplicate, not a fix.
  unique (plugin_id, version)
);

comment on table public.community_plugin_versions is
  'One uploaded package. Path, hash, size and manifest never change; only the server moves status.';

create index if not exists community_versions_plugin_idx
  on public.community_plugin_versions (plugin_id, status);
create index if not exists community_versions_published_idx
  on public.community_plugin_versions (plugin_id, published_at desc)
  where status = 'published';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Reports — write-only for people, readable only by the service role
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.community_plugin_reports (
  id          uuid primary key default gen_random_uuid(),
  plugin_id   uuid not null references public.community_plugins (id) on delete cascade,
  -- Optional: a report may be about a listing, or about the one version that misbehaved.
  version_id  uuid references public.community_plugin_versions (id) on delete set null,
  reporter_id uuid not null references public.community_profiles (user_id) on delete cascade,
  reason      text not null check (reason in ('malware', 'stolen-work', 'broken', 'misleading', 'other')),
  note        text not null default '' check (length(note) <= 2000),
  created_at  timestamptz not null default now()
);

comment on table public.community_plugin_reports is
  'A person''s complaint about a listing. Insert-only for the reporter; read by the service role only.';

create index if not exists community_reports_plugin_idx
  on public.community_plugin_reports (plugin_id, created_at desc);
create index if not exists community_reports_reporter_idx
  on public.community_plugin_reports (reporter_id, created_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Installs — a hint, never an authority
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The device's own database is what decides whether a plugin is installed and which
-- version is running; that is true offline, which is most of the time. This table
-- exists so the catalogue can say "412 people have this" and so a person can carry
-- their list to a new device. Nothing may gate a download on a row here: a missing row
-- is not an uninstall, and a present row is not permission.

create table if not exists public.community_plugin_installs (
  user_id      uuid not null references public.community_profiles (user_id) on delete cascade,
  version_id   uuid not null references public.community_plugin_versions (id) on delete cascade,
  -- Denormalised so a count per listing needs no join; kept honest by the FK.
  plugin_id    uuid not null references public.community_plugins (id) on delete cascade,
  installed_at timestamptz not null default now(),
  primary key (user_id, version_id)
);

comment on table public.community_plugin_installs is
  'Per-user install rows. A convenience for counts and migration, never the authority on what is installed.';

create index if not exists community_installs_plugin_idx
  on public.community_plugin_installs (plugin_id);
create index if not exists community_installs_user_idx
  on public.community_plugin_installs (user_id, installed_at desc);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Triggers — the columns a client may not decide
-- ─────────────────────────────────────────────────────────────────────────────

-- Defined here rather than with the other helpers because it names the versions table,
-- and a SQL function's body is parsed at creation time: above, the table did not exist.
create or replace function public.community_is_privileged()
returns boolean
language sql
stable
set search_path = public
as $$
  -- `current_user` is the *function owner* inside a `security definer` function, so this
  -- is also how the admin-checked publish function is recognised: it runs as postgres,
  -- and no path reachable with an anon or user token runs as postgres.
  select public.community_is_service()
      or current_user = (
           select pg_catalog.pg_get_userbyid(c.relowner)
           from pg_catalog.pg_class c
           where c.oid = 'public.community_plugin_versions'::regclass
         );
$$;

comment on function public.community_is_privileged() is
  'True when the current session is the service role, a direct session, or a security definer function owned by this schema''s owner. Never true for anon or authenticated.';

create or replace function public.community_profiles_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- A role is not something a person can give themselves. Downgraded silently rather
    -- than refused, because the row is otherwise correct and the client had no say: an
    -- insert that asks for `admin` produces a member, not an admin and not an error loop.
    if new.role <> 'member' and not public.community_is_privileged() then
      new.role := 'member';
    end if;
    return new;
  end if;

  if new.user_id <> old.user_id then
    raise exception 'A profile belongs to one person.' using errcode = '42501';
  end if;

  if new.role <> old.role and not public.community_is_privileged() then
    raise exception 'Only the server may change a role.' using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists community_profiles_guard on public.community_profiles;
create trigger community_profiles_guard
  before insert or update on public.community_profiles
  for each row execute function public.community_profiles_guard();

create or replace function public.community_plugins_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- A listing is born pending. Not "pending unless told otherwise": the body is
    -- written by whoever holds the token, so a client that sends `published` is not
    -- making a request, it is describing a decision it does not get to make.
    if new.status <> 'pending' and not public.community_is_privileged() then
      raise exception 'A listing is created pending; only the server may publish one.'
        using errcode = '42501',
              hint = 'Submit the package and wait for review.';
    end if;
    return new;
  end if;

  -- Identity, in the sense of "which thing is this": the row's id, the person it
  -- belongs to, its address, and the manifest id it stands for. None of these is a
  -- field, they are the row; an update that changes one is asking to be another row.
  if new.id <> old.id then
    raise exception 'A listing id never changes.' using errcode = '42501';
  end if;
  if new.owner_id <> old.owner_id then
    raise exception 'A listing belongs to the person who created it.' using errcode = '42501';
  end if;
  if new.slug <> old.slug then
    raise exception 'A listing''s slug is its address; publish under a new slug instead.'
      using errcode = '42501';
  end if;
  if new.plugin_id <> old.plugin_id then
    raise exception 'A listing''s manifest id never changes.' using errcode = '42501';
  end if;

  if new.status <> old.status and not public.community_is_privileged() then
    raise exception 'Only the server may change a listing''s status.'
      using errcode = '42501',
            hint = 'Publishing is an admin action; revoking is done by the publish function.';
  end if;

  if old.status = 'published' and new.status = 'pending' then
    raise exception 'A published listing cannot go back to pending; suspend it instead.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

drop trigger if exists community_plugins_guard on public.community_plugins;
create trigger community_plugins_guard
  before insert or update on public.community_plugins
  for each row execute function public.community_plugins_guard();

create or replace function public.community_versions_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' and not public.community_is_privileged() then
      raise exception 'A version is created pending; only the server may publish one.'
        using errcode = '42501';
    end if;
    if new.status = 'published' and new.validation_ok is not true then
      raise exception 'A version cannot be published before it has been validated on the server.'
        using errcode = '42501',
              hint = 'Call validate-plugin first; it records the verdict this trigger reads.';
    end if;
    return new;
  end if;

  -- Content is identity. Anything that would change what gets installed is a different
  -- version and has to arrive as a new row with a new hash and a new path.
  if new.plugin_id is distinct from old.plugin_id
     or new.version is distinct from old.version
     or new.sha256 is distinct from old.sha256
     or new.storage_path is distinct from old.storage_path
     or new.manifest is distinct from old.manifest
     or new.byte_size is distinct from old.byte_size then
    raise exception 'A stored package never changes; submit a new version instead.'
      using errcode = '42501';
  end if;

  -- Revocation is the end of a version's life, not a pause: making it reversible would
  -- mean a package that was pulled for malware could be brought back by re-publishing it.
  if old.status = 'revoked' then
    raise exception 'A revoked version is final.' using errcode = '42501';
  end if;

  if old.status = 'published' then
    if new.status not in ('published', 'suspended', 'revoked') then
      raise exception 'A published version can only be suspended or revoked.'
        using errcode = '42501';
    end if;
    -- The validation record is part of what was published: "this verdict, for these
    -- bytes". Rewriting it afterwards would make the record describe a decision nobody made.
    if new.validation_ok is distinct from old.validation_ok
       or new.validation_problem is distinct from old.validation_problem
       or new.validated_at is distinct from old.validated_at then
      raise exception 'The validation record of a published version is immutable.'
        using errcode = '42501';
    end if;
  end if;

  if new.status = 'published' and new.validation_ok is not true then
    raise exception 'A version cannot be published before it has been validated on the server.'
      using errcode = '42501';
  end if;

  if new.status <> old.status and not public.community_is_privileged() then
    raise exception 'Only the server may change a version''s status.'
      using errcode = '42501';
  end if;

  if new.status = 'published' and old.published_at is null then
    new.published_at := now();  -- the server's clock, not the writer's
  end if;

  return new;
end;
$$;

drop trigger if exists community_versions_guard on public.community_plugin_versions;
create trigger community_versions_guard
  before insert or update on public.community_plugin_versions
  for each row execute function public.community_versions_guard();

-- Keep `updated_at` honest without trusting the writer's clock. One function for both
-- tables that have the column; the entitlements schema uses the same idea.
create or replace function public.community_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists community_profiles_touch on public.community_profiles;
create trigger community_profiles_touch
  before update on public.community_profiles
  for each row execute function public.community_touch_updated_at();

drop trigger if exists community_plugins_touch on public.community_plugins;
create trigger community_plugins_touch
  before update on public.community_plugins
  for each row execute function public.community_touch_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Row-level security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.community_profiles         enable row level security;
alter table public.community_plugins          enable row level security;
alter table public.community_plugin_versions  enable row level security;
alter table public.community_plugin_reports   enable row level security;
alter table public.community_plugin_installs  enable row level security;

-- Profiles: a name and an avatar are public by design — the catalogue shows them
-- next to a plugin. Nothing else about a person is in this table.
drop policy if exists "profiles are public" on public.community_profiles;
create policy "profiles are public"
  on public.community_profiles
  for select
  to anon, authenticated
  using (true);

drop policy if exists "a person creates only their own profile" on public.community_profiles;
create policy "a person creates only their own profile"
  on public.community_profiles
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "a person edits only their own profile" on public.community_profiles;
create policy "a person edits only their own profile"
  on public.community_profiles
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Listings: published ones are the catalogue. A pending or suspended one is visible
-- to its owner and nobody else, which is what makes "suspended" mean hidden rather
-- than merely labelled.
drop policy if exists "published listings are public" on public.community_plugins;
create policy "published listings are public"
  on public.community_plugins
  for select
  to anon, authenticated
  using (status = 'published');

drop policy if exists "an owner sees their own listing" on public.community_plugins;
create policy "an owner sees their own listing"
  on public.community_plugins
  for select
  to authenticated
  using (owner_id = auth.uid());

drop policy if exists "an owner creates a pending listing" on public.community_plugins;
create policy "an owner creates a pending listing"
  on public.community_plugins
  for insert
  to authenticated
  with check (owner_id = auth.uid() and status = 'pending');

drop policy if exists "an owner edits their own listing" on public.community_plugins;
create policy "an owner edits their own listing"
  on public.community_plugins
  for update
  to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Deleting a listing is deleting its versions (the FK cascades). That is allowed only
-- while nothing has been published: once other people can install something, the row
-- stops being only the owner's to remove.
drop policy if exists "an owner deletes an unpublished listing" on public.community_plugins;
create policy "an owner deletes an unpublished listing"
  on public.community_plugins
  for delete
  to authenticated
  using (
    owner_id = auth.uid()
    and status <> 'published'
    and not exists (
      select 1 from public.community_plugin_versions v
      where v.plugin_id = community_plugins.id and v.status = 'published'
    )
  );

-- Versions: the visibility rule that makes revocation real. A caller who is not the
-- service role can see a version only when it is published (and its listing is too),
-- or when it is their own and still pending. `suspended` and `revoked` match no
-- branch, so they are not filtered out of the answer — they are absent from the only
-- rows the query can reach.
drop policy if exists "published versions of a published listing" on public.community_plugin_versions;
create policy "published versions of a published listing"
  on public.community_plugin_versions
  for select
  to anon, authenticated
  using (
    status = 'published'
    and exists (
      select 1 from public.community_plugins p
      where p.id = community_plugin_versions.plugin_id and p.status = 'published'
    )
  );

drop policy if exists "an owner sees their own pending versions" on public.community_plugin_versions;
create policy "an owner sees their own pending versions"
  on public.community_plugin_versions
  for select
  to authenticated
  using (
    status = 'pending'
    and exists (
      select 1 from public.community_plugins p
      where p.id = community_plugin_versions.plugin_id and p.owner_id = auth.uid()
    )
  );

drop policy if exists "an owner submits a pending version" on public.community_plugin_versions;
create policy "an owner submits a pending version"
  on public.community_plugin_versions
  for insert
  to authenticated
  with check (
    status = 'pending'
    and exists (
      select 1 from public.community_plugins p
      where p.id = community_plugin_versions.plugin_id and p.owner_id = auth.uid()
    )
  );

-- Withdrawing a version before review is the owner's business. Rewriting one is not:
-- there is no UPDATE policy on this table at all. A pending version is corrected by
-- deleting it and submitting again, so the hash a reviewer reads is always the hash of
-- the bytes that were uploaded.
drop policy if exists "an owner withdraws a pending version" on public.community_plugin_versions;
create policy "an owner withdraws a pending version"
  on public.community_plugin_versions
  for delete
  to authenticated
  using (
    status = 'pending'
    and exists (
      select 1 from public.community_plugins p
      where p.id = community_plugin_versions.plugin_id and p.owner_id = auth.uid()
    )
  );

-- Reports: insert only, always as yourself. There is no SELECT policy and no SELECT
-- grant, so a report is readable by the service role and by nobody else — not by the
-- reporter, not by the person reported. Being able to read your own accusation would
-- tell you who filed it as soon as there are two people involved.
drop policy if exists "a signed-in person files a report as themselves" on public.community_plugin_reports;
create policy "a signed-in person files a report as themselves"
  on public.community_plugin_reports
  for insert
  to authenticated
  with check (reporter_id = auth.uid());

-- Installs: each person's own rows. Not authoritative (see the table comment), so
-- there is nothing here worth protecting from the owner themselves.
drop policy if exists "a person reads their own installs" on public.community_plugin_installs;
create policy "a person reads their own installs"
  on public.community_plugin_installs
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "a person records their own installs" on public.community_plugin_installs;
create policy "a person records their own installs"
  on public.community_plugin_installs
  for insert
  to authenticated
  with check (user_id = auth.uid());

drop policy if exists "a person updates their own installs" on public.community_plugin_installs;
create policy "a person updates their own installs"
  on public.community_plugin_installs
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "a person forgets their own installs" on public.community_plugin_installs;
create policy "a person forgets their own installs"
  on public.community_plugin_installs
  for delete
  to authenticated
  using (user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────────
-- 8. Grants, stated rather than inherited
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Supabase's default privileges hand `anon` and `authenticated` access to the public
-- schema, and a policy on a table nobody was granted answers "permission denied"
-- instead of "no rows". Every grant below is the minimum its policies need; the RLS
-- policies above are what decide rows, these decide verbs.

revoke all on public.community_profiles, public.community_plugins,
              public.community_plugin_versions, public.community_plugin_reports,
              public.community_plugin_installs
  from anon, authenticated;

grant select on public.community_profiles to anon, authenticated;
grant insert, update on public.community_profiles to authenticated;

grant select on public.community_plugins to anon, authenticated;
grant insert, update, delete on public.community_plugins to authenticated;

grant select on public.community_plugin_versions to anon, authenticated;
grant insert, delete on public.community_plugin_versions to authenticated;
-- No UPDATE, on purpose: a version is written once. The service role bypasses grants.

grant insert on public.community_plugin_reports to authenticated;
-- No SELECT: reports are for the service role only.

grant select, insert, update, delete on public.community_plugin_installs to authenticated;

-- The service role keeps every verb. It bypasses RLS but not grants, and a project
-- created with different default privileges would otherwise leave the Edge Functions
-- able to read rows and unable to write any. This is the key the functions hold, so
-- the grant is not a widening of what a client can do.
grant all on public.community_profiles, public.community_plugins,
             public.community_plugin_versions, public.community_plugin_reports,
             public.community_plugin_installs
  to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 9. Publishing — one security definer function, one admin check
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This is the only client-reachable path that can move a version to `published`.
-- It is `security definer` because the write it performs is a write the caller does
-- not otherwise have the privilege to make — that is the whole point of the function,
-- and the reason it must check the caller itself rather than lean on RLS.
--
-- `auth.uid()` is still the admin's id here (a definer function changes `current_user`,
-- not the request's claims), so the check is about the person, not the key.
-- A service-role session has no user id and is therefore refused: publishing is an
-- admin's decision, and an automated retry must not be able to make it.

create or replace function public.community_publish_version(
  p_version_id uuid,
  p_action     text
)
returns public.community_plugin_versions
language plpgsql
security definer
set search_path = public
as $$
declare
  caller      uuid := auth.uid();
  target      public.community_plugin_versions;
  is_admin    boolean;
begin
  if p_action not in ('publish', 'revoke') then
    raise exception 'p_action must be publish or revoke, not %.', p_action
      using errcode = '22023';
  end if;

  if p_version_id is null then
    raise exception 'A version id is required.' using errcode = '22023';
  end if;

  select exists (
    select 1 from public.community_profiles p
    where p.user_id = caller and p.role = 'admin'
  ) into is_admin;

  if not coalesce(is_admin, false) then
    raise exception 'Only an admin may publish or revoke a version.'
      using errcode = '42501';
  end if;

  select * into target
  from public.community_plugin_versions
  where id = p_version_id
  for update;

  if not found then
    raise exception 'No version with id %.', p_version_id using errcode = 'P0002';
  end if;

  if p_action = 'publish' then
    if target.status = 'revoked' then
      raise exception 'A revoked version cannot be published again.' using errcode = '42501';
    end if;
    if target.validation_ok is not true then
      raise exception 'This version has not passed server-side validation.'
        using errcode = '42501',
              hint = 'Call validate-plugin for this version first.';
    end if;

    update public.community_plugin_versions
       set status = 'published',
           published_at = coalesce(published_at, now())
     where id = p_version_id
    returning * into target;

    -- A listing with a published version is browsable. `suspended` is cleared here
    -- because publishing a version is an admin saying "this one is fine".
    update public.community_plugins
       set status = 'published'
     where id = target.plugin_id;
  else
    update public.community_plugin_versions
       set status = 'revoked'
     where id = p_version_id
    returning * into target;

    -- Revoking the last published version takes the listing out of the catalogue:
    -- there is nothing left to install, and a listing page with no installable
    -- version is a dead end that looks like a bug.
    if not exists (
      select 1 from public.community_plugin_versions v
      where v.plugin_id = target.plugin_id and v.status = 'published'
    ) then
      update public.community_plugins
         set status = 'suspended'
       where id = target.plugin_id;
    end if;
  end if;

  return target;
end;
$$;

comment on function public.community_publish_version(uuid, text) is
  'Publish or revoke one version. Security definer; refuses anyone whose profile role is not admin.';

revoke all on function public.community_publish_version(uuid, text) from public, anon;
grant execute on function public.community_publish_version(uuid, text) to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- 10. What an installer may read
-- ─────────────────────────────────────────────────────────────────────────────
--
-- One view, so the client never writes the join that decides installability. It is
-- `security_invoker`, so the RLS policies above still apply to whoever selects — the
-- view narrows, it does not elevate. A revoked or suspended version, or a version of
-- a suspended listing, cannot appear here by construction.
--
-- Note what is absent: the package bytes. The bucket is private and has no client
-- policy, so a download goes through a signed URL minted by the server. That is a
-- deliberate gap in this migration — see docs/community-backend.md.

create or replace view public.community_installable_versions
with (security_invoker = true) as
select
  v.id,
  p.slug,
  p.plugin_id,
  v.version,
  v.sha256,
  v.storage_path,
  v.byte_size,
  v.manifest,
  v.published_at
from public.community_plugin_versions v
join public.community_plugins p on p.id = v.plugin_id
where v.status = 'published'
  and p.status = 'published';

comment on view public.community_installable_versions is
  'The only rows an installer should read: published versions of published listings.';

revoke all on public.community_installable_versions from anon, authenticated;
grant select on public.community_installable_versions to anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 11. The bucket
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Created here so a fresh project has it, guarded so this migration also applies to a
-- plain PostgreSQL database with no storage schema (the tests do that). Private: a
-- published package is meant to be public, but the storage API cannot join to a table
-- to ask "is this version published", so the bucket has no anon policy at all and every
-- read is a signed URL from the server. Uploads are service-role only; there is no
-- policy letting `authenticated` write here, which is why submit-plugin holds the key.

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public)
    values ('community-plugins', 'community-plugins', false)
    on conflict (id) do nothing;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- What is deliberately absent
-- ─────────────────────────────────────────────────────────────────────────────
--
-- No policy anywhere lets a client set `status` to `published` on a listing or a
-- version, and no UPDATE grant exists on versions at all. No trigger computes a hash:
-- a hash is only worth recording if the server computed it from the bytes it stored,
-- and a database cannot see those bytes.
--
-- No table here records a review verdict on a listing (only on a version), because a
-- listing has no bytes of its own; its trustworthiness is exactly the trustworthiness
-- of the version a person installs.
