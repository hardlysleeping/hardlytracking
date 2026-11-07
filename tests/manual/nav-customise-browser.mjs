// Run against this worktree's Vite (default :5231). Synthetic memory DB only, never a real library.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/nav-customise-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const PORT = process.env.NAV_PORT ?? '5231';
const HOST = process.env.NAV_HOST ?? 'localhost';
const browser = await chromium.launch({headless:true});
const out = new URL('../../data/nav-customise-qa/',import.meta.url);
await mkdir(out,{recursive:true});
const evidence=[];
const errors=[];
const page=await browser.newPage({viewport:{width:440,height:956},isMobile:true,hasTouch:true,deviceScaleFactor:3});
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{ if(m.type()==='error') errors.push('console: '+m.text()); });
await page.route('**/*',route=>new URL(route.request().url()).hostname===HOST ? route.continue() : route.abort());
await page.goto(`http://${HOST}:${PORT}/tests/manual/nav-customise.html`);
await page.waitForFunction(()=>window.navFixture);
await page.waitForTimeout(400);

const cdp=await page.context().newCDPSession(page);
await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:62,bottom:34,left:0,right:0}});
await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
await page.waitForTimeout(300);

const prefs=async()=>page.evaluate(()=>({bottomNav:[...window.navFixture.settings.bottomNav],libraryTabs:[...window.navFixture.settings.libraryTabs]}));
const barLabels=()=>page.locator('nav.bar button').evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-label')));
const tabs=()=>page.locator('.library-tabs button').evaluateAll(ns=>ns.map(n=>n.textContent.trim()));
const title=()=>page.locator('main .pagemenu .title').first();
const menuItems=()=>page.locator('[role="menuitem"]').evaluateAll(ns=>ns.map(n=>({name:n.innerText.trim(),current:n.getAttribute('aria-current'),height:n.getBoundingClientRect().height})));
const route=async hash=>{await page.evaluate(h=>{location.hash=h;},hash);await page.waitForTimeout(350);};
const shot=async name=>page.screenshot({path:new URL(name+'.png',out).pathname,fullPage:false});
const noOverflow=async()=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no sideways overflow');

try {
  // ---- (a) the bar draws the pref, in the pref's order, and nothing else changed ---------------
  let state=await prefs();
  assert.deepEqual(state.bottomNav,['more','history','search','browse','library'],'the stored order was loaded as stored');
  assert.deepEqual(await barLabels(),['More','History','Search','Browse','Library'],'the bar is the pref order');
  const bar=await page.locator('nav.bar button').evaluateAll(ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {label:n.getAttribute('aria-label'),text:n.innerText.trim(),height:r.height,width:r.width,current:n.getAttribute('aria-current'),color:getComputedStyle(n).color};}));
  assert.equal(bar.length,5);
  for(const item of bar){assert.equal(item.text,'','the bar stays icon-only');assert.ok(item.height>=44,`${item.label} keeps its tap target`);}
  assert.equal(bar.find(item=>item.label==='Library').current,'page','active state still comes from destinationOf');
  const type=await title().evaluate(n=>({text:n.innerText.trim(),size:getComputedStyle(n).fontSize,weight:getComputedStyle(n).fontWeight,height:n.getBoundingClientRect().height}));
  const token2xl=await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--t-2xl').trim());
  assert.equal(type.text,'Library');
  assert.equal(type.size,token2xl,'the title is the h1 size token');
  assert.equal(type.weight,'650');
  assert.ok(type.height>=44,'the title is a 44 px tap target');
  await noOverflow();
  evidence.push({check:'(a) bottom bar = pref order, icon-only, 48 px targets, title keeps h1 type',bar,type,token2xl});
  await shot('a-bar-order');

  // ---- (f) the title menu lists every destination and navigates --------------------------------
  await title().click();
  await page.waitForTimeout(200);
  assert.equal(await page.locator('[role="menu"]').count(),1);
  const items=await menuItems();
  assert.deepEqual(items.map(item=>item.name),['Library','Browse','Search','History','More'],'every destination, in DESTINATIONS order');
  assert.equal(items.find(item=>item.name==='Library').current,'page');
  assert.ok(items.every(item=>item.height>=44),'44 px rows');
  const box=await page.locator('[role="menu"]').evaluate(n=>{const r=n.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};});
  assert.ok(box.top>=62,`the menu opens below the notch (top ${box.top})`);
  assert.ok(box.bottom<=956 && box.left>=0 && box.right<=440,'the menu stays on screen');
  await shot('f-menu-open');
  await page.getByRole('menuitem',{name:'Search',exact:true}).click();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>location.hash),'#/search','the row navigates with go()');
  assert.equal(await page.locator('[role="menu"]').count(),0,'a route change closes it');
  assert.equal((await title().innerText()).trim(),'Search');
  // Escape closes and hands the focus back to the title button.
  await title().click();
  await page.waitForTimeout(150);
  assert.equal((await menuItems()).find(item=>item.name==='Search').current,'page','the page you are on is marked');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[role="menu"]').count(),0,'Escape closes');
  assert.ok(await page.evaluate(()=>document.activeElement?.classList.contains('title')===true),'focus returns to the title');
  // An outside tap closes; nothing is trapped.
  await title().click();
  await page.waitForTimeout(150);
  await page.mouse.click(410,700);
  await page.waitForTimeout(150);
  assert.equal(await page.locator('[role="menu"]').count(),0,'an outside tap closes');
  // Every destination page carries the same menu, and each one marks itself as the current page.
  const visited=[];
  for(const name of ['Browse','History','More','Library']){
    await title().click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitem',{name,exact:true}).click();
    await page.waitForTimeout(350);
    assert.equal((await title().innerText()).trim(),name,`${name} draws its own title`);
    await title().click();
    await page.waitForTimeout(150);
    assert.equal((await menuItems()).find(item=>item.name===name).current,'page',`${name} marks itself current`);
    await page.keyboard.press('Escape');
    visited.push(name);
  }
  evidence.push({check:'(f) title menu: every destination page, aria-current, 44 px rows, safe-area top, navigates, Escape/outside close',items,box,visited});
  await shot('f-search-after-nav');

  // ---- (e) the Library sections follow the pref, and the arrows change it ----------------------
  await route('#/updates');
  assert.equal((await title().innerText()).trim(),'Library','the Updates tab draws the Library title menu');
  assert.equal(await title().evaluate(n=>getComputedStyle(n).fontSize),token2xl,'and the same heading type');
  // The stored order predates the Downloads section, so it is appended rather than hidden: a tab
  // added by a newer build must not be invisible to anyone who ever reordered.
  assert.deepEqual(await tabs(),['Updates','Titles','Downloads'],'the stored tab order is drawn');
  await page.getByRole('button',{name:'Titles',exact:true}).click();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>location.hash),'#/library','a reordered tab still goes to its own route');
  await route('#/settings');
  await page.getByRole('button',{name:'Move Titles up',exact:true}).click();
  await page.waitForTimeout(200);
  assert.deepEqual((await prefs()).libraryTabs,['titles','updates','downloads'],'the arrow writes the new order');
  await route('#/library');
  assert.deepEqual(await tabs(),['Titles','Updates','Downloads'],'and the Library draws it');
  evidence.push({check:'(e) Library section tabs follow settings.libraryTabs and reorder with the arrows',tabs:await tabs()});
  await shot('e-library-tabs');

  // ---- (b) hiding a destination removes it from the bar, not from the app ----------------------
  await route('#/settings');
  const barEditor=page.locator('.navedit').first();
  assert.deepEqual(await barEditor.locator('.navlabel').evaluateAll(ns=>ns.map(n=>n.textContent.trim())),['More','History','Search','Browse','Library'],'every destination is listed, bar order first');
  await page.getByRole('button',{name:'Hide Browse in the navigation',exact:true}).click();
  await page.waitForTimeout(200);
  assert.deepEqual((await prefs()).bottomNav,['more','history','search','library']);
  await route('#/library');
  assert.deepEqual(await barLabels(),['More','History','Search','Library'],'Browse is off the bar');
  await title().click();
  await page.waitForTimeout(150);
  assert.deepEqual((await menuItems()).map(item=>item.name),['Library','Browse','Search','History','More'],'the title menu still lists the hidden page');
  await page.getByRole('menuitem',{name:'Browse',exact:true}).click();
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>location.hash),'#/browse','and navigating there works');
  assert.equal((await title().innerText()).trim(),'Browse');
  const activeWithBrowse=await page.locator('nav.bar button').evaluateAll(ns=>ns.map(n=>n.getAttribute('aria-current')));
  assert.ok(!activeWithBrowse.includes('page'),'no bar button claims to be the current page when it is not on the bar');
  evidence.push({check:'(b) hidden destination leaves the bar, stays in the title menu, and its page still opens',bar:await barLabels(),hash:await page.evaluate(()=>location.hash)});
  await shot('b-browse-off-bar');

  // ---- (d) reordering the bar changes the bar ------------------------------------------------
  await route('#/settings');
  await page.getByRole('button',{name:'Move Library up',exact:true}).click();
  await page.getByRole('button',{name:'Move Library up',exact:true}).click();
  await page.waitForTimeout(200);
  assert.deepEqual((await prefs()).bottomNav,['more','library','history','search']);
  assert.deepEqual(await barEditor.locator('.navrow .navlabel').evaluateAll(ns=>ns.map(n=>n.textContent.trim())),['More','Library','History','Search','Browse'],'the editor lists the bar in its new order');
  await route('#/library');
  assert.deepEqual(await barLabels(),['More','Library','History','Search'],'the bar draws the new order');
  evidence.push({check:'(d) arrow reordering changes the bar order',bar:await barLabels()});
  await shot('d-bar-reordered');

  // ---- (c) the last visible destination cannot be hidden -------------------------------------
  await route('#/settings');
  for(const name of ['More','History','Search']){
    await page.getByRole('button',{name:`Hide ${name} in the navigation`,exact:true}).click();
    await page.waitForTimeout(120);
  }
  assert.deepEqual((await prefs()).bottomNav,['library'],'one destination remains');
  await page.getByRole('button',{name:'Hide Library in the navigation',exact:true}).click();
  await page.waitForTimeout(200);
  assert.deepEqual((await prefs()).bottomNav,['library'],'the last one is refused, not written');
  const note=page.getByRole('status').filter({hasText:'Keep at least one page in the bar.'});
  assert.equal(await note.count(),1,'the refusal says why');
  assert.equal(await page.getByRole('button',{name:'Hide Library in the navigation',exact:true}).getAttribute('aria-pressed'),'true');
  await shot('c-refusal-note');
  await noOverflow();
  await route('#/library');
  assert.deepEqual(await barLabels(),['Library'],'never an empty bar');
  await title().click();
  await page.waitForTimeout(150);
  assert.equal((await menuItems()).length,5,'with one button left, every page is still reachable');
  await page.getByRole('menuitem',{name:'History',exact:true}).click();
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>location.hash),'#/history');
  evidence.push({check:'(c) hiding the last visible destination is refused with an inline reason; bar keeps one item; menu still reaches everything',bar:await barLabels()});
  await shot('c-last-refused');

  await noOverflow();
  assert.deepEqual(errors,[]);
  await writeFile(new URL('evidence.json',out),JSON.stringify({kind:'Chromium browser emulation at 440x956 with iPhone safe-area insets, not physical iOS proof',evidence,errors},null,2));
  console.log(JSON.stringify({pass:true,evidence,errors,artifacts:out.pathname},null,2));
}finally{await browser.close();}
