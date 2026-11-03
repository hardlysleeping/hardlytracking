# The community catalogue backend

The server half of the plugin catalogue: one migration, three Edge Functions, and one
private storage bucket. It exists so that a package someone publishes is checked by
something other than the person who published it.

**Nothing in the app talks to this yet.** `src/api/community.ts` is the client that will
(the submit call and the shape it expects are already written), but no view constructs a
`CommunityClient`, there is no publish button, and no project is configured in any build.
It has also **never been deployed or run against a live Supabase project** — there is none
on the machine this was written on. What *has* been run: the migration against a local
PostgreSQL 16 with a stand-in for `auth` (47 behavioural checks, all passing), and the
functions under Node against a stubbed Supabase (30 checks, all passing, plus the real
`examples/reader-tools.htp` through the validation pipeline). Everything below involving a
URL is therefore a procedure, not a transcript.

## What is in the box

| Path | What it is |
| --- | --- |
| `supabase/migrations/20261102000000_community_plugins.sql` | Tables, RLS, triggers, the publish function, the installable view, the bucket |
| `supabase/functions/submit-plugin/` | A person uploads a package; the server decides what it is |
| `supabase/functions/validate-plugin/` | The service re-reads a stored package and records a verdict |
| `supabase/functions/publish-plugin/` | An admin publishes or revokes one version |
| `supabase/functions/_shared/` | Config, HTTP, auth, REST/Storage calls, and the package pipeline |
| `supabase/functions/deno.json` | `fflate` for the app's ZIP reader, and the import settings the app's own modules need |

The rules a package is judged by are **not** in this directory. `_shared/package.ts`
imports `readPackage` from `src/plugins/validate.ts` and `readManifest` from
`src/plugins/manifest.ts` — the same two files the app installs with. A server with its
own copy of those rules would eventually publish something the app refuses, and nobody
would know which side was right.

## 1. Apply the migration

```sh
supabase link --project-ref <ref>          # once
supabase db push
```

or paste the file into the project's SQL editor. It is safe to re-run: every table is
`create table if not exists`, every policy and trigger is dropped before it is created.

It creates:

- `community_profiles` — a name and a role per person (`member`, `moderator`, `admin`).
- `community_plugins` — the listing: slug, manifest id, name, description, status.
- `community_plugin_versions` — one immutable package per row: version, sha256, storage
  path, manifest, status, validation verdict.
- `community_plugin_reports` — insert-only reports.
- `community_plugin_installs` — per-user rows, a convenience, never authoritative.
- `community_installable_versions` — a view: published versions of published listings.
- `community_publish_version(uuid, text)` — the only client-reachable way to publish.
- the `community-plugins` bucket, if the storage schema is present.

## 2. The bucket

The migration inserts it when it can:

```sql
insert into storage.buckets (id, name, public) values ('community-plugins', 'community-plugins', false)
on conflict (id) do nothing;
```

If your project's storage schema was not visible to the migration, create it by hand —
dashboard → Storage → New bucket, name `community-plugins`, **private**. Do not add a
policy for `anon` or `authenticated`: uploads go through `submit-plugin` with the service
key, and downloads are meant to be signed URLs minted by the server. A package's path is
`<plugin id>/<version>.htp`, e.g. `8f14e45f-…/1.2.0.htp`.

## 3. Secrets

```sh
supabase secrets set \
  CATALOGUE_APP_VERSION=0.5.9
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected into every
function by the platform; the code reads them from the environment and refuses to run with
a readable 500 if one is missing. `CATALOGUE_APP_VERSION` is the release a package's
`minAppVersion` is judged against — set it to the newest release you are willing to have
plugins require, and bump it when you ship.

Never put the service key in the app. It is only ever typed into an operator's shell.

## 4. Deploy

```sh
supabase functions deploy submit-plugin
supabase functions deploy validate-plugin
supabase functions deploy publish-plugin
```

Leave JWT verification on: each function checks the credential it needs itself, and
`submit-plugin` wants a *person's* token, not merely a valid one.

> **The one part that may not survive first contact.** These functions import the app's
> TypeScript directly (`../../../src/plugins/manifest.ts`), and every module under `src/`
> imports its siblings without a file extension. Node and Vite resolve that; Deno does not
> by default. `supabase/functions/deno.json` turns on `unstable: ["sloppy-imports"]` to
> bridge it. If your CLI or runtime refuses the import, the fallback is to copy
> `manifest.ts`, `validate.ts`, `lib/semver.ts` and `fflate` into the function bundle at
> deploy time — **not** to write a second copy of the rules by hand.

## 5. Submit a package

A submit needs a signed-in person's access token. There is no publish UI, so the token
comes from the client's own session or from a test sign-in:

```sh
PROJECT=https://<ref>.supabase.co
ANON=<anon key>
USER_JWT=<a signed-in user's access token>

# The package as base64, with no newlines.
base64 -w0 examples/reader-tools.htp > /tmp/pkg.b64

jq -n --rawfile pkg /tmp/pkg.b64 \
      --arg slug reader-tools \
      --arg description "Shows extra info on a series page." \
  '{slug: $slug, description: $description, package: ($pkg | rtrimstr("\n"))}' > /tmp/submit.json

curl -sS -X POST "$PROJECT/functions/v1/submit-plugin" \
  -H "Authorization: Bearer $USER_JWT" \
  -H "Content-Type: application/json" \
  --data @/tmp/submit.json | jq
```

The answer is `{ "version": { … } }` with `status: "pending"` and a `sha256` you did not
supply. If the body also carried `sha256`, `status`, `storage_path` or `version`, they were
ignored — the version comes from the manifest, the hash from the bytes, the path from the
plugin id and the version. A refusal is `{ "error": "…", "problems": ["…"] }` with 422 for
a package that is not one this app could install.

Common refusals: `401` no token or an expired one; `409` the slug belongs to someone else,
or that version already exists (including a revoked one — its number is burned); `422`
the archive or the manifest is wrong, with every problem listed.

## 6. Validate it

Service key only. The function re-downloads the object, recomputes the SHA-256 and
compares it with the row before re-running the validation rules; a mismatch is recorded as
a failed verdict.

```sh
SERVICE=<service role key>
VERSION_ID=<the id from the submit response>

curl -sS -X POST "$PROJECT/functions/v1/validate-plugin" \
  -H "Authorization: Bearer $SERVICE" \
  -H "Content-Type: application/json" \
  -d "{\"version_id\":\"$VERSION_ID\"}" | jq
```

`{ "verdict": { "ok": true, "problem": null, "problems": [] }, "version": { … } }`.
A failure is recorded too — `validation_ok: false` plus the sentence — which is what makes
a retry meaningful rather than a way to launder a bad package.

## 7. Publish or revoke

Two credentials: the service key in `apikey` (this is the backend, not a public endpoint)
and an **admin's** access token in `Authorization` (a decision needs a person). The write
then runs as that admin, so the database's own check in `community_publish_version()`
decides — the function's check only turns a refusal into a readable 403.

```sh
ADMIN_JWT=<an admin's access token>

curl -sS -X POST "$PROJECT/functions/v1/publish-plugin" \
  -H "apikey: $SERVICE" \
  -H "Authorization: Bearer $ADMIN_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"version_id\":\"$VERSION_ID\",\"action\":\"publish\"}" | jq
```

`action` is `publish` or `revoke`. Publishing requires `validation_ok = true`; a version
that has not been through `validate-plugin` is refused by the database, not just by the
function. Revoking sets the version to `revoked` (final — it cannot be published or edited
again) and, if it was the listing's last published version, sets the listing to
`suspended`, so the catalogue cannot show a listing with nothing installable behind it.

Making someone an admin is deliberately not an API call:

```sql
update public.community_profiles set role = 'admin' where username = '<their username>';
```

## 8. What each policy refuses

Everything below is enforced in the database. A client that ignores the API and speaks
PostgREST directly gets the same answers.

| Attempt | Result |
| --- | --- |
| Insert a listing with `status = 'published'` | `42501` — a listing is born pending |
| Update your own listing's `status` | `42501` — only the server may change it |
| Update a listing's `id`, `owner_id`, `slug` or manifest id | `42501` — identity is immutable |
| Update someone else's listing or profile | 0 rows; RLS filters it out |
| Delete a listing that has a published version | 0 rows — once people can install it, it is not only yours |
| Insert a version as `published`, or into someone else's listing | `42501` (trigger) / RLS refusal |
| Update a version at all | `permission denied` — there is no UPDATE grant; a correction is a new version |
| Change a stored version's `sha256`, `path`, `manifest` or size | `42501` — even for the service role |
| Change a version's validation record after it is published | `42501` — the verdict belongs to the bytes that were published |
| Publish without a passing validation record | `42501` |
| Re-publish or edit a `revoked` version | `42501` — revocation is final |
| Read a `suspended` or `revoked` version as anyone but the service role | Absent from the result — the select policy has no branch that matches |
| Read a pending listing/version that is not yours | Absent from the result |
| Read reports | `permission denied` — no SELECT grant, no SELECT policy |
| File a report as someone else | RLS refusal |
| Read or write someone else's install rows | 0 rows / RLS refusal |
| Call `community_publish_version` as a non-admin | `42501`, even with a valid session |

The one thing a policy cannot check is whether a human is a moderator, because the service
role has no user id. That check lives in `community_publish_version()`, where `auth.uid()`
is still the caller — and a service-role session, having no `sub`, is refused there too.

## 9. Checking what an installer would see

```sql
select slug, version, sha256, storage_path, published_at
from public.community_installable_versions
where slug = 'reader-tools';
```

If a version you published is missing from that view, either its status or its listing's
status is not `published`; the view is `security_invoker`, so it also obeys RLS for the
role running the query.

## 10. Known gaps

- **Nothing calls any of this.** `CommunityClient` is not constructed anywhere in `src/`;
  there is no catalogue screen, no publish or revoke UI, and no download path. Packages are
  private, so an installer needs a signed URL, and no function mints one yet.
- **`src/api/community.ts` calls `functions/v1/report-plugin`, which does not exist here.**
  Reports do not need a function — `community_plugin_reports` is insert-only for the
  reporter, with `reporter_id` checked against `auth.uid()` and the reason checked by a
  constraint — so either that call should become a PostgREST insert, or a fourth function
  should be added. It was left out rather than invented.
- **`deno.json`'s `sloppy-imports`** is the seam described in §4, and is the first thing to
  check if a deploy fails.
- **No rate limiting.** Nothing stops a signed-in person submitting packages in a loop;
  the unique constraints stop duplicates, not volume.
- **No review queue.** `moderator` exists as a role and means nothing yet: `validate-plugin`
  is mechanical, and everything else is an admin acting on a report they read in SQL.
