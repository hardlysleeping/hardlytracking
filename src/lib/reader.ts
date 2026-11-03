/** Visible page first, then forward reading order; bounded backfill comes last. */
export function readerOrder(current: number, count: number, ahead = 3, behind = 1): number[] {
  const order = [current];
  for (let i = 1; i <= ahead; i++) order.push(current + i);
  for (let i = 1; i <= behind; i++) order.push(current - i);
  return order.filter(i => i >= 0 && i < count);
}
export interface ReaderJob { run(signal: AbortSignal): Promise<void> }
/** One worker, including while an obsolete non-abortable decoder is settling. */
export class ReaderQueue {
  private pending: ReaderJob[] = [];
  private done = new WeakSet<ReaderJob>();
  private running: ReaderJob | null = null;
  private controller: AbortController | null = null;
  set(jobs: ReaderJob[]): void {
    this.pending = jobs.filter(job => !this.done.has(job) && (job !== this.running || this.controller?.signal.aborted));
    if (this.running && !jobs.includes(this.running)) this.controller?.abort();
    void this.pump();
  }
  cancel(): void { this.set([]); }
  private async pump(): Promise<void> {
    if (this.running) return;
    const job = this.pending.shift();
    if (!job) return;
    this.running = job;
    const controller = this.controller = new AbortController();
    try { await job.run(controller.signal); }
    catch { /* Each image reports its own error, never stalls the queue. */ }
    finally {
      if (!controller.signal.aborted) this.done.add(job);
      this.running = null;
      this.controller = null;
      void this.pump();
    }
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
