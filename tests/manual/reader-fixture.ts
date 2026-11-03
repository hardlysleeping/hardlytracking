// Isolated, generated images only. No profile open, real library, or downloads.
import { mount } from 'svelte';
import Reader from '../../src/views/Reader.svelte';
import { library } from '../../src/state/library.svelte';
import { downloads } from '../../src/state/downloads.svelte';
import { settings } from '../../src/state/settings.svelte';
const args = new URLSearchParams(location.search);
const events: {kind: string; page: number; at: number}[] = [];
const log = (kind: string, page: number) => events.push({kind, page, at: Math.round(performance.now())});
const wide = args.has('wide');
const [w,h] = wide ? [1600,800] : [800,1600];
const pages = Array.from({length:12}, (_,index) => ({index,url:`fixture:${location.search}:${index}`,open:async()=>{
  log('start',index);
  await new Promise(resolve=>setTimeout(resolve,index===Number(args.get('resume')??0)?100:600));
  log('resolved',index);
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${index%2?'#458':'#845'}"/><text x="20" y="80" font-size="60" fill="white">Fixture ${index+1}</text></svg>`],{type:'image/svg+xml'});
}}));
// Intentionally in-memory stubs; never call LibraryState.open().
library.profile = {store:{getProgress:async()=>({page:Number(args.get('resume')??0)}),isRead:async()=>false,getChapter:async()=>undefined}} as any;
library.pages = async()=>pages;
library.chapters = async()=>[];
library.ownsProgress = ()=>true;
library.remember = async()=>{};
library.beginSession = async()=>null as any;
library.endSession = async()=>{};
downloads.local = async()=>null;
settings.readerMode = (args.get('mode')??'vertical') as any;
settings.readerFit = (args.get('fit')??'width') as any;
settings.pageGap = 12;
settings.tapZones = true;
settings.set = ((key: string,value: unknown)=>{(settings as any)[key]=value;}) as any;
(window as any).readerFixture = {events,settings};
mount(Reader,{target:document.body,props:{seriesId:'fixture:series',chapterId:'fixture:chapter'}});
new MutationObserver(()=>{
 for(const img of document.querySelectorAll('img')) if(!img.dataset.observed){
  img.dataset.observed='true';img.addEventListener('load',()=>log('loaded',Number(img.closest('[data-page]')?.getAttribute('data-page'))));
 }
}).observe(document.body,{subtree:true,childList:true});
