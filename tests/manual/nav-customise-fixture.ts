// Synthetic records in memoryDatabase only. Never call library.open(), never touch a real library.
// The prefs are stored *before* `settings.load` so the fixture also exercises the real coercion.
import { mount } from 'svelte';
import Fixture from './NavCustomiseFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key,value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key,value);
import { memoryDatabase } from '../../src/lib/db/open';
import { LibraryStore } from '../../src/lib/db/store';
import { downloads } from '../../src/state/downloads.svelte';
import { library } from '../../src/state/library.svelte';
import { categories } from '../../src/state/categories.svelte';
import { sourceMarks } from '../../src/state/source-marks.svelte';
import { settings } from '../../src/state/settings.svelte';
import { viewport } from '../../src/lib/layout.svelte';
import type { Series, Chapter, Source } from '../../src/api/source';
const store = new LibraryStore(memoryDatabase());
const rows: Series[] = [
 {id:'local:a',provider:'local',title:'Fixture Alpha',categoryIds:['reading']},
 {id:'local:b',provider:'local',title:'Fixture Beta',categoryIds:[]},
 {id:'mihon:1',provider:'mihon',title:'Fixture Gamma',categoryIds:['reading']},
];
const sources: Source[] = [{id:'local:src:library',provider:'local',name:'Fixture Local Source'}, {id:'mihon:src:99',provider:'mihon',name:'Fixture Remote Source'}];
await store.putCategory({id:'reading',name:'Reading',order:0,hidden:false,pinned:false,tabPinned:true});
const chapters: Chapter[] = rows.map(row=>({id:`${row.id}:ch`,seriesId:row.id,name:`${row.title} issue`,number:1,pageCount:10,read:false}));
for(const row of rows) {
 await store.addSeries(row);
 await store.putChapters(row.id,chapters.filter(c=>c.seriesId===row.id));
 await store.setPosition(row.id,`${row.id}:ch`,2);
 await store.recordHistory(row.id,`${row.id}:ch`);
 await store.setProgress(`${row.id}:ch`,2,10);
}
// A stored order that is not the shipped one, so a bar in this order proves the pref is what draws.
// `libraryTabs` is reversed too, and the bottom bar deliberately leaves out nothing.
await store.setPref('settings.bottomNav', ['more','history','search','browse','library']);
await store.setPref('settings.libraryTabs', ['updates','titles']);
const provider = (kind:'local'|'mihon') => ({kind,name:'Fixture provider',ownsProgress:true,
 search:async()=>({items:rows.filter(r=>r.provider===kind),hasNext:false}),
 details:async(id:string)=>rows.find(r=>r.id===id)!,
 chapters:async(id:string)=>chapters.filter(c=>c.seriesId===id),
});
library.profile = {store,providers:[provider('local'),provider('mihon')],warnings:[]} as any;
library.library = rows;
library.sources = sources;
library.ready = true;
downloads.load = async()=>{};
downloads.knownTotals = async()=>({});
downloads.rows = [];
library.chapters = async(id)=>chapters.filter(c=>c.seriesId===id);
library.pages = async()=>[{index:0,url:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="440" height="880"><rect width="100%" height="100%" fill="teal"/></svg>')}];
library.ownsProgress = ()=>true;
library.remember = async()=>{};
library.beginSession = async()=>null;
library.endSession = async()=>{};
library.continueReading = async()=>rows.map(row=>({seriesId:row.id,chapterId:`${row.id}:ch`,page:2,title:row.title,chapterName:'Fixture issue'}));
library.viewState = async()=>undefined;
library.saveViewState = async()=>{};
settings.contentLevel = 'all' as any;
settings.adultDeclared = true;
await categories.load(store);
await sourceMarks.load(store);
// The real loader, so the stored order is coerced exactly as a launch coerces it.
await settings.load(store);
viewport.start();
(window as any).navFixture = {settings,store,library,rows,sources};
mount(Fixture,{target:document.body});
