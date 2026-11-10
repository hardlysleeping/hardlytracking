/**
 * The local screen curtain: a PIN-gated screen, not encryption.
 *
 * The curtain hides hidden shelves from somebody glancing at the screen. The PIN that raises it is
 * a preference (`settings.privacyPin`, salted hash only, see `lib/pin`), so it is the same PIN on
 * every device signed into HardlySync. Nothing in this class is authentication for a server, and
 * no library byte is encrypted: a locked screen is privacy from eyes, not from a filesystem.
 */
import { hasPin, verifyPin } from "../lib/pin";
import { settings } from "./settings.svelte";

/**
 * Attempts are unlimited, by the owner's call.
 *
 * The curtain is privacy from eyes, not encryption (see the header): a count that locks the keypad
 * only hurts the person holding the device, and five tries is a number nobody asked for. A wrong PIN
 * says so and the sheet takes the next one.
 */
export type LockResult = "locked" | "needs-pin" | "already";
export type UnlockResult = "unlocked" | "wrong" | "no-pin" | "already";

export class PrivacyState {
  locked = $state(false);
  revision = $state(0);
  /** The sentence the unlock sheet shows after a refusal. Empty means nothing to say. */
  notice = $state("");
  /** The curtain's own fold, laid on top of the reader's. It never writes their choice. */
  #sealed = $state(false);

  /**
   * Folded or not.
   *
   * The reader's fold is a preference (`settings.privacyBandCollapsed`), so reopening the app — or
   * restoring an export — gives back the band the way it was left. Locking folds the band without
   * touching that preference, which is why the curtain needs its own flag: raising it hands the
   * band back in the state the reader chose, not in the state the lock imposed.
   */
  get bandCollapsed(): boolean {
    return this.#sealed || settings.privacyBandCollapsed === true;
  }

  set bandCollapsed(value: boolean) {
    // An explicit fold is the reader's answer, so it cancels the curtain's: while locked, the tab
    // is the way back to the band, and what they choose there is what unlocking must keep.
    this.#sealed = false;
    settings.set("privacyBandCollapsed", value);
  }

  /** True when a PIN is stored. Without one the curtain refuses to come down at all. */
  get pinSet(): boolean {
    return hasPin(settings.privacyPin);
  }

  /** The tab works in every state, including locked: it is the way back to the band. */
  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
  }

  /**
   * Lower the curtain. Refuses when no PIN is set: a lock with no key is a screen the reader
   * cannot leave, so the caller opens the Set a PIN sheet instead.
   */
  lock(): LockResult {
    if (this.locked) return "already";
    if (!this.pinSet) return "needs-pin";
    // Locking folds the band. The curtain is already down; leaving the controls on screen beside
    // it says the shelves are one press away, which is the opposite of the point.
    this.#sealed = true;
    this.locked = true;
    this.notice = "";
    this.revision++;
    return "locked";
  }

  /**
   * Verify a PIN and, only if it is right, raise the curtain.
   *
   * `at` stays in the signature so a caller that already keeps a clock can pass it; nothing is
   * measured against it any more.
   */
  async attemptUnlock(pin: string, _at = Date.now()): Promise<UnlockResult> {
    if (!this.locked) return "already";
    if (!this.pinSet) {
      // A PIN removed on another device reaches us through sync; say so instead of pretending
      // the curtain can be raised.
      this.notice = "No PIN is set — open Settings to set one.";
      return "no-pin";
    }
    if (await verifyPin(settings.privacyPin, pin)) {
      this.locked = false;
      this.#sealed = false;
      this.notice = "";
      this.revision++;
      return "unlocked";
    }
    this.notice = "That PIN is not right — try again.";
    return "wrong";
  }
}
export const privacy = new PrivacyState();
