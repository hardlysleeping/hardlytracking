import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'svelte/compiler';

const source = readFileSync(new URL('../../src/views/Extensions.svelte', import.meta.url), 'utf8');
const ast = parse(source, { modern: true });
function attr(node, name) {
  return node.attributes?.find(a => a.name === name)?.value?.[0]?.data;
}
const elements = [];
function visit(node, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  const element = node.type === 'RegularElement';
  if (element) elements.push({ node, ancestors });
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, element ? [...ancestors, node] : ancestors);
    else if (value && typeof value === 'object') visit(value, element ? [...ancestors, node] : ancestors);
  }
}
visit(ast);

test('extension search and heading share the safe-area-aware sticky wrapper', () => {
  const fields = elements.filter(({node}) => node.name === 'input' && attr(node, 'aria-label') === 'Search extensions');
  assert.equal(fields.length, 1, 'render one search field, not a duplicated sticky copy');
  const pin = fields[0].ancestors.find(node => attr(node, 'class')?.split(/\s+/).includes('pin'));
  assert.ok(pin, 'search must be inside the shared pinned header, not the scrolling list');
  assert.ok(elements.some(({node, ancestors}) => node.name === 'header' && ancestors.includes(pin)), 'heading stays with its search field');
  const view = elements.find(({node}) => node.name === 'section' && attr(node, 'class') === 'view').node;
  assert.ok(elements.find(({node, ancestors}) => node === pin && ancestors.at(-1) === view), 'shared sticky rule requires .pin directly below .view');
});
