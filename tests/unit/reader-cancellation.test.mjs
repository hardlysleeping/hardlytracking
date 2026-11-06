import test from 'node:test';
import assert from 'node:assert/strict';
import {activity, withDeadline} from '../../src/lib/deadline.ts';

test('abandoning a reader wait removes its activity immediately, not the next book activity', async()=>{
 const baseline=activity.count;
 const old=new AbortController(); let finish;
 const result=withDeadline(new Promise(r=>finish=r),5000,'old book',old.signal);
 const rejected=assert.rejects(result,{name:'AbortError'});
 const next=new AbortController();
 const nextResult=withDeadline(new Promise(()=>{}),5000,'new book',next.signal);
 const nextRejected=assert.rejects(nextResult,{name:'AbortError'});
 old.abort();
 assert.equal(activity.count,baseline+1);
 assert.equal(activity.slowest().label,'new book');
 finish('late old answer'); await rejected;
 assert.equal(activity.count,baseline+1);
 next.abort(); await nextRejected;
 assert.equal(activity.count,baseline);
});
test('already abandoned wait never registers activity and consumes late rejection',async()=>{
 const baseline=activity.count; const controller=new AbortController();controller.abort();
 await assert.rejects(withDeadline(Promise.reject(new Error('late')),5000,'obsolete',controller.signal),{name:'AbortError'});
 assert.equal(activity.count,baseline);
});
