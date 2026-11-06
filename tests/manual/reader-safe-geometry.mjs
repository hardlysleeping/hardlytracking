// Synthetic fixture only: never opens a real profile or library.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:440,height:956},isMobile:true,hasTouch:true});
const errors=[]; page.on('pageerror',e=>errors.push(e.message));
const base=process.env.READER_FIXTURE_URL || 'http://127.0.0.1:5226/tests/manual/reader-fixture.html';
const report=[];
const close=(a,b,label)=>assert.ok(Math.abs(a-b)<1.1,`${label}: ${a} != ${b}`);
try {
 for (const [width,height,top,bottom,left,right] of [[440,956,62,34,0,0],[956,440,0,21,62,62],[390,844,47,34,0,0]]) {
  await page.setViewportSize({width,height});
  for(const wide of [false,true]) for(const mode of ['vertical','webtoon','paged','ltr','rtl']) {
   await page.goto(`${base}?fit=contain&mode=${mode}${wide?'&wide':''}`);
   await page.addStyleTag({content:`:root{--safe-t:${top}px;--safe-b:${bottom}px;--safe-l:${left}px;--safe-r:${right}px}`});
   await page.waitForFunction(()=>document.images[0]?.naturalWidth>0);
   await page.waitForTimeout(100);
   const g=await page.evaluate(()=>{
    const rect=el=>{const {x,y,width,height}=el.getBoundingClientRect();return {x,y,width,height};};
    return {image:rect(document.images[0]),surface:rect(document.querySelector('.scroller')),button:rect(document.querySelector('.turn .btn')),viewport:[innerWidth,innerHeight],coarse:matchMedia('(pointer:coarse)').matches,safe:getComputedStyle(document.documentElement).getPropertyValue('--safe-t').trim()};
   });
   const availableWidth=width-left-right, availableHeight=height-top;
   const scale=Math.min(availableWidth/(wide?1600:800),availableHeight/(wide?800:1600),1);
   close(g.surface.y,top,'surface below status'); close(g.surface.height,availableHeight,'full bottom viewport');
   close(g.surface.x,left,'surface safe left'); close(g.surface.width,availableWidth,'surface width');
   close(g.image.width,(wide?1600:800)*scale,'image width');close(g.image.height,(wide?800:1600)*scale,'image height');
   close(g.image.x+g.image.width/2,left+availableWidth/2,'horizontal center');
   close(g.image.y+g.image.height/2,top+availableHeight/2,'vertical center');
   assert.deepEqual(g.viewport,[width,height]);assert.ok(g.coarse);assert.equal(g.safe,`${top}px`);
   assert.ok(g.button.height>=44&&g.button.height<=45,'compact accessible chapter height');
   assert.ok(g.button.width<availableWidth/2-10,'chapter buttons do not fill half screen');
   assert.ok(g.button.y+g.button.height<=height-bottom,'chapter button bottom safe');
   report.push({width,height,wide,mode,...g});
  }
 }
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({cases:report.length,errors,report},null,2));
} finally {await browser.close();}
