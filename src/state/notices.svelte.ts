/**
 * The one notice on screen, and the log behind it.
 *
 * A notice used to be a full-width bar in the layout, so raising one pushed the header and the whole
 * page down — and because nothing took it away, a single failure left a permanent band across the
 * top. It is an overlay now: it covers the top of the screen for a few seconds, the layout underneath
 * does not move, and it leaves on its own. Everything it said is kept in `lib/notice-log`, which the
 * More page shows inline.
 *
 * Two rules that are not arbitrary:
 *
 * - **Seven seconds, not a tap you have to find.** Long enough to read a sentence, short enough that
 *   nobody has to dismiss it. A new notice restarts the clock rather than stacking.
 * - **A sticky notice stays.** Device storage being unavailable is not news you can catch up on
 *   later: it means nothing you do will survive. That one is raised as sticky and stays until the
 *   cause is gone, and its own sentence says so.
 */
import {
  NOTICE_LOG_LIMIT,
  appendNotice,
  clearNoticeLog,
  readNoticeLog,
  writeNoticeLog,
  type NoticeLogEntry,
} from "../lib/notice-log";

/** How long a plain notice is on screen. */
export const NOTICE_DURATION_MS = 7000;

class NoticesState {
  /** The sentence on screen, or null. */
  current = $state<string | null>(null);
  /** Everything raised on this device, newest first. Device-local, not exported, not synced. */
  log = $state<NoticeLogEntry[]>([]);
  /** A sticky notice has no timer and no dismiss: only its cause removes it. */
  sticky = $state(false);

  #timer: ReturnType<typeof setTimeout> | null = null;

  load(): void {
    if (this.log.length > 0) return;
    this.log = readNoticeLog();
  }

  /**
   * Raise a notice. The log is written even when the same sentence is already on screen, because the
   * log is the record of *when* the app said it, and the on-screen copy is just the last one.
   */
  show(text: string, options: { sticky?: boolean; now?: number } = {}): void {
    const sentence = text.trim();
    if (sentence === "") return;
    this.load();
    this.sticky = options.sticky === true;
    this.current = sentence;
    this.log = appendNotice(this.log, { at: options.now ?? Date.now(), text: sentence }, NOTICE_LOG_LIMIT);
    writeNoticeLog(this.log);
    this.#arm();
  }

  dismiss(): void {
    if (this.sticky) return;
    this.#clear();
    this.current = null;
  }

  /** Take a sticky notice down because its cause is gone (storage came back), never by tapping. */
  resolve(): void {
    this.#clear();
    this.sticky = false;
    this.current = null;
  }

  clearLog(): void {
    this.log = [];
    clearNoticeLog();
  }

  #arm(): void {
    this.#clear();
    if (this.sticky) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.current = null;
    }, NOTICE_DURATION_MS);
  }

  #clear(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}

export const notices = new NoticesState();
