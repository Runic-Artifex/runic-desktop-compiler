// M5 host services (docs/design/M5-PLATFORM.md): console, clipboard,
// session history and location, randomness. Behaviour against Chromium is
// checked by conformance/run.mjs (cases console, clipboard, hash-router,
// hash-router-start, randomness); these tests pin the interpreter's model
// (the probe environment: start URL, clipboard text, seed) and the
// rejections, with locations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const fixture = collect('fixtures/host-svelte');

async function edits(file, pairs) {
  const g = await fixture;
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `Replacement must match: ${from}`);
    code = code.replace(from, to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

const rejects = async (pairs, code, message) =>
  assert.rejects(lower(await edits('App.svelte', pairs)), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    assert.equal(e.source?.file, 'App.svelte', e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    if (message) assert.match(e.message, message);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) =>
  textOf(flat(step.state.dom).find(n => n.attrs.id === id))
    .replace(/\s+/g, ' ')
    .trim();

test('history and location: hash navigations, pushState, user and script traversals', async () => {
  const { ir } = await lower(await fixture);
  const steps = interpret(
    ir,
    [
      { kind: 'click', id: 'nav-about' },
      { kind: 'click', id: 'nav-same' },
      { kind: 'click', id: 'filter' },
      { kind: 'back' },
      { kind: 'back' },
      { kind: 'click', id: 'forward' },
      { kind: 'back' },
      { kind: 'back' },
    ],
    { url: '/#/items/2' },
  );
  assert.equal(text(steps[0], 'view'), 'Item 2');
  assert.deepEqual(steps[0].state.host, {
    console: [{ level: 'log', text: 'mounted at /#/items/2' }],
    href: '/#/items/2',
  });
  // popstate runs nested in the setter, before the handler continues; hashchange is a task.
  assert.equal(text(steps[1], 'events'), '3: popstate #/about, go #/about, hashchange #/about');
  assert.deepEqual(steps[1].state.host, { href: '/#/about', historyLength: 2 });
  // Setting the current hash does nothing.
  assert.equal(text(steps[2], 'events'), '4: go #/about, hashchange #/about, go #/about');
  assert.deepEqual(steps[2].state.host, { href: '/#/about', historyLength: 2 });
  assert.deepEqual(steps[3].state.host, { href: '/?q=red#/about', historyLength: 3 });
  // Back over the query: popstate only; back over the fragment: popstate and hashchange.
  assert.match(text(steps[4], 'events'), /push #\/about, popstate #\/about$/);
  assert.match(text(steps[5], 'events'), /popstate #\/items\/2, hashchange #\/items\/2$/);
  assert.equal(text(steps[6], 'view'), 'About');
  // Back at the first entry does nothing.
  assert.equal(text(steps[8], 'view'), 'Item 2');
  assert.deepEqual(steps[8].state.host, { href: '/#/items/2', historyLength: 3 });
});

test('the start URL: a hash set while loading replaces the entry; a reload keeps the history', async () => {
  const { ir } = await lower(await fixture);
  const steps = interpret(
    ir,
    [{ kind: 'click', id: 'nav-items' }, { kind: 'reload' }, { kind: 'back' }],
    { url: '/start?x=1' },
  );
  assert.equal(text(steps[0], 'events'), '3: popstate #/, go #/, hashchange #/');
  assert.equal(steps[0].state.host.href, '/start?x=1#/');
  assert.equal(steps[0].state.host.historyLength, undefined);
  assert.equal(steps[2].state.host.historyLength, 2);
  // A traversal to an entry of the document before the reload is outside the model.
  assert.ok(steps[3].outcome.rejected, JSON.stringify(steps[3].outcome));
});

test('clipboard and console: settled promises, Chromium message text', async () => {
  const { ir } = await lower(await fixture);
  const steps = interpret(
    ir,
    [
      { kind: 'click', id: 'paste' },
      { kind: 'click', id: 'copy' },
      { kind: 'click', id: 'log' },
    ],
    { clipboard: 'seeded' },
  );
  assert.equal(text(steps[1], 'clipboard'), 'pasted: seeded');
  assert.equal(steps[2].state.host.clipboard, 'Grüße 😀');
  assert.deepEqual(steps[3].state.host.console, [
    { level: 'log', text: 'clicked 1 true null undefined' },
    { level: 'info', text: 'info 1' },
    { level: 'warn', text: 'values 0 1e+21 0.30000000000000004 NaN -Infinity' },
    { level: 'error', text: 'error false' },
    { level: 'debug', text: 'debug a b ' },
  ]);
});

test('randomness: the seeded generator, restarted by a reload', async () => {
  const { ir } = await lower(await fixture);
  const run = seed =>
    interpret(
      ir,
      [
        { kind: 'click', id: 'shuffle' },
        { kind: 'click', id: 'dice' },
        { kind: 'click', id: 'uuid' },
        { kind: 'reload' },
        { kind: 'click', id: 'shuffle' },
      ],
      { seed },
    );
  const a = run(7);
  assert.deepEqual(
    a.map(s => text(s, 'deck')),
    run(7).map(s => text(s, 'deck')),
  );
  assert.notEqual(text(a[1], 'deck'), text(run(8)[1], 'deck'));
  // Seed 7 (the randomness case): the same values Chromium shows with the harness's generator.
  assert.equal(text(a[1], 'deck'), 'F E B D A C · 0');
  assert.equal(text(a[2], 'deck'), 'F E B D A C · 2');
  assert.equal(text(a[3], 'ids'), '77cbc4a1-33c2-40f6-93fc-d6513d02befe');
  assert.equal(text(a[5], 'deck'), text(a[1], 'deck'));
});

test('rejected: console shapes Chromium formats or reports differently', async () => {
  await rejects(
    [['console.info(`info ${logged}`);', 'console.info(deck);']],
    'E_HOST',
    /strings, numbers/,
  );
  await rejects(
    [['console.info(`info ${logged}`);', 'console.info();']],
    'E_HOST',
    /without arguments/,
  );
  await rejects(
    [["console.debug('debug', 'a b', '');", "console.debug('%s!', 'a b');"]],
    'E_HOST',
    /format string/,
  );
  await rejects(
    [["console.debug('debug', 'a b', '');", 'console.debug(draft, logged);']],
    'E_HOST',
    /format string/,
  );
  await rejects([['console.info(`info ${logged}`);', 'console.table(logged);']], 'E_MEMBER');
});

test('rejected: history state, reloads, other documents, the origin', async () => {
  await rejects(
    [["history.pushState(null, '', `?q=", "history.pushState({ q }, '', `?q="]],
    'E_HOST',
    /state objects/,
  );
  await rejects([['history.go(-2)', 'history.go(0)']], 'E_HOST', /non-zero integer literal/);
  await rejects([['history.go(-2)', 'history.go(logged)']], 'E_HOST', /non-zero integer literal/);
  await rejects(
    [['length = history.length;', 'length = history.state;']],
    'E_HOST',
    /history.state/,
  );
  await rejects([['hash = location.hash;', 'hash = location.href;']], 'E_HOST', /origin/);
  await rejects([['location.hash = to;', 'location.pathname = to;']], 'E_HOST', /another document/);
  await rejects([['location.hash = to;', 'location.reload();']], 'E_HOST', /another document/);
  await rejects(
    [['ids.push(crypto.randomUUID());', 'crypto.getRandomValues(ids);']],
    'E_HOST',
    /typed array/,
  );
  await rejects(
    [['await navigator.clipboard.writeText(draft);', 'await navigator.clipboard.write(draft);']],
    'E_MEMBER',
  );
});

test('rejected: host values read while rendering, history events off the window', async () => {
  await rejects(
    [['<p id="location">{where}', '<p id="location">{location.pathname}']],
    'E_REACTIVITY',
    /session history/,
  );
  await rejects([['· {roll}</p>', '· {Math.random()}</p>']], 'E_REACTIVITY', /Randomness/);
  await rejects(
    [
      [
        '<svelte:window onpopstate',
        '<svelte:document onpopstate={() => {}} />\n<svelte:window onpopstate',
      ],
    ],
    'E_EVENT',
  );
});
