import test from 'node:test';
import assert from 'node:assert/strict';
import { checkExpectedText } from '../conformance/harness/expectations.mjs';
const element = (id, children) => ({ tag: 'p', attributes: { id }, children });
const steps = [
  {
    dom: element('log', [
      { text: 'before ' },
      element('nested', [{ text: 'submit' }]),
      { text: ' after' },
    ]),
  },
];
test('case expectations read nested text exactly, including portals', () => {
  assert.equal(
    checkExpectedText(steps, [{ step: 0, id: 'log', text: 'before submit after' }]).passed,
    true,
  );
  assert.equal(
    checkExpectedText(
      [{ dom: null, portals: [element('portal', [{ text: 'ok' }])] }],
      [{ step: 0, id: 'portal', text: 'ok' }],
    ).passed,
    true,
  );
});
test('identical incorrect outputs cannot satisfy an independent expectation', () => {
  const expected = [{ step: 0, id: 'log', text: 'submit after before' }];
  assert.equal(checkExpectedText(steps, expected).passed, false);
  assert.equal(
    checkExpectedText(structuredClone(steps), expected).failures[0].actual,
    'before submit after',
  );
});
test('missing trace steps, missing IDs and ambiguous IDs fail', () => {
  for (const expected of [
    { step: 1, id: 'log', text: '' },
    { step: 0, id: 'missing', text: '' },
  ])
    assert.equal(checkExpectedText(steps, [expected]).passed, false);
  assert.equal(
    checkExpectedText(
      [{ dom: element('root', [element('same', []), element('same', [])]) }],
      [{ step: 0, id: 'same', text: '' }],
    ).passed,
    false,
  );
});
test('malformed or duplicate expectations are errors, not passes', () => {
  for (const expected of [
    null,
    {},
    [{ step: -1, id: 'log', text: '' }],
    [{ step: 0, id: '', text: '' }],
    [{ step: 0, id: 'log', text: 1 }],
  ])
    assert.throws(() => checkExpectedText(steps, expected));
  const row = { step: 0, id: 'log', text: 'before submit after' };
  assert.throws(() => checkExpectedText(steps, [row, row]));
});
