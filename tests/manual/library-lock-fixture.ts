// All records are synthetic and live only in memoryDatabase. Never call library.open().
import { mount } from 'svelte';
import Fixture from './LibraryLockFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key,value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key,value);
import { memoryDatabase } from '../../src/lib/db/open';
import { LibraryStore } from '../../src/lib/db/store';
import { downloads } from '../../src/state/downloads.svelte';
import { library } from '../../src/state/library.svelte';
import { categories } from '../../src/state/categories.svelte';
import { sourceMarks } from '../../src/state/source-marks.svelte';
import { privacy } from '../../src/state/privacy.svelte';
import { settings } from '../../src/state/settings.svelte';
import type { Series, Chapter, Source } from '../../src/api/source';
const store = new LibraryStore(memoryDatabase());
const rows: Series[] = [
 {id:'local:public',provider:'local',title:'Fixture Public',categoryIds:['public']},
 {id:'local:private',provider:'local',title:'Fixture Private Shelf',categoryIds:['private']},
 {id:'mihon:1',provider:'mihon',title:'Fixture Private Source',categoryIds:[]},
 {id:'local:mixed',provider:'local',title:'Fixture Mixed',categoryIds:['public','private']},
];
const sources: Source[] = [{id:'local:src:library',provider:'local',name:'Fixture Public Source'}, {id:'mihon:src:99',provider:'mihon',name:'Fixture Hidden Source'}];
await store.putCategory({id:'public',name:'Public collection',order:0,hidden:false,pinned:false,tabPinned:true});
await store.putCategory({id:'private',name:'Private collection label',order:1,hidden:true,pinned:true,tabPinned:true});
await store.putSourceMark({id:'mihon:src:99',hidden:true,pinned:false});
const chapters: Chapter[] = rows.map(row=>({id:`${row.id}:ch`,seriesId:row.id,name:`${row.title} issue`,number:1,pageCount:10,read:false}));
for(const row of rows) {
 await store.addSeries(row);
 await store.putChapters(row.id,chapters.filter(c=>c.seriesId===row.id));
 await store.setPosition(row.id,`${row.id}:ch`,2);
 await store.recordHistory(row.id,`${row.id}:ch`);
 await store.setProgress(`${row.id}:ch`,2,10);
}
await store.putMapping({seriesId:'mihon:1',provider:'mihon',sourceId:'99',at:1});
let releases: (()=>void)[] = [];
let delayed = false;
const provider = (kind:'local'|'mihon') => ({kind,name:'Fixture provider',ownsProgress:true,
 search:async()=>{if(delayed) await new Promise<void>(r=>releases.push(r));return {items:rows.filter(r=>r.provider===kind),hasNext:false};},
 details:async(id:string)=>rows.find(r=>r.id===id)!,
 chapters:async(id:string)=>chapters.filter(c=>c.seriesId===id),
});
library.profile = {store,providers:[provider('local'),provider('mihon')],warnings:[]} as any;
library.library = rows;
library.sources = sources;
library.ready = true;
downloads.load = async()=>{};
downloads.knownTotals = async()=>({});
downloads.rows = rows.map(row=>({chapterId:`${row.id}:ch`,seriesId:row.id,chapterName:`${row.title} issue`,pages:10,total:10,bytes:100,at:1,state:'done'}));
library.chapters = async(id)=>chapters.filter(c=>c.seriesId===id);
library.pages = async()=>[{index:0,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="440" height="880"><rect width="100%" height="100%" fill="teal"/></svg>')}];
library.ownsProgress = ()=>true;
library.remember = async()=>{};
library.beginSession = async()=>null;
library.endSession = async()=>{};
downloads.local = async()=>null;
library.continueReading = async()=>rows.map(row=>({seriesId:row.id,chapterId:`${row.id}:ch`,page:2,title:row.title,chapterName:'Fixture issue'}));
library.viewState = async()=>undefined;
library.saveViewState = async()=>{};
settings.set = ((key:string,value:unknown)=>{(settings as any)[key]=value;}) as any;
settings.contentLevel = 'all' as any;
settings.adultDeclared = true;
settings.showContinue = true;
settings.pinnedSources = sources.map(s=>s.id);
await categories.load(store); await sourceMarks.load(store);
(window as any).lockFixture = {privacy,categories,sourceMarks,store,rows,delay:()=>{delayed=true;},release:()=>{for (const done of releases) done(); releases=[]; delayed=false;}};
mount(Fixture,{target:document.body});
