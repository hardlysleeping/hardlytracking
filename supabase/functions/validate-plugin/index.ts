/**
 * validate-plugin — the second pair of eyes, and the only place a verdict is recorded.
 *
 * A submission is validated once, on the way in; this function validates it again from
 * storage. That is not redundancy for its own sake. The two checks answer different
 * questions:
 *
 * - `submit-plugin` answered "is this a package this app could install?" about the bytes
 *   in that request.
 * - this answers "are the bytes in the bucket still the bytes whose hash is in the row,
 *   and are they still a valid package?" — about what would actually be served.
 *
 * Between the two, a bug in upload, a wrong path, a truncated object or a partially
 * written row all become a refused version rather than a broken install. The comparison
 * is deliberate: the stored hash is the claim, the recomputed hash is the check, and a
 * mismatch is recorded as a failure instead of being repaired.
 *
 * It is service-role only. Not because validation is dangerous, but because the verdict
 * is what publishing reads: a person who could call this could tell the catalogue that
 * their own package had been checked.
 *
 * It reads a stored package and writes one row's validation columns. It cannot publish:
 * there is no code path here that sets `status`, and the database's trigger would refuse
 * one anyway if the caller were not the service role.
 */
import { configuration } from "../_shared/config.ts";
import { HttpError, failure, isUuid, json, preflight, readJson, text } from "../_shared/http.ts";
import { requireService } from "../_shared/auth.ts";
import { verifyPackage } from "../_shared/package.ts";
import { sha256 } from "../../../src/plugins/validate.ts";
import { downloadPackage, selectOne, update } from "../_shared/db.ts";

interface VersionRow {
  readonly id: string;
  readonly plugin_id: string;
  readonly version: string;
  readonly sha256: string;
  readonly storage_path: string;
  readonly status: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();

  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const project = configuration();
    await requireService(req, project); // refuses every caller without the service key

    const body = await readJson(req);
    const versionId = await resolveVersion(project, body);

    const row = (await selectOne(
      project,
      `community_plugin_versions?id=eq.${encodeURIComponent(versionId)}&select=id,plugin_id,version,sha256,storage_path,status`,
      project.serviceKey,
    )) as VersionRow | null;
    if (row === null) throw new HttpError(404, "No such version.");

    // A verdict is part of what was published. Re-validating a live version would rewrite
    // history rather than correct it, and the trigger would refuse halfway through.
    if (row.status === "published") {
      throw new HttpError(409, "That version is published; its verdict is already recorded.");
    }
    if (row.status === "revoked") {
      throw new HttpError(409, "That version was revoked; a revoked version is final.");
    }

    const plugin = (await selectOne(
      project,
      `community_plugins?id=eq.${encodeURIComponent(row.plugin_id)}&select=plugin_id`,
      project.serviceKey,
    )) as { plugin_id: string } | null;
    if (plugin === null) throw new HttpError(404, "The version's listing is missing.");

    const bytes = await downloadPackage(project, row.storage_path);

    // The claim is the row; the check is the bytes. A package that no longer hashes to
    // what was recorded is a failure to record, not a package to accept: whatever was
    // reviewed is not what would be served.
    const digest = await sha256(bytes);
    const verdict =
      digest === row.sha256
        ? await verifyPackage(bytes, { appVersion: project.appVersion, existingId: plugin.plugin_id })
        : {
            ok: false as const,
            problem: "The stored package does not match the hash recorded for this version.",
            problems: [
              `Recorded ${row.sha256}; the stored object hashes to ${digest}.`,
            ],
          };

    const updated = await update(
      project,
      `community_plugin_versions?id=eq.${encodeURIComponent(row.id)}`,
      {
        validated_at: new Date().toISOString(),
        validation_ok: verdict.ok,
        validation_problem: verdict.ok ? null : verdict.problem,
      },
      project.serviceKey,
    );
    if (updated.length === 0) throw new HttpError(502, "The verdict could not be recorded.");

    return json({
      version: updated[0],
      verdict: {
        ok: verdict.ok,
        problem: verdict.ok ? null : verdict.problem,
        problems: verdict.ok ? [] : verdict.problems,
      },
    });
  } catch (cause) {
    return failure(cause);
  }
});

/**
 * Which version to validate: `{ "version_id": "…" }`, or `{ "plugin_id": "…", "version":
 * "1.0.0" }` for an operator who has the package but not the row id.
 */
async function resolveVersion(
  project: ReturnType<typeof configuration>,
  body: Record<string, unknown>,
): Promise<string> {
  const id = text(body.version_id);
  if (id !== "") {
    if (!isUuid(id)) throw new HttpError(400, "version_id must be a UUID.");
    return id;
  }

  const version = text(body.version);
  const pluginId = text(body.plugin_id);
  if (version === "" || pluginId === "") {
    throw new HttpError(400, "Send version_id, or plugin_id and version.");
  }
  if (!isUuid(pluginId)) throw new HttpError(400, "plugin_id must be a UUID (the listing's id, not its slug).");

  const row = await selectOne(
    project,
    `community_plugin_versions?plugin_id=eq.${encodeURIComponent(pluginId)}&version=eq.${encodeURIComponent(version)}&select=id`,
    project.serviceKey,
  );
  if (row === null || typeof row.id !== "string") {
    throw new HttpError(404, `No version ${version} for that listing.`);
  }
  return row.id;
}
