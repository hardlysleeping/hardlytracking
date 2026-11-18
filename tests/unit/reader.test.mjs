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
test('cancel drops old queued work and never overlaps an abortable old decode',async()=>{
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

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

test('a stuck page stops holding the next one after the grace', async () => {
  const q = new ReaderQueue(10), log = [];
  let finishFirst;
  const stuck = { run: async () => { log.push('stuck'); await new Promise(r => (finishFirst = r)); log.push('stuck done'); } };
  const next = { run: async () => { log.push('next'); } };
  q.set([stuck, next]);
  await wait(5);
  assert.deepEqual(log, ['stuck'], 'the second lane opened before the grace');
  await wait(40);
  assert.deepEqual(log, ['stuck', 'next'], 'a stuck page held the next one for its whole deadline');
  finishFirst();
  q.cancel();
});

test('a page that fails outright is not a reason to stop reading', async () => {
  const q = new ReaderQueue(10), log = [];
  const broken = { run: async () => { throw new Error('page 1 is gone'); } };
  const next = { run: async () => { log.push('next'); } };
  q.set([broken, next]);
  await wait(10);
  assert.deepEqual(log, ['next']);
  q.cancel();
});

test('the spare lane is one lane, never a fan-out', async () => {
  const q = new ReaderQueue(10), started = [];
  const hang = (name) => ({ run: async () => { started.push(name); await new Promise(() => {}); } });
  q.set([hang('a'), hang('b'), hang('c'), hang('d')]);
  await wait(5);
  assert.deepEqual(started, ['a'], 'more than one page started before the grace');
  await wait(40);
  assert.deepEqual(started, ['a', 'b'], 'a slow chapter fanned out past two lanes');
  q.cancel();
});

test('a window that moves on aborts the page that is no longer wanted', async () => {
  const q = new ReaderQueue(10);
  let signal;
  const gone = { run: async (s) => { signal = s; await new Promise(() => {}); } };
  const now = { run: async () => {} };
  q.set([gone, now]);
  await wait(5);
  q.set([now]);
  assert.equal(signal.aborted, true, 'a page scrolled out of the window kept working');
  q.cancel();
});
