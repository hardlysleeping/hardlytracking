// Synthetic memory-only fixture. Start Vite :5227; set PLAYWRIGHT_MODULE if not installed locally.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true });
try {
  for (const [name, width, height, insets] of [
    ['portrait', 440, 956, {top:62,bottom:34,left:0,right:0}],
    ['landscape', 956, 440, {top:0,bottom:21,left:62,right:62}],
  ]) {
    const page = await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true});
    const errors=[]; page.on('pageerror',e=>errors.push(e.message));
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
    await page.goto(`${process.env.FIXTURE_URL ?? 'http://127.0.0.1:5227'}/tests/manual/cover-fixture.html`);
    await page.waitForFunction(()=>document.images.length===3 && [...document.images].every(i=>i.naturalWidth>0));
    await page.waitForTimeout(500);
    const count=await page.evaluate(()=>window.coverResolutions);
    assert.equal(count,2,'one initial callback and one resolved blob, not a self-triggering loader');
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(()=>window.coverResolutions),count);
    const button=page.getByRole('button',{name:'Dismiss',exact:true});
    const box=await button.boundingBox();
    assert.ok(box.y>=insets.top && box.x>=insets.left && box.x+box.width<=width-insets.right);
    assert.ok(box.width>=44 && box.height>=44);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),width);
    await button.click();
    assert.equal(await page.getByRole('status').count(),0);
    assert.deepEqual(errors,[]);
    console.log(`${name}: 3 decoded covers, stable callback, safe-area dismiss ${JSON.stringify(box)}`);
    await page.close();
  }
} finally { await browser.close(); }
