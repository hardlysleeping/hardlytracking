/**
 * Google Drive, as a place to fetch the comics you already own.
 *
 * The owner's sentence is the specification: *"if they bought drm free comics they can read them here
 * easily by picking the folder from their files or cloud like googledrive"*. So Drive is not a source
 * and not a sync backend here — it is a **file picker that happens to be remote**. The bytes are
 * downloaded once into the same `books` store a picked local file goes into, and from that moment the
 * book reads with no token, no network and no Drive account. That is the important property: an
 * access token lives an hour, a library lives for years.
 *
 * Why a client id and not a bundled one: this app has no server to keep a secret on, and Google's
 * "installed/web client, no secret" flow is designed for exactly that. The user registers an OAuth
 * client in their own Google Cloud project once (the app cannot do it for them), pastes the id, and
 * the app asks Google for a short-lived token in a popup. Nothing is stored but the id.
 *
 * Scope is `drive.readonly`, the narrowest that can see a folder of files the user already has.
 * `drive.file` would only see files this app created, which is useless for a folder the user filled.
 *
 * Everything below is REST v3 over `fetch`, so it is testable with a fake fetch and there is no SDK.
 */

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** One entry in a Drive folder, reduced to the fields this app asks for. */
export interface DriveFile {
  id: string;
  name: string;
  /** Bytes, as a string — Drive sends `size` as a string and it can exceed 2^53 in theory. */
  size?: string;
  mimeType: string;
  modifiedTime?: string;
}

/** A Drive call that failed in a way the user has to act on. */
export class DriveError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DriveError";
    this.status = status;
  }
}

/** Anything that can do what `fetch` does; a parameter so tests need no network. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const IMAGE_OR_ARCHIVE = /\.(cbz|zip|pdf|cbr)$/i;

/**
 * The folder id out of whatever the user pasted.
 *
 * People paste the URL from the address bar, and it comes in three shapes:
 * `drive.google.com/drive/folders/<id>`, `drive.google.com/drive/u/0/folders/<id>?usp=sharing`, and
 * a bare id from the API docs. A *file* link (`/file/d/<id>/view`) is refused rather than guessed at:
 * importing one file by id would work, but the picker is a folder and silently treating a file link as
 * a folder produces "this folder is empty", which reads as a bug in the app.
 */
export function folderIdFrom(input: string): string | null {
  const text = input.trim();
  if (text === "") return null;
  const folder = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text);
  if (folder) return folder[1];
  if (/\/file\/d\//.test(text)) return null;
  // A bare id: Drive ids are long and use `-` and `_`, never spaces or slashes.
  if (/^[A-Za-z0-9_-]{10,}$/.test(text)) return text;
  return null;
}

/** The `q` Drive expects for "the children of this folder". */
export function folderQuery(folderId: string): string {
  return `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
}

/**
 * The files in a listing this app can open, in reading order.
 *
 * Drive returns folders and Google-native documents in the same list; both are dropped here rather
 * than at the call site, so nothing downstream has to remember that a `.gdoc` is not a comic.
 */
export function comicFiles(files: readonly DriveFile[]): DriveFile[] {
  return files
    .filter((file) => file.mimeType !== FOLDER_MIME && IMAGE_OR_ARCHIVE.test(file.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

function messageFor(status: number, body: string): string {
  if (status === 401) return "Google Drive refused the token — connect again.";
  if (status === 403) {
    return "Google Drive refused this folder. If the app is still in testing, add your account as a test user on the OAuth consent screen.";
  }
  if (status === 404) return "That folder is not there any more, or this account cannot see it.";
  const trimmed = body.trim().slice(0, 200);
  return trimmed === "" ? `Google Drive returned ${status}.` : `Google Drive returned ${status}: ${trimmed}`;
}

async function call(url: string, token: string, fetcher: Fetcher): Promise<Response> {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new DriveError(response.status, messageFor(response.status, await response.text()));
  return response;
}

/**
 * Everything directly inside a folder. Paged, because Drive caps a page at 1000 and a folder of a
 * thousand comics is not unusual; the loop stops on the first page without a `nextPageToken`.
 */
export async function listFolder(
  token: string,
  folderId: string,
  fetcher: Fetcher = fetch,
  limit = 20,
): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < limit; page += 1) {
    const params = new URLSearchParams({
      q: folderQuery(folderId),
      fields: "nextPageToken,files(id,name,size,mimeType,modifiedTime)",
      pageSize: "1000",
      orderBy: "name_natural",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken !== undefined) params.set("pageToken", pageToken);
    const response = await call(`${DRIVE_API}/files?${params.toString()}`, token, fetcher);
    const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string };
    out.push(...(body.files ?? []));
    if (body.nextPageToken === undefined || body.nextPageToken === "") break;
    pageToken = body.nextPageToken;
  }
  return out;
}

/** One file's bytes. `alt=media` is the content, not the metadata. */
export async function downloadFile(token: string, fileId: string, fetcher: Fetcher = fetch): Promise<Blob> {
  const params = new URLSearchParams({ alt: "media", supportsAllDrives: "true" });
  const response = await call(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?${params.toString()}`, token, fetcher);
  return await response.blob();
}

/**
 * Turn chosen Drive entries into `File`s, ready for the same importer a local pick goes through.
 *
 * One at a time, in order: a folder of 200-page books fetched in parallel is how a phone runs out of
 * memory before the first one is imported, and the import loop is sequential anyway.
 */
export async function driveToFiles(
  token: string,
  files: readonly DriveFile[],
  fetcher: Fetcher = fetch,
  onProgress?: (done: number, total: number) => void,
): Promise<File[]> {
  const out: File[] = [];
  for (const [index, entry] of files.entries()) {
    const blob = await downloadFile(token, entry.id, fetcher);
    out.push(new File([blob], entry.name, { type: blob.type || "application/octet-stream" }));
    onProgress?.(index + 1, files.length);
  }
  return out;
}
