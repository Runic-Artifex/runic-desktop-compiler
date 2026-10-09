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
