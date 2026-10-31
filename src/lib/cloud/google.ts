/**
 * Getting a short-lived Google Drive token, in the browser, with no server.
 *
 * Google's own `accounts.google.com/gsi/client` is the supported way to do this from a page: it opens
 * a popup, the user approves, and the callback hands back an access token that expires in an hour.
 * There is no secret and no redirect URI to register beyond the app's own origin — which matters,
 * because a redirect would have to survive the Tauri webview and the Capacitor shell, and neither of
 * those handles one well.
 *
 * What is stored: the client id (not a secret) and the folder id. Never the token — it lives in
 * memory for the session, and losing it costs one popup.
 */

const SCRIPT = "https://accounts.google.com/gsi/client";
const CLIENT_KEY = "hardlytracking.driveClientId";
const FOLDER_KEY = "hardlytracking.driveFolderId";

/** The bit of the GIS global this app uses. */
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}
interface GoogleIdentity {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (response: { access_token?: string; error?: string; error_description?: string }) => void;
        error_callback?: (error: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
}

declare global {
  interface Window {
    google?: GoogleIdentity;
  }
}

export function storedClientId(): string {
  try {
    return localStorage.getItem(CLIENT_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeClientId(value: string): void {
  try {
    if (value.trim() === "") localStorage.removeItem(CLIENT_KEY);
    else localStorage.setItem(CLIENT_KEY, value.trim());
  } catch {
    // A browser with storage disabled still reads Drive; it just forgets the id between visits.
  }
}

export function storedFolderId(): string {
  try {
    return localStorage.getItem(FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function storeFolderId(value: string): void {
  try {
    if (value.trim() === "") localStorage.removeItem(FOLDER_KEY);
    else localStorage.setItem(FOLDER_KEY, value.trim());
  } catch {
    // as above
  }
}

let loading: Promise<GoogleIdentity> | null = null;

/** Load the GIS script once, and never twice — a second `<script>` re-initialises the library. */
export function loadGoogleIdentity(): Promise<GoogleIdentity> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google);
  if (loading !== null) return loading;
  loading = new Promise<GoogleIdentity>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    const script = existing ?? document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.addEventListener("load", () => {
      if (window.google?.accounts?.oauth2) resolve(window.google);
      else reject(new Error("Google's sign-in library loaded but did not initialise."));
    });
    script.addEventListener("error", () => {
      loading = null;
      reject(new Error("Could not reach accounts.google.com — the popup needs a connection once."));
    });
    if (existing === null) document.head.append(script);
  });
  return loading;
}

/**
 * Ask for a token. Resolves with the token, or rejects with something the user can act on — a closed
 * popup and a refused consent are different problems and get different sentences.
 */
export async function requestDriveToken(clientId: string, scope: string): Promise<string> {
  if (clientId.trim() === "") throw new Error("Paste your OAuth client id first.");
  const google = await loadGoogleIdentity();
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (token: string) => {
      if (settled) return;
      settled = true;
      resolve(token);
    };
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId.trim(),
      scope,
      callback: (response) => {
        if (response.access_token) finish(response.access_token);
        else fail(response.error_description ?? response.error ?? "Google did not return a token.");
      },
      error_callback: (error) => {
        fail(
          error.type === "popup_closed"
            ? "The Google window was closed before approving."
            : error.message ?? "Google's popup could not open.",
        );
      },
    });
    client.requestAccessToken({ prompt: "" });
  });
}
