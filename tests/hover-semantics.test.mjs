// Element-target hover semantics in the reference interpreter. Native/browser
// conformance separately checks coordinate hits and text-to-padding movement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const flat = nodes =>
  nodes.flatMap(node => (typeof node === 'string' ? [] : [node, ...flat(node.children)]));
const textOf = node => (typeof node === 'string' ? node : node.children.map(textOf).join(''));
function textAt(step, id) {
  const node = flat(step.state.dom).find(node => node.attrs.id === id);
  assert.ok(node, `fixture must expose #${id}`);
  return textOf(node);
}

// These are expected browser-style element transitions, independent of the
// implementation's hovered-path calculation. The target remains the label;
// bubbling changes currentTarget and never substitutes an ancestor as relatedTarget.
const initialA = [
  'pointerover:label-a:item-a:-:-1:0',
  'pointerover:label-a:list:-:-1:0',
  'mouseover:label-a:item-a:-:0:0',
  'mouseover:label-a:list:-:0:0',
];
const aToB = [
  'pointerout:label-a:item-a:label-b:-1:0',
  'pointerout:label-a:list:label-b:-1:0',
  'pointerover:label-b:item-b:label-a:-1:0',
  'pointerover:label-b:list:label-a:-1:0',
  'mouseout:label-a:item-a:label-b:0:0',
  'mouseout:label-a:list:label-b:0:0',
  'mouseover:label-b:item-b:label-a:0:0',
  'mouseover:label-b:list:label-a:0:0',
];
const bToTitle = [
  'pointerout:label-b:item-b:title:-1:0',
  'pointerout:label-b:list:title:-1:0',
  'pointerover:title:title:label-b:-1:0',
  'mouseout:label-b:item-b:title:0:0',
  'mouseout:label-b:list:title:0:0',
  'mouseover:title:title:label-b:0:0',
];
const titleToA = [
  'pointerout:title:title:label-a:-1:0',
  'pointerover:label-a:item-a:title:-1:0',
  'pointerover:label-a:list:title:-1:0',
  'mouseout:title:title:label-a:0:0',
  'mouseover:label-a:item-a:title:0:0',
  'mouseover:label-a:list:title:0:0',
];

const expectedLogs = [''];
let retained = [];
for (const transition of [initialA, aToB, bToTitle, titleToA, []]) {
  retained = [...retained, ...transition].slice(-14);
  expectedLogs.push(retained.join(' '));
}

for (const framework of ['react', 'svelte', 'vue']) {
  test(`${framework} hover bubbles real related targets and ignores a repeated element target`, async () => {
    const { ir } = await lower(await collect(`fixtures/hover-events-${framework}`));
    const steps = interpret(
      ir,
      ['label-a', 'label-b', 'title', 'label-a', 'label-a'].map(id => ({ kind: 'hover', id })),
    );
    assert.equal(steps.length, 6);
    assert.deepEqual(
      steps.map(step => textAt(step, 'boundary-log')),
      expectedLogs,
    );
    assert.deepEqual(
      steps.map(step => textAt(step, 'overs')),
      ['0', '1', '2', '2', '3', '3'],
    );
    assert.equal(
      textAt(steps[1], 'boundary-log'),
      initialA.join(' '),
      'first entry must have a null related target',
    );
    assert.equal(textAt(steps[5], 'boundary-log'), textAt(steps[4], 'boundary-log'));
    assert.equal(
      textAt(steps[5], 'log'),
      textAt(steps[4], 'log'),
      'same-target move must not fire extra enter/out/over handlers',
    );
  });
}
