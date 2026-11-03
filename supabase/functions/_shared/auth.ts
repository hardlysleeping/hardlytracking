/**
 * The two credentials these functions understand, and the one question they answer.
 *
 * There are exactly two kinds of caller:
 *
 * - **a person**, proved by a Supabase access token in `Authorization`. The token is not
 *   decoded here — it is handed to GoTrue (`/auth/v1/user`), which verifies the
 *   signature, the expiry and the revocation state. Decoding a JWT and trusting its
 *   `sub` would be a suggestion, not a check: anyone can base64 a claim.
 * - **the deployment**, proved by the service-role key. That key is also what the
 *   functions use to read rows RLS hides from people. It is compared in constant time
 *   and never logged, echoed, or put in a URL.
 *
 * `publish-plugin` asks for both — the key, so the endpoint is not a public API, and an
 * admin's token, so the write is attributable and the database's own admin check has a
 * `sub` to look at.
 */
import { HttpError } from "./http.ts";
import { configuration, type Project } from "./config.ts";

export interface Caller {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

/** `Authorization: Bearer <token>`, or "". */
export function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const token = match?.[1];
  return token === undefined ? "" : token.trim();
}

/**
 * Compares two secrets without leaking their length or their first wrong byte through
 * timing. Both sides are hashed first, so even the comparison loop sees fixed-size input.
 */
export async function sameSecret(presented: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const digest = async (value: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  const [left, right] = await Promise.all([digest(presented), digest(expected)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0 && presented.length > 0;
}

/**
 * The deployment: a request carrying the service-role key.
 *
 * Either header may carry it. `Authorization` is how an operator's curl and a
 * service-role client both send it; `apikey` is where it sits when the same request also
 * carries an admin's token in `Authorization`, which is exactly what `publish-plugin`
 * needs. A request is this deployment's if *either* proves it, and neither header is
 * allowed to fall back to the other's value by accident.
 */
export async function requireService(req: Request, project: Project): Promise<void> {
  const candidates = [bearer(req), (req.headers.get("apikey") ?? "").trim()].filter(
    (value) => value !== "",
  );
  if (candidates.length === 0) {
    throw new HttpError(401, "This endpoint is for the catalogue's own operators.");
  }
  const matches = await Promise.all(
    candidates.map((candidate) => sameSecret(candidate, project.serviceKey)),
  );
  if (!matches.some(Boolean)) {
    // 403, not 401: the caller is not going to succeed by trying again with the same
    // token, and the status says "you are not this" rather than "sign in".
    throw new HttpError(403, "This endpoint is for the catalogue's own operators.");
  }
}

/** A person, verified by GoTrue. Refuses an anonymous request and an expired token. */
export async function requireUser(req: Request, project: Project): Promise<Caller> {
  const token = bearer(req);
  if (token === "") {
    throw new HttpError(401, "Sign in to use the community catalogue.");
  }

  let response: Response;
  try {
    response = await fetch(`${project.url}/auth/v1/user`, {
      method: "GET",
      headers: { apikey: project.anonKey, authorization: `Bearer ${token}` },
    });
  } catch (cause) {
    console.error(`community: the auth service did not answer — ${String(cause)}`);
    throw new HttpError(503, "The sign-in service did not answer. Try again.");
  }

  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "This device's sign-in has expired — sign in again.");
  }
  if (!response.ok) {
    throw new HttpError(502, `The sign-in service answered ${response.status}.`);
  }

  const body = (await response.json().catch(() => null)) as
    | { id?: unknown; email?: unknown }
    | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (id === "") {
    throw new HttpError(401, "This device's sign-in has expired — sign in again.");
  }
  return { id, email: typeof body?.email === "string" ? body.email : "", token };
}

/**
 * A person whose profile says `admin`.
 *
 * The database asks the same question again inside `community_publish_version()`, and
 * that second asking is the one that counts: this check exists so a non-admin gets a
 * readable 403 instead of a plpgsql exception, not because it is the enforcement point.
 */
export async function requireAdmin(req: Request, project: Project): Promise<Caller> {
  const caller = await requireUser(req, project);
  const rows = await select(
    project,
    `community_profiles?user_id=eq.${encodeURIComponent(caller.id)}&select=role`,
    project.serviceKey,
  );
  const profile = rows[0];
  const role = profile !== undefined && typeof profile.role === "string" ? profile.role : "";
  if (role !== "admin") {
    throw new HttpError(403, "Publishing is a moderator action.");
  }
  return caller;
}

/** Re-exported so the callers of this module do not import config twice. */
export { configuration };

/**
 * One PostgREST GET with the service key. Used here only for the role lookup, which is
 * deliberately not something the caller's own token could answer: a person can read
 * their profile, but this function needs to read it as an authority, not as a request.
 */
async function select(
  project: Project,
  path: string,
  key: string,
): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${project.url}/rest/v1/${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
  });
  if (!response.ok) {
    throw new HttpError(502, `The catalogue's database answered ${response.status}.`);
  }
  const rows = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}
