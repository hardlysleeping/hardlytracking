/**
 * Where a WebDAV folder lives, and who we are on it.
 *
 * WebDAV is the one cloud that needs nobody's permission: Nextcloud, ownCloud, a Synology, Apache
 * mod_dav, a router with a USB stick. There is no OAuth client to register and no developer console —
 * an address and a login, which is exactly what the user already has. That is why it comes before
 * Google Drive in the queue even though both are "cloud": one of them can be tried today.
 *
 * The address is the **folder**, not the server: `https://cloud.example.com/remote.php/dav/files/me/
 * Comics`. A WebDAV root lists nothing useful, and asking the user to type a path per read is worse
 * than asking once.
 *
 * The password lives in `localStorage` beside Komga's and the HT-Server token — this device, not the
 * library database, so it is never in an exported backup. Read through functions, never captured, so
 * a saved address takes effect on the next read.
 */
const URL_KEY = "hardlytracking.webdav";
const USER_KEY = "hardlytracking.webdavUser";
const PASSWORD_KEY = "hardlytracking.webdavPassword";
const ENABLED_KEY = "hardlytracking.webdavEnabled";

export interface WebdavSettings {
  /** The folder, with no trailing slash. */
  url: string;
  username: string;
  password: string;
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function write(key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage disabled still reads; the setting just does not survive a reload.
  }
}

/** The folder URL, trimmed of trailing slashes. */
export function webdavUrl(): string {
  return read(URL_KEY).trim().replace(/\/+$/, "");
}

export function webdavUsername(): string {
  return read(USER_KEY).trim();
}

export function webdavPassword(): string {
  return read(PASSWORD_KEY);
}

export function setWebdavUrl(value: string): void {
  write(URL_KEY, value.trim().replace(/\/+$/, ""));
}

export function setWebdavUsername(value: string): void {
  write(USER_KEY, value.trim());
}

export function setWebdavPassword(value: string): void {
  write(PASSWORD_KEY, value);
}

/** Configured once there is a folder and a login: one without the other is a 401 nobody can explain. */
export function webdavSettings(): WebdavSettings | null {
  const url = webdavUrl();
  const username = webdavUsername();
  const password = webdavPassword();
  if (url === "" || username === "" || password === "") return null;
  return { url, username, password };
}

/** The switch is its own setting, so turning it off keeps the login for next time. */
export function webdavEnabled(): boolean {
  return read(ENABLED_KEY) !== "0";
}

export function setWebdavEnabled(enabled: boolean): void {
  write(ENABLED_KEY, enabled ? "1" : "0");
}

/** A name for the source chip: the folder's last segment, or the host when the folder is the root. */
export function webdavLabel(url: string = webdavUrl()): string {
  const trimmed = url.replace(/\/+$/, "");
  const segments = trimmed.split("/").filter((part) => part !== "");
  const last = segments.pop() ?? "";
  if (last === "" || last.includes(".")) return segments.pop() ?? "WebDAV";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}
