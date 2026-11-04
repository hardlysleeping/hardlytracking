# T67: Library visibility band and local screen privacy

The Library has direct Hidden → Revealed → Only and Active → Only → Hidden controls.
The eye and pin use existing `--tone-hidden` / `--tone-pinned` variables (defaults
`#e5484d` / `#0078e0`). Fold is a session preference. Lock holds that fold aside,
tucks both controls away, forces the effective category/source eye to Hidden, and
Unlock restores the prior fold and intended eye filters. This is explicitly **local
screen privacy, not authentication, a passcode system, or encryption**. Anyone can
unlock; reload starts a new session.

`state/privacy.svelte.ts` owns the curtain. `state/visibility.svelte.ts` reuses
`contextOf` / `isHidden`, including saved category membership and source mappings,
for fetched results and direct detail views. Unloaded policy/mappings fail closed
while locked. Library, Continue, Search blocks and expanded detail/selection,
History's split detail, Stats, Browse, Series/Source routes and Downloads filter
records rather than CSS-hiding them. Hidden collection labels are removed from
tabs, pickers and sheets. Writes that could unhide/reclassify shelves are refused
while locked. Search/source request completions carry a privacy revision check.

## Reader route integration

`src/App.svelte` mounts `ReaderGate` for every read route. The gate loads saved mappings from the current profile's store and mounts `Reader` only when `visibility.allows({ id: seriesId })`. Locking reacts immediately by unmounting protected reader images, actions and pending component work; it is not a CSS overlay. A neutral curtain links back to Library without printing the protected title or chapter.

The memory-only fixture exercises this same component for locked direct-entry, unlock-to-mount, live lock-to-unmount, and a public reader that remains usable while locked. Two AST/source regressions keep App routed through this gate and the Reader mounted only inside its allowed branch. Unrelated messaging edits in App remain uncommitted.

## Reproduce (synthetic memory database only)

```sh
npm run dev -- --host 127.0.0.1 --port 5217 --strictPort
# In another terminal:
node --experimental-strip-types --import ./tests/unit/register-ts.mjs --test tests/unit/library-lock.test.mjs
node tests/manual/library-lock-browser.mjs
npm test
npx tsc --noEmit
npx svelte-check --threshold error
npm run build
```

The browser runner imports `playwright` by default; set `PLAYWRIGHT_MODULE` to an external installation's `index.mjs` if browser tooling is kept outside the project. Fixture entry is
`tests/manual/library-lock-fixture.html`; setup is `library-lock-fixture.ts` and
`LibraryLockFixture.svelte` beside it. No `library.open()`, real profile, passcode,
real library, source network mutation, or persistent fixture database is used.
Non-local browser HTTP requests are blocked. Fixture navigation is not App routing.

Evidence is generated under ignored `data/library-lock-qa/`: `evidence.json`,
portrait/open-and-locked and landscape screenshots, secondary compatibility shots,
`run.log`, `test.log`, `tsc.log`, `svelte-check.log`, `build.log`.
The browser asserts private text/ARIA/title/image-alt absence from the **DOM**,
public records retained, both full eye/pin cycles, direct mutation refusal,
pre-opened category sheet removal, folded/unfolded restoration, pre-fetched and
expanded private Search results, and completed delayed requests after Lock.

Primary geometry is **iPhone 17 Pro Max / iOS 26 target browser emulation**:
440×956 @3x with 62/34 top/bottom insets, and 956×440 @3x with 62px left/right,
21px bottom. Each measurement verifies actual inner dimensions, coarse pointer,
DPR, all consumed safe variables/padding, no page horizontal overflow, in-bounds
controls ≥44px, and exact default eye/pin colors. 390 and 320 are secondary
compatibility cases, not the owner's phone. This does not prove physical iOS 26,
WebKit, actual notch behavior, or native safe-area integration.

## Verification at handoff

- New deterministic state tests: 3 passed.
- Browser fixture: passed, no page errors; primary portrait/landscape and secondary
  390/320 geometry passed, 44px controls and default red/blue verified.
- TypeScript: passed. Svelte check: 0 errors, 9 existing warnings. Build: passed.
- Full unit suite: 1,009 passed / 3 failed out of 1,012. The same three fail in a
  clean HEAD archive (1,006 passed / 3 failed out of 1,009): Stats destination,
  paid Sync belongs to More, More's shared sync account controls. These depend on
  parent-owned App/navigation work and were not repaired here. Baseline output is
  `data/library-lock-qa/baseline-test.log`.
## Parent integrated verification

- Parent reran the memory-only browser runner, including the same ReaderGate component App uses: locked direct-entry refused, unlock mounts, live lock unmounts all reader images/actions, public reading retained while locked.
- Pro Max 440×956 @3x / 956×440, simulated insets, 44px controls, default red/blue, private DOM absence, stale Search responses, and fold restoration pass with zero browser page errors. Portrait open/locked screenshots visually reviewed.
- Clean committed-tree gates after feature-only routing integration: 1,018 tests passed, TypeScript passed, Svelte zero errors/nine existing warnings, production build passed. No unrelated messaging files are included in that tree.
- Physical iOS 26/WebKit and device native-runtime behavior remain unverified. No new IPA is part of this code-only continuation.
