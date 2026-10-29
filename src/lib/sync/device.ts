/**
 * Which device this is.
 *
 * A device id is local bookkeeping for the sync stamps — it is never an account id and
 * never leaves the device except as a stamp on a row. It is generated once and kept in
 * prefs so two runs of the app agree about who wrote what.
 */
import type { LibraryStore } from "../db/store";

const DEVICE_KEY = "sync.device";

export async function deviceId(store: LibraryStore): Promise<string> {
  const stored = await store.getPref<string>(DEVICE_KEY);
  if (typeof stored === "string" && stored !== "") return stored;
  const fresh = `dev-${Math.random().toString(36).slice(2, 10)}`;
  await store.setPref(DEVICE_KEY, fresh);
  return fresh;
}
