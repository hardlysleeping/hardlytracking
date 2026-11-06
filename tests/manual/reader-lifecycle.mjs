// Synthetic in-memory reader only; no profile open or real book access.
import assert from 'node:assert/strict';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:440,height:956},hasTouch:true,isMobile:true});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const base=process.env.READER_FIXTURE_URL||'http://127.0.0.1:5231/tests/manual/reader-fixture.html';
try {
 await page.goto(base+'?pageListDelay=10000');
 await page.waitForSelector('.loading');
 await page.waitForTimeout(3500);
 assert.equal(await page.locator('header').evaluate(e=>getComputedStyle(e).opacity),'1','exit auto-hid during loading');
 await page.getByRole('button',{name:'Back to series',exact:true}).click();
 assert.match(await page.evaluate(()=>location.hash),/series/);
 // Simulate a new chapter in the same mounted Reader while the old page list remains pending.
 await page.evaluate(async()=>{
  const {library}=await import('/src/state/library.svelte.ts');
  const {activity}=await import('/src/lib/deadline.ts');
  window.lifecycleActivity=activity;
  library.pages=async()=>[{index:0,url:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>'}];
  readerFixture.changeChapter('fixture:new');
 });
 await page.waitForFunction(()=>document.images[0]?.naturalWidth>0);
 await page.waitForFunction(()=>lifecycleActivity.count===0);
 assert.equal(await page.locator('.loading').count(),0);
 await page.waitForTimeout(7000);
 assert.equal(await page.locator('img').count(),1,'late page list overwrote new chapter');
 assert.equal(await page.locator('.banner:not(.note)').count(),0);
 // A permanently pending page producer must stop owning activity when the reader unmounts.
 await page.evaluate(async()=>{
  const {library}=await import('/src/state/library.svelte.ts');
  library.pages=async()=>[{index:0,url:'fixture:never',open:()=>new Promise(()=>{})}];
  readerFixture.changeChapter('fixture:stuck');
 });
 await page.waitForFunction(()=>lifecycleActivity.count>0);
 await page.evaluate(()=>readerFixture.teardown());
 await page.waitForFunction(()=>lifecycleActivity.count===0);
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({loadingExit:true,staleChapterIgnored:true,abandonedActivityCleared:true,errors}));
} finally {await browser.close();}
