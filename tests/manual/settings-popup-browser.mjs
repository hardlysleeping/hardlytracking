// Proves the gear popups: present on Library and History at 390x844 and 440x956, opens the same
// panel the Settings page renders, does not move the route, Escape closes and focus returns.
// Run against this worktree's Vite: PLAYWRIGHT_MODULE=... node tests/manual/settings-popup-browser.mjs
// Synthetic memory DB only, never a real library.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const PORT = process.env.POPUP_PORT ?? '5247';
const HOST = process.env.POPUP_HOST ?? 'localhost';
const browser = await chromium.launch({headless:true});
const out = new URL('../../data/settings-popup-qa/',import.meta.url);
await mkdir(out,{recursive:true});
const evidence=[];
const errors=[];

async function controls(page, rootSel) {
  // The signature is built inside the page: no eval, and the same words the reader sees.
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (root === null) return null;
    const signatureOf = (el) => {
      if (el.tagName === 'BUTTON') {
        if (el.classList.contains('orderbtn')) return 'button:order§' + el.getAttribute('aria-label');
        if (el.classList.contains('chip')) return 'button:chip§' + el.innerText.trim();
        const first = el.querySelector('span');
        return 'button:link§' + (first?.innerText.trim() ?? el.innerText.trim());
      }
      const host = el.closest('label') ?? el.closest('.row');
      const span = host?.querySelector('span');
      const label = (span?.innerText ?? '').split('\n')[0].trim();
      const options = el.tagName === 'SELECT' ? [...el.options].map(o => o.textContent.trim()).join('|') : '';
      return el.tagName.toLowerCase() + (el.type ? ':' + el.type : '') + '§' + label + '§' + options;
    };
    const list = [];
    for (const el of root.querySelectorAll('input, select, button')) list.push(signatureOf(el));
    return list.sort();
  }, rootSel);
}

function minus(big, small) {
  const left = [...big];
  for (const item of small) {
    const at = left.indexOf(item);
    assert.ok(at >= 0, `panel is missing a control Settings still has: ${item}`);
    left.splice(at, 1);
  }
  return left;
}

async function run(width, height) {
  const page = await browser.newPage({viewport:{width,height},isMobile:true,hasTouch:true,deviceScaleFactor:2});
  page.on('pageerror',e=>errors.push(`${width}x${height} pageerror: ${e.message}`));
  page.on('console',m=>{ if(m.type()==='error') errors.push(`${width}x${height} console: ${m.text()}`); });
  await page.route('**/*',route=>new URL(route.request().url()).hostname===HOST ? route.continue() : route.abort());
  await page.goto(`http://${HOST}:${PORT}/tests/manual/settings-popup.html`);
  await page.waitForFunction(()=>window.settingsPopup);
  await page.waitForTimeout(400);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:62,bottom:34,left:0,right:0}});
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(300);

  const routeOf = ()=>page.evaluate(()=>({pathname:location.pathname,hash:location.hash}));
  const shot = name=>page.screenshot({path:new URL(`${width}x${height}-${name}.png`,out).pathname,fullPage:false});
  const noOverflow = async where=>assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${where}: no sideways overflow`);

  const at = async hash => { await page.evaluate(h => { location.hash = h; }, hash); await page.waitForTimeout(450); };

  // ---- the Settings page is the source of truth for both control lists ------------------------
  await at('#/settings');
  const settingsLibrary = await controls(page,'[data-panel="library"]');
  const settingsHistory = await controls(page,'[data-panel="history"]');
  assert.ok(settingsLibrary !== null && settingsLibrary.length > 0, 'Settings still renders the Library panel');
  assert.ok(settingsHistory !== null && settingsHistory.length > 0, 'Settings still renders the History panel');
  // The view/columns row is drawn by `<BrowseDisplay />`, which the Library page draws inline.
  const browse = await controls(page,'[data-panel="library"] .display');
  assert.ok(browse.length > 0, 'the panel draws BrowseDisplay on the Settings page');

  // ---- Library: gear, popup, same controls ------------------------------------------------
  await at('#/library');
  await noOverflow('library');
  const libraryRoute = await routeOf();
  const gear = page.getByRole('button',{name:'Library settings',exact:true});
  assert.equal(await gear.count(),1,'one gear on the Library page');
  assert.equal(await gear.getAttribute('title'),'Library settings','the gear keeps a title');
  assert.equal(await gear.getAttribute('aria-haspopup'),'dialog','the gear says what it opens');
  const gearBox = await gear.evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};});
  assert.ok(gearBox.w>=36&&gearBox.h>=36,`gear is a real target (${gearBox.w}x${gearBox.h})`);
  assert.ok(gearBox.x>=0&&gearBox.right<=width&&gearBox.y>=0&&gearBox.bottom<=height,'the gear is inside the viewport');
  // Nothing is drawn over it: the hit test at its centre lands on the gear itself.
  assert.ok(await gear.evaluate(n=>{const r=n.getBoundingClientRect();const el=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return el===n||n.contains(el);}),'the gear is hit-testable');
  // Parity: the four icons the bar already had are all still there.
  for (const name of ['Search the library','Select series','Refresh','More library actions']) {
    assert.equal(await page.getByRole('button',{name,exact:true}).count(),1,`${name} still in the top bar`);
  }

  await gear.click();
  await page.waitForTimeout(250);
  const dialog = page.locator('[role="dialog"]');
  assert.equal(await dialog.count(),1,'the gear opens a real dialog, not a page');
  assert.equal(await dialog.getAttribute('aria-modal'),'true');
  assert.deepEqual(await routeOf(),libraryRoute,'opening the popup does not change the route');
  const popupLibrary = await controls(page,'[role="dialog"] [data-panel="library"]');
  assert.deepEqual(minus(settingsLibrary,browse),popupLibrary,'every Library control in Settings is in the popup (BrowseDisplay lives inline on the page)');
  await shot('library-popup');

  // A control inside the popup really writes: the popup is not a picture of the settings.
  const cont = page.locator('[role="dialog"]').getByLabel('Show “Continue reading”');
  const before = await page.evaluate(()=>window.settingsPopup.settings.showContinue);
  await cont.click();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.settingsPopup.settings.showContinue),!before,'the popup checkbox writes the setting');
  await cont.click();
  await page.waitForTimeout(150);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[role="dialog"]').count(),0,'Escape closes the popup');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Library settings','focus returns to the gear');
  assert.deepEqual(await routeOf(),libraryRoute,'closing does not change the route either');

  // The `⋯` sheet's "Library settings" expands here too — it used to send you to /settings.
  await page.getByRole('button',{name:'More library actions',exact:true}).click();
  await page.waitForTimeout(250);
  await page.locator('[role="dialog"]').getByRole('button',{name:'Library settings',exact:true}).click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[role="dialog"] [data-panel="library"]').count(),1,'the overflow entry opens the popup, not another page');
  assert.deepEqual(await routeOf(),libraryRoute,'the overflow entry does not move the route');
  assert.deepEqual(await controls(page,'[role="dialog"] [data-panel="library"]'),popupLibrary,'and it is the same panel');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // The inline view/columns row is still on the page, so those controls are not buried either.
  assert.ok((await controls(page,'.display')).length>0,'BrowseDisplay is still drawn inline above the shelf');

  // ---- History: gear, popup, same controls ------------------------------------------------
  await at('#/history');
  await noOverflow('history');
  const historyRoute = await routeOf();
  const hgear = page.getByRole('button',{name:'History settings',exact:true});
  assert.equal(await hgear.count(),1,'one gear on the History page');
  const hBox = await hgear.evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};});
  assert.ok(hBox.w>=36&&hBox.h>=36,`history gear is a real target (${hBox.w}x${hBox.h})`);
  assert.ok(hBox.x>=0&&hBox.right<=width&&hBox.y>=0&&hBox.bottom<=height,'the history gear is inside the viewport');
  await hgear.click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('[role="dialog"]').count(),1,'the history gear opens a dialog');
  assert.deepEqual(await routeOf(),historyRoute,'the history popup does not change the route');
  assert.deepEqual(await controls(page,'[role="dialog"] [data-panel="history"]'),settingsHistory,'every History control in Settings is in the popup');
  await shot('history-popup');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'History settings','focus returns to the history gear');

  // ---- both doors lead to the same component ----------------------------------------------
  evidence.push({
    viewport:`${width}x${height}`,
    library:{settingsLibrary,popupLibrary,browseInline:browse,controlsMatched:popupLibrary.length},
    history:{settingsHistory,controlsMatched:settingsHistory.length},
    libraryGear:gearBox,historyGear:hBox,
  });

  await page.close();
}

try {
  await run(390,844);
  await run(440,956);
  assert.deepEqual(errors,[],'no page errors or console errors');
  await writeFile(new URL('evidence.json',out),JSON.stringify({evidence,errors},null,2));
  for (const e of evidence) {
    console.log(`${e.viewport}: library popup ${e.library.controlsMatched} controls (+${e.library.browseInline.length} inline display controls), history popup ${e.history.controlsMatched} controls, gear ${Math.round(e.libraryGear.w)}px / ${Math.round(e.historyGear.w)}px`);
  }
  console.log('settings gear popups: PASS');
} catch (error) {
  await writeFile(new URL('evidence.json',out),JSON.stringify({evidence,errors,error:String(error?.stack??error)},null,2));
  console.error('FAIL', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
