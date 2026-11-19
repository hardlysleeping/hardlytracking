/**
 * Kitsu, as one adapter.
 *
 * The seam it plugs into is `host.ts`: this file only knows how to talk to Kitsu. Everything about
 * *when* to push, what to do when it fails and how to reconcile a disagreement lives there.
 *
 * Three things about Kitsu are not obvious and are the reason this file is shaped the way it is:
 *
 * 1. **A rejected token is not an error.** Measured against the live API: a bogus
 *    `Authorization: Bearer …` answers `200` with `{"data":[]}` — not `401`. A client that treats
 *    "no data" as "empty list" therefore reports a broken connection as a working one with nothing
 *    on it. `verifyToken` is the only door, and it insists on a real user record coming back.
 * 2. **The per-media filters are unreliable right now.** `library-entries?filter[mangaId]=…` answers
 *    `200` with no rows whatever the id, and `filter[animeId]` answers `500`; `filter[kind]=manga`
 *    without a user answers `500`. So an entry is looked up by walking *this user's own* entries,
 *    which is the one shape that answers `200`, and matching the manga id locally.
 * 3. **Progress never goes backwards.** Kitsu will happily accept a lower `progress` and that is how
 *    a list gets wrecked. The guard is here as well as in `planPush`, because this is the last place
 *    before the write.
 *
 * Auth is the user's own API token from their Kitsu account settings, sent as a bearer. That needs
 * no OAuth application registration, which is the only kind of credential this app can ask a reader
 * to paste.
 */
import type { Tracker, TrackerHostOptions } from "./host";
import {
  SCORE_SCALE,
  needsRefresh,
  type TrackerEntry,
  type TrackerSearchResult,
  type TrackerService,
  type TrackerStatus,
} from "./types";

export const KITSU_BASE = "https://kitsu.io/api/edge";

/** Kitsu's own words for the five states this app draws. */
const STATUS_TO_KITSU: Record<TrackerStatus, string> = {
  reading: "current",
  completed: "completed",
  on_hold: "on_hold",
  dropped: "dropped",
  plan_to_read: "planned",
};

const KITSU_TO_STATUS: Record<string, TrackerStatus> = {
  current: "reading",
  completed: "completed",
  on_hold: "on_hold",
  dropped: "dropped",
  planned: "plan_to_read",
};

export interface KitsuOptions {
  /** The user's own API token. Never logged, never sent anywhere but kitsu.io. */
  token: string;
  /** Numeric Kitsu user id, learned once at connect time by `verifyToken`. */
  userId: string;
  fetchImpl?: typeof fetch;
  base?: string;
}

/** A Kitsu JSON:API resource, reduced to what this app reads. */
interface Resource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: { id: string; type: string } | null }>;
}

interface Document {
  data?: Resource | Resource[] | null;
  included?: Resource[];
  errors?: { title?: string; detail?: string }[];
  meta?: { count?: number };
  links?: { next?: string; first?: string; last?: string };
}

/**
 * Every call goes through here, so the token, the content type and the error shape exist once.
 *
 * A failed request becomes a sentence with the service's own words in it — "401 Unauthorized" is
 * true and useless, while "Kitsu said: the access token is invalid" is something a reader can act on.
 */
async function request(
  options: KitsuOptions,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Document> {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.base ?? KITSU_BASE;
  const headers: Record<string, string> = {
    Accept: "application/vnd.api+json",
    Authorization: `Bearer ${options.token}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/vnd.api+json";

  // `links.next` comes back absolute, so a path that already carries an origin is used as it is.
  const address = /^https?:\/\//i.test(path) ? path : `${base}${path}`;
  let response: Response;
  try {
    response = await doFetch(address, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch (error) {
    throw new Error(`Kitsu could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }

  const text = await response.text();
  let document: Document = {};
  if (text.trim() !== "") {
    try {
      document = JSON.parse(text) as Document;
    } catch {
      throw new Error(`Kitsu answered ${response.status} with something that is not JSON`);
    }
  }

  if (!response.ok) {
    const said = document.errors?.[0];
    const detail = said?.detail ?? said?.title ?? `HTTP ${response.status}`;
    throw new Error(`Kitsu said: ${detail}`);
  }
  return document;
}

/** The first resource of a to-one document, or undefined. */
function one(document: Document): Resource | undefined {
  const data = document.data;
  return Array.isArray(data) ? data[0] : data ?? undefined;
}

/** Every resource of a to-many document. */
function many(document: Document): Resource[] {
  const data = document.data;
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

/**
 * Prove a token belongs to a real account, and learn which one.
 *
 * This is the only check that can tell a working token from a rejected one, because Kitsu answers
 * both with `200`. It returns the user id every later call needs; an empty `data` means the token
 * was ignored, which is a rejection whatever the status code said.
 */
export async function verifyToken(
  token: string,
  fetchImpl?: typeof fetch,
  base: string = KITSU_BASE,
): Promise<{ id: string; name?: string }> {
  if (token.trim() === "") throw new Error("Kitsu needs an API token");
  const document = await request({ token, userId: "", ...(fetchImpl === undefined ? {} : { fetchImpl }), base }, "/users?filter[self]=true");
  const user = one(document);
  if (user === undefined) {
    // Measured: an ignored token is a 200 with no rows. Saying so is the difference between "wrong
    // token" and "your list is empty", and only one of those is the reader's to fix.
    throw new Error("Kitsu rejected that token — check it was copied in full from your account settings");
  }
  const name = user.attributes?.name;
  return { id: user.id, ...(typeof name === "string" && name !== "" ? { name } : {}) };
}

/** A connected Kitsu session: the tokens, and who they belong to. */
export interface KitsuTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms, from the service's own `expires_in`. */
  expiresAt?: number;
  userId: string;
  name?: string;
}

/**
 * Sign in with the reader's own Kitsu account.
 *
 * Measured against the live service: the password grant is enabled and needs **no** client id or
 * secret — the endpoint answers `invalid_client` only when one is sent and it is wrong. That is what
 * makes a tracker possible here at all, because registering an OAuth application would need the
 * reader's account anyway.
 *
 * The tokens are returned, never stored here: `trackerAccounts` is the one place a secret lives.
 */
export async function login(
  email: string,
  password: string,
  fetchImpl?: typeof fetch,
  base: string = KITSU_BASE,
): Promise<KitsuTokens> {
  if (email.trim() === "" || password === "") throw new Error("Kitsu needs your email and password");
  const doFetch = fetchImpl ?? fetch;
  const tokenUrl = base.replace(/\/edge\/?$/, "") + "/oauth/token";
  const body = new URLSearchParams({ grant_type: "password", username: email.trim(), password });

  let response: Response;
  try {
    response = await doFetch(tokenUrl, {
      method: "POST",
      headers: { Accept: "application/vnd.api+json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (error) {
    throw new Error(`Kitsu could not be reached (${error instanceof Error ? error.message : String(error)})`);
  }
  const text = await response.text();
  let tokens: Record<string, unknown> = {};
  try {
    tokens = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    throw new Error(`Kitsu answered ${response.status} with something that is not JSON`);
  }
  const accessToken = tokens.access_token;
  if (!response.ok || typeof accessToken !== "string" || accessToken === "") {
    // `invalid_grant` is Kitsu's word for a wrong email or password — it never says which, on
    // purpose. Repeating its sentence without inventing a cause is the honest answer.
    const said = typeof tokens.error_description === "string" ? tokens.error_description : `HTTP ${response.status}`;
    throw new Error(`Kitsu refused the sign-in: ${said}`);
  }

  const user = await verifyToken(accessToken, fetchImpl, base);
  const expiresIn = tokens.expires_in;
  const refresh = tokens.refresh_token;
  return {
    accessToken,
    userId: user.id,
    ...(user.name === undefined ? {} : { name: user.name }),
    ...(typeof refresh === "string" && refresh !== "" ? { refreshToken: refresh } : {}),
    ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

/**
 * Rotate an expired access token.
 *
 * Kitsu's tokens last 30 days, which is long enough that a reader will hit this eventually and
 * short enough that they will not expect to be asked to sign in again.
 */
export async function refresh(
  refreshToken: string,
  fetchImpl?: typeof fetch,
  base: string = KITSU_BASE,
): Promise<Omit<KitsuTokens, "userId" | "name">> {
  const doFetch = fetchImpl ?? fetch;
  const tokenUrl = base.replace(/\/edge\/?$/, "") + "/oauth/token";
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  const response = await doFetch(tokenUrl, {
    method: "POST",
    headers: { Accept: "application/vnd.api+json", "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await response.text();
  const tokens = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
  const accessToken = tokens.access_token;
  if (!response.ok || typeof accessToken !== "string" || accessToken === "") {
    throw new Error("Kitsu would not renew that session — sign in again");
  }
  const expiresIn = tokens.expires_in;
  const rotated = tokens.refresh_token;
  return {
    accessToken,
    ...(typeof rotated === "string" && rotated !== "" ? { refreshToken: rotated } : {}),
    ...(typeof expiresIn === "number" ? { expiresAt: Date.now() + expiresIn * 1000 } : {}),
  };
}

/**
 * Every entry on the user's manga list, keyed by the manga id it points at.
 *
 * A page at a time, because a long list is thousands of rows and this app only ever asks about one
 * title. The walk stops on the first short page instead of trusting a count that changes under it.
 */
async function mangaEntries(options: KitsuOptions): Promise<Map<string, Resource>> {
  const byManga = new Map<string, Resource>();
  // `include=media` is not optional: without it Kitsu sends the relationship's *links* and leaves
  // `data` out, so every entry would look like it points at nothing. Measured on the live API.
  let path: string | undefined =
    `/library-entries?filter[userId]=${encodeURIComponent(options.userId)}&include=media&page[limit]=100`;
  // `links.next` is the authority on whether there is more: a page that happens to come back short
  // is not the same thing as the end of the list.
  for (let page = 0; path !== undefined && page < 40; page += 1) {
    const document = await request(options, path);
    for (const row of many(document)) {
      const media = row.relationships?.media?.data;
      if (media !== undefined && media !== null && media.type === "manga") byManga.set(media.id, row);
    }
    const next = document.links?.next;
    path = next === undefined || next === "" ? undefined : next;
  }
  return byManga;
}

/** One library entry reduced to what the rest of the app understands. */
function toEntry(row: Resource): TrackerEntry {
  const attributes = row.attributes ?? {};
  const progress = attributes.progress;
  const rating = attributes.ratingTwenty;
  const status = attributes.status;
  return {
    ...(typeof status === "string" && KITSU_TO_STATUS[status] !== undefined
      ? { status: KITSU_TO_STATUS[status] }
      : {}),
    ...(typeof rating === "number" ? { score: (rating / 20) * 5 } : {}),
    ...(typeof progress === "number" ? { lastChapter: progress } : {}),
  };
}

export function kitsuTracker(options: KitsuOptions): Tracker {
  const service: TrackerService = "kitsu";

  return {
    service,

    async search(title: string): Promise<TrackerSearchResult[]> {
      if (title.trim() === "") return [];
      const document = await request(options, `/manga?filter[text]=${encodeURIComponent(title)}&page[limit]=10`);
      return many(document).map((row) => {
        const attributes = row.attributes ?? {};
        const poster = attributes.posterImage as { small?: string } | undefined;
        const chapters = attributes.chapterCount;
        const year = typeof attributes.startDate === "string" ? Number(attributes.startDate.slice(0, 4)) : NaN;
        const canonical = attributes.canonicalTitle;
        return {
          remoteId: row.id,
          title: typeof canonical === "string" && canonical !== "" ? canonical : `Kitsu #${row.id}`,
          ...(Number.isFinite(year) && year > 0 ? { year } : {}),
          ...(typeof chapters === "number" ? { totalChapters: chapters } : {}),
          ...(poster?.small === undefined ? {} : { cover: poster.small }),
        };
      });
    },

    async pull(remoteId: string): Promise<TrackerEntry> {
      const entries = await mangaEntries(options);
      const row = entries.get(remoteId);
      // No entry is not an error: a title can be bound before it is on the list, and the first push
      // creates it.
      return row === undefined ? {} : toEntry(row);
    },

    async push(remoteId: string, chapter: number): Promise<TrackerEntry> {
      const entries = await mangaEntries(options);
      const row = entries.get(remoteId);
      const current = row?.attributes?.progress;
      const at = typeof current === "number" ? current : 0;
      // Last line of defence: a lower progress is how a list gets wrecked, and Kitsu accepts it.
      if (chapter <= at) return row === undefined ? {} : toEntry(row);

      const wanted = String(STATUS_TO_KITSU.reading);
      if (row === undefined) {
        const created = await request(options, "/library-entries", {
          method: "POST",
          body: {
            data: {
              type: "libraryEntries",
              attributes: { status: wanted, progress: chapter },
              relationships: {
                user: { data: { type: "users", id: options.userId } },
                media: { data: { type: "manga", id: remoteId } },
              },
            },
          },
        });
        const resource = one(created);
        return resource === undefined ? { lastChapter: chapter } : toEntry(resource);
      }

      const updated = await request(options, `/library-entries/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: { data: { id: row.id, type: "libraryEntries", attributes: { progress: chapter } } },
      });
      const resource = one(updated);
      return resource === undefined ? { ...toEntry(row), lastChapter: chapter } : toEntry(resource);
    },

    async setScore(remoteId: string, serviceScore: number): Promise<void> {
      const row = (await mangaEntries(options)).get(remoteId);
      if (row === undefined) throw new Error("That title is not on your Kitsu list yet");
      // The host hands this the service's *own* score (0–5 for Kitsu), not the UI's 0–10 — `host.ts`
      // documents it as `serviceScore`. Kitsu stores `ratingTwenty`, so the only conversion here is
      // that one, and zero means "clear it".
      const raw = Math.round((serviceScore / SCORE_SCALE.kitsu.max) * 20);
      // Kitsu accepts 2–20. Anything a reader picks above zero therefore floors at 2, and zero
      // clears the rating instead of sending an out-of-range number the service would reject.
      const ratingTwenty = raw <= 0 ? 0 : Math.min(20, Math.max(2, raw));
      await request(options, `/library-entries/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: {
          data: { id: row.id, type: "libraryEntries", attributes: { ratingTwenty: ratingTwenty === 0 ? null : ratingTwenty } },
        },
      });
    },

    async setStatus(remoteId: string, status: TrackerStatus): Promise<void> {
      const row = (await mangaEntries(options)).get(remoteId);
      if (row === undefined) throw new Error("That title is not on your Kitsu list yet");
      await request(options, `/library-entries/${encodeURIComponent(row.id)}`, {
        method: "PATCH",
        body: { data: { id: row.id, type: "libraryEntries", attributes: { status: STATUS_TO_KITSU[status] } } },
      });
    },
  };
}

/**
 * The host with Kitsu registered, when an account is connected.
 *
 * `trackers` in `sync.ts` is the shared set; this is the one call that fills it from the stored
 * account, so a reconnect after a launch does not need a second wiring.
 */
export async function registerKitsu(store: TrackerHostOptions["store"], fetchImpl?: typeof fetch): Promise<boolean> {
  const account = await store.getTrackerAccount("kitsu");
  if (account === undefined || account.accessToken.trim() === "") return false;

  // A 30-day token is long enough that a reader meets this by surprise. Renew it before the first
  // call rather than after a failed one, and keep the refreshed pair.
  let current = account;
  if (needsRefresh(account) && account.refreshToken !== undefined) {
    try {
      const renewed = await refresh(account.refreshToken, fetchImpl);
      current = {
        ...account,
        accessToken: renewed.accessToken,
        ...(renewed.refreshToken === undefined ? {} : { refreshToken: renewed.refreshToken }),
        ...(renewed.expiresAt === undefined ? {} : { expiresAt: renewed.expiresAt }),
      };
      await store.putTrackerAccount(current);
    } catch {
      // A refresh that fails is not fatal: the access token may still work, and if it does not the
      // next push reports the service's own words.
    }
  }

  let userId = current.username ?? "";
  if (!/^\d+$/.test(userId)) {
    const user = await verifyToken(current.accessToken, fetchImpl);
    userId = user.id;
    await store.putTrackerAccount({ ...current, username: userId });
  }
  const { registerTracker } = await import("./sync");
  registerTracker(kitsuTracker({ token: current.accessToken, userId, ...(fetchImpl === undefined ? {} : { fetchImpl }) }));
  return true;
}
