/** Visible page first, then forward reading order; bounded backfill comes last. */
export function readerOrder(current: number, count: number, ahead = 3, behind = 1): number[] {
  const order = [current];
  for (let i = 1; i <= ahead; i++) order.push(current + i);
  for (let i = 1; i <= behind; i++) order.push(current - i);
  return order.filter(i => i >= 0 && i < count);
}
export interface ReaderJob { run(signal: AbortSignal): Promise<void> }

/**
 * How long one page may hold the next one back.
 *
 * A page that is merely slow should finish before the next one competes with it for the decoder, so
 * the queue is one worker. But a page that is *stuck* — a host that accepted the connection and
 * stopped talking, an at-home URL that hangs — held every page behind it for its full 45 s deadline,
 * one after another. After this grace a second lane opens, so the page the reader is about to look at
 * can load while the first one is still lost.
 */
export const READ_AHEAD_GRACE_MS = 1_500;

/**
 * Page jobs in reading order, with one worker — and one spare lane for a page that is stuck.
 *
 * Concurrency stays at one in the normal case: the visible page paints, then the next begins. The
 * spare lane is opened by the grace, never by demand, and never goes past two, so a chapter cannot
 * fan out into a decoder stampede on a slow connection.
 */
export class ReaderQueue {
  private pending: ReaderJob[] = [];
  private done = new WeakSet<ReaderJob>();
  private running = new Map<ReaderJob, AbortController>();
  private grace: ReturnType<typeof setTimeout> | null = null;
  private graceOpen = false;
  private readonly graceMs: number;

  constructor(graceMs: number = READ_AHEAD_GRACE_MS) {
    this.graceMs = graceMs;
  }

  set(jobs: ReaderJob[]): void {
    const wanted = jobs.filter(job => !this.done.has(job));
    // A job already running stays running (it may be mid-decode), unless the reader no longer wants
    // it — then its signal is aborted and it may be queued again if it comes back.
    this.pending = wanted.filter(job => {
      const controller = this.running.get(job);
      return controller === undefined || controller.signal.aborted;
    });
    for (const [job, controller] of this.running) {
      if (!wanted.includes(job)) controller.abort();
    }
    this.pump();
  }

  cancel(): void { this.set([]); }

  private pump(): void {
    // One page at a time; a second only once the grace has opened the spare lane.
    const limit = this.graceOpen ? 2 : 1;
    while (this.running.size < limit) {
      const job = this.pending.shift();
      if (job === undefined) break;
      this.start(job);
    }
    this.armGrace();
  }

  private start(job: ReaderJob): void {
    const controller = new AbortController();
    this.running.set(job, controller);
    void (async () => {
      try { await job.run(controller.signal); }
      catch { /* Each image reports its own error, never stalls the queue. */ }
      finally {
        if (!controller.signal.aborted) this.done.add(job);
        this.running.delete(job);
        if (this.running.size === 0) {
          this.graceOpen = false;
          this.clearGrace();
        }
        this.pump();
      }
    })();
  }

  private armGrace(): void {
    if (this.grace !== null || this.graceOpen || this.pending.length === 0) return;
    if (this.running.size === 0) return;
    this.grace = setTimeout(() => {
      this.grace = null;
      this.graceOpen = true;
      this.pump();
    }, this.graceMs);
  }

  private clearGrace(): void {
    if (this.grace === null) return;
    clearTimeout(this.grace);
    this.grace = null;
  }
}

/** Movement is sticky: returning to the start does not turn a drag into a tap. */
export class ReaderTap {
  private start: {id: number; x: number; y: number} | null = null;
  private moved = false;
  down(id: number, x: number, y: number): void {
    if (this.start) { this.moved = true; return; }
    this.start = {id,x,y}; this.moved = false;
  }
  move(id: number, x: number, y: number): void {
    if (this.start?.id !== id) return;
    if (Math.hypot(x-this.start.x,y-this.start.y) > 10) this.moved = true;
  }
  cancel(): void { this.start = null; this.moved = true; }
  up(id: number, x: number, y: number): boolean {
    this.move(id,x,y);
    const tap = this.start?.id === id && !this.moved;
    this.start = null;
    return tap;
  }
}