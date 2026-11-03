const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({headless:true,args:['--no-sandbox']});
const page = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
page.on('pageerror', e=>console.error('PAGE ERROR',e));
await page.goto('http://127.0.0.1:5217/tests/manual/reader-fixture.html');
await page.waitForTimeout(4000);
console.log('BASE',await page.evaluate(()=>({events:readerFixture.events,scroll:document.querySelector('.scroller').scrollTop,hit:document.elementFromPoint(195,400).outerHTML})));
for(const fit of ['width','height','contain']){
 await page.evaluate(fit=>readerFixture.settings.readerFit=fit,fit);
 await page.waitForTimeout(50);
 console.log(fit, await page.locator('img').first().boundingBox());
}
const cdp=await page.context().newCDPSession(page);
await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:650}]});
for(let y=620;y>=260;y-=30){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:195,y}]});await page.waitForTimeout(20);}
await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await page.waitForTimeout(300);
console.log('AFTER DRAG',await page.evaluate(()=>({scroll:document.querySelector('.scroller').scrollTop,hidden:document.querySelector('.reader').classList.contains('hide')})));
await browser.close();
