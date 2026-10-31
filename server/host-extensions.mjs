/**
 * The HT-Server's extension routes: list, install, uninstall, enable/disable.
 *
 * These exist because `/dalvik` has no way to say any of it. The protocol's ten methods all run an
 * extension that is already loaded; install is `sourcesManga` carrying base64 APK bytes, and there
 * is no call at all that lists, uninstalls or disables one. So the machine that *has* the extensions
 * answers these four questions itself, from its own registry (`host-store.mjs`), and a paired phone
 * asks it.
 *
 * The token is not checked here: `/api/*` is already behind `x-hardlytracking-token` (or `?token=`)
 * in `proxy.mjs`, and a second check would be a second place to get it wrong.
 */
import { createHostStore, publicRow, safeExtensionId } from "./host-store.mjs";

/** An APK is a few megabytes; base64 of it is a third more. Past this, it is not an APK. */
const MAX_APK_BYTES = 48 * 1024 * 1024;

/** The runtime's answer when it has forgotten an APK it was handed (it keeps them in memory). */
export function forgotExtension(message) {
  return typeof message === "string" && /no longer loaded|resend the apk/i.test(message);
}

/**
 * Install one APK on the local runtime, and learn what it exposes in the same round trip.
 *
 * The id the runtime answers with is the SHA-256 of those bytes, which is why the same APK always
 * installs to the same id and why re-sending it is safe.
 */
export async function installOnRuntime(dalvikUrl, apkBase64, fetchImpl = fetch) {
  const response = await fetchImpl(`${dalvikUrl.replace(/\/+$/, "")}/dalvik`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "identity" },
    body: JSON.stringify({ method: "sourcesManga", data: apkBase64 }),
  });
  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    throw new Error(`the extension host answered ${response.status} with something that is not JSON`);
  }
  if (!response.ok) {
    const message = body !== null && typeof body.error === "string" ? body.error : `the extension host answered ${response.status}`;
    throw new Error(message);
  }
  const extensionId = response.headers.get("x-mangayomi-extension-id");
  if (extensionId === null || extensionId === "") {
    throw new Error("the extension host accepted the APK but returned no extension id");
  }
  return { extensionId, sources: Array.isArray(body) ? body : [] };
}

/** Read a JSON request body, refusing anything that is not an object. */
async function jsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_APK_BYTES * 2) throw new Error(`that request is larger than ${MAX_APK_BYTES} bytes of APK`);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("a JSON object is required");
  return parsed;
}

function send(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

/** A source list from a request body or the runtime, kept to the fields the app reads. */
function cleanSources(sources) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((source) => source !== null && typeof source === "object" && typeof source.id === "string" && source.id !== "")
    .map((source) => ({
      id: String(source.id),
      name: typeof source.name === "string" && source.name !== "" ? source.name : String(source.id),
      ...(typeof source.lang === "string" && source.lang !== "" ? { lang: source.lang } : {}),
      ...(typeof source.baseUrl === "string" && source.baseUrl !== "" ? { baseUrl: source.baseUrl } : {}),
    }));
}

/**
 * The four routes, mounted on a state directory.
 *
 * `handle` answers `true` when it took the request, so `proxy.mjs` can fall through to its own
 * routes without a second copy of the path list.
 */
export function createHostExtensions({ dir, dalvikUrl, fetchImpl = fetch }) {
  const store = createHostStore(dir);

  async function install(request, response) {
    let body;
    try {
      body = await jsonBody(request);
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const apk = typeof body.apk === "string" ? body.apk.replace(/^data:[^,]*,/, "") : "";
    if (apk === "") {
      send(response, 400, { error: "an APK is required: POST { apk: <base64>, packageId }" });
      return;
    }
    const packageId = typeof body.packageId === "string" && body.packageId.trim() !== "" ? body.packageId.trim() : "";
    if (packageId === "") {
      send(response, 400, { error: "a packageId is required, so the row can be named after the extension" });
      return;
    }
    let installed;
    try {
      installed = await installOnRuntime(dalvikUrl, apk, fetchImpl);
    } catch (error) {
      // The runtime's own words: "zip file is empty" and "no extension host" are different problems
      // and the person installing needs to know which one they have.
      send(response, 502, { error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const row = await store.put(
      {
        extensionId: installed.extensionId,
        packageId,
        ...(typeof body.name === "string" && body.name !== "" ? { name: body.name } : {}),
        ...(typeof body.iconUrl === "string" && body.iconUrl !== "" ? { iconUrl: body.iconUrl } : {}),
        ...(typeof body.repoUrl === "string" && body.repoUrl !== "" ? { repoUrl: body.repoUrl } : {}),
        ...(typeof body.versionName === "string" ? { versionName: body.versionName } : {}),
        ...(typeof body.versionCode === "number" ? { versionCode: body.versionCode } : {}),
        sources: cleanSources(installed.sources),
        enabled: body.enabled !== false,
      },
      Buffer.from(apk, "base64"),
    );
    send(response, 201, { extension: row });
  }

  async function handle(request, response, url) {
    if (url.pathname === "/api/host/extensions") {
      if (request.method === "GET") {
        send(response, 200, { extensions: await store.list() });
        return true;
      }
      if (request.method === "POST") {
        await install(request, response);
        return true;
      }
      send(response, 405, { error: "GET or POST" });
      return true;
    }
    if (!url.pathname.startsWith("/api/host/extensions/")) return false;

    const raw = decodeURIComponent(url.pathname.slice("/api/host/extensions/".length));
    const extensionId = safeExtensionId(raw);
    if (extensionId === null) {
      send(response, 400, { error: `not an extension id: ${raw}` });
      return true;
    }
    if (request.method === "DELETE") {
      const removed = await store.remove(extensionId);
      send(response, removed ? 200 : 404, removed ? { removed: extensionId } : { error: `no extension ${extensionId}` });
      return true;
    }
    if (request.method === "PATCH") {
      let body;
      try {
        body = await jsonBody(request);
      } catch (error) {
        send(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
      if (typeof body.enabled !== "boolean") {
        send(response, 400, { error: "PATCH { enabled: true|false }" });
        return true;
      }
      const row = await store.setEnabled(extensionId, body.enabled);
      send(response, row === undefined ? 404 : 200, row === undefined ? { error: `no extension ${extensionId}` } : { extension: row });
      return true;
    }
    send(response, 405, { error: "DELETE or PATCH" });
    return true;
  }

  return { store, handle, installOnRuntime: (apkBase64) => installOnRuntime(dalvikUrl, apkBase64, fetchImpl), publicRow };
}
