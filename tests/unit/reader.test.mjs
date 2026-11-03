import test from 'node:test';
import assert from 'node:assert/strict';
import { ReaderQueue, ReaderTap, readerOrder } from '../../src/lib/reader.ts';
const settle = () => new Promise(resolve=>setImmediate(resolve));
test('reader order starts at resumed page, bounded forward then backfill',()=>{
 assert.deepEqual(readerOrder(4,100),[4,5,6,7,3]);
 assert.deepEqual(readerOrder(0,100),[0,1,2,3]);
 assert.deepEqual(readerOrder(99,100),[99,98]);
});
test('one worker waits for current paint barrier, no fan-out',async()=>{
 const q=new ReaderQueue(), log=[]; let painted;
 const first={run:async()=>{log.push('current');await new Promise(r=>painted=r);log.push('paint');}};
 const next={run:async()=>{log.push('next');}};
 q.set([first,next]); await settle(); assert.deepEqual(log,['current']);
 painted(); await settle(); assert.deepEqual(log,['current','paint','next']);
 q.set([first,next]);await settle();assert.equal(log.length,3);
});
test('cancel drops old queued work and never overlaps non-abortable old decode',async()=>{
 const q=new ReaderQueue(), log=[];let finish,signal;
 const old={run:async(s)=>{signal=s;log.push('old');await new Promise(r=>finish=r);}};
 q.set([old,{run:async()=>log.push('obsolete')}]);
 q.cancel();q.set([{run:async()=>log.push('new')}]);await settle();
 assert.equal(signal.aborted,true); assert.deepEqual(log,['old']);
 finish();await settle();assert.deepEqual(log,['old','new']);
});
test('cancelled same image can be retried when reader returns',async()=>{
 const q=new ReaderQueue();let finish;let runs=0;
 const job={run:async()=>{runs++;if(runs===1)await new Promise(r=>finish=r);}};
 q.set([job]);q.cancel();q.set([job]);finish();await settle();assert.equal(runs,2);
});
test('tap vs sticky drag, native cancel, multitouch, mouse movement',()=>{
 const tap=new ReaderTap();
 tap.down(1,20,20);assert.equal(tap.up(1,22,24),true);
 tap.down(1,20,20);tap.move(1,20,40);assert.equal(tap.up(1,20,20),false);
 tap.down(1,20,20);tap.cancel();assert.equal(tap.up(1,20,20),false);
 tap.down(1,20,20);tap.down(2,20,20);assert.equal(tap.up(1,20,20),false);
});
