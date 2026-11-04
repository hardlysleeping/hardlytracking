// Isolated, generated images only. No profile open, real library, or downloads.
import { mount, unmount } from 'svelte';
import '../../src/app.css';
import ReaderFixture from './ReaderFixture.svelte';
import { library } from '../../src/state/library.svelte';
import { downloads } from '../../src/state/downloads.svelte';
import { settings } from '../../src/state/settings.svelte';
const args = new URLSearchParams(location.search);
const events: {kind: string; page: number; at: number; chapter?:string}[] = [];
const log = (kind: string, page: number, chapter?:string) => events.push({kind, page, at: Math.round(performance.now()),chapter});
const wide = args.has('wide');
const [w,h] = wide ? [1600,800] : [800,1600];
const makePages = (chapter:string) => Array.from({length:12}, (_,index) => ({index,url:`fixture:${chapter}:${location.search}:${index}`,open:async()=>{
  log('start',index,chapter);
  await new Promise(resolve=>setTimeout(resolve,index===Number(args.get('resume')??0)?100:600));
  log('resolved',index,chapter);
  if (Number(args.get('fail')??-1) === index) throw new Error(`Fixture page ${index+1} failed`);
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${index%2?'#458':'#845'}"/><text x="20" y="80" font-size="60" fill="white">Fixture ${index+1}</text></svg>`],{type:'image/svg+xml'});
}})).map(page => args.has('plain') ? {index:page.index,url:`${location.origin}/fixture-page/${page.index}.svg`} : page);
// Intentionally in-memory stubs; never call LibraryState.open().
library.profile = {store:{getProgress:async()=>({page:Number(args.get('resume')??0)}),isRead:async()=>false,getChapter:async()=>undefined}} as any;
library.pages = async(id)=>{await new Promise(r=>setTimeout(r,Number(args.get('pageListDelay')??0)));return makePages(id);};
library.chapters = async()=>{await new Promise(r=>setTimeout(r,Number(args.get('metadataDelay')??0)));return [];};
library.ownsProgress = ()=>true;
library.remember = async()=>{};
// Session lifecycle is recorded, not written: the cutoff the Reader passes is the thing under test.
const sessions: {kind:string; id:string|null; page:number; completed?:boolean; at:number|undefined; now:number}[] = [];
library.beginSession = async()=>{const id='fixture:session';sessions.push({kind:'begin',id,page:-1,at:undefined,now:Date.now()});return id;};
library.endSession = async(id,page,completed,at)=>{sessions.push({kind:'end',id,page,completed,at,now:Date.now()});};
downloads.local = async()=>args.has('partial') ? {
 chapterId:'fixture:chapter',total:12,
 urls:Array.from({length:12},(_,i)=>i===0?`data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="green"/></svg>`)}`:null),
} as any : null;
settings.readerMode = (args.get('mode')??'vertical') as any;
settings.readerFit = (args.get('fit')??'width') as any;
settings.pageGap = 12;
if (args.has('ahead')) settings.readerAhead = Number(args.get('ahead')) as any;
settings.tapZones = true;
settings.set = ((key: string,value: unknown)=>{(settings as any)[key]=value;}) as any;
(window as any).readerFixture = {events,sessions,settings};
const fixture = mount(ReaderFixture,{target:document.body});
(window as any).readerFixture.changeChapter = fixture.changeChapter;
// A teardown the test can trigger: the reader's own cleanup must close the session at the cutoff.
(window as any).readerFixture.teardown = ()=>{ void unmount(fixture); };
new MutationObserver(()=>{
 for(const img of document.querySelectorAll('img')) if(!img.dataset.observed){
  img.dataset.observed='true';img.addEventListener('load',()=>{
   const index=Number(img.closest('[data-page]')?.getAttribute('data-page'));
   log('loaded',index);
   requestAnimationFrame(()=>requestAnimationFrame(()=>log('painted',index)));
  });
 }
}).observe(document.body,{subtree:true,childList:true});
