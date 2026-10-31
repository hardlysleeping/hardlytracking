/**
 * The HT-Server's extension registry: what this PC has installed, on disk.
 *
 * The phone cannot read this machine's IndexedDB, and a SPA cannot answer an HTTP request, so the
 * proxy is the only place both machines can meet. That makes this file the one list: the PC's own
 * app reads it through `/api/host/extensions` when the proxy is serving it, and a paired phone reads
 * and manages the same rows through the same routes. Two lists would drift the moment either device
 * installed something.
 *
 * Two shapes on disk, for one reason: the metadata is small and wants to be one readable JSON file,
 * while an APK is a megabyte of somebody else's binary. So `<dir>/host-extensions.json` holds the
 * rows and `<dir>/host-extensions/<id>.apk` holds the bytes. The bytes are here, not on the client,
 * because the runtime keeps APKs in memory only: after its restart every call answers "no longer
 * loaded; resend the APK", and the machine that installed it is the machine that should resend —
 * never a phone handing its own APK to a PC, which silently installs the phone's extensions there.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Where the rows live under a state directory. */
const INDEX = "host-extensions.json";
/** Where the bytes live under the same directory. */
const APK_DIR = "host-extensions";

/**
 * An extension id becomes a file name, so it is checked rather than trusted.
 *
 * It is the runtime's own handle (a SHA-256), which is hex; anything with a slash or a dot-dot in it
 * came from a request body and must not reach the filesystem.
 */
export function safeExtensionId(id) {
  return typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) ? id : null;
}

/** A row as a client sees it: no bytes, and the version numbers kept as they arrived. */
export function publicRow(row) {
  const { apk, ...rest } = row;
  return rest;
}

function emptyIndex() {
  return { version: 1, extensions: [] };
}

/**
 * The registry, keyed by extension id.
 *
 * Every write is one read-modify-write, and they are serialised through a promise chain: two requests
 * arriving together (a phone installing while the PC's app seeds) would otherwise each write the
 * whole file from their own stale copy and lose one of the two.
 */
export function createHostStore(dir) {
  const indexFile = join(dir, INDEX);
  const apkDir = join(dir, APK_DIR);
  let queue = Promise.resolve();

  function serialised(task) {
    const run = queue.then(task, task);
    // Keep the chain alive after a failure: one bad write must not stop every later one.
    queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function readIndex() {
    let text;
    try {
      text = await readFile(indexFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return emptyIndex();
      throw error;
    }
    try {
      const parsed = JSON.parse(text);
      const rows = Array.isArray(parsed?.extensions) ? parsed.extensions : [];
      return { version: 1, extensions: rows.filter((row) => safeExtensionId(row?.extensionId) !== null) };
    } catch {
      // A corrupt registry must not take the server down with it; an unreadable list is an empty one,
      // and the next install rewrites it.
      return emptyIndex();
    }
  }

  async function writeIndex(index) {
    await mkdir(dir, { recursive: true });
    const temporary = `${indexFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    // Rename is atomic on one filesystem: a reader sees the old file or the new one, never half.
    await rename(temporary, indexFile);
  }

  const store = {
    /** Every row, newest install last. No bytes: a list is a list. */
    async list() {
      const index = await readIndex();
      return index.extensions
        .map(publicRow)
        .sort((a, b) => (a.installedAt ?? 0) - (b.installedAt ?? 0));
    },

    async get(extensionId) {
      const id = safeExtensionId(extensionId);
      if (id === null) return undefined;
      const index = await readIndex();
      const found = index.extensions.find((row) => row.extensionId === id);
      return found === undefined ? undefined : publicRow(found);
    },

    /** The APK bytes for one extension, or `null` when this machine never kept them. */
    async apk(extensionId) {
      const id = safeExtensionId(extensionId);
      if (id === null) return null;
      try {
        return await readFile(join(apkDir, `${id}.apk`));
      } catch {
        return null;
      }
    },

    /**
     * Add or replace a row, and its bytes when it has any.
     *
     * Replacing is the normal case: the same APK twice is the same id, and an update is a new id
     * with the same package. `installedAt` is kept from the row being replaced so a re-install does
     * not jump to the end of the list.
     */
    async put(row, apkBytes = null) {
      const id = safeExtensionId(row?.extensionId);
      if (id === null) throw new Error("an extension id is required");
      return serialised(async () => {
        if (apkBytes !== null) {
          await mkdir(apkDir, { recursive: true });
          await writeFile(join(apkDir, `${id}.apk`), apkBytes);
        }
        const index = await readIndex();
        const at = index.extensions.findIndex((existing) => existing.extensionId === id);
        const previous = at >= 0 ? index.extensions[at] : undefined;
        const next = {
          ...row,
          extensionId: id,
          installedAt: previous?.installedAt ?? row.installedAt ?? Date.now(),
        };
        delete next.apk;
        if (at >= 0) index.extensions[at] = next;
        else index.extensions.push(next);
        await writeIndex(index);
        return publicRow(next);
      });
    },

    async remove(extensionId) {
      const id = safeExtensionId(extensionId);
      if (id === null) return false;
      return serialised(async () => {
        const index = await readIndex();
        const at = index.extensions.findIndex((row) => row.extensionId === id);
        if (at < 0) return false;
        index.extensions.splice(at, 1);
        await writeIndex(index);
        // The bytes go with the row: an extension nobody lists must not be reinstalled from a file
        // the user thought they had removed.
        await rm(join(apkDir, `${id}.apk`), { force: true });
        return true;
      });
    },

    async setEnabled(extensionId, enabled) {
      const id = safeExtensionId(extensionId);
      if (id === null) return undefined;
      return serialised(async () => {
        const index = await readIndex();
        const found = index.extensions.find((row) => row.extensionId === id);
        if (found === undefined) return undefined;
        found.enabled = enabled === true;
        await writeIndex(index);
        return publicRow(found);
      });
    },
  };
  return store;
}
