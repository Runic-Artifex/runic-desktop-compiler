// Spike acceptance: drives four original fixtures through the browser harness
// with one shared Chromium and checks a few observable values per step.
// Usage (dev shell): node conformance/harness/smoke.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createBrowserHarness } from './browser.mjs';

const counter = [
  { kind: 'click', id: 'increment' },
  { kind: 'click', id: 'increment' }, // reaches 3: the focused button becomes disabled
  { kind: 'click', id: 'increment' }, // disabled: the browser ignores the click
  { kind: 'click', id: 'toggle' },
  { kind: 'focus', id: 'sequence' },
  { kind: 'blur', id: 'sequence' },
];
const cases = [
  ['fixtures/counter-react', counter],
  ['fixtures/counter-vue', [{ kind: 'click', id: 'sequence' }, { kind: 'click', id: 'toggle' }]],
  ['fixtures/counter-svelte', counter],
  [
    'fixtures/editor-svelte',
    [
      { kind: 'click', id: 'editor' },
      { kind: 'type', text: 'Hello' },
      { kind: 'press', key: 'Backspace' },
      { kind: 'select', id: 'editor', start: 0, end: 1 },
      { kind: 'type', text: 'J' },
      { kind: 'click', id: 'lock' }, // disables the input
      { kind: 'click', id: 'lock' },
      { kind: 'type', id: 'editor', text: '!' },
      { kind: 'press', key: 'Tab' },
    ],
  ],
];

const text = (dom, id) => {
  const find = n => (n.id === id ? n : (n.children ?? []).map(find).find(Boolean));
  const all = n => (n.text ?? '') + (n.children ?? []).map(all).join('');
  const node = find(dom);
  return node && all(node);
};
const find = (dom, id) =>
  dom.id === id ? dom : (dom.children ?? []).map(n => find(n, id)).find(Boolean);

const harness = await createBrowserHarness();
console.log(`chromium ${harness.browserVersion} launch ${harness.launchMs.toFixed(0)} ms`);
try {
  for (const viewport of [{ width: 800, height: 600 }, { width: 420, height: 600 }])
    for (const [fixture, actions] of cases) {
      const t = performance.now();
      const r = await harness.run(fixture, { viewport, actions });
      assert.deepEqual(r.errors, [], fixture + ' page errors');
      const steps = r.steps.map(s => ({
        value: text(s.dom, 'value') ?? find(s.dom, 'editor')?.value,
        focused: s.focused,
        ms: Object.values(s.timing).map(v => Math.round(v)).join('/'),
      }));
      const last = r.steps.at(-1);
      if (fixture.includes('counter-') && actions === counter) {
        assert.equal(text(r.steps[2].dom, 'value'), '3');
        assert.equal(find(r.steps[2].dom, 'increment').disabled, true);
        assert.equal(text(r.steps[3].dom, 'value'), '3');
        assert.equal(find(r.steps[4].dom, 'details'), undefined);
        assert.equal(r.steps[5].focused, 'sequence');
        assert.equal(last.focused, null);
      }
      if (fixture.endsWith('counter-vue')) {
        assert.equal(text(r.steps[1].dom, 'value'), '3');
        assert.equal(text(r.steps[1].dom, 'observed'), '3');
      }
      if (fixture.endsWith('editor-svelte')) {
        assert.equal(r.steps[2].focused, 'editor');
        assert.equal(text(r.steps[2].dom, 'preview'), 'Hello');
        assert.equal(find(r.steps[5].dom, 'editor').value, 'Jell');
        assert.equal(find(r.steps[6].dom, 'editor').disabled, true);
        // Refocusing restores the previous caret (after 'J'), as in a real browser.
        assert.equal(find(last.dom, 'editor').value, 'J!ell');
        assert.equal(text(last.dom, 'count'), '5');
        assert.equal(last.focused, 'clear');
      }
      console.log(
        `${r.fixture} ${viewport.width}x${viewport.height}: serve ${r.timings.serveMs.toFixed(0)} ms, ` +
          `mount ${r.timings.mountMs.toFixed(0)} ms, total ${(performance.now() - t).toFixed(0)} ms`,
      );
      console.log('  ' + steps.map(s => `${s.value}|${s.focused}|${s.ms}ms`).join('  ') + '  (action/settle/snapshot/screenshot ms)');
    }
} finally {
  await harness.close();
}
