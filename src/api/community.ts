/**
 * The community catalogue: plugins people publish, the versions they publish, and the
 * reports they file about each other's.
 *
 * Two rules shape this file.
 *
 * **It never signs anyone in.** The client and the session belong to `account.ts`, the same
 * one the subscription uses, so a person who signed in for sync is already signed in here and
 * is never asked twice. If this file created a client, the app would have two sessions that
 * could disagree about who is looking at the screen.
 *
 * **Nothing here trusts the client.** A publish is a request to an Edge Function; the hash,
 * the status and the storage path are decided by the server, which re-reads the manifest and
 * re-computes the SHA-256. The uploader sends bytes and an idea, never a verdict. That is why
 * no function below accepts a `status` or a `sha256` from its caller.
 */
import { sharedAccount, text, type Account } from "./account";

/** A plugin listing, as the catalogue shows it. */
export interface CommunityPlugin {
  readonly id: string;
  readonly ownerId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  /** `pending` until a moderator publishes it; only `published` may be installed. */
  readonly status: "pending" | "published" | "suspended";
  readonly owner?: string;
  readonly iconUrl?: string;
}

/** One published version of a listing. The bytes behind it never change. */
export interface CommunityVersion {
  readonly id: string;
  readonly pluginId: string;
  readonly version: string;
  /** Computed by the server on upload; a client-supplied hash is ignored. */
  readonly sha256: string;
  readonly manifest: unknown;
  readonly status: "pending" | "published" | "suspended" | "revoked";
  readonly publishedAt?: number;
}

/** A person, as the catalogue names them. Kept out of the auth tables on purpose. */
export interface CommunityProfile {
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl?: string;
}

/** Why a report exists. Anything else is not a reason a moderator can act on. */
export type ReportReason =
  | "malware"
  | "stolen-work"
  | "broken"
  | "misleading"
  | "other";

export interface CommunityOptions {
  readonly account?: Account | null;
  readonly fetch?: typeof fetch;
}

/** The catalogue refused, and said why in words a person can read. */
export class CommunityError extends Error {
  readonly code: "not_signed_in" | "unreachable" | "refused" | "not_found";
  readonly detail: string | null;

  constructor(code: CommunityError["code"], message: string, detail: string | null = null) {
    super(message);
    this.name = "CommunityError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The catalogue, for one signed-in person.
 *
 * Reads are plain PostgREST queries with the user's own token: row-level security decides what
 * comes back, so a suspended listing or someone else's draft simply is not in the answer.
 * Writes are Edge Functions, because they need the service key and a moderator.
 */
export class CommunityClient {
  private readonly account: Account | null;
  private readonly call: typeof fetch;

  constructor(options: CommunityOptions = {}) {
    // The subscription's account, unless a suite hands over its own: one person, one session.
    this.account = options.account === undefined ? sharedAccount() : options.account;
    this.call = options.fetch ?? fetch;
  }

  /** Whether there is an account to talk with at all. A build with no project says no. */
  get available(): boolean {
    return this.account !== null;
  }

  private project(): { base: string; anonKey: string } {
    if (this.account === null) {
      throw new CommunityError("not_signed_in", "This build has no account service configured.");
    }
    // The SDK keeps both; reading them back means one source of truth for the project.
    const sdk = this.account.client as unknown as {
      supabaseUrl?: string;
      supabaseKey?: string;
    };
    const base = text(sdk.supabaseUrl).replace(/\/+$/, "");
    const anonKey = text(sdk.supabaseKey);
    if (base === "" || anonKey === "") {
      throw new CommunityError("not_signed_in", "This build has no account service configured.");
    }
    return { base, anonKey };
  }

  private async token(): Promise<string> {
    const session = await this.account?.session();
    if (session === null || session === undefined) {
      throw new CommunityError("not_signed_in", "Sign in to use the community catalogue.");
    }
    return session.token;
  }

  /** One PostgREST read, with the user's own token and no way to ask for a write. */
  private async select<T>(path: string): Promise<T[]> {
    const { base, anonKey } = this.project();
    const token = await this.token();
    let response: Response;
    try {
      response = await this.call(`${base}/rest/v1/${path}`, {
        method: "GET",
        headers: { apikey: anonKey, Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
    } catch (cause) {
      throw new CommunityError("unreachable", "The catalogue did not answer.", String(cause));
    }
    if (response.status === 401 || response.status === 403) {
      throw new CommunityError("not_signed_in", "This device's sign-in has expired — sign in again.");
    }
    if (!response.ok) {
      throw new CommunityError("unreachable", `The catalogue answered ${response.status}.`);
    }
    const rows = (await response.json().catch(() => null)) as unknown;
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  /** Published listings, newest first. Suspended ones are excluded by the query, not by us. */
  async plugins(options: { search?: string; limit?: number } = {}): Promise<CommunityPlugin[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    const search = text(options.search);
    const filter =
      search === "" ? "" : `&or=(name.ilike.*${encodeURIComponent(search)}*,description.ilike.*${encodeURIComponent(search)}*)`;
    const rows = await this.select<Record<string, unknown>>(
      `community_plugins?status=eq.published&select=id,owner_id,slug,name,description,status${filter}&order=name.asc&limit=${limit}`,
    );
    return rows.map(pluginOf);
  }

  /** One listing and its installable versions. A suspended version is not in the answer. */
  async plugin(slug: string): Promise<{ plugin: CommunityPlugin; versions: CommunityVersion[] }> {
    const key = encodeURIComponent(slug);
    const rows = await this.select<Record<string, unknown>>(
      `community_plugins?slug=eq.${key}&select=id,owner_id,slug,name,description,status&limit=1`,
    );
    const row = rows[0];
    if (row === undefined) throw new CommunityError("not_found", "No such plugin.");
    const plugin = pluginOf(row);
    const versions = await this.select<Record<string, unknown>>(
      `community_plugin_versions?plugin_id=eq.${encodeURIComponent(plugin.id)}&status=eq.published&select=id,plugin_id,version,sha256,manifest,status,published_at&order=published_at.desc`,
    );
    return { plugin, versions: versions.map(versionOf) };
  }

  /**
   * Submits a package for review.
   *
   * The bytes go to the Edge Function, which re-reads the manifest, computes the SHA-256 and
   * stores the immutable package. This call cannot publish: the reply is a `pending` version,
   * and a moderator's action is what makes it installable.
   */
  async submit(input: {
    slug: string;
    name: string;
    description: string;
    version: string;
    bytes: Uint8Array;
  }): Promise<CommunityVersion> {
    const { base } = this.project();
    const token = await this.token();
    const body = JSON.stringify({
      slug: input.slug,
      name: input.name,
      description: input.description,
      version: input.version,
      package: base64Of(input.bytes),
    });
    let response: Response;
    try {
      response = await this.call(`${base}/functions/v1/submit-plugin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
      });
    } catch (cause) {
      throw new CommunityError("unreachable", "The submission did not reach the server.", String(cause));
    }
    if (response.status === 401 || response.status === 403) {
      throw new CommunityError("not_signed_in", "This device's sign-in has expired — sign in again.");
    }
    const answer = (await response.json().catch(() => null)) as
      | { version?: unknown; error?: unknown }
      | null;
    if (!response.ok) {
      throw new CommunityError(
        "refused",
        typeof answer?.error === "string" ? answer.error : `The submission was refused (${response.status}).`,
      );
    }
    const version = answer?.version;
    if (version === undefined || version === null) {
      throw new CommunityError("refused", "The server accepted the upload but named no version.");
    }
    return versionOf(version as Record<string, unknown>);
  }

  /** Files a report. The reporter's id comes from the token, never from this body. */
  async report(pluginId: string, reason: ReportReason, note = ""): Promise<void> {
    const { base } = this.project();
    const token = await this.token();
    let response: Response;
    try {
      response = await this.call(`${base}/functions/v1/report-plugin`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ plugin_id: pluginId, reason, note }),
      });
    } catch (cause) {
      throw new CommunityError("unreachable", "The report did not reach the server.", String(cause));
    }
    if (!response.ok) {
      throw new CommunityError("refused", `The report was refused (${response.status}).`);
    }
  }
}

/** A profile row, as the app names it. Snake case stops at this boundary. */
export function profileOf(row: Record<string, unknown>): CommunityProfile {
  return {
    userId: text(row.user_id),
    username: text(row.username),
    displayName: text(row.display_name) || text(row.username),
    ...(text(row.avatar_url) === "" ? {} : { avatarUrl: text(row.avatar_url) }),
  };
}

function pluginOf(row: Record<string, unknown>): CommunityPlugin {
  const status = text(row.status);
  return {
    id: text(row.id),
    ownerId: text(row.owner_id),
    slug: text(row.slug),
    name: text(row.name),
    description: text(row.description),
    status: status === "published" || status === "suspended" ? status : "pending",
  };
}

function versionOf(row: Record<string, unknown>): CommunityVersion {
  const status = text(row.status);
  const published = typeof row.published_at === "number" ? row.published_at : Date.parse(text(row.published_at));
  return {
    id: text(row.id),
    pluginId: text(row.plugin_id),
    version: text(row.version),
    sha256: text(row.sha256),
    manifest: row.manifest ?? null,
    status:
      status === "published" || status === "suspended" || status === "revoked" ? status : "pending",
    ...(Number.isFinite(published) ? { publishedAt: published } : {}),
  };
}

/** Base64 of arbitrary bytes, in chunks: `String.fromCharCode(...all)` overflows the stack. */
export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
