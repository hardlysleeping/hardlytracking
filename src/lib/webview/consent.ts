/**
 * Permission to share cookies with one source.
 *
 * App Store 4.7.3 asks for consent before a downloaded plug-in is given data or permissions — and a
 * cookie jar is both. The runtime's jar is per domain and the app re-sends those cookies on every
 * `/dalvik` call, so "logging in" is not a single hand-off the user can see; it is an ongoing
 * share. So each source asks once, for its own domain, and the answer is remembered.
 *
 * One grant per `sourceId + domain`, which is deliberately narrow:
 *
 * - per source, because two extensions can point at the same host and one of them is the one you
 *   meant to sign into;
 * - per domain, because a source that later moves hosts must ask again rather than carry the old
 *   answer somewhere new.
 *
 * The rule is a pure function of the grant list so a screen cannot invent its own version of it.
 */

export interface ConsentGrant {
  sourceId: string;
  /** The bare host, lowercase, no port — the thing the question names. */
  domain: string;
  at: number;
}

/** The key a grant is stored under. One string, so a lookup is a `some` and not a nested scan. */
export function consentKey(sourceId: string, domain: string): string {
  return `${sourceId}|${normaliseDomain(domain)}`;
}

export function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, "").replace(/:\d+$/, "");
}

/** Has this source been allowed to use cookies for this domain? */
export function isGranted(grants: readonly ConsentGrant[], sourceId: string, domain: string): boolean {
  const wanted = consentKey(sourceId, domain);
  return grants.some((grant) => consentKey(grant.sourceId, grant.domain) === wanted);
}

/** Remember a yes. Adding the same pair twice is not two grants. */
export function grantConsent(
  grants: readonly ConsentGrant[],
  sourceId: string,
  domain: string,
  at: number,
): ConsentGrant[] {
  const domain2 = normaliseDomain(domain);
  if (isGranted(grants, sourceId, domain2)) return [...grants];
  return [...grants, { sourceId, domain: domain2, at }];
}

/**
 * Take a yes back — one domain, or every domain when `domain` is left out.
 *
 * Uninstalling a source is the second form: the source is gone, so its permission should be too,
 * and a reinstall should ask again.
 */
export function revokeConsent(grants: readonly ConsentGrant[], sourceId: string, domain?: string): ConsentGrant[] {
  if (domain === undefined) return grants.filter((grant) => grant.sourceId !== sourceId);
  const wanted = consentKey(sourceId, domain);
  return grants.filter((grant) => consentKey(grant.sourceId, grant.domain) !== wanted);
}

/** What the question says, in the words the user will read. */
export function consentQuestion(domain: string): string {
  return `Allow this source to use cookies for ${normaliseDomain(domain)}?`;
}

/**
 * The sentence under the question.
 *
 * It has to be true of this app specifically: the cookies are kept on the device, sent to the
 * runtime on each call, and that is what "signed in" means here.
 */
export const CONSENT_DETAIL =
  "The sign-in page runs on the site itself. Whatever it sets is kept on this device and sent to the source with each request, so you stay signed in. Refusing keeps the source working, just signed out.";

/** A readable list for a settings screen: `sourceId — domain`. */
export function describeGrant(grant: ConsentGrant): string {
  return `${grant.sourceId} — ${grant.domain}`;
}
