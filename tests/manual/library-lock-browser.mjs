// Run against this worktree's Vite on :5217. Synthetic memory DB only.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/library-lock-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({headless:true});
const out = new URL('../../data/library-lock-qa/',import.meta.url);
await mkdir(out,{recursive:true});
const evidence=[];
const errors=[];
const page=await browser.newPage({viewport:{width:440,height:956},isMobile:true,hasTouch:true,deviceScaleFactor:3});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1' ? route.continue() : route.abort());
await page.goto('http://127.0.0.1:5217/tests/manual/library-lock-fixture.html');
await page.waitForFunction(()=>window.lockFixture);
const views=page.getByRole('navigation',{name:'Fixture views'});
const view=async name=>{await views.getByRole('button',{name,exact:true}).click();await page.waitForTimeout(200);};
const lock=()=>page.getByRole('button',{name:'Lock local privacy screen',exact:true}).click();
const unlock=()=>page.getByRole('button',{name:'Unlock local privacy screen',exact:true}).click();
const absent=async()=>{
 const text=await page.locator('body').evaluate(el=>el.textContent + [...el.querySelectorAll('[aria-label],[title],img')].map(node=>[node.getAttribute('aria-label'),node.getAttribute('title'),node.getAttribute('alt')].join(' ')).join(' '));
 for(const privateText of ['Fixture Private Shelf','Fixture Private Source','Private collection label','Fixture Hidden Source']) assert.ok(!text.includes(privateText),`leaked ${privateText}`);
};
const cdp=await page.context().newCDPSession(page);
async function geometry(name,w,h,insets){
 await page.setViewportSize({width:w,height:h});
 await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
 await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
 await page.waitForTimeout(450);
 const result=await page.evaluate(()=>({url:location.href,width:innerWidth,height:innerHeight,coarse:matchMedia('(pointer: coarse)').matches,dpr:devicePixelRatio,safe:Object.fromEntries(['t','r','b','l'].map(k=>[k,getComputedStyle(document.documentElement).getPropertyValue('--safe-'+k).trim()])),bodyPadding:{top:getComputedStyle(document.body).paddingTop,right:getComputedStyle(document.body).paddingRight,bottom:getComputedStyle(document.body).paddingBottom,left:getComputedStyle(document.body).paddingLeft},bodyTop:document.body.getBoundingClientRect().top,navTop:document.querySelector('nav').getBoundingClientRect().top,scroll:document.documentElement.scrollWidth,controls:[...document.querySelector('[aria-label="Library visibility"]').querySelectorAll('button')].map(el=>({label:el.getAttribute('aria-label'),height:el.getBoundingClientRect().height,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,color:getComputedStyle(el).color}))}));
 assert.equal(result.width,w);assert.equal(result.height,h);assert.equal(result.coarse,true);assert.equal(result.dpr,3);
 assert.equal(result.scroll,w);assert.equal(result.navTop,insets.top);
 for(const [key,value] of Object.entries({t:insets.top,r:insets.right,b:insets.bottom,l:insets.left})) assert.equal(result.safe[key],`${value}px`);
 for(const [key,value] of Object.entries(insets)) assert.equal(result.bodyPadding[key],`${value}px`);
 for(const button of result.controls){
   if(button.label.startsWith('Hidden categories:')) assert.equal(button.color,'rgb(229, 72, 77)');
   if(button.label.startsWith('Pinned:')) assert.equal(button.color,'rgb(0, 120, 224)');
   assert.ok(button.height>=44);assert.ok(button.left>=insets.left && button.right<=w-insets.right);
 }
 evidence.push({name,...result});await page.screenshot({path:new URL(name+'.png',out).pathname,fullPage:false});
}
try {
 await geometry('iphone17-pro-max-portrait',440,956,{top:62,bottom:34,left:0,right:0});
 const eye=()=>page.getByRole('button',{name:/^Hidden categories:/});
 for(const label of ['Revealed','Only','Hidden']){await eye().click();assert.equal(await eye().getAttribute('aria-label'),`Hidden categories: ${label}`);}
 const pin=()=>page.getByRole('button',{name:/^Pinned:/});
 for(const label of ['Only','Hidden','Active']){await pin().click();assert.equal(await pin().getAttribute('aria-label'),`Pinned: ${label}`);}
 await eye().click();await page.waitForTimeout(150);
 assert.ok((await page.locator('body').innerText()).includes('Fixture Private Shelf'));
 await page.getByRole('button',{name:'Categories…',exact:true}).click();
 assert.ok((await page.locator('body').innerText()).includes('Private collection label'));
 // Lock through state while a sheet is open: same central transition, even when overlay owns focus.
 await page.evaluate(()=>window.lockFixture.privacy.lock());await page.waitForTimeout(150);await absent();
 assert.equal(await eye().count(),0);
 await page.evaluate(async()=>{const f=window.lockFixture;await f.categories.cycleHiddenView();await f.categories.setHidden('private',false);await f.sourceMarks.setHidden('mihon:src:99',false);f.categories.hiddenView='revealed';f.sourceMarks.hiddenView='revealed';});
 await absent();
 await unlock();assert.equal(await eye().getAttribute('aria-label'),'Hidden categories: Revealed');
 await page.getByRole('button',{name:'Fold visibility controls',exact:true}).click();await lock();await unlock();
 assert.equal(await eye().count(),0);await page.getByRole('button',{name:'Expand visibility controls',exact:true}).click();
 await lock();
 await geometry('iphone17-pro-max-portrait-locked',440,956,{top:62,bottom:34,left:0,right:0});
 for(const name of ['Library','History','Stats','Downloads','Browse','Source','Series']){
   await view(name);
   if(name==='Downloads'){await page.getByRole('tab',{name:/Finished/}).click();await page.waitForTimeout(100);}
   await absent();
   const text=await page.locator('body').innerText();
   if(['Library','History','Stats','Downloads'].includes(name)) assert.ok(text.includes('Fixture Public'),`${name} lost public records`);
   if(name==='Browse') assert.ok(text.includes('Fixture Public Source'));
   if(['Source','Series'].includes(name)) assert.ok(text.includes('Hidden by local screen privacy'));
   evidence.push({check:`${name} locked: private DOM absent, public content/privacy notice retained`,pass:true});
 }
 // Previously fetched search blocks and expanded private details disappear, not CSS-hidden.
 await unlock();await view('Search');
 await page.getByRole('searchbox',{name:'Search every selected source'}).fill('Fixture');
 await page.getByRole('button',{name:'Search',exact:true}).last().click();
 await page.waitForTimeout(200);
 assert.ok((await page.locator('body').innerText()).includes('Fixture Private Shelf'));
 await page.getByText('Fixture Private Shelf',{exact:true}).first().click();await page.waitForTimeout(100);
 await lock();await absent();
 assert.equal(await page.locator('img[alt="Fixture Private Shelf"]').count(),0);
 await unlock();
 await page.evaluate(()=>window.lockFixture.delay());
 await page.getByRole('button',{name:'Search',exact:true}).last().click();await page.waitForTimeout(100);await lock();
 await page.evaluate(()=>window.lockFixture.release());await page.getByRole('button',{name:'Search',exact:true}).last().waitFor();assert.equal(await page.getByRole('button',{name:'Search',exact:true}).last().isEnabled(),true);await absent();
 evidence.push({check:'Search fetched/expanded and late async responses filtered',pass:true});
 // Same ReaderGate that App mounts for direct #/read routes: direct-entry and live-lock transitions.
 await view('Reader');
 await page.getByText('This title is hidden while the privacy lock is on.',{exact:true}).waitFor();
 assert.equal(await page.locator('.reader').count(),0);
 await absent();
 await page.evaluate(()=>window.lockFixture.privacy.unlock());
 await page.locator('.reader img[src]').first().waitFor();
 await page.evaluate(()=>window.lockFixture.privacy.lock());
 await page.getByText('This title is hidden while the privacy lock is on.',{exact:true}).waitFor();
 assert.equal(await page.locator('.reader, .reader img, .reader .chrome').count(),0);
 await absent();
 await view('Public reader');
 await page.locator('.reader img[src]').first().waitFor();
 assert.equal(await page.locator('.reader-curtain').count(),0);
 evidence.push({check:'Direct private reader refused; unlocking mounts; locking unmounts images/controls; public reader retained while locked',pass:true});
 // Leave immersive Reader through the same route-state change the real App router makes.
 await page.evaluate(()=>{document.querySelector('nav[aria-label="Fixture views"] button').click();});
 await geometry('iphone17-pro-max-landscape' ,956,440,{top:0,bottom:21,left:62,right:62});
 await unlock();await geometry('iphone17-pro-max-landscape-open',956,440,{top:0,bottom:21,left:62,right:62});
 await geometry('compat-390',390,844,{top:47,bottom:34,left:0,right:0});
 await geometry('compat-320',320,640,{top:0,bottom:0,left:0,right:0});
 assert.deepEqual(errors,[]);
 await writeFile(new URL('evidence.json',out),JSON.stringify({kind:'Chromium browser emulation, not physical iOS 26 proof',evidence,errors},null,2));
 console.log(JSON.stringify({pass:true,evidence,errors,artifacts:out.pathname},null,2));
}finally{await browser.close();}
