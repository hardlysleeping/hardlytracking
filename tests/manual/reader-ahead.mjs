import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const base=process.env.QA_BASE??'http://127.0.0.1:5313';
const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
const report=[];
async function open(width,height,ahead,resume=4){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:3,isMobile:true,hasTouch:true});
 const page=await context.newPage();
 await page.addInitScript(({portrait})=>{
  document.addEventListener('DOMContentLoaded',()=>{
   const style=document.createElement('style');
   style.textContent=portrait?':root{--safe-t:62px;--safe-b:34px;--safe-l:0px;--safe-r:0px}':':root{--safe-t:0px;--safe-b:21px;--safe-l:62px;--safe-r:62px}';
   document.head.appendChild(style);
  });
 },{portrait:width<height});
 await page.goto(`${base}/tests/manual/reader-fixture.html?resume=${resume}${ahead===undefined?'':`&ahead=${ahead}`}`);
 await page.waitForFunction(()=>window.readerFixture&&document.querySelector('img[src]'));
 return{page,context};
}
try{
 for(const [width,height] of [[440,956],[956,440]]){
  for(const ahead of [0,2,3,5,10]){
   const resume=ahead===10?0:4;
   const{page,context}=await open(width,height,ahead,resume);
   const expected=[resume,...Array.from({length:Math.min(ahead,11-resume)},(_,i)=>resume+i+1),...(ahead===0||resume===0?[]:[resume-1])];
   await page.waitForFunction(n=>readerFixture.events.filter(e=>e.kind==='painted').length>=n,expected.length,{timeout:20000});
   await page.waitForTimeout(200);
   const state=await page.evaluate(()=>({size:[innerWidth,innerHeight],coarse:matchMedia('(pointer:coarse)').matches,
    top:getComputedStyle(document.documentElement).getPropertyValue('--safe-t').trim(),
    starts:readerFixture.events.filter(e=>e.kind==='start').map(e=>e.page),
    events:readerFixture.events,count:document.querySelector('.count')?.textContent,
    rootX:document.documentElement.scrollWidth-innerWidth}));
   assert.deepEqual(state.size,[width,height]);assert.equal(state.coarse,true);
   assert.equal(state.top,width<height?'62px':'0px');
   assert.deepEqual(state.starts,expected);
   for(let i=1;i<state.starts.length;i++){
    const current=state.events.find(e=>e.kind==='start'&&e.page===state.starts[i]);
    const prev=state.events.find(e=>e.kind==='resolved'&&e.page===state.starts[i-1]);
    assert.ok(current.at>=prev.at,'never fetch two pages simultaneously');
   }
   report.push({width,height,ahead,...state});await context.close();
  }
 }
 // The control is real UI and changes the mounted window: ten must reach beyond the old four.
 const{page,context}=await open(440,956,0,0);
 await page.getByRole('button',{name:'Reader settings',exact:true}).click({force:true});
 const group=page.getByRole('group',{name:'Read ahead pages'});
 assert.deepEqual(await group.locator('button').allTextContents(),['None','2','3','5','10']);
 await group.getByRole('button',{name:'10',exact:true}).click();
 await page.waitForFunction(()=>readerFixture.events.filter(e=>e.kind==='painted').length===11,null,{timeout:20000});
 assert.equal(await group.getByRole('button',{name:'10',exact:true}).getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>readerFixture.settings.readerAhead),10);
 const geometry=await group.locator('button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return{text:b.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,hit:document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest('button')===b};}));
 for(const r of geometry){assert.ok(r.left>=0&&r.right<=r.width&&r.top>=0&&r.bottom<=r.height);assert.ok(r.bottom-r.top>=44);assert.ok(r.hit);}
 report.push({case:'live UI None to 10',geometry,starts:await page.evaluate(()=>readerFixture.events.filter(e=>e.kind==='start').map(e=>e.page))});
 await context.close();
 const def=await open(440,956,undefined,0);
 assert.equal(await def.page.evaluate(()=>readerFixture.settings.readerAhead),3);await def.context.close();
 console.log(JSON.stringify({cases:report.length,checks:'current-first; sequential; None=one; all five budgets; live UI grows window; default three',report},null,2));
 await writeFile(process.env.QA_REPORT??'reader-ahead-report.json',JSON.stringify(report,null,2));
}finally{await browser.close();}
