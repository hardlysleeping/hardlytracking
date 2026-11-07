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

/** Five honest tries, then a pause. Counting is per session — a reload is a fresh screen. */
export const MAX_UNLOCK_TRIES = 5;
const RETRY_COOLDOWN_MS = 60_000;

export type LockResult = "locked" | "needs-pin" | "already";
export type UnlockResult = "unlocked" | "wrong" | "no-pin" | "wait" | "already";

export class PrivacyState {
  locked = $state(false);
  bandCollapsed = $state(false);
  revision = $state(0);
  /** Tries left before the pause; shown beside the keypad so the count is never a surprise. */
  triesLeft = $state(MAX_UNLOCK_TRIES);
  /** The sentence the unlock sheet shows after a refusal. Empty means nothing to say. */
  notice = $state("");
  #priorFold = false;
  #retryAt = 0;

  /** True when a PIN is stored. Without one the curtain refuses to come down at all. */
  get pinSet(): boolean {
    return hasPin(settings.privacyPin);
  }

  /** The tab works in every state, including locked: it is the way back to the band. */
  toggleBand(): void {
    this.bandCollapsed = !this.bandCollapsed;
    // A fold the reader chose while the curtain was down is their fold. Unlocking must not
    // re-collapse the band under them, so the memory is what they last asked for.
    if (this.locked) this.#priorFold = this.bandCollapsed;
  }

  /**
   * Lower the curtain. Refuses when no PIN is set: a lock with no key is a screen the reader
   * cannot leave, so the caller opens the Set a PIN sheet instead.
   */
  lock(): LockResult {
    if (this.locked) return "already";
    if (!this.pinSet) return "needs-pin";
    this.#priorFold = this.bandCollapsed;
    // Locking folds the band. The curtain is already down; leaving the controls on screen beside
    // it says the shelves are one press away, which is the opposite of the point.
    this.bandCollapsed = true;
    this.locked = true;
    this.triesLeft = MAX_UNLOCK_TRIES;
    this.notice = "";
    this.#retryAt = 0;
    this.revision++;
    return "locked";
  }

  /**
   * Verify a PIN and, only if it is right, raise the curtain.
   *
   * `at` is the clock the cooldown is measured against; the sheets never pass it, tests do.
   */
  async attemptUnlock(pin: string, at = Date.now()): Promise<UnlockResult> {
    if (!this.locked) return "already";
    if (!this.pinSet) {
      // A PIN removed on another device reaches us through sync; say so instead of pretending
      // the curtain can be raised.
      this.notice = "No PIN is set — open Settings to set one.";
      return "no-pin";
    }
    if (at < this.#retryAt) {
      const seconds = Math.max(1, Math.ceil((this.#retryAt - at) / 1000));
      this.notice = `Too many tries — wait ${seconds}s.`;
      return "wait";
    }
    if (await verifyPin(settings.privacyPin, pin)) {
      this.locked = false;
      this.bandCollapsed = this.#priorFold;
      this.triesLeft = MAX_UNLOCK_TRIES;
      this.notice = "";
      this.#retryAt = 0;
      this.revision++;
      return "unlocked";
    }
    this.triesLeft = Math.max(0, this.triesLeft - 1);
    if (this.triesLeft === 0) {
      this.#retryAt = at + RETRY_COOLDOWN_MS;
      this.notice = "That PIN is not right — no tries left. Wait a minute.";
    } else {
      this.notice = `That PIN is not right — ${this.triesLeft} ${this.triesLeft === 1 ? "try" : "tries"} left.`;
    }
    return "wrong";
  }
}
export const privacy = new PrivacyState();
