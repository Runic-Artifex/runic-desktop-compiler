// Reactivity of deep state, aliasing and staleness
// (docs/design/REACTIVITY-ALIASING.md): the adversarial fixtures the
// frameworks and the native model disagree on are rejected where they
// stand, and those the model covers agree with the reference interpreter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const lowered = root => collect(root).then(g => lower(g));
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const shown = (step, id) =>
  text(flat(step.state.dom).find(n => n.attrs.id === id))
    .replace(/\s+/g, ' ')
    .trim();
const click = id => ({ kind: 'click', id });

/** Expects a diagnostic `code` located in `file` (and matching `pattern`). */
const failWith = (code, file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file === file &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(
    `expected ${code} in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('effects that write what they read run again, through proxies too (R4)', async () => {
  const { ir } = await lowered('fixtures/effect-self-svelte');
  const steps = interpret(ir, [click('dump'), click('grow'), click('dump')], {});
  assert.equal(shown(steps[0], 'values'), '3 3 3 1 1');
  // Svelte 5.57.1 in Chromium: every effect runs, then each one its write
  // invalidated, in passes; one writing back the value it read runs once
  // more and stops (case effect-self).
  assert.equal(
    shown(steps[1], 'log'),
    'len 5 | count 5 | box 5 | mirror 0 0 | len 4 | count 4 | box 4 | mirror 1 1 | len 3 | count 3 | box 3',
  );
  assert.equal(
    shown(steps[3], 'log'),
    'len 5 | count 6 | box 6 | mirror 1 1 | len 4 | count 5 | box 5 | mirror 2 2 | len 3 | count 4 | box 4 | count 3 | box 3',
  );
});

test('a Vue watcher writing what it reads is rejected', async () => {
  // Vue does not run a watchEffect again for its own writes (case
  // effect-self's Vue fixture in Chromium: `len 5 | count 5 | box 5`).
  await assert.rejects(
    lowered('fixtures/effect-self-vue'),
    failWith('E_EFFECT', 'App.vue', /writes items, which it depends on/),
  );
});

