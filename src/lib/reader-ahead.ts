/** Pages warmed after the current page, not a download of the whole chapter. */
export const READ_AHEAD_CHOICES = [0, 2, 3, 5, 10] as const;
export type ReadAhead = typeof READ_AHEAD_CHOICES[number];
export const DEFAULT_READ_AHEAD: ReadAhead = 3;

/** Old/malformed preferences must not create an unbounded page queue. */
export function readAheadOf(value: unknown): ReadAhead {
  return typeof value === "number" && READ_AHEAD_CHOICES.includes(value as ReadAhead)
    ? value as ReadAhead : DEFAULT_READ_AHEAD;
}
