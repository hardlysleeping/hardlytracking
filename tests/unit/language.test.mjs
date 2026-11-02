/**
 * What a source row may print where a language belongs.
 *
 * The rule exists because of one real row: a Mihon extension declares its language itself, and the
 * bundled local-source extension answers with the *name of its resource key* — `LOCALSOURCELANG` —
 * because the translation for that key is missing in the locale it ran under. The host cannot tell
 * a key from a tag; a screen can, because real tags are short.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { languageLabel } from "../../src/lib/language.ts";

test("a real tag is shown as given", () => {
  assert.equal(languageLabel("EN"), "EN");
  assert.equal(languageLabel("es"), "es");
  assert.equal(languageLabel("pt-BR"), "pt-BR");
  assert.equal(languageLabel("zh-Hans"), "zh-Hans");
  assert.equal(languageLabel("ALL"), "ALL", "three letters is a plausible tag, not a key");
});

test("a resource key is not a language", () => {
  // Exactly the string a bundled extension actually returns.
  assert.equal(languageLabel("LOCALSOURCELANG"), null);
  assert.equal(languageLabel("SOURCE_LANGUAGE"), null, "no real tag holds an underscore");
  // The value reaches the screen lower-cased by the runtime, which is how it was seen:
  // "Local source · localsourcelang". A tag never ends in "lang", so the suffix is the tell.
  assert.equal(languageLabel("localsourcelang"), null);
  assert.equal(languageLabel("english"), "english", "a word is a language, however long");
  assert.equal(languageLabel("MULTI"), null, "five capitals with nothing else is the key shape");
});

test("nothing is shown for an empty tag", () => {
  assert.equal(languageLabel(undefined), null);
  assert.equal(languageLabel(null), null);
  assert.equal(languageLabel(""), null);
  assert.equal(languageLabel("   "), null);
  assert.equal(languageLabel(" EN "), "EN", "a padded tag is still a tag");
});
