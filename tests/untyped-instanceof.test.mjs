// `x instanceof C` of a class compiled from source (or given by a pack) where
// TypeScript types `x` as `any` or `unknown`: an untyped helper's parameter,
// specialised per call site (bits-ui's date utils, `isCalendarDateTime(v)`
// called with a `DateValue`, the @internationalized/date pack's class
// union). The IR type of the value decides it: a class instance carries its
// class, a primitive or null/undefined is no instance; other values of
// unknown type (caught exceptions) stay rejected. Expected values follow
// ECMAScript (computed with the real package where it is used).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as real from '@internationalized/date';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** A Svelte app of `files` (App.svelte is the root); `run` gets its root. */
async function withApp(files, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/instanceof-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    const all = {
      'index.html':
        '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
      'main.js':
        "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
      'style.css':
        "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
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
const find = (nodes, id) => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    if (n.attrs.id === id) return n;
    const f = find(n.children, id);
    if (f) return f;
  }
};

/** The text of #out after mounting and after each click on #go. */
async function outputs(files, clicks) {
  return withApp(files, async root => {
    const { ir } = await lower(await collect(root));
    const steps = interpret(
      ir,
      Array.from({ length: clicks }, () => ({ kind: 'click', id: 'go' })),
    );
    return steps.map(s => text(find(s.state.dom, 'out')));
  });
}

// bits-ui's internal/date-time/utils.js, as it stands (untyped JavaScript).
const UTILS = `import { CalendarDate, CalendarDateTime, ZonedDateTime, endOfMonth } from '@internationalized/date';
function isCalendarDateTime(dateValue) {
  return dateValue instanceof CalendarDateTime;
}
export function isZonedDateTime(dateValue) {
  return dateValue instanceof ZonedDateTime;
}
export function hasTime(dateValue) {
  return isCalendarDateTime(dateValue) || isZonedDateTime(dateValue);
}
export function isDate(value) {
  return value instanceof CalendarDate;
}
export function getDaysInMonth(date) {
  if (date instanceof Date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return new Date(year, month, 0).getDate();
  } else {
    return endOfMonth(date).day;
  }
}
`;

test('instanceof Date is decided by the IR type; the branch never taken is not lowered', async () => {
  // bits-ui's getDaysInMonth(date) of a `Date | DateValue`: given a class
  // instance, the Date branch (untypable for it) never runs, and the other
  // way round.
  const program = M => {
    const days = date =>
      date instanceof Date
        ? new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
        : M.endOfMonth(date).day;
    return [1, 2].map(m =>
      [
        days(new M.CalendarDate(2024, m, 5)),
        days(new Date(2024, m - 1, 5)),
        new M.CalendarDate(2024, m, 5) instanceof Date,
      ].join(' '),
    );
  };
  const got = await outputs(
    {
      'utils.js': UTILS,
      'App.svelte': `<script lang="ts">
  import { CalendarDate } from '@internationalized/date';
  import { getDaysInMonth } from './utils.js';
  let m = $state(1);
  function view(m: number): string {
    const a: number = getDaysInMonth(new CalendarDate(2024, m, 5));
    const d: number = getDaysInMonth(new Date(2024, m - 1, 5));
    return \`\${a} \${d} \${new CalendarDate(2024, m, 5) instanceof Date}\`;
  }
</script>
<button id="go" onclick={() => (m = m + 1)}>go</button>
<p id="out">{view(m)}</p>
`,
    },
    1,
  );
  assert.deepEqual(got, program(real));
});

test('instanceof of a pack class over its class union is decided by the instance class', async () => {
  // The same program against the real package.
  const program = M => {
    const values = [
      new M.CalendarDate(2025, 1, 2),
      new M.CalendarDateTime(2025, 1, 2, 3, 4),
      M.toZoned(new M.CalendarDateTime(2025, 1, 2, 3, 4), 'UTC'),
    ];
    const hasTime = v => v instanceof M.CalendarDateTime || v instanceof M.ZonedDateTime;
    const isDate = v => v instanceof M.CalendarDate;
    return values.map((v, i) =>
      [
        hasTime(v),
        v instanceof M.ZonedDateTime,
        isDate(v),
        isDate(i === 0 ? undefined : v),
        isDate(i === 1 ? null : v),
        isDate(i),
        isDate(String(i)),
      ].join(' '),
    );
  };
  const expected = program(real);
  const got = await outputs(
    {
      'utils.js': UTILS,
      'App.svelte': `<script lang="ts">
  import { CalendarDate, CalendarDateTime, toZoned, type DateValue } from '@internationalized/date';
  import { hasTime, isZonedDateTime, isDate } from './utils.js';
  const values: DateValue[] = [
    new CalendarDate(2025, 1, 2),
    new CalendarDateTime(2025, 1, 2, 3, 4),
    toZoned(new CalendarDateTime(2025, 1, 2, 3, 4), 'UTC'),
  ];
  let i = $state(0);
  const v = $derived(values[i]);
  const absent = $derived(i === 0 ? undefined : v);
  const nothing = $derived(i === 1 ? null : v);
</script>
<button id="go" onclick={() => (i = i + 1)}>go</button>
<p id="out">{[hasTime(v), isZonedDateTime(v), isDate(v), isDate(absent), isDate(nothing), isDate(i), isDate(String(i))].join(' ')}</p>
`,
    },
    2,
  );
  assert.deepEqual(got, expected);
});

test('instanceof in untyped code follows the class hierarchy of the program', async () => {
  // JavaScript: a subclass instance is an instance of its base, not the reverse.
  class Shape {}
  class Circle extends Shape {}
  class Square extends Shape {}
  const isShape = v => v instanceof Shape;
  const isCircle = v => v instanceof Circle;
  const shapes = [new Shape(), new Circle(), new Square()];
  const expected = shapes.map(s => `${isShape(s)} ${isCircle(s)} ${isShape(new Circle())}`);
  const got = await outputs(
    {
      'shapes.ts': `export class Shape { kind = 'shape'; }
export class Circle extends Shape { r = 1; }
export class Square extends Shape { side = 2; }
`,
      'tests.js': `import { Shape, Circle } from './shapes.ts';
export function isShape(v) {
  return v instanceof Shape;
}
export function isCircle(v) {
  return v instanceof Circle;
}
`,
      'App.svelte': `<script lang="ts">
  import { Shape, Circle, Square } from './shapes.ts';
  import { isShape, isCircle } from './tests.js';
  const shapes: Shape[] = [new Shape(), new Circle(), new Square()];
  let i = $state(0);
</script>
<button id="go" onclick={() => (i = i + 1)}>go</button>
<p id="out">{isShape(shapes[i])} {isCircle(shapes[i])} {isShape(new Circle())}</p>
`,
    },
    2,
  );
  assert.deepEqual(got, expected);
});

test('instanceof of a value of unknown type that no class type decides stays rejected', async () => {
  // A caught exception: its type is unknown, and the IR's error record says nothing.
  await withApp(
    {
      'App.svelte': `<script lang="ts">
  class Failure { reason = 'x'; }
  let out = $state('');
  function go() {
    try {
      out = String(JSON.parse('{'));
    } catch (e) {
      out = e instanceof Failure ? 'failure' : 'other';
    }
  }
</script>
<button id="go" onclick={go}>go</button>
<p id="out">{out}</p>
`,
    },
    root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        e =>
          (e instanceof Diagnostic &&
            e.code === 'E_CLASS' &&
            e.source?.file === 'App.svelte' &&
            e.source.line === 8 &&
            /instanceof needs an operand whose static type decides it/.test(e.message)) ||
          assert.fail(`${e.code} ${JSON.stringify(e.source)}: ${e.message}`),
      ),
  );
});
