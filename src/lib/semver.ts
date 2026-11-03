/**
 * Semantic versions, compared the way every other tool compares them.
 *
 * The app has one need for this: a plugin declares `minAppVersion` and the host has to answer "is
 * this build new enough". That question is decided by the spec's rules, not by string order —
 * `0.5.10` is newer than `0.5.9`, and a plain `>=` on strings would refuse it.
 *
 * Deliberately small: no ranges, no carets, no prerelease ordering beyond "a prerelease is older
 * than its release". A build identifier (`0.5.8+12`) is ignored, because it names a build of the
 * same version rather than a different one.
 */

interface Parsed {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Prerelease identifiers, or null for a release. */
  readonly pre: readonly string[] | null;
}

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(value: string): Parsed | null {
  const match = PATTERN.exec(value.trim());
  if (match === null) return null;
  const pre = match[4];
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: pre === undefined ? null : pre.split("."),
  };
}

export function isSemver(value: string): boolean {
  return parseVersion(value) !== null;
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * -1, 0 or 1 for `a < b`, `a == b`, `a > b`. An unparseable version sorts below everything, which
 * is the safe direction: a malformed requirement cannot make a build look new enough.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) return left === null ? (right === null ? 0 : -1) : 1;

  for (const part of ["major", "minor", "patch"] as const) {
    if (left[part] !== right[part]) return left[part] < right[part] ? -1 : 1;
  }

  // A release outranks any prerelease of the same version.
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;

  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const one = left.pre[index];
    const two = right.pre[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const order = compareIdentifiers(one, two);
    if (order !== 0) return order;
  }
  return 0;
}
