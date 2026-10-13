// Top-level code of packages compiled from source that do not declare
// `"sideEffects": false` (frontend/module-effects.ts; vaul-svelte, paneforge
// and mode-watcher): a bundle evaluates every module the program's imports
// load, so the compiler, which lowers only the declarations the program
// reaches, accepts such a package only where that code is inert and rejects
// the first code that is not where it stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/module-effects-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nmount(App, { target: document.getElementById('root') });\n",
      'runic.json': JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
      ...files,
    };
    for (const [file, text] of Object.entries(all)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const text = n => (typeof n === 'string' ? n : n.children.map(text).join(''));
const byId = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const found = byId(n.children, id);
    if (found) return found;
  }
  return undefined;
};

/**
 * A source package whose barrel (index.js) re-exports `used.js`, which the
 * program calls, and `other.js` (code `other`), which nothing the program
 * reaches uses. paneforge@1.0.2 declares no `sideEffects`; svelte-sonner@1.2.1
 * stands in for a package declaring `"sideEffects": false`.
 */
function pkg(other, { name = 'paneforge', version = '1.0.2', sideEffects } = {}) {
  const dir = `node_modules/${name}`;
  return {
    [`${dir}/package.json`]: JSON.stringify({
      name,
      version,
      type: 'module',
      ...(sideEffects === undefined ? {} : { sideEffects }),
      svelte: './dist/index.js',
      types: './dist/index.d.ts',
      exports: {
        '.': { types: './dist/index.d.ts', svelte: './dist/index.js', default: './dist/index.js' },
      },
    }),
    [`${dir}/dist/index.js`]: "export { greet } from './used.js';\nexport * from './other.js';\n",
    [`${dir}/dist/index.d.ts`]: "export { greet } from './used.js';\nexport * from './other.js';\n",
    [`${dir}/dist/used.d.ts`]: 'export declare function greet(name: string): string;\n',
    [`${dir}/dist/other.d.ts`]: 'export declare const other: unknown;\n',
    [`${dir}/dist/used.js`]:
      "const PREFIX = 'hello ';\nexport function greet(name) {\n    return PREFIX + name;\n}\n",
    [`${dir}/dist/other.js`]: other,
  };
}

const app = (name = 'paneforge') => ({
  'App.svelte': `<script lang="ts">
  import { greet } from '${name}';
</script>

<p id="g">{greet('you')}</p>
`,
});

async function renders(files) {
  await withApp(files, async root => {
    const { ir } = await lower(await collect(root));
    const [start] = interpret(ir, []);
    assert.equal(text(byId(start.state.dom, 'g')), 'hello you');
  });
}

/** Lowering `files` fails with `code` at `at` (file:line:column), the message matching `pattern`. */
async function rejects(files, code, at, pattern) {
  await withApp(files, root =>
    assert.rejects(
      collect(root).then(g => lower(g)),
      e => {
        assert.equal(e.code, code, e.message);
        assert.equal(`${e.source?.file}:${e.source?.line}:${e.source?.column}`, at, e.message);
        if (pattern) assert.match(e.message, pattern);
        return true;
      },
    ),
  );
}

const OTHER = 'node_modules/paneforge/dist/other.js';

test('a package without "sideEffects": false whose evaluated top-level code is inert lowers', async () => {
  await renders({
    ...pkg(`const DEFAULTS = Object.freeze({ size: 10, dir: 'horizontal' });
const KEYS = new Map([['a', 1], ['b', 2]]);
const seen = new WeakMap();
const tag = Symbol('pane');
const isServer = typeof window === 'undefined';
const mode = isServer ? 'server' : 'client';
globalThis.paneCounter ??= { current: 0 };
function make(size) {
    return { size, half: size === 0 ? 0 : size };
}
class Store {
    items = [];
    size;
    constructor(size) {
        this.size = size;
        this.onResize = this.onResize.bind(this);
    }
    onResize() {
        return this.size;
    }
}
export const other = new Store(make(10));
export { KEYS, seen, tag, mode };
`),
    ...app(),
  });
});

test('top-level code reading host state is rejected where it stands, even in a module nothing reaches', async () => {
  await rejects(
    { ...pkg('export const other = window.innerWidth;\n'), ...app() },
    'E_MODULE',
    `${OTHER}:1:22`,
    /paneforge@1\.0\.2 that is not inert: this reads window\.innerWidth .*does not declare "sideEffects": false/,
  );
  // A statement run for its effect.
  await rejects(
    { ...pkg("console.log('loaded');\nexport const other = 1;\n"), ...app() },
    'E_MODULE',
    `${OTHER}:1:1`,
  );
});

test("a constructor run at module evaluation is followed into its body (mode-watcher's localStorage read)", async () => {
  await rejects(
    {
      ...pkg(`class Prefs {
    value;
    constructor() {
        this.value = localStorage.getItem('mode') ?? 'system';
    }
}
export const other = new Prefs();
`),
      ...app(),
    },
    'E_MODULE',
    `${OTHER}:4:22`,
    /calls localStorage.getItem at module evaluation \(run at module evaluation by node_modules\/paneforge\/dist\/other\.js:7:1\)/,
  );
});

test('a binding read before its declaration ran is rejected (it throws in a bundle)', async () => {
  await rejects(
    {
      ...pkg(`function size() {
    return LATER;
}
export const other = size();
const LATER = 1;
`),
      ...app(),
    },
    'E_MODULE',
    `${OTHER}:2:12`,
  );
});

test('a package an evaluated module imports must be covered; the pack error is reported at the import', async () => {
  await rejects(
    {
      ...pkg("import { pad } from 'left-pad-x';\nexport const other = 1;\n"),
      'node_modules/left-pad-x/package.json': JSON.stringify({
        name: 'left-pad-x',
        version: '1.0.0',
        type: 'module',
        exports: { '.': './index.js' },
      }),
      'node_modules/left-pad-x/index.js': 'export function pad(s) {\n    return s;\n}\n',
      ...app(),
    },
    'E_DEPENDENCY',
    `${OTHER}:1:1`,
    /left-pad-x@1\.0\.0.*paneforge@1\.0\.2 does not declare "sideEffects": false, so a bundle evaluates this import/,
  );
});

test('the same code in a package declaring "sideEffects": false is not run unless reached', async () => {
  const sonner = { name: 'svelte-sonner', version: '1.2.1', sideEffects: false };
  await renders({
    ...pkg("export const other = window.innerWidth;\nconsole.log('loaded');\n", sonner),
    ...app('svelte-sonner'),
  });
});
