/**
 * The HTTP furniture: one error type, one JSON writer, one set of CORS headers.
 *
 * The rules that matter for a public endpoint:
 *
 * - **An error is a sentence.** Every refusal says what was wrong in words the person
 *   submitting can act on, because the only UI for a refusal is a line of text next to
 *   the file they chose. Stack traces stay in the log.
 * - **No body is ever echoed back.** A request may carry a 10 MB package; putting it in
 *   an error message (or in the log) would turn a refusal into a memory problem.
 * - **CORS is `*` and that is not a hole.** These endpoints authenticate with a bearer
 *   token, never a cookie, so there is no ambient credential for another origin to ride.
 *   A wildcard here lets the web shell call the same functions the desktop shell calls.
 */

/** A refusal with a status, a sentence, and (for a bad package) the list of problems. */
export class HttpError extends Error {
  readonly status: number;
  readonly problems: readonly string[];

  constructor(status: number, message: string, problems: readonly string[] = []) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.problems = problems;
  }
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info, prefer",
  "access-control-max-age": "86400",
  "x-content-type-options": "nosniff",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

/** The answer to a browser's preflight. No authentication: a preflight has no headers. */
export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** Turns anything thrown into a response, and logs only what is safe to log. */
export function failure(cause: unknown): Response {
  if (cause instanceof HttpError) {
    return json(
      { error: cause.message, ...(cause.problems.length === 0 ? {} : { problems: cause.problems }) },
      cause.status,
    );
  }
  // Logged without the request, the body, the headers or the key: an error message from
  // PostgREST or Storage names a constraint or a path, and that is all an operator needs.
  const message = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  console.error(`community: refused with an unexpected error — ${message}`);
  return json({ error: "The catalogue failed. Nothing was written; try again." }, 500);
}

/** A JSON body, or a 400 that says so. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new HttpError(400, "The request body is not JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** A trimmed string field, or "" — never `undefined`, so callers can test for empty. */
export function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
