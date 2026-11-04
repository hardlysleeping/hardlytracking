/**
 * The one place that decides "keep this title now", so pieces that cannot import each other can ask.
 *
 * `library` owns adding titles, `downloads` owns the queue, and neither may import the other's
 * module: the sink is registered by whatever owns the queue at startup, and asking costs a function
 * call when it exists and nothing when it does not.
 */
export interface KeepSink {
  /** Fetch the issues of one title that are not here yet. Returns what it queued, if known. */
  keep(seriesId: string): Promise<{ queued: number; total: number } | null>;
}

let sink: KeepSink | null = null;

export function setKeepSink(next: KeepSink | null): void {
  sink = next;
}

/** Fire-and-forget: a keep that fails must never make adding a title fail. */
export function requestKeep(seriesId: string): void {
  void sink?.keep(seriesId).catch(() => {});
}

export function keepSinkInstalled(): boolean {
  return sink !== null;
}
