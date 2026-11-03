/**
 * submit-plugin — a package arrives, the server decides what it is.
 *
 * The request is a person's token and a base64 `.htp`. Everything a catalogue row needs
 * is derived here and nowhere else:
 *
 *   | field          | where it comes from                                  |
 *   | -------------- | ---------------------------------------------------- |
 *   | `sha256`       | computed from the decoded bytes in this function     |
 *   | `storage_path` | built as `<plugin id>/<manifest version>.htp`        |
 *   | `manifest`     | the archive's own `manifest.json`, re-read and judged |
 *   | `version`      | the manifest's `version`, not the body's             |
 *   | `status`       | `pending`, always; this function cannot publish       |
 *
 * A body may carry `sha256`, `status`, `storage_path`, `version` or `owner_id`; none of
 * them is read. That is not politeness — the client's own module says the uploader sends
 * "bytes and an idea, never a verdict", and the way to keep that true is for the function
 * to have no code path that accepts one.
 *
 * The writes use the caller's own token, so row-level security is the thing that decides
 * whether this person may write this row. The one exception is the package itself: the
 * bucket has no client write policy at all (see the migration), so the object goes up
 * with the service key — after the manifest has been validated, never before.
 */
import { configuration } from "../_shared/config.ts";
import { HttpError, failure, json, preflight, readJson, text } from "../_shared/http.ts";
import { requireUser } from "../_shared/auth.ts";
import { PACKAGE_LIMITS, decodeBase64, storagePathFor, verifyPackage } from "../_shared/package.ts";
import { insert, removePackage, selectOne, uploadPackage } from "../_shared/db.ts";

/** The URL name of a listing: lower-case, no dots, no spaces. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

interface PluginRow {
  readonly id: string;
  readonly owner_id: string;
  readonly slug: string;
  readonly plugin_id: string;
  readonly status: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();

  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const project = configuration();
    const caller = await requireUser(req, project);
    const body = await readJson(req);

    const slug = text(body.slug).toLowerCase();
    if (!SLUG.test(slug)) {
      throw new HttpError(
        400,
        "A slug is 2–63 lower-case letters, digits or hyphens, and starts with a letter or digit.",
      );
    }

    const encoded = text(body.package);
    if (encoded === "") throw new HttpError(400, "The request carries no package.");

    const bytes = decodeBase64(encoded);
    if (bytes === null) {
      throw new HttpError(
        400,
        `The package is not valid base64, or is larger than ${megabytes(PACKAGE_LIMITS.compressedBytes)}.`,
      );
    }

    // A profile row is what a listing refers to. A first-time submitter has none, and
    // asking them to create one before they can upload a file would be a dead end; the
    // row is written with their own token, so they can only ever create their own.
    await ensureProfile(project, caller.id, caller.email, caller.token);

    const existing = (await selectOne(
      project,
      `community_plugins?slug=eq.${encodeURIComponent(slug)}&select=id,owner_id,slug,plugin_id,status`,
      project.serviceKey,
    )) as PluginRow | null;

    if (existing !== null && existing.owner_id !== caller.id) {
      throw new HttpError(409, `The slug "${slug}" is already used by another plugin.`);
    }

    // The manifest is judged against the app's own rules — including, for an update, that
    // it still calls itself the same plugin. A package that changes its id is a different
    // plugin, and would inherit the original's installations and permission grants.
    const verdict = await verifyPackage(bytes, {
      appVersion: project.appVersion,
      ...(existing === null ? {} : { existingId: existing.plugin_id }),
    });
    if (!verdict.ok) throw new HttpError(422, verdict.problem, verdict.problems);

    const manifest = verdict.package.manifest;

    let pluginId: string;
    if (existing === null) {
      const created = await insert(
        project,
        "community_plugins",
        {
          owner_id: caller.id,
          slug,
          // Both of these come from the package: the listing must not be able to claim a
          // name its manifest does not, because the install panel shows the manifest's.
          plugin_id: manifest.id,
          name: manifest.name,
          description: manifest.description ?? text(body.description),
        },
        caller.token,
      );
      if (created === null || typeof created.id !== "string") {
        throw new HttpError(502, "The listing was created but the catalogue did not return it.");
      }
      pluginId = created.id;
    } else {
      pluginId = existing.id;
    }

    // Read as the service, so a revoked or suspended version with this number is seen
    // too: a version number that was pulled is burned, and reusing it would let a package
    // take the place of one that moderators removed.
    const duplicate = await selectOne(
      project,
      `community_plugin_versions?plugin_id=eq.${pluginId}&version=eq.${encodeURIComponent(manifest.version)}&select=id,status`,
      project.serviceKey,
    );
    if (duplicate !== null) {
      throw new HttpError(
        409,
        `Version ${manifest.version} has already been submitted for this plugin. Publish a higher version.`,
      );
    }

    // A listing created by a submission that then fails stays behind, empty and pending.
    // That is deliberate: it is invisible to everybody but its owner, and a retry with the
    // same slug finds it and adds the version, which is exactly what the person wanted.
    const storagePath = storagePathFor(pluginId, manifest.version);
    await uploadPackage(project, storagePath, bytes);

    let version: Record<string, unknown> | null;
    try {
      version = await insert(
        project,
        "community_plugin_versions",
        {
          plugin_id: pluginId,
          version: manifest.version,
          sha256: verdict.package.sha256,
          storage_path: storagePath,
          byte_size: bytes.byteLength,
          manifest,
          status: "pending",
        },
        caller.token,
      );
    } catch (cause) {
      // The bytes are already stored. A package with no row is unreachable — nothing can
      // name its id — so leaving it would be litter, not a leak; removing it is tidier.
      await removePackage(project, storagePath);
      throw cause;
    }

    if (version === null) {
      await removePackage(project, storagePath);
      throw new HttpError(502, "The version was stored but the catalogue did not return it.");
    }

    // The shape `src/api/community.ts` reads: `{ version: { id, plugin_id, version,
    // sha256, manifest, status, published_at } }`, snake case because it is the row.
    return json({ version }, 201);
  } catch (cause) {
    return failure(cause);
  }
});

/**
 * Makes sure the person has a profile, without ever touching somebody else's.
 *
 * The username is derived from their id rather than asked for, because this function's
 * job is a package and not a sign-up form; the catalogue can offer renaming later without
 * a unique-constraint fight at upload time.
 */
async function ensureProfile(
  project: ReturnType<typeof configuration>,
  userId: string,
  email: string,
  token: string,
): Promise<void> {
  const existing = await selectOne(
    project,
    `community_profiles?user_id=eq.${encodeURIComponent(userId)}&select=user_id`,
    project.serviceKey,
  );
  if (existing !== null) return;

  const local = email.split("@")[0]?.trim() ?? "";
  await insert(
    project,
    "community_profiles",
    {
      user_id: userId,
      username: `user-${userId.replace(/-/g, "").slice(0, 24)}`,
      display_name: (local === "" ? "Member" : local).slice(0, 64),
    },
    token,
    { ignoreDuplicates: true }, // two uploads racing create one profile, not an error
  );
}

function megabytes(value: number): string {
  const amount = value / (1024 * 1024);
  return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} MB`;
}
