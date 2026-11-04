import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parse} from 'svelte/compiler';

test('App direct read route uses the reactive privacy gate, not an unguarded Reader',()=>{
 const app=readFileSync(new URL('../../src/App.svelte',import.meta.url),'utf8');
 assert.match(app,/import ReaderGate from "\.\/components\/ReaderGate.svelte"/);
 assert.match(app,/<ReaderGate seriesId=\{route.id\} chapterId=\{route.chapterId\}/);
 assert.doesNotMatch(app,/<Reader\s/);
});
test('reader content is conditionally mounted inside the same live visibility policy, never CSS-covered',()=>{
 const text=readFileSync(new URL('../../src/components/ReaderGate.svelte',import.meta.url),'utf8');
 const ast=parse(text,{modern:true});
 const branch=ast.fragment.nodes.find(n=>n.type==='IfBlock');
 assert.equal(branch.test.type,'CallExpression');
 assert.equal(branch.test.callee.object.name,'visibility');assert.equal(branch.test.callee.property.name,'allows');
 assert.ok(branch.consequent.nodes.some(n=>n.type==='Component'&&n.name==='Reader'));
 assert.ok(!branch.alternate.nodes.some(n=>n.type==='Component'&&n.name==='Reader'));
 assert.match(text,/visibility.load\(store\)/);
});
