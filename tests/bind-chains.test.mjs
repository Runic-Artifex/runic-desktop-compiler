// `bind:` through wrapper chains (M6, shadcn-svelte's Slider and
// DropdownMenu.RadioGroup over bits-ui): a variable of the present type
// bound to a `value = $bindable()` prop without a default whose component
// writes it only through svelte-toolbelt box setters that are only ever
// called with present values, and a nullable variable bound to a prop with
// a default where the variable never holds undefined (Svelte's prop()
// throws `props_invalid_value` if it is undefined when the child is
// created). Fixture bind-chain-svelte, case bind-chains.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const FIXTURE = 'fixtures/bind-chain-svelte';

/** The fixture with `changes` (file → text, or file → [from, to] replacements). */
async function withFixture(changes, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/bind-chains-'));
  try {
    await cp(FIXTURE, root, { recursive: true });
    for (const [file, change] of Object.entries(changes)) {
      const target = path.join(root, file);
      if (typeof change === 'string') await writeFile(target, change);
      else {
        const text = await readFile(target, 'utf8');
        assert.ok(text.includes(change[0]), `${file} holds ${change[0]}`);
        await writeFile(target, text.replace(change[0], change[1]));
      }
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const lowered = root => collect(root).then(g => lower(g));
const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const shown = (step, id) => text(flat(step.state.dom).find(n => n.attrs.id === id));

/** Expects E_TEMPLATE located in `file` and matching `pattern`. */
const failWith = (file, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === 'E_TEMPLATE' &&
    e.source?.file === file &&
    e.source.line > 0 &&
    pattern.test(e.message)) ||
  assert.fail(
    `expected E_TEMPLATE in ${file}, got ${e.code} ${JSON.stringify(e.source)}: ${e.message}`,
  );

test('bound chains write through in both directions', async () => {
  assert.ok((await readdir(FIXTURE)).includes('App.svelte'));
  const { ir } = await lowered(FIXTURE);
  const steps = interpret(ir, [
    { kind: 'click', id: 'range-up-0' },
    { kind: 'click', id: 'range-down-1' },
    { kind: 'click', id: 'range-reset' },
    { kind: 'click', id: 'range-down-0' },
    { kind: 'click', id: 'range-narrow' },
    { kind: 'click', id: 'position-right' },
    { kind: 'click', id: 'outside-top' },
    { kind: 'click', id: 'position-bottom' },
    { kind: 'click', id: 'fixed-left' },
  ]);
  const range = s => [
    shown(s, 'range-value'),
    shown(s, 'range-thumb-0'),
    shown(s, 'range-thumb-1'),
  ];
  assert.deepEqual(range(steps[0]), ['20 to 60', '20', '60']);
  assert.deepEqual(range(steps[1]), ['30 to 60', '30', '60']);
  assert.deepEqual(range(steps[2]), ['30 to 50', '30', '50']);
  assert.deepEqual(range(steps[3]), ['0 to 100', '0', '100']);
  // (Clamped at 0: the box writes the same values again.)
  assert.deepEqual(range(steps[4]), ['0 to 100', '0', '100']);
  assert.deepEqual(range(steps[5]), ['5 to 95', '5', '95']);
  const position = s => [shown(s, 'position-value'), shown(s, 'position-changes')];
  assert.deepEqual(position(steps[5]), ['bottom', '0']);
  assert.deepEqual(position(steps[6]), ['right', '1']);
  assert.deepEqual(position(steps[7]), ['top', '1']);
  assert.deepEqual(position(steps[8]), ['bottom', '2']);
  assert.equal(shown(steps[8], 'fixed-changes'), '0');
  assert.equal(shown(steps[9], 'fixed-changes'), '1');
});

test('a box setter that may receive a nullish value is not trusted', async () => {
  const absent = /may set to undefined/;
  // A box of the same record assigned a nullable value anywhere.
  await withFixture(
    {
      'state.svelte.ts': [
        'thumbs = $derived.by',
        'clear(other: number[] | undefined) {\n    this.opts.value.current = other;\n  }\n\n  thumbs = $derived.by',
      ],
      'RangeCore.svelte': [
        '<div class="range" {id}>',
        '<button id="clear" onclick={() => range.clear(undefined)}>clear</button>\n<div class="range" {id}>',
      ],
    },
    root => assert.rejects(lowered(root), failWith('App.svelte', absent)),
  );
  // A setter that is not written inline (other code may call it).
  await withFixture(
    {
      'RangeCore.svelte': ['v => {\n        value = v;\n      },', 'set,'],
    },
    async root => {
      const file = path.join(root, 'RangeCore.svelte');
      const text = await readFile(file, 'utf8');
      await writeFile(
        file,
        text.replace(
          'const range =',
          'function set(v: number[] | undefined) {\n    value = v;\n  }\n  const range =',
        ),
      );
      await assert.rejects(lowered(root), failWith('App.svelte', absent));
    },
  );
  // A setter assigning its parameter before writing it.
  await withFixture(
    {
      'RangeCore.svelte': [
        'v => {\n        value = v;',
        'v => {\n        if (v?.length === 0) v = undefined;\n        value = v;',
      ],
    },
    root => assert.rejects(lowered(root), failWith('App.svelte', absent)),
  );
});

test('a nullable variable bound to a prop with a default must never hold undefined', async () => {
  const absent = /may be undefined, to a prop with a default/;
  // A site that leaves the wrapper's value undefined (Svelte throws
  // props_invalid_value when ChoiceCore is created).
  await withFixture(
    { 'App.svelte': ['<Choice id="fixed" value="right"', '<Choice id="fixed"'] },
    root => assert.rejects(lowered(root), failWith('Choice.svelte', absent)),
  );
  // A site passing a nullable variable.
  await withFixture(
    {
      'App.svelte': [
        "let position = $state('bottom');",
        "let position = $state('bottom');\n  let maybe = $state<string | undefined>('left');",
      ],
    },
    async root => {
      const file = path.join(root, 'App.svelte');
      const text = await readFile(file, 'utf8');
      await writeFile(file, text.replace('value="right"', 'bind:value={maybe}'));
      await assert.rejects(lowered(root), failWith('Choice.svelte', absent));
    },
  );
  // The wrapper writing undefined itself (the page's binding of a string to
  // it is rejected first).
  await withFixture(
    {
      'Choice.svelte': [
        '<p class="echo">',
        '<button id="unset" onclick={() => (value = undefined)}>unset</button>\n<p class="echo">',
      ],
    },
    root => assert.rejects(lowered(root), failWith('App.svelte', /may set to undefined/)),
  );
  // A nullable $state bound directly: accepted while it starts present and
  // is only written present values.
  const direct = (init, extra = '') => ({
    'App.svelte': `<script lang="ts">
  import ChoiceCore from './ChoiceCore.svelte';
  let picked = $state<string | undefined>(${init});
</script>

<ChoiceCore id="direct" bind:value={picked} options={['a', 'b']} />
<p id="picked">{picked ?? 'none'}</p>
${extra}`,
  });
  await withFixture(
    direct("'a'", '<button id="unset" onclick={() => (picked = undefined)}>unset</button>\n'),
    root => assert.rejects(lowered(root), failWith('App.svelte', absent)),
  );
  await withFixture(direct("'a'"), async root => {
    const { ir } = await lowered(root);
    const steps = interpret(ir, [{ kind: 'click', id: 'direct-b' }]);
    assert.equal(shown(steps[0], 'picked'), 'a');
    assert.equal(shown(steps[1], 'picked'), 'b');
  });
  await withFixture(direct(''), root =>
    assert.rejects(lowered(root), failWith('App.svelte', absent)),
  );
});
