// A session must close at the last moment reading was real, not at the wall clock of the close.
//
// Drives the real Reader fixture (tests/manual/reader-fixture.html) with a controllable clock and a
// controllable `document.visibilityState`, then reads what the view passed to `library.endSession`.
// Cases: a visible close (unchanged), a long absence (ends at the moment the page left the screen,
// and does not grow when the absence does), a teardown while hidden, and a chapter change.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/session-cutoff.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const base = process.env.QA_BASE ?? 'http://127.0.0.1:5313';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const report = [];

async function open() {
  const context = await browser.newContext({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.addInitScript(() => {
    const realNow = Date.now.bind(Date);
    window.__offset = 0;
    Date.now = () => realNow() + window.__offset;
    window.__advance = (ms) => { window.__offset += ms; return Date.now(); };
    window.__visibility = (state) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    };
  });
  await page.goto(`${base}/tests/manual/reader-fixture.html?resume=0&ahead=0`);
  await page.waitForFunction(() => window.readerFixture?.sessions?.some((s) => s.kind === 'begin') && document.querySelector('img[src]'));
  // Let the page queue drain, so an in-flight fetch cannot be mistaken for reading that continued.
  await page.waitForTimeout(1200);
  return { page, context, errors };
}

const state = (page) => page.evaluate(() => ({
  sessions: readerFixture.sessions.map((s) => ({ ...s })),
  now: Date.now(),
}));

try {
  // 1. A visible close keeps the wall clock: nothing about a session that never hid changes.
  {
    const { page, context, errors } = await open();
    await page.waitForTimeout(1500);
    await page.evaluate(() => readerFixture.teardown());
    await page.waitForFunction(() => readerFixture.sessions.some((s) => s.kind === 'end'));
    const { sessions } = await state(page);
    const begin = sessions.find((s) => s.kind === 'begin');
    const end = sessions.find((s) => s.kind === 'end');
    assert.ok(Math.abs(end.at - end.now) < 50, 'a close at the page ends now, exactly as before');
    assert.ok(end.at - begin.now >= 1500, 'and the span is the wall clock');
    assert.deepEqual(errors, []);
    report.push({ case: 'visible close', span: end.at - begin.now, wall: end.now - begin.now });
    await context.close();
  }

  // 2. A long absence ends the session when the page left the screen — and the span stops growing.
  {
    const { page, context, errors } = await open();
    const hiddenAt = await page.evaluate(() => { __visibility('hidden'); return Date.now(); });
    await page.evaluate(() => __advance(3_600_000));
    await page.evaluate(() => __visibility('visible'));
    await page.waitForFunction(() => readerFixture.sessions.some((s) => s.kind === 'end'));
    let { sessions } = await state(page);
    const begin = sessions.find((s) => s.kind === 'begin');
    const first = sessions.find((s) => s.kind === 'end');
    assert.equal(first.at, hiddenAt, 'the end is the moment it went hidden, not the return');
    assert.ok(first.now - begin.now >= 3_590_000, 'the wall clock really did grow by an hour');
    assert.ok(first.at - begin.now < 6_000, 'the stored span is visible time only');
    // When the absence grows, the stored span does not.
    await page.evaluate(() => __advance(7_200_000));
    await page.evaluate(() => { __visibility('hidden'); __visibility('visible'); });
    ({ sessions } = await state(page));
    assert.equal(sessions.filter((s) => s.kind === 'end').length, 1, 'one session, one close');
    const end = sessions.find((s) => s.kind === 'end');
    assert.equal(end.at, hiddenAt, 'two more hours of absence add nothing to the span');
    assert.deepEqual(errors, []);
    report.push({ case: 'hidden gap', span: end.at - begin.now, wall: end.now - begin.now, gap: first.now - hiddenAt });
    await context.close();
  }

  // 3. Teardown while hidden (a route change from a webview the app left) uses the hide timestamp.
  {
    const { page, context, errors } = await open();
    const hiddenAt = await page.evaluate(() => { __visibility('hidden'); return Date.now(); });
    await page.evaluate(() => __advance(1_800_000));
    await page.evaluate(() => readerFixture.teardown());
    await page.waitForFunction(() => readerFixture.sessions.some((s) => s.kind === 'end'));
    const { sessions } = await state(page);
    const begin = sessions.find((s) => s.kind === 'begin');
    const end = sessions.find((s) => s.kind === 'end');
    assert.equal(end.at, hiddenAt, 'a teardown after half an hour in the background ends at the hide');
    assert.ok(end.at - begin.now < 6_000);
    assert.deepEqual(errors, []);
    report.push({ case: 'teardown while hidden', span: end.at - begin.now, wall: end.now - begin.now });
    await context.close();
  }

  // 4. A chapter change closes the old session at the wall clock and opens the next one.
  {
    const { page, context, errors } = await open();
    await page.waitForTimeout(1200);
    const closedAt = await page.evaluate(() => { readerFixture.changeChapter('fixture:chapter2'); return Date.now(); });
    await page.waitForFunction(() => readerFixture.sessions.filter((s) => s.kind === 'begin').length >= 2);
    const { sessions } = await state(page);
    const end = sessions.find((s) => s.kind === 'end');
    assert.ok(end !== undefined, 'the chapter change closed the previous session');
    assert.ok(Math.abs(end.at - closedAt) < 1000, 'a visible chapter change still ends now');
    assert.equal(sessions.filter((s) => s.kind === 'begin').length, 2, 'and the next chapter has its own session');
    assert.deepEqual(errors, []);
    report.push({ case: 'chapter change', span: end.at - sessions[0].now, drift: end.at - closedAt });
    await context.close();
  }

  console.log(JSON.stringify({ cases: report.length, checks: 'visible close unchanged; hidden gap ends at hide and stops growing; teardown while hidden; chapter change', report }, null, 2));
} finally {
  await browser.close();
}
