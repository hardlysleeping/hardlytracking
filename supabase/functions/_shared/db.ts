/**
 * The four HTTP surfaces this backend uses, and nothing else.
 *
 * PostgREST, Storage and GoTrue are all just HTTP with a key in a header, so the client
 * library would only be a wrapper around `fetch` — and a wrapper that brings its own
 * idea of retries, session refresh and error shapes into a function that deliberately has
 * no session. Plain `fetch` keeps every request visible in this file, which is what makes
 * the security review of these functions a read rather than a hunt.
 *
 * Two habits worth noticing:
 *
 * - **The key decides the privilege, and it is chosen by the caller of these helpers**, so
 *   a reviewer can see at each call site whether a write runs as the person or as the
 *   service. Nothing here falls back from one to the other.
 * - **A database refusal is translated, not swallowed.** `42501` from a trigger is a
 *   sentence a person can read (`Only the server may publish one.`), and passing it on is
 *   better than replacing it with "request failed".
 */
import { HttpError } from "./http.ts";
import type { Project } from "./config.ts";

export type Row = Record<string, unknown>;

/** The bucket `submit-plugin` writes to. Private; see docs/community-backend.md. */
export const BUCKET = "community-plugins";

/** PostgREST's error body, as far as this backend cares. */
interface PostgrestError {
  readonly code?: string;
  readonly message?: string;
  readonly details?: string;
}

async function refusal(response: Response): Promise<HttpError> {
  const body = (await response.json().catch(() => null)) as PostgrestError | null;
  const message = (body?.message ?? "").trim();
  const code = body?.code ?? "";

  // A trigger or a policy refusing, in the words it chose. These sentences are written
  // for a person ("A stored package never changes; submit a new version instead."), so
  // the only thing to add is the status.
  if (code === "42501") return new HttpError(403, message || "The catalogue refused that change.");
  if (code === "P0002") return new HttpError(404, message || "Nothing matched.");
  if (code === "23505") return new HttpError(409, "That already exists.");
  if (code === "23503") return new HttpError(400, "That refers to something that does not exist.");
  if (code.startsWith("22")) return new HttpError(400, message || "That value is not valid.");

  console.error(`community: database answered ${response.status} ${code} — ${message}`);
  return new HttpError(502, `The catalogue's database answered ${response.status}.`);
}

interface RestRequest {
  readonly method?: string;
  readonly body?: unknown;
  readonly key: string;
  /** `return=representation`, `resolution=ignore-duplicates`, … */
  readonly prefer?: string;
}

async function rest(project: Project, path: string, request: RestRequest): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${project.url}/rest/v1/${path}`, {
      method: request.method ?? "GET",
      headers: {
        apikey: request.key,
        authorization: `Bearer ${request.key}`,
        accept: "application/json",
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        ...(request.prefer === undefined ? {} : { prefer: request.prefer }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
  } catch (cause) {
    // The cause is a network failure and carries no body; safe to log, and the only way
    // an operator learns that the URL is wrong.
    console.error(`community: the database did not answer — ${String(cause)}`);
    throw new HttpError(503, "The catalogue's database did not answer.");
  }
  if (!response.ok) throw await refusal(response);
  return response;
}

/** Rows, in the order PostgREST returned them. An empty array is a valid answer. */
export async function select(project: Project, path: string, key: string): Promise<Row[]> {
  const response = await rest(project, path, { key });
  const rows = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

export async function selectOne(project: Project, path: string, key: string): Promise<Row | null> {
  const rows = await select(project, path, key);
  return rows[0] ?? null;
}

/** One inserted row, read back from the database rather than assumed. */
export async function insert(
  project: Project,
  table: string,
  row: unknown,
  key: string,
  options: { readonly ignoreDuplicates?: boolean } = {},
): Promise<Row | null> {
  const response = await rest(project, table, {
    method: "POST",
    body: row,
    key,
    prefer: options.ignoreDuplicates === true ? "resolution=ignore-duplicates" : "return=representation",
  });
  const rows = (await response.json().catch(() => null)) as unknown;
  if (!Array.isArray(rows)) return null;
  return (rows[0] as Row | undefined) ?? null;
}

/** Updated rows. An empty array means RLS allowed the statement and no row matched. */
export async function update(project: Project, path: string, patch: unknown, key: string): Promise<Row[]> {
  const response = await rest(project, path, {
    method: "PATCH",
    body: patch,
    key,
    prefer: "return=representation",
  });
  const rows = (await response.json().catch(() => null)) as unknown;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

/** A SQL function, called with the key the caller chose — which decides `auth.uid()`. */
export async function rpc(project: Project, name: string, args: unknown, key: string): Promise<unknown> {
  const response = await rest(project, `rpc/${name}`, { method: "POST", body: args, key });
  return response.json().catch(() => null);
}

function encodePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Stores one package. `x-upsert: false` is the immutability rule at the storage layer: a
 * second PUT to a path that exists is refused rather than silently replacing the bytes
 * whose hash is already in the database.
 */
export async function uploadPackage(project: Project, path: string, bytes: Uint8Array): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${project.url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
      method: "POST",
      headers: {
        apikey: project.serviceKey,
        authorization: `Bearer ${project.serviceKey}`,
        "content-type": "application/octet-stream",
        "x-upsert": "false",
        "cache-control": "max-age=31536000",
      },
      // `Uint8Array` is a valid BodyInit at runtime (Deno and undici both accept it); the
      // cast is for TypeScript 5.7+, whose Uint8Array is generic over its buffer.
      body: bytes as unknown as BodyInit,
    });
  } catch (cause) {
    console.error(`community: storage did not answer — ${String(cause)}`);
    throw new HttpError(503, "The package store did not answer.");
  }
  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 300);
    console.error(`community: storage refused an upload — ${response.status} ${body}`);
    throw new HttpError(502, "The package could not be stored. Try again.");
  }
}

export async function downloadPackage(project: Project, path: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(`${project.url}/storage/v1/object/${BUCKET}/${encodePath(path)}`, {
      headers: { apikey: project.serviceKey, authorization: `Bearer ${project.serviceKey}` },
    });
  } catch (cause) {
    console.error(`community: storage did not answer — ${String(cause)}`);
    throw new HttpError(503, "The package store did not answer.");
  }
  if (response.status === 404) {
    throw new HttpError(404, "The stored package is missing; the version cannot be validated.");
  }
  if (!response.ok) throw new HttpError(502, `The package store answered ${response.status}.`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Removes a package that never got a row. Best effort and deliberately quiet: the caller
 * is already failing, and the object it is trying to clean up is behind a server-only
 * bucket, so a second failure changes nothing for the person reading the error.
 */
export async function removePackage(project: Project, path: string): Promise<void> {
  try {
    await fetch(`${project.url}/storage/v1/object/${BUCKET}`, {
      method: "DELETE",
      headers: {
        apikey: project.serviceKey,
        authorization: `Bearer ${project.serviceKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prefixes: [path] }),
    });
  } catch (cause) {
    console.error(`community: could not remove an orphaned package — ${String(cause)}`);
  }
}
