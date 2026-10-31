/**
 * What this app says about other people's code.
 *
 * An app that installs third-party extensions has to be clear about the line: the app is ours, the
 * extensions are not. Paperback publishes that line, and it is the right one — no claim of support,
 * no discussion of extensions in the project's own channels, support goes to whoever wrote them.
 *
 * The same words appear in `README.md` under "Third-party sources" and on the Extensions screen.
 * They live here as constants so a screen cannot quietly soften them, and a test can pin that the
 * three ideas survive: not ours, no support here, your decision to install.
 */

/** The one-line version, for a confirmation panel about a single repository. */
export const THIRD_PARTY_NOTICE =
  "Third-party sources from this repository are not maintained by HardlyTracking.";

/**
 * The full disclosure, for the Extensions screen.
 *
 * Deliberately concrete: "not developed or maintained" is a fact, and so is "support goes to the
 * publisher" — a vague "use at your own risk" would leave the person with nowhere to go.
 */
export const THIRD_PARTY_DISCLOSURE =
  "Extensions add sources. They are not developed or maintained by HardlyTracking, and we provide no information about them — not whether they work, not what they show, and not what they do with your data. Support for an extension goes to whoever publishes it, not to HardlyTracking and not to this app's issues.";

/** What the screen says about the decision itself, so the disclosure does not read as a warning only. */
export const THIRD_PARTY_DECISION =
  "Nothing is installed until you tap Add Repository, and every extension can be disabled or uninstalled from here.";
