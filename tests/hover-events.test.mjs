// Typed boundary-event declarations and differential driving actions must agree
// with the supported event surface; a mount-only trace is not event coverage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const boundaryEvents = ['pointerover', 'pointerout', 'mouseover', 'mouseout'];

function typeDiagnostics(source) {
  const virtualFile = path.join(repo, 'frontend', '__hover_event_type_test.ts');
  const options = {
    target: ts.ScriptTarget.ES2023,
    lib: ['lib.es2023.d.ts'],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) =>
    file === virtualFile
      ? ts.createSourceFile(file, source, args[0], true)
      : originalGetSourceFile(file, ...args);
  const program = ts.createProgram(
    [path.join(repo, 'frontend', 'dom.d.ts'), virtualFile],
    options,
    host,
  );
  return ts
    .getPreEmitDiagnostics(program)
    .map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}

test('boundary names are typed for window/document and forwarded event bags', () => {
  const source = boundaryEvents
    .map(event => {
      const pointer = event.startsWith('pointer');
      const member = pointer ? 'pointerId' : 'clientX';
      const type = pointer ? 'PointerEvent' : 'MouseEvent';
      return `
        window.addEventListener('${event}', event => { const value: number = event.${member}; });
        document.addEventListener('${event}', event => {
          const value: number = event.${member};
          const related: HTMLElement | null = event.relatedTarget;
          if (related !== null) { const id: string = related.id; }
        });
        const forwarded_${event} = {
          on${event}: (event: RunicEventMap['${event}']) => { const value: number = event.${member}; }
        } satisfies { on${event}: (event: ${type}) => void };
      `;
    })
    .join('\n');
  assert.deepEqual(typeDiagnostics(source), []);
  assert.ok(
    typeDiagnostics("window.addEventListener('pointercancel', () => {});").length > 0,
    'adding boundary events must not admit unsupported event names',
  );
  assert.ok(
    typeDiagnostics(
      "window.addEventListener('mouseover', event => { const id = event.pointerId; });",
    ).length > 0,
    'mouse callbacks must retain the mouse interface rather than becoming untyped',
  );
  for (const event of ['mouseover', 'pointerover']) {
    assert.ok(
      typeDiagnostics(
        `window.addEventListener('${event}', event => { const related: HTMLElement = event.relatedTarget; });`,
      ).length > 0,
      `${event} relatedTarget must retain the null case`,
    );
  }
});

// Evaluate the actual pure event-discovery function from the CLI source. Parsing
// its declarations avoids importing the differential driver's top-level native
// build/capture loop and avoids duplicating its event-to-action implementation.
async function differentialEventKinds() {
  const source = await readFile(path.join(repo, 'conformance', 'differential.mjs'), 'utf8');
  const parsed = ts.createSourceFile(
    'differential.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const declarations = parsed.statements.filter(statement => {
    if (ts.isFunctionDeclaration(statement)) return statement.name?.text === 'eventKinds';
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        d => ts.isIdentifier(d.name) && ['ACTION', 'optionValues'].includes(d.name.text),
      )
    );
  });
  assert.equal(
    declarations.length,
    3,
    'the isolated driver must contain its actual mapping and discovery function',
  );
  return runInNewContext(declarations.map(d => d.getText(parsed)).join('\n') + '\neventKinds;');
}

function irWithListener(event, nested = false) {
  const element = { kind: 'element', tag: 'div', listeners: [{ event, handler: 0 }] };
  return {
    components: [
      {
        template: nested
          ? [{ kind: 'if', then: [{ kind: 'component', slots: [{ body: [element] }] }] }]
          : [element],
      },
    ],
  };
}

test('every boundary-only program schedules hover differential actions', async () => {
  const eventKinds = await differentialEventKinds();
  for (const event of boundaryEvents) {
    for (const nested of [false, true]) {
      assert.deepEqual([...eventKinds(irWithListener(event, nested))], ['hover']);
    }
  }
});

test('boundary-only selects receive hover while input/change retain choose', async () => {
  const eventKinds = await differentialEventKinds();
  for (const event of [...boundaryEvents, 'input', 'change']) {
    const ir = irWithListener(event);
    ir.components[0].template[0].tag = 'select';
    assert.deepEqual([...eventKinds(ir)], [boundaryEvents.includes(event) ? 'hover' : 'choose']);
  }
});

test('unmapped differential listeners fail discovery instead of yielding mount-only coverage', async () => {
  const eventKinds = await differentialEventKinds();
  for (const event of ['not-an-event', 'toString', 'focus']) {
    assert.throws(
      () => eventKinds(irWithListener(event)),
      error =>
        error.code === 'E_DIFFERENTIAL_ACTION' && error.message.includes(JSON.stringify(event)),
    );
  }
  const select = irWithListener('not-an-event');
  select.components[0].template[0].tag = 'select';
  assert.throws(
    () => eventKinds(select),
    error => error.code === 'E_DIFFERENTIAL_ACTION',
    'select action special-casing must not bypass the unsupported-event guard',
  );
  assert.deepEqual([...eventKinds(irWithListener('click'))], ['click']);
});

async function differentialTraceHelpers() {
  const source = await readFile(path.join(repo, 'conformance/differential.mjs'), 'utf8');
  const parsed = ts.createSourceFile(
    'differential.mjs',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const names = ['sameTraceAction', 'resolvedPointerActions', 'traceCoverage'];
  const declarations = parsed.statements.filter(
    statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text),
  );
  assert.equal(declarations.length, names.length);
  return runInNewContext(
    declarations.map(d => d.getText(parsed)).join('\n') +
      '\n({ resolvedPointerActions, traceCoverage });',
  );
}

const nativeTrace = actions => ({
  steps: [null, ...actions].map(action => ({ action, dom: { tag: 'div' } })),
});
const interpreterTrace = actions =>
  [null, ...actions].map(action => ({ action, state: { dom: [] } }));
const resolvedTarget = (overrides = {}) => ({
  kind: 'element',
  elementPath: [1, 0],
  tag: 'span',
  id: 'label-b',
  point: { x: 40.5, y: 21.25 },
  ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));

test('differential coverage requires the initial state and every requested action', async () => {
  const { traceCoverage } = await differentialTraceHelpers();
  const actions = [{ kind: 'wheel', nth: 7, deltaX: 0, deltaY: 100 }],
    actual = nativeTrace(actions);
  actual.steps[1].action = { deltaY: 100, nth: 7, kind: 'wheel', deltaX: 0 };
  const coverage = traceCoverage(actions, interpreterTrace(actions), actual);
  assert.equal(coverage.complete, true);
  assert.equal(coverage.comparableSteps, 2);
  assert.equal(coverage.issues.length, 0);
});

test('differential missing and extra states cannot silently pass a common prefix', async () => {
  const { traceCoverage } = await differentialTraceHelpers();
  const actions = [
    { kind: 'hover', nth: 1 },
    { kind: 'hover', nth: 2 },
  ];
  for (const side of ['native', 'interpreter'])
    for (const length of [0, 1, 2, 4]) {
      const expected = interpreterTrace(actions),
        actual = nativeTrace(actions);
      const rows = side === 'native' ? actual.steps : expected;
      if (length > rows.length) rows.push(rows.at(-1));
      else rows.length = length;
      const coverage = traceCoverage(actions, expected, actual);
      assert.equal(coverage.complete, false);
      assert.equal(coverage.comparableSteps, 0);
      assert.ok(coverage.issues.some(issue => issue.kind === 'unreported-trace-length'));
    }
});

test('malformed differential traces and shifted actions fail coverage', async () => {
  const { traceCoverage } = await differentialTraceHelpers();
  const actions = [{ kind: 'hover', nth: 1 }],
    expected = interpreterTrace(actions);
  for (const actual of [
    { steps: null },
    { steps: {} },
    { steps: [null] },
    {
      steps: [
        { action: null, dom: null },
        { action: actions[0], dom: {} },
      ],
    },
    nativeTrace([{ kind: 'hover', nth: 2 }]),
  ]) {
    const coverage = traceCoverage(actions, expected, actual);
    assert.equal(coverage.complete, false);
    assert.ok(coverage.issues.length > 0);
  }
});

test('hidden-target stops preserve only the correctly reported incomplete prefix', async () => {
  const { traceCoverage } = await differentialTraceHelpers();
  const actions = [
    { kind: 'hover', nth: 1 },
    { kind: 'hover', nth: 2 },
  ];
  const actual = nativeTrace(actions.slice(0, 1));
  actual.stopped = 'action 2 targets hidden, which a pointer at its centre does not hit';
  const valid = traceCoverage(actions, interpreterTrace(actions), actual);
  assert.equal(valid.validStop, true);
  assert.equal(valid.complete, false);
  assert.equal(valid.comparableSteps, 2);
  assert.equal(valid.issues.length, 0);
  for (const stopped of ['action 1 targets hidden', 'action 3 targets hidden', '', true]) {
    const invalid = traceCoverage(actions, interpreterTrace(actions), { ...actual, stopped });
    assert.equal(invalid.complete, false);
    assert.ok(invalid.issues.some(issue => issue.kind === 'invalid-native-stop'));
  }
});

test('matching render errors are explicit incomplete traces, not unexplained truncation', async () => {
  const { traceCoverage } = await differentialTraceHelpers();
  const actions = [
    { kind: 'hover', nth: 1 },
    { kind: 'hover', nth: 2 },
  ];
  const expected = interpreterTrace(actions.slice(0, 1)),
    actual = nativeTrace(actions.slice(0, 1));
  expected[1].state.dom = { error: 'E_THROW duplicate key' };
  actual.steps[1].renderErrors = ['duplicate key'];
  const valid = traceCoverage(actions, expected, actual);
  assert.equal(valid.complete, false);
  assert.equal(valid.comparableSteps, 2);
  assert.equal(valid.issues.length, 0);
  for (const errors of [[], ['different key'], true]) {
    const changed = structuredClone(actual);
    changed.steps[1].renderErrors = errors;
    const invalid = traceCoverage(actions, expected, changed);
    assert.equal(invalid.complete, false);
    assert.ok(invalid.issues.length > 0);
  }
});

test('pointer replay preserves original physical actions and asserts the captured live endpoint', async () => {
  const { resolvedPointerActions, traceCoverage } = await differentialTraceHelpers();
  for (const kind of ['click', 'dblclick', 'contextmenu', 'hover', 'wheel']) {
    const actions = [{ kind, nth: 7, deltaX: 0, deltaY: 100 }],
      original = structuredClone(actions);
    const actual = nativeTrace(actions);
    actual.steps[1].pointerTarget = resolvedTarget();
    const replay = resolvedPointerActions(actions, actual);
    assert.equal(replay.complete, true);
    assert.deepEqual(plain(replay.actions), [
      { ...original[0], elementPath: [1, 0], targetTag: 'span', targetId: 'label-b' },
    ]);
    assert.deepEqual(actions, original);
    assert.equal(
      traceCoverage(actions, interpreterTrace(replay.actions), actual, replay.actions).complete,
      true,
    );
    actual.steps[1].pointerTarget.elementPath[0] = 99;
    assert.deepEqual(plain(replay.actions[0].elementPath), [1, 0]);
  }
});

test('shifted native action identity cannot dictate any replay endpoint', async () => {
  const { resolvedPointerActions } = await differentialTraceHelpers();
  const actions = [
      { kind: 'hover', nth: 1 },
      { kind: 'hover', nth: 2 },
    ],
    actual = nativeTrace(actions);
  for (const step of actual.steps.slice(1)) step.pointerTarget = resolvedTarget();
  actual.steps[2].action = { kind: 'hover', nth: 3 };
  const replay = resolvedPointerActions(actions, actual);
  assert.equal(replay.complete, false);
  assert.ok(replay.issues.some(issue => issue.kind === 'native-step-action-mismatch'));
  assert.deepEqual(plain(replay.actions), actions);
});

test('missing pointer evidence stays incomplete while no-target and nonpointer actions retain their model', async () => {
  const { resolvedPointerActions } = await differentialTraceHelpers();
  const actions = [{ kind: 'hover', nth: 1 }];
  for (const target of [
    undefined,
    { kind: 'unavailable', reason: 'outside mount' },
    resolvedTarget({ elementPath: [] }),
    resolvedTarget({ elementPath: [-1] }),
    resolvedTarget({ point: { x: NaN, y: 1 } }),
    resolvedTarget({ id: 9 }),
  ]) {
    const actual = nativeTrace(actions);
    actual.steps[1].pointerTarget = target;
    const replay = resolvedPointerActions(actions, actual);
    assert.equal(replay.complete, false);
    assert.equal(replay.incomplete.length, 1);
    assert.deepEqual(plain(replay.actions), actions);
  }
  const none = nativeTrace(actions);
  none.steps[1].pointerTarget = { kind: 'none' };
  assert.equal(resolvedPointerActions(actions, none).complete, true);
  const input = [{ kind: 'input', nth: 3, value: 'text' }];
  assert.equal(resolvedPointerActions(input, nativeTrace(input)).complete, true);
  const nullable = nativeTrace(actions);
  nullable.steps[1].pointerTarget = resolvedTarget({ id: null });
  assert.equal(resolvedPointerActions(actions, nullable).actions[0].targetId, null);
});
