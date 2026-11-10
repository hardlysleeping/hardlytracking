import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The reader's exit is a router question, so the module is exercised with a fake router: a depth
// that pushes and pops, a `history` that records the traversal it was asked for, and a `go` sink.
// Imports are stripped and the collaborators passed in, the same way `library-lock.test.mjs` loads
// the state classes without a browser.
function load(depth = 0) {
  const source = readFileSync(new URL('../../src/lib/reader-origin.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import[\s\S]*?;\s*/gm, '').replace(/export /g, '');
  const router = { depth };
  const calls = [];
  const history = {
    go(by) { calls.push(['go', by]); router.depth += by; },
    replaceState(_state, _title, url) { calls.push(['replace', url]); },
  };
  const go = (path) => { calls.push(['push', path]); router.depth += 1; };
  const pathTo = (name, ...ids) => [name, ...ids].map(encodeURIComponent).join('/');
  const api = new Function('navHistory', 'go', 'pathTo', 'history', js + ';return { noteRoute, readerOrigin, leaveReader, readerOriginLabel };')(router, go, pathTo, history);
  return { ...api, router, calls };
}

test('a reader opened from a shelf returns to that shelf, not to the series page', () => {
  // Library is entry 4; the ▶ pushes the reader at 5, and the router has counted that push before
  // it tells us the route changed.
  const api = load(4);
  api.noteRoute('#/library', false);
  api.router.depth = 5;
  api.noteRoute('#/read/series%3A1/ch1', true);
  assert.deepEqual(api.readerOrigin(), { hash: '#/library', steps: 1 });
  api.leaveReader('series:1');
  assert.deepEqual(api.calls[0], ['go', -1], 'pops the reader instead of pushing a copy of the shelf');
  assert.equal(api.router.depth, 4, 'and lands on the shelf, never on #/series/…');
});

test('chapter jumps are popped with the reader, so one exit lands on the origin entry', () => {
  const api = load(4);
  api.noteRoute('#/library', false);
  api.router.depth = 5;
  api.noteRoute('#/read/s1/ch1', true);
  api.router.depth = 6;
  api.noteRoute('#/read/s1/ch2', true);
  api.router.depth = 7;
  api.noteRoute('#/read/s1/ch3', true);
  assert.equal(api.readerOrigin()?.steps, 3, 'three reader entries: two chapter jumps and this one');
  api.leaveReader('s1');
  assert.deepEqual(api.calls[0], ['go', -3], 'pops the chapter entries instead of pushing a copy of the shelf');
});

test('the series page is still the origin when the reader was opened from it', () => {
  const api = load(2);
  api.noteRoute('#/library', false);
  api.router.depth = 3;
  api.noteRoute('#/series/s1', false);
  api.router.depth = 4;
  api.noteRoute('#/read/s1/ch1', true);
  assert.equal(api.readerOriginLabel(), 'the series');
  api.leaveReader('s1');
  assert.deepEqual(api.calls[0], ['go', -1]);
});

test('a cold start inside the reader has no origin and keeps the series page as its way out', () => {
  const api = load(0);
  api.noteRoute('#/read/s1/ch1', true);
  assert.equal(api.readerOrigin(), null);
  api.leaveReader('s1');
  assert.deepEqual(api.calls[0], ['push', 'series/s1']);
});

test('leaving the reader by another door forgets the origin', () => {
  const api = load(1);
  api.noteRoute('#/library', false);
  api.router.depth = 2;
  api.noteRoute('#/read/s1/ch1', true);
  api.router.depth = 1; // device Back pops the reader
  api.noteRoute('#/library', false);
  assert.equal(api.readerOrigin(), null);
  // A second reader opened from History records History, not the stale Library.
  api.router.depth = 2;
  api.noteRoute('#/history', false);
  api.router.depth = 3;
  api.noteRoute('#/read/s2/ch9', true);
  assert.deepEqual(api.readerOrigin(), { hash: '#/history', steps: 1 });
  assert.equal(api.readerOriginLabel(), 'History');
});

test('a replaced route with nothing to pop still exits to the origin without stacking', () => {
  const api = load(0);
  api.noteRoute('#/library', false);
  api.noteRoute('#/read/s1/ch1', true);
  assert.equal(api.readerOrigin()?.steps, 0);
  api.leaveReader('s1');
  assert.deepEqual(api.calls[0], ['replace', '#/library']);
  assert.deepEqual(api.calls[1], ['push', '#/library']);
});
