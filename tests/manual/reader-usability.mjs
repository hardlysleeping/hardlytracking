// Run against an isolated Vite server; npm install playwright in a scratch prefix if needed.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/manual/reader-usability.mjs
import assert from 'node:assert/strict';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const base=process.env.READER_FIXTURE_URL || 'http://127.0.0.1:5217/tests/manual/reader-fixture.html';
const result={geometry:[],gestures:{},queue:[],seams:[],errors};
const close=(a,b)=>assert.ok(Math.abs(a-b)<1.1,`${a} != ${b}`);
async function open(query=''){
 await page.goto(base+'?'+query);
 await page.waitForFunction(()=>[...document.images].some(img=>img.naturalWidth>0));
}
async function drag(x=195,from=650,to=440){
 const cdp=await page.context().newCDPSession(page);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:from}]});
 for(let y=from-10;y>=to;y-=10){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});await page.waitForTimeout(25);}
 // Stop before release to avoid a momentum-dependent verdict.
 await page.waitForTimeout(120);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 await page.waitForTimeout(120);await cdp.detach();
}
try{
 for(const [width,height] of [[390,844],[844,390]]) for(const wide of [false,true]) for(const mode of ['vertical','webtoon','paged','ltr','rtl']){
  await page.setViewportSize({width,height});
  await open(`mode=${mode}${wide?'&wide':''}`);
  const natural=wide?[1600,800]:[800,1600];
  for(const fit of ['width','height','contain']){
   await page.evaluate(fit=>readerFixture.settings.readerFit=fit,fit);
   await page.waitForTimeout(40);
   const bounds=await page.locator('img').first().boundingBox();
   const scale=fit==='width'?Math.min(width,900)/natural[0]:fit==='height'?height/natural[1]:Math.min(width/natural[0],height/natural[1],1);
   close(bounds.width,natural[0]*scale);close(bounds.height,natural[1]*scale);
   result.geometry.push({viewport:`${width}x${height}`,shape:wide?'wide':'tall',mode,fit,w:bounds.width,h:bounds.height});
   if(fit==='height'&&bounds.width>width){
    // Oversize fit-height must have a reachable leading and trailing edge, not negative overflow.
    const accessibility=await page.evaluate(()=>{const s=document.querySelector('.scroller');const i=document.querySelector('img');return {left:i.getBoundingClientRect().left,right:i.getBoundingClientRect().right,scrollWidth:s.scrollWidth};});
    if(mode!=='rtl')assert.ok(accessibility.left>=-1,'inaccessible leading edge');
    assert.ok(accessibility.scrollWidth>=bounds.width-1);
   }
  }
 }
 await page.setViewportSize({width:390,height:844});
 await open();await page.waitForTimeout(3400);
 const before=await page.locator('.scroller').evaluate(el=>el.scrollTop);
 await drag();
 const after=await page.locator('.scroller').evaluate(el=>el.scrollTop);
 assert.ok(after>before+100);assert.equal(await page.locator('.reader').evaluate(el=>el.classList.contains('hide')),true);
 result.gestures.closedDrag={before,after};
 await page.touchscreen.tap(195,400);assert.equal(await page.locator('.reader').evaluate(el=>el.classList.contains('hide')),false);
 const openBefore=await page.locator('.scroller').evaluate(el=>el.scrollTop);await drag();
 assert.ok(await page.locator('.scroller').evaluate(el=>el.scrollTop)>openBefore+100);
 result.gestures.openDrag=true;
 await page.getByRole('button',{name:'Reader settings',exact:true}).click();
 assert.ok(await page.getByRole('button',{name:'Whole page',exact:true}).isVisible());
 await page.getByRole('button',{name:'Height',exact:true}).click();
 assert.equal(await page.locator('.scroller').getAttribute('data-fit'),'height');
 close((await page.locator('img').first().boundingBox()).height,844);
 await page.getByRole('button',{name:'Whole page',exact:true}).click();
 assert.equal(await page.locator('.scroller').getAttribute('data-fit'),'contain');
 close((await page.locator('img').first().boundingBox()).width,390);
 result.gestures.settingsButton=true;
 await open();await page.waitForTimeout(3400);
 await page.touchscreen.tap(360,400);await page.waitForTimeout(600);
 assert.match(await page.locator('.count').textContent(),/^2 \/ 12$/);
 result.gestures.edgeTap=true;
 await page.touchscreen.tap(195,400);assert.equal(await page.locator('.reader').evaluate(el=>el.classList.contains('hide')),false);
 await page.touchscreen.tap(195,400);assert.equal(await page.locator('.reader').evaluate(el=>el.classList.contains('hide')),true);
 result.gestures.centerToggle=true;
 for(const mode of ['vertical','webtoon']){
  await open(`mode=${mode}&wide`);await page.waitForFunction(()=>document.querySelectorAll('img')[1]?.naturalWidth>0);
  const seam=await page.evaluate(()=>{const [a,b]=document.images;return b.getBoundingClientRect().top-a.getBoundingClientRect().bottom;});
  close(seam,mode==='webtoon'?0:12);result.seams.push({mode,seam});
 }
 await open('resume=4&metadataDelay=2500');
 await page.waitForFunction(()=>readerFixture.events.some(e=>e.kind==='start'&&e.page===5));
 let events=await page.evaluate(()=>readerFixture.events);
 assert.equal(events.find(e=>e.kind==='start').page,4);
 const firstPaint=events.find(e=>e.kind==='painted'&&e.page===4);
 const nextStart=events.find(e=>e.kind==='start'&&e.page===5);
 assert.ok(firstPaint&&firstPaint.at<=nextStart.at);
 assert.equal(await page.locator('.loading').count(),0);
 await page.waitForTimeout(2600);
 events=await page.evaluate(()=>readerFixture.events);
 assert.deepEqual(events.filter(e=>e.kind==='start').map(e=>e.page),[4,5,6,7,3]);
 const anchor=await page.locator('[data-page="4"]').boundingBox();
 close(anchor.y,0);
 result.queue=events;
 // Change chapter during a non-abortable next-page decode. Its one in-flight operation may settle,
 // but no further old page should start and no stale result should replace the new chapter.
 await open();await page.waitForFunction(()=>readerFixture.events.some(e=>e.kind==='start'&&e.page===1));
 await page.evaluate(()=>readerFixture.changeChapter('fixture:new'));
 await page.waitForTimeout(2300);
 const cancelled=await page.evaluate(()=>readerFixture.events);
 assert.deepEqual(cancelled.filter(e=>e.kind==='start'&&e.chapter==='fixture:chapter').map(e=>e.page),[0,1]);
 assert.deepEqual(cancelled.filter(e=>e.kind==='start'&&e.chapter==='fixture:new').map(e=>e.page),[0,1,2,3]);
 result.cancelled=cancelled;
 await open('partial&pageListDelay=2500');
 const partial=await page.evaluate(()=>({at:performance.now(),events:readerFixture.events,loading:!!document.querySelector('.loading')}));
 assert.ok(partial.at<1500,'available local page waited for missing metadata');
 assert.equal(partial.loading,false);assert.equal(partial.events.filter(e=>e.kind==='start').length,0);
 result.partial=partial;
 await open('fail=1');await page.waitForFunction(()=>readerFixture.events.some(e=>e.kind==='loaded'&&e.page===2));
 const failure=await page.locator('[data-page="1"]').evaluate(el=>({note:el.dataset.note,content:getComputedStyle(el,'::after').content}));
 assert.equal(failure.note,'Fixture page 2 failed');assert.match(failure.content,/Fixture page 2 failed/);
 result.failure=failure;
 for(const mode of ['paged','ltr','rtl']){
  await open(`mode=${mode}`);await page.waitForTimeout(3300);
  await page.touchscreen.tap(mode==='rtl'?30:360,400);await page.waitForTimeout(650);
  assert.equal(await page.locator('.count').textContent(),'2 / 12');
  await page.touchscreen.tap(mode==='rtl'?360:30,400);await page.waitForTimeout(650);
  assert.equal(await page.locator('.count').textContent(),'1 / 12');
 }
 result.gestures.horizontalTurns=true;
 await page.route('**/fixture-page/*.svg',async route=>{
  const index=Number(route.request().url().match(/(\d+)\.svg$/)[1]);
  await page.evaluate(index=>readerFixture.events.push({kind:'request',page:index,at:Math.round(performance.now())}),index);
  await new Promise(r=>setTimeout(r,150));
  await route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1600"><rect width="100%" height="100%" fill="blue"/></svg>'});
 });
 await open('plain');await page.waitForFunction(()=>readerFixture.events.some(e=>e.kind==='painted'&&e.page===3));
 const network=await page.evaluate(()=>readerFixture.events);
 assert.deepEqual(network.filter(e=>e.kind==='request').map(e=>e.page),[0,1,2,3]);
 for(let i=1;i<4;i++) assert.ok(network.find(e=>e.kind==='painted'&&e.page===i-1).at<=network.find(e=>e.kind==='request'&&e.page===i).at);
 result.network=network;
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
