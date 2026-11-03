/**
 * publish-plugin — the one action a person, not a package, decides.
 *
 * Two credentials, for two different reasons:
 *
 * - **the service-role key**, in `apikey`, so this endpoint is part of the backend rather
 *   than a public button anyone can press. It is checked in constant time and never used
 *   to identify anybody;
 * - **an admin's access token**, in `Authorization`, because publishing is a decision and
 *   a decision needs a person. The function looks that person up and refuses anyone whose
 *   `community_profiles.role` is not `admin`.
 *
 * The write itself then runs with the **admin's own token**, through
 * `community_publish_version()`. That ordering is the point: the function's admin check is
 * a courtesy that turns a plpgsql exception into a readable 403, while the check that
 * matters is inside the `security definer` function, where `auth.uid()` is still the
 * admin's id and no service-role session has one at all. A bug here — a deleted check, a
 * wrongly cased string — leaves the endpoint open to *admins only*, not to everyone.
 *
 * `revoke` is not "unpublish": it sets the version to `revoked`, which the select policy
 * makes invisible to every non-service caller and the trigger makes final. The database
 * also takes the listing out of the catalogue when its last published version goes, so a
 * revoked package cannot be installed through a listing that still looks alive.
 */
import { configuration } from "../_shared/config.ts";
import { HttpError, failure, isUuid, json, preflight, readJson, text } from "../_shared/http.ts";
import { requireAdmin, requireService } from "../_shared/auth.ts";
import { rpc } from "../_shared/db.ts";

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return preflight();

  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST.");
    const project = configuration();

    // Gate 1: the deployment. A wrong key stops here, before the token is even looked at.
    await requireService(req, project);

    // Gate 2: the person. `requireAdmin` verifies the token with GoTrue and reads the
    // role with the service key, because an admin may need to act on a listing that RLS
    // would hide from them (a pending one that is not theirs).
    const admin = await requireAdmin(req, project);

    const body = await readJson(req);
    const versionId = text(body.version_id);
    if (!isUuid(versionId)) throw new HttpError(400, "version_id must be a UUID.");

    const action = text(body.action).toLowerCase();
    if (action !== "publish" && action !== "revoke") {
      throw new HttpError(400, "action must be publish or revoke.");
    }

    // The admin's token, not the service key: the database's own check reads `sub` from
    // it. Passing the service key here would authenticate the deployment and no one.
    const result = await rpc(
      project,
      "community_publish_version",
      { p_version_id: versionId, p_action: action },
      admin.token,
    );

    const version = Array.isArray(result) ? result[0] : result;
    if (version === null || typeof version !== "object") {
      throw new HttpError(502, "The catalogue did not return the version it changed.");
    }

    return json({
      version,
      action,
      // Named explicitly so an operator's script can log it without parsing the row.
      by: admin.id,
    });
  } catch (cause) {
    return failure(cause);
  }
});
