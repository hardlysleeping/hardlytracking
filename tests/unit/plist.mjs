/**
 * A reader for the plist subset Apple uses in the iOS shell: dict, array, key, string, integer,
 * true, false.
 *
 * Node ships no XML parser and a plist is not JSON, so this walks the tokens instead of adding a
 * dependency for a handful of files. Comments, the XML declaration and the doctype are skipped.
 *
 * It lives here rather than in one test because two gates read real Apple files: the ATS test
 * (`ios-ats.test.mjs`, `Info.plist`) and the project-hygiene test (`ios-hygiene.test.mjs`,
 * `Info.plist` and `PrivacyInfo.xcprivacy`). A second copy of a parser is a second answer.
 */
import assert from "node:assert/strict";

export function readPlist(xml) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z]+)\s*>|<([A-Za-z]+)\s*\/>|<([A-Za-z]+)[^>]*>|([^<]+)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const [, close, empty, open, text] = match;
    if (close !== undefined) tokens.push({ kind: "close", name: close });
    else if (empty !== undefined) tokens.push({ kind: "empty", name: empty });
    else if (open !== undefined) tokens.push({ kind: "open", name: open });
    else if (text !== undefined && text.trim() !== "") tokens.push({ kind: "text", text: text.trim() });
  }

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  function value() {
    const token = take();
    assert.ok(token !== undefined, "plist ended early");
    if (token.kind === "open" && token.name === "dict") {
      const out = {};
      for (;;) {
        const next = peek();
        if (next === undefined) assert.fail("unclosed <dict>");
        if (next.kind === "close" && next.name === "dict") {
          take();
          return out;
        }
        const key = take();
        assert.equal(key.kind, "open", `expected <key>, saw ${JSON.stringify(key)}`);
        assert.equal(key.name, "key", `expected <key>, saw <${key.name}>`);
        const name = take();
        assert.equal(name.kind, "text", "a <key> carries no value");
        assert.equal(out[name.text], undefined, `duplicate key ${name.text}`);
        assert.equal(take().name, "key", "a <key> closes immediately");
        out[name.text] = value();
      }
    }
    if (token.kind === "open" && token.name === "array") {
      const out = [];
      for (;;) {
        const next = peek();
        if (next === undefined) assert.fail("unclosed <array>");
        if (next.kind === "close" && next.name === "array") {
          take();
          return out;
        }
        out.push(value());
      }
    }
    if (token.kind === "empty" && token.name === "true") return true;
    if (token.kind === "empty" && token.name === "false") return false;
    // `<array/>` and `<dict/>` are how Xcode writes an empty one.
    if (token.kind === "empty" && token.name === "array") return [];
    if (token.kind === "empty" && token.name === "dict") return {};
    if (token.kind === "open" && token.name === "string") {
      const text = take();
      assert.equal(take().name, "string", "a <string> closes after its text");
      return text.kind === "text" ? text.text : "";
    }
    if (token.kind === "open" && token.name === "integer") {
      const text = take();
      assert.equal(take().name, "integer", "an <integer> closes after its digits");
      return Number(text.text);
    }
    assert.fail(`unsupported plist element ${JSON.stringify(token)}`);
  }

  const first = take();
  assert.ok(first.kind === "open" && first.name === "plist", "not a plist");
  const root = value();
  return root;
}
