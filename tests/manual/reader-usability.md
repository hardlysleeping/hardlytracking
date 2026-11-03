# Reader usability fixture QA (T51/T52/T53/T55)

These fixtures stub library/download methods **in memory**, never open a profile/database, and
produce SVG bytes. No real library rows, source requests, or permanent downloads are used.

## Re-run

From the isolated checkout:

```sh
npm run dev -- --host 127.0.0.1 --port 5217 --strictPort
# In another terminal; install Playwright in a scratch prefix, not the app dependencies:
PLAYWRIGHT_MODULE=/absolute/scratch/node_modules/playwright/index.mjs node tests/manual/reader-usability.mjs
# Or use a preinstalled playwright package without the environment variable.
node --experimental-strip-types --import ./tests/unit/register-ts.mjs --test tests/unit/reader.test.mjs
```

`READER_FIXTURE_URL` overrides the fixture URL. `reader-repro.mjs` prints the simple drag/fit repro.
The automated browser closes in `finally`; stop the Vite process when finished.
Fixture query options: `mode=vertical|webtoon|paged|ltr|rtl`, `fit=width|height|contain`, `wide`,
`resume=4`, `metadataDelay=2500`, `partial&pageListDelay=2500`, `fail=1`, and `plain` (the latter
requires the QA runner's generated-image request interceptor).

## Observed red controls (baseline 6f7442c)

- Closed-overlay center touch drag left scrollTop at **48 → 48**; hit-test landed on the sibling
  `.zone.mid` button. Native scrolling cannot chain into a sibling scroller.
- Tall portrait bounds for Width, Height, Whole page were all **390 × 780**. `object-fit` width/height
  are invalid; object-fit contain alone cannot resize an auto-sized image.
- Partial download with a present first page and a 2500 ms missing-page-list delay: no image after
  800 ms. Pages **1 through 11 all started at 2621 ms**, first local page loaded at **3227 ms**.
  The missing-page `Promise.all` gated available local content.
- Plain image request starts: pages **0,1,2,3 all at 143 ms**, before page 0 loaded at 298 ms.

## Passing output

All 60 geometry assertions pass: five reading modes × two aspect ratios × two orientations ×
three fits. Bounds in pixels (same sizing in all five modes):

| Viewport / image | Width | Height | Whole page |
|---|---|---|---|
| 390×844 / tall | 390×780 | 422×844 | 390×780 |
| 390×844 / wide | 390×195 | 1688×844 | 390×195 |
| 844×390 / tall | 844×1688 | 195×390 | 195×390 |
| 844×390 / wide | 844×422 | 780×390 | 780×390 |

Coincident fits here are mathematically correct. Height permits accessible horizontal panning;
Whole page is bounded by both viewport dimensions. Width preserves its 900 px desktop cap.

- Closed-overlay real browser touch drag: **0 → 195 px** with controls remaining hidden. Open-overlay
  drag, center-toggle taps, reader settings/fit chips, edge taps and paged/LTR/RTL turns pass.
- Wide pages: vertical gap **12 px**; webtoon seam **0 px**. No per-page viewport-height whitespace.
- Resume fixture: page indices start **4,5,6,7,3** (zero-based). Page 4 loads at **146 ms**, reaches
  the two-frame paint checkpoint at **164 ms**, then page 5 starts at **164 ms** and loads at 766 ms.
  The 2500 ms chapter-list metadata wait does not gate rendering. Resumed page remains at y=0 after
  aspect estimates become measured sizes (the initially reproduced drift was 891 px).
- Partial fixture: first local page loads at **43 ms**, paint checkpoint **63 ms**; missing-page
  metadata is still waiting. No batch gate.
- Plain URLs: request starts **164,344,527,710 ms**; preceding paint checkpoints **342,525,708 ms**.
- Chapter replacement during an old decode starts no additional old queued pages. The one old
  in-flight decode may settle, but its result never paints into the replacement chapter.
- Failed page explains itself through rendered `data-note`/pseudo-content and does not stall page 3.
- `npm test`: **954 passed, 0 failed**; TypeScript passes; svelte-check **0 errors**, seven existing
  warnings outside Reader; production build passes (existing large-chunk warning).

Times are observations, not performance promises. `painted` is a browser double-animation-frame
checkpoint following image load; it is not proof of a physical device compositing frame.

## Remaining boundaries

No physical iPhone/WebKit test was possible. Chromium touch input does not prove native behavior.
`Page.open()` and image-cache resolvers have no AbortSignal API: queued obsolete work is dropped,
stale results are ignored, and one worker waits for the in-flight resolver (with a deadline).
A deadline cannot forcibly stop underlying unabortable decode work. Direct image fetches can be
cancelled by removing `src`. Some archive/cloud formats still require the whole container before
page enumeration; sequential image painting cannot eliminate that format cost. The existing
`downloads.local()` API also enumerates stored blob rows before handing Reader its local URLs;
this patch does not introduce a new lazy disk-read API.

No new settings interface is required for these fixes. Read-ahead currently uses three forward
pages plus one backfill, with a nine-image mount window. Configurable read-ahead and autoscroll
are deliberately not implemented here.
