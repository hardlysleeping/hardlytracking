import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DEFAULT_READ_AHEAD, READ_AHEAD_CHOICES, readAheadOf } from '../../src/lib/reader-ahead.ts';
import { ReaderQueue, readerOrder } from '../../src/lib/reader.ts';
import { DEFAULT_BOTTOM_NAV, DEFAULT_LIBRARY_TABS, DESTINATION_IDS, LIBRARY_SECTION_IDS, normaliseOrder } from '../../src/lib/nav-order.ts';

test('ahead choices are finite, default three; malformed preferences cannot expand the queue',()=>{
 assert.deepEqual(READ_AHEAD_CHOICES,[0,2,3,5,10]);
 assert.equal(DEFAULT_READ_AHEAD,3);
 for(const value of [null,undefined,'10',-1,1,100000,NaN,Infinity,{},2.5]) assert.equal(readAheadOf(value),3);
 for(const n of READ_AHEAD_CHOICES) assert.equal(readAheadOf(n),n);
});

test('each ahead budget starts with the current page then forwards before bounded backfill',()=>{
 for(const n of READ_AHEAD_CHOICES){
  const order=readerOrder(5,100,n,n===0?0:1);
  assert.deepEqual(order,[5,...Array.from({length:n},(_,i)=>6+i),...(n===0?[]:[4])]);
  assert.ok(order.every(i=>i>=0&&i<100));
 }
 assert.deepEqual(readerOrder(99,100,10,1),[99,98]);
});

test('lowering ahead to None drops all queued neighbours, even with an old non-abortable page settling',async()=>{
 const queue=new ReaderQueue(), log=[];let finish;
 const jobs=Array.from({length:12},(_,i)=>({run:async()=>{
  log.push(i);if(i===1)await new Promise(r=>finish=r);
 }}));
 queue.set(readerOrder(0,12,10,1).map(i=>jobs[i]));
 await new Promise(r=>setImmediate(r));
 assert.deepEqual(log,[0,1]);
 queue.set(readerOrder(0,12,0,0).map(i=>jobs[i]));
 finish();await new Promise(r=>setImmediate(r));
 assert.deepEqual(log,[0,1],'no later neighbours may start after the preference shrinks');
});

// Execute the actual Settings load/set implementation with a rune shim and in-memory prefs.
// No browser storage, library data, or network is used.
function freshSettings(){
 const raw=readFileSync(new URL('../../src/state/settings.svelte.ts',import.meta.url),'utf8');
 const stripped=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const state=Object.assign(value=>value,{snapshot:value=>structuredClone(value)});
 const ctx={exports:{},$state:state,structuredClone,require:(id)=>{
  if(id.includes('reader-ahead'))return{DEFAULT_READ_AHEAD,readAheadOf};
  if(id.includes('library/filter'))return{EMPTY_FILTER:{statuses:[],sources:[]}};
  if(id.includes('library/sort'))return{sortSpecOfLegacy:()=>({key:'title'})};
  if(id.includes('library/badges'))return{DEFAULT_BADGES:{}};
  if(id.includes('performance'))return{DEFAULT_CPU_LEVEL:'balanced'};
  if(id.includes('content/levels'))return{levelOr:value=>value};
  if(id.includes('browse-display'))return{browseMode:value=>value,columnsFor:value=>value};
  // Settings also normalises the autoscroll choices; the real validators are cheap and pure.
  if(id.includes('lib/autoscroll'))return{autoscrollCurveOf:value=>value,autoscrollSpeedOf:value=>value,DEFAULT_AUTOSCROLL_CURVE:'linear',DEFAULT_AUTOSCROLL_SPEED:'steady'};
  if(id.includes('offline/policy'))return{keepCategoriesOf:value=>Array.isArray(value)?value.filter(v=>typeof v==='string'):[]};
  // The screen-curtain PIN is read defensively; nothing is stored in this fixture.
  if(id.includes('lib/pin'))return{pinRecordOf:value=>typeof value==='string'?value:''};
  if(id.includes('view-options'))return{isNavCorner:value=>['bottom-right','bottom-left','top-left','top-right'].includes(value)};
  if(id.includes('library/continue'))return{DEFAULT_CONTINUE_COLLAPSED:false,continueCollapsedOf:value=>value===true};
  // The nav order validators are pure and dependency-free, so the real ones run here.
  if(id.includes('lib/nav-order'))return{DEFAULT_BOTTOM_NAV,DEFAULT_LIBRARY_TABS,DESTINATION_IDS,LIBRARY_SECTION_IDS,normaliseOrder};
  throw new Error(`Unexpected dependency ${id}`);
 }};
 vm.runInNewContext(stripped,ctx);
 return ctx.exports.settings;
}
test('Settings stores the selected budget and restores it through load, including None',async()=>{
 const prefs=new Map(),store={getPref:async k=>prefs.get(k),setPref:async(k,v)=>prefs.set(k,v)};
 for(const n of READ_AHEAD_CHOICES){
  const first=freshSettings();await first.load(store);first.set('readerAhead',n);
  assert.equal(first.readerAhead,n);assert.equal(prefs.get('settings.readerAhead'),n);
  const restored=freshSettings();await restored.load(store);assert.equal(restored.readerAhead,n);
 }
 prefs.set('settings.readerAhead',10000);
 const malformed=freshSettings();await malformed.load(store);assert.equal(malformed.readerAhead,3);
 malformed.set('readerAhead','bad');assert.equal(malformed.readerAhead,3);assert.equal(prefs.get('settings.readerAhead'),3);
});

// The floating Back/Forward corner is a default plus a closed choice: bottom right unless the reader
// picks another one, and a stored value nothing recognises is the default rather than no position.
test('the back/forward corner defaults to bottom right and refuses an unknown value',async()=>{
 const prefs=new Map(),store={getPref:async k=>prefs.get(k),setPref:async(k,v)=>prefs.set(k,v)};
 const first=freshSettings();await first.load(store);
 assert.equal(first.historyNavCorner,'bottom-right');
 first.set('historyNavCorner','top-left');
 assert.equal(first.historyNavCorner,'top-left');
 assert.equal(prefs.get('settings.historyNavCorner'),'top-left');
 const restored=freshSettings();await restored.load(store);
 assert.equal(restored.historyNavCorner,'top-left');
 prefs.set('settings.historyNavCorner','diagonal');
 const malformed=freshSettings();await malformed.load(store);
 assert.equal(malformed.historyNavCorner,'bottom-right');
 malformed.set('historyNavCorner','sideways');
 assert.equal(malformed.historyNavCorner,'bottom-right');
});
