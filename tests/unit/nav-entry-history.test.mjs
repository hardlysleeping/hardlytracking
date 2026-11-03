import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the real history module with identity runes and an in-memory browser history.
// Browser checks separately exercise Svelte reactivity and actual history traversal.
function harness() {
  let at = 0;
  let entries = [{ state: null }];
  const handlers = {};
  const storage = new Map();
  const history = {
    get state() { return entries[at].state; },
    replaceState(state) { entries[at].state = state; },
  };
  const scope = { history, crypto: { randomUUID: () => 'test-session' },
    sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,v) },
    window: { addEventListener: (name, fn) => { handlers[name] = fn; } },
    $state: value => value,
  };
  let code = readFileSync(new URL('../../src/lib/nav-history.svelte.ts', import.meta.url),'utf8')
    .replace('export const navHistory =', 'globalThis.navHistory =');
  code = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInNewContext(code, scope);
  return {
    nav: scope.navHistory,
    push() { entries = entries.slice(0, at+1); entries.push({state:null}); at++; handlers.popstate(); handlers.hashchange(); },
    back() { at--; handlers.popstate(); handlers.hashchange(); },
    forward() { at++; handlers.popstate(); handlers.hashchange(); },
  };
}

test('a newly pushed repeated route is not mistaken for Back', () => {
  const h = harness();
  assert.equal(h.nav.depth, 0);
  assert.equal(h.nav.canForward, false);
  // library -> browse -> library: same URL, different browser entry.
  h.push(); h.push();
  assert.equal(h.nav.depth, 2);
  assert.equal(h.nav.canForward, false);
  h.back();
  assert.equal(h.nav.depth, 1);
  assert.equal(h.nav.canForward, true);
  h.back();
  assert.equal(h.nav.depth, 0);
  assert.equal(h.nav.canForward, true);
  h.forward(); h.forward();
  assert.equal(h.nav.depth, 2);
  assert.equal(h.nav.canForward, false);
});

test('a new branch removes the real forward history', () => {
  const h = harness();
  h.push(); h.push(); h.back();
  assert.equal(h.nav.canForward, true);
  h.push();
  assert.equal(h.nav.depth, 2);
  assert.equal(h.nav.canForward, false);
});
