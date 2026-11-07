// Synthetic records in memoryDatabase only. Never call library.open(), never touch a real library.
// Mounts the real Library, History and Settings pages so the gear popups can be proved against the
// same components the app ships.
import { mount } from 'svelte';
import Fixture from './SettingsPopupFixture.svelte';
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
 {id:'local:c',provider:'local',title:'Fixture Delta',categoryIds:[]},
 {id:'local:d',provider:'local',title:'Fixture Epsilon',categoryIds:['reading']},
 {id:'local:e',provider:'local',title:'Fixture Zeta',categoryIds:[]},
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
library.clearHistory = async()=>({sessions:0,history:0});
library.pruneSessions = async()=>0;
settings.contentLevel = 'all' as any;
settings.adultDeclared = true;
await categories.load(store);
await sourceMarks.load(store);
// The real loader, so stored defaults are coerced exactly as a launch coerces them.
await settings.load(store);
viewport.start();
(window as any).settingsPopup = {settings,store,library,rows,sources};
mount(Fixture,{target:document.body});
