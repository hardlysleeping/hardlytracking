/**
 * The language tag a source row may show.
 *
 * A Mihon extension declares its language itself, and one of them — the bundled local-source
 * extension — answers with the *name of its resource key* (`LOCALSOURCELANG`) instead of a
 * translated value, because the translation for that key is missing in the locale it ran under.
 * The host has no way to know that; the screen does. So a tag is shown only when it is shaped like
 * one: real tags are short (`EN`, `ES`, `pt-BR`, `zh-Hans`); a five-plus-letter run of capitals with
 * nothing else in it is a key, no real tag contains an underscore, and none ends in "lang" — that
 * suffix only appears in names like `LOCALSOURCELANG`, which is a key whichever case it arrives in.
 *
 * Nothing else is guessed. An unfamiliar but plausible tag is shown as given — hiding a real
 * language would be a worse bug than showing a strange one.
 */
export function languageLabel(lang: string | undefined | null): string | null {
  if (lang === undefined || lang === null) return null;
  const trimmed = lang.trim();
  if (trimmed === "") return null;
  if (/^[A-Z]{5,}$/.test(trimmed) || trimmed.includes("_")) return null;
  if (/lang$/i.test(trimmed) && trimmed.length >= 8) return null;
  return trimmed;
}
