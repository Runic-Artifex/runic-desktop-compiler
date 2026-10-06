// Unhandled promise rejections (docs/IR.md, promises; M6): reported as
// Chromium reports them, an `Uncaught (in promise) Name: message` console
// error line in a task after the microtask checkpoint that left the promise
// without a handler. The expected lines are Chromium 153's for the same
// actions (conformance/run.mjs, cases rejections and rejections-timer, check
// the native app against Chromium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const click = id => ({ kind: 'click', id });
const lines = step => (step.state.host?.console ?? []).map(l => `${l.level}: ${l.text}`);

/** The fixture with replacements in `file`. */
async function edited(fixture, file, pairs) {
  const g = await collect(fixture);
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `Replacement must match: ${from}`);
    code = code.replace(from, () => to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

// Chromium 153 (the harness's console lines for these clicks).
const CHROMIUM = [
  ['log: count 0'],
  ['log: before', 'log: after', 'log: microtask', 'error: Uncaught (in promise) Error: rejected'],
  ['log: caught handled'],
  [
    'log: chained',
    'log: finally ran',
    'error: Uncaught (in promise) Error',
    'error: Uncaught (in promise) RangeError: in then',
    'error: Uncaught (in promise) Error: in all',
    'error: Uncaught (in promise) TypeError: finally',
  ],
  ['log: count 1', 'log: awaited', 'error: Uncaught (in promise) TypeError: async failure'],
  ['log: count 2', 'error: Uncaught (in promise) Error: after a write'],
];

test('unhandled rejections are reported after the checkpoint, as in Chromium', async () => {
  for (const f of ['svelte', 'react', 'vue']) {
    const { ir } = await lower(await collect(`fixtures/rejections-${f}`));
    const steps = interpret(ir, ['reject', 'handled', 'chained', 'async', 'state'].map(click));
    assert.deepEqual(steps.map(lines), CHROMIUM, f);
    for (const s of steps.slice(1)) assert.equal(s.outcome, 'handled', f);
  }
});

test('a rejection in a timer is reported after the timer callback', async () => {
  const { ir } = await lower(await collect('fixtures/rejections-react'));
  const steps = interpret(ir, [click('timer'), { kind: 'wait', ms: 150 }]);
  assert.deepEqual(lines(steps[2]), ['log: timer', 'error: Uncaught (in promise) Error: timer']);
});

test('Vue catches a promise a listener returns and logs it (callWithAsyncErrorHandling)', async () => {
  const g = await edited('fixtures/rejections-vue', 'App.vue', [
    [
      'function asyncFailure() {\n  count.value++;\n  failLater();\n}',
      'async function asyncFailure() {\n  count.value++;\n  await failLater();\n}',
    ],
    [
      '<button id="state"',
      '<button id="inline" @click="() => failLater()">Inline</button>\n      <button id="state"',
    ],
  ]);
  const { ir } = await lower(g);
  const steps = interpret(ir, [click('async'), click('inline')]);
  assert.deepEqual(lines(steps[1]), [
    'log: count 1',
    'log: awaited',
    'error: TypeError: async failure',
  ]);
  assert.deepEqual(lines(steps[2]), ['log: awaited', 'error: TypeError: async failure']);
});

test('a handler added after the report is unsupported (Chromium revokes the report)', async () => {
  const g = await edited('fixtures/rejections-svelte', 'App.svelte', [
    [
      '  function stateAndReject() {',
      "  let held: Promise<void> = Promise.resolve();\n  function hold() {\n    held = Promise.reject(new Error('held'));\n  }\n  function release() {\n    held.catch(() => console.log('late'));\n  }\n  function stateAndReject() {",
    ],
    [
      '<button id="timer"',
      '<button id="hold" onclick={hold}>Hold</button>\n    <button id="release" onclick={release}>Release</button>\n    <button id="timer"',
    ],
  ]);
  const { ir } = await lower(g);
  const steps = interpret(ir, [click('hold'), click('release')]);
  assert.deepEqual(lines(steps[1]), ['error: Uncaught (in promise) Error: held']);
  assert.equal(steps[2].outcome.rejected?.code, 'E_UNSUPPORTED');
  assert.match(
    steps[2].outcome.rejected.message,
    /after its rejection \(Error: held\) was reported/,
  );
});
