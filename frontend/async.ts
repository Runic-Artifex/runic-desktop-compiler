// Async functions as state machines (docs/design/M4-EFFECTS.md, "Promises and
// async functions"). The IR, the interpreter and codegen only see promises,
// closures and the scheduler:
//
//   let $promise = promise.pending()    // the function's result
//   let $state = 0, $thrown = false, $error, $step, $value<k>, … hoisted locals
//   let $resume<k> = (v) => { $value<k> = v; $step() }   // one per await
//   let $reject = (e) => { $error = e; $thrown = true; $step() }
//   $step = () => machine: while (true) {
//     try { if ($state === 0) { … } else if ($state === 1) { … } … }
//     catch (e) { the catch state of the try range holding $state, or fail }
//   }
//   $step(); return $promise
//
// Statements without `await` stay structured inside one state; statements
// containing `await` are split into states. An `await e` stores the resume
// state, registers `$resume<k>`/`$reject` with `then(Promise.resolve(e))`
// (one tick after `e` settles, as in V8) and leaves `$step`; the resume state
// rethrows a rejection at the await point.

import ts from 'typescript';
import type { Expr, Fn, Stmt, Type } from './ir.ts';
import { COMPOUND, FnBuilder, Lowerer, remapLocals, skipParens } from './language.ts';

const NUMBER: Type = 'number';
const BOOLEAN: Type = 'boolean';
const VOID: Type = 'void';
const lit = (value: number | boolean): Expr => ({ op: 'lit', value });

/** Whether `n` contains an `await` (outside nested functions). */
export function containsAwait(n: ts.Node): boolean {
  let found = false;
  const visit = (x: ts.Node) => {
    if (found) return;
    if (ts.isAwaitExpression(x) || (ts.isForOfStatement(x) && x.awaitModifier)) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(x)) return;
    ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
}

export function isAsync(decl: ts.FunctionLikeDeclaration): boolean {
  return !!ts
    .getModifiers(decl as ts.HasModifiers)
    ?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword);
}

/** Symbols that nested functions of `decl` refer to. */
function capturedSymbols(lower: Lowerer, decl: ts.Node): Set<ts.Symbol> {
  const out = new Set<ts.Symbol>();
  const inner = (n: ts.Node) => {
    if (ts.isIdentifier(n)) {
      const s = lower.checker.getSymbolAtLocation(n);
      if (s) out.add(s);
    }
    ts.forEachChild(n, inner);
  };
  const outer = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== decl) inner(n);
    else ts.forEachChild(n, outer);
  };
  ts.forEachChild(decl, outer);
  return out;
}

/**
 * The body of async function `decl`, lowered into `b` (its parameters are
 * registered and boxed). `value` is the type the promise fulfils with; with
 * `discard` (event handlers) the promise is not returned.
 */
export function asyncBody(
  lower: Lowerer,
  decl: ts.FunctionLikeDeclaration,
  b: FnBuilder,
  value: Type,
  discard = false,
): Stmt[] {
  const fail = (n: ts.Node, message: string): never => lower.fail(n, 'E_ASYNC', message);
  const errorType: Type = { record: lower.errorRecord() };
  const promiseType: Type = { promise: value };
  const captured = capturedSymbols(lower, decl);
  // Locals of `b` (boxed: the machine's closures share them), declared in
  // order before any closure is created.
  const outer: { local: number; init?: Expr }[] = [];
  const own = (name: string, type: Type, init?: Expr) => {
    const local = b.local(name, type, true);
    outer.push({ local, ...(init ? { init } : {}) });
    return local;
  };
  const promise = own('$promise', promiseType, {
    op: 'builtin',
    name: 'promise.pending',
    args: [],
    type: promiseType,
  });
  const state = own('$state', NUMBER, lit(0));
  const thrown = own('$thrown', BOOLEAN, lit(false));
  const error = own('$error', errorType);
  const step = own('$step', { fn: { params: [], result: VOID } });

  // A closure of `b` built by hand: `params` become its parameters.
  const closure = (name: string, params: Type[], body: (f: FnBuilder) => Stmt[]): Expr => {
    const f = new FnBuilder(`${b.name}.${name}`, b, b.component, new Set(), false);
    for (const [i, t] of params.entries()) f.param(`p${i}`, t);
    const stmts = body(f);
    const index = lower.reserve();
    const fn: Fn = {
      name: f.name,
      ...(b.component !== undefined ? { component: b.component } : {}),
      ...(f.captures.length ? { captures: f.captures } : {}),
      params: f.params,
      locals: f.locals,
      result: VOID,
      body: remapLocals(stmts, i => f.final(i)),
    };
    lower.functions[index] = fn;
    return { op: 'closure', function: index, captures: f.captureSources.map(c => c.local) };
  };
  const callStep = (f: FnBuilder): Stmt => ({
    op: 'expr',
    value: { op: 'call-value', callee: { op: 'local', local: f.resolve(b, step) }, args: [] },
  });
  const reject = own('$reject', { fn: { params: [errorType], result: VOID } });
  const resumes: { local: number; init: () => Expr }[] = [];

  // --- The machine (`$step`) ---
  const s = new FnBuilder(`${b.name}.async`, b, b.component, b.boxed, false);
  const machine = s.label('machine');
  const at = (local: number): Expr => ({ op: 'local', local: s.resolve(b, local) });
  const set = (local: number, v: Expr): Stmt => ({
    op: 'assign',
    target: { place: 'local', local: s.resolve(b, local) },
    value: v,
  });
  const states: Stmt[][] = [[]];
  let cur = 0;
  const newState = () => states.push([]) - 1;
  const emit = (...st: Stmt[]) => states[cur].push(...st);
  const jump = (k: number): Stmt[] => [set(state, lit(k)), { op: 'continue', label: machine }];
  const tries: { from: number; to: number; handler: number }[] = [];
  let loopDepth = 0;
  let awaits = 0;
  const builtin = (name: string, args: Expr[], type: Type = VOID): Expr => ({
    op: 'builtin',
    name,
    args,
    type,
  });
  const settle = (name: 'fulfil' | 'adopt', v: Expr): Stmt[] => [
    { op: 'expr', value: builtin(`promise.${name}`, [at(promise), v]) },
    { op: 'return' },
  ];
  // `return e` inside the machine: fulfil (or adopt a returned promise).
  s.asyncReturn = (e, node) => {
    if (!e) return settle('fulfil', { op: 'undefined', type: VOID });
    if (containsAwait(e)) return fail(node, 'await inside a return value is planned for later');
    // `return undefined`: the contextual type is `T | PromiseLike<T>`; the value is the result's.
    const bare = skipParens(e);
    if (
      ts.isIdentifier(bare) &&
      bare.text === 'undefined' &&
      !lower.binding(bare) &&
      typeof value === 'object' &&
      'maybe' in value
    )
      return settle('fulfil', { op: 'undefined', type: value });
    const v = lower.expr(e, s);
    const t = lower.irType(v, s);
    if (typeof t === 'object' && 'promise' in t) return settle('adopt', v);
    return settle('fulfil', lower.coerce(e, s, value));
  };

  /** `await e` in the current state; returns the awaited value. */
  const awaitValue = (e: ts.Expression): Expr => {
    const k = awaits++;
    const awaited = lower.expr(e, s);
    const t = lower.irType(awaited, s);
    const settled = typeof t === 'object' && 'promise' in t ? t.promise : t;
    const promised: Type = { promise: settled };
    const slot = own(`$value${k}`, settled);
    const resume = b.local(`$resume${k}`, { fn: { params: [settled], result: VOID } }, true);
    resumes.push({
      local: resume,
      init: () =>
        closure(`resume${k}`, [settled], f => [
          {
            op: 'assign',
            target: { place: 'local', local: f.resolve(b, slot) },
            value: { op: 'local', local: 0 },
          },
          callStep(f),
        ]),
    });
    const after = newState();
    emit(
      set(state, lit(after)),
      {
        op: 'expr',
        value: builtin(
          'promise.then',
          [builtin('promise.resolve', [awaited], promised), at(resume), at(reject)],
          { promise: VOID },
        ),
      },
      { op: 'return' },
    );
    cur = after;
    // A rejection is thrown at the await point.
    emit({
      op: 'if',
      test: at(thrown),
      then: [set(thrown, lit(false)), { op: 'throw', value: at(error) }],
    });
    return at(slot);
  };

  /** A variable of a split statement list: a local of `b`, live across states. */
  const hoist = (d: ts.Node, name?: ts.Identifier): number => {
    const id = name ?? (d as ts.VariableDeclaration).name;
    if (!ts.isIdentifier(id))
      return fail(d, 'Destructuring declarations next to await are planned for later');
    const sym = lower.checker.getSymbolAtLocation(id)!;
    if (loopDepth && captured.has(sym))
      fail(d, 'A closure capturing a loop variable across await is planned for later');
    const type =
      lower.types.typeOrUndefined(id) ??
      fail(d, `${id.text} needs a type annotation next to await`);
    const local = b.local(id.text, type, true);
    outer.push({ local });
    lower.bindings.set(sym, { kind: 'local', owner: b, local });
    return local;
  };

  const assignTo = (target: ts.Expression, v: Expr) => {
    if (!ts.isIdentifier(target)) fail(target, 'await results are assigned to variables');
    emit(...lower.writeTo(target, v, s));
  };

  /** A loop split into states: `test` ends its state; `body` runs between. */
  const loop = (
    stmt: ts.IterationStatement,
    parts: {
      test?: (exit: Stmt[]) => void;
      body: ts.Statement;
      update?: () => void;
      testFirst: boolean;
    },
  ) => {
    const test = newState();
    const body = newState();
    const update = parts.update ? newState() : test;
    const end = newState();
    const label = ts.isLabeledStatement(stmt.parent) ? stmt.parent.label.text : s.label('loop');
    emit(...jump(parts.testFirst ? test : body));
    cur = test;
    parts.test?.(jump(end));
    emit(...jump(body));
    cur = body;
    s.loops.push({ label, real: true, jump: { break: jump(end), continue: jump(update) } });
    loopDepth++;
    statement(parts.body);
    loopDepth--;
    s.loops.pop();
    emit(...jump(update));
    if (parts.update) {
      cur = update;
      parts.update();
      emit(...jump(test));
    }
    cur = end;
  };

  const statement = (st: ts.Statement): void => {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init =
          d.initializer && ts.isAwaitExpression(skip(d.initializer)) ? d.initializer : undefined;
        if (d.initializer && !init && containsAwait(d.initializer))
          fail(d.initializer, 'await is supported as the whole initialiser');
        const v = init ? awaitValue((skip(init) as ts.AwaitExpression).expression) : undefined;
        if (ts.isObjectBindingPattern(d.name)) {
          // `const { a, b: c } = await e`: the value in a hoisted temporary,
          // then each name from its field (or a class instance's member).
          if (!d.initializer) fail(d, 'Destructuring requires an initializer');
          const value = v ?? lower.expr(d.initializer!, s);
          const type = lower.irType(value, s);
          const tmp = b.local('$destructure', type, true);
          outer.push({ local: tmp });
          emit(set(tmp, value));
          for (const el of d.name.elements) {
            const key = (el.propertyName ?? el.name) as ts.Identifier;
            if (el.dotDotDotToken || !ts.isIdentifier(key) || !ts.isIdentifier(el.name))
              fail(el, 'Destructuring next to await takes plain names');
            const record = typeof type === 'object' && 'record' in type ? type.record : undefined;
            if (record === undefined) fail(d, 'Object destructuring requires a record value');
            let read: Expr = lower.types.records[record!].class
              ? lower.classes.readMember(type, at(tmp), key, el, el.name, s)
              : {
                  op: 'get',
                  object: at(tmp),
                  field: lower.types.fieldIndex(record!, key.text, el),
                };
            if (el.initializer)
              read = { op: 'nullish', left: read, right: lower.expr(el.initializer, s) };
            const local = hoist(el, el.name as ts.Identifier);
            emit(set(local, read));
          }
          continue;
        }
        const local = hoist(d);
        if (v) emit(set(local, v));
        else if (d.initializer) {
          const f = skip(d.initializer);
          const value =
            ts.isArrowFunction(f) || ts.isFunctionExpression(f)
              ? lower.closure(f, s, (d.name as ts.Identifier).text)
              : lower.coerce(d.initializer, s, b.typeOf(local));
          emit(set(local, value));
        }
      }
      return;
    }
    if (!containsAwait(st)) {
      if (ts.isFunctionDeclaration(st))
        fail(st, 'Function declarations in async functions are planned for later');
      emit(...lower.statement(st, s));
      return;
    }
    if (ts.isBlock(st)) {
      for (const x of st.statements) statement(x);
      return;
    }
    if (ts.isExpressionStatement(st)) {
      const e = skip(st.expression);
      if (ts.isAwaitExpression(e)) {
        awaitValue(e.expression);
        return;
      }
      if (
        ts.isBinaryExpression(e) &&
        e.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isAwaitExpression(skip(e.right)) &&
        !containsAwait(e.left)
      ) {
        assignTo(e.left, awaitValue((skip(e.right) as ts.AwaitExpression).expression));
        return;
      }
      // `x op= await e` reads x before the await, as JavaScript does.
      const compound = ts.isBinaryExpression(e) && COMPOUND[e.operatorToken.kind];
      if (
        compound &&
        ts.isBinaryExpression(e) &&
        ts.isIdentifier(e.left) &&
        ts.isAwaitExpression(skip(e.right))
      ) {
        const old = lower.expr(e.left, s);
        const type = lower.irType(old, s);
        const before = own(`$before${awaits}`, type);
        emit(set(before, old));
        const v = awaitValue((skip(e.right) as ts.AwaitExpression).expression);
        assignTo(e.left, lower.binary(compound, at(before), type, v, lower.irType(v, s), e));
        return;
      }
      return fail(
        st,
        'await is supported as a statement, an initialiser, an assignment or a return value',
      );
    }
    if (ts.isReturnStatement(st)) {
      const e = st.expression && skip(st.expression);
      if (e && ts.isAwaitExpression(e) && !containsAwait(e.expression)) {
        const v = awaitValue(e.expression);
        emit(...settle('fulfil', v));
        return;
      }
      return fail(st, 'await inside a return value is planned for later');
    }
    if (ts.isIfStatement(st)) {
      if (containsAwait(st.expression))
        fail(st.expression, 'await in a condition is planned for later');
      const test = lower.expr(st.expression, s);
      const yes = newState();
      const no = st.elseStatement ? newState() : undefined;
      const after = newState();
      emit({ op: 'if', test, then: jump(yes), else: jump(no ?? after) });
      cur = yes;
      statement(st.thenStatement);
      emit(...jump(after));
      if (no !== undefined) {
        cur = no;
        statement(st.elseStatement!);
        emit(...jump(after));
      }
      cur = after;
      return;
    }
    if (ts.isWhileStatement(st) || ts.isDoStatement(st)) {
      if (containsAwait(st.expression))
        fail(st.expression, 'await in a condition is planned for later');
      loop(st, {
        testFirst: ts.isWhileStatement(st),
        test: exit => {
          const test = lower.expr(st.expression, s);
          emit({ op: 'if', test: { op: 'not', arg: test }, then: exit });
        },
        body: st.statement,
      });
      return;
    }
    if (ts.isForStatement(st)) {
      if (
        (st.condition && containsAwait(st.condition)) ||
        (st.incrementor && containsAwait(st.incrementor))
      )
        fail(st, 'await in a loop header is planned for later');
      const init = st.initializer;
      if (init && ts.isVariableDeclarationList(init)) {
        loopDepth++;
        for (const d of init.declarations) {
          if (d.initializer && containsAwait(d.initializer))
            fail(d, 'await in a loop header is planned for later');
          const local = hoist(d);
          if (d.initializer) emit(set(local, lower.coerce(d.initializer, s, b.typeOf(local))));
        }
        loopDepth--;
      } else if (init) {
        if (containsAwait(init)) fail(init, 'await in a loop header is planned for later');
        emit(
          ...lower.statement(ts.factory.createExpressionStatement(init as ts.Expression), s, init),
        );
      }
      loop(st, {
        testFirst: true,
        test: st.condition
          ? exit => {
              const test = lower.expr(st.condition!, s);
              emit({ op: 'if', test: { op: 'not', arg: test }, then: exit });
            }
          : undefined,
        body: st.statement,
        update: st.incrementor
          ? () =>
              emit(
                ...lower.statement(
                  ts.factory.createExpressionStatement(st.incrementor!),
                  s,
                  st.incrementor,
                ),
              )
          : undefined,
      });
      return;
    }
    if (ts.isForOfStatement(st)) {
      if (st.awaitModifier) fail(st, 'for await is planned for later');
      if (containsAwait(st.expression))
        fail(st.expression, 'await in a loop header is planned for later');
      const items = lower.expr(st.expression, s);
      const t = lower.irType(items, s);
      if (!(typeof t === 'object' && 'array' in t))
        return fail(
          st.expression,
          'Loops with await iterate arrays (maps and sets are planned for later)',
        );
      if (!ts.isVariableDeclarationList(st.initializer) || st.initializer.declarations.length !== 1)
        return fail(st.initializer, 'for-of with await declares one variable');
      const list = own('$items', t);
      const index = own('$index', NUMBER);
      emit(set(list, items), set(index, lit(0)));
      loopDepth++;
      const item = hoist(st.initializer.declarations[0]);
      loopDepth--;
      // Array iteration reads the length and the element at each step (live).
      loop(st, {
        testFirst: true,
        test: exit => {
          emit({
            op: 'if',
            test: {
              op: 'ge',
              left: at(index),
              right: builtin('array.length', [at(list)], NUMBER),
            },
            then: exit,
          });
          emit(set(item, { op: 'index', array: at(list), index: at(index) }));
          emit(set(index, { op: 'add', left: at(index), right: lit(1) }));
        },
        body: st.statement,
      });
      return;
    }
    if (ts.isLabeledStatement(st)) return statement(st.statement);
    if (ts.isTryStatement(st)) {
      if (st.finallyBlock) fail(st.finallyBlock, 'finally with await is planned for later');
      const from = newState();
      emit(...jump(from));
      cur = from;
      statement(st.tryBlock);
      const after = newState();
      emit(...jump(after));
      const handler = newState();
      tries.push({ from, to: after, handler });
      cur = handler;
      const v = st.catchClause!.variableDeclaration;
      if (v) {
        if (!ts.isIdentifier(v.name)) fail(v, 'Destructured catch bindings are planned for later');
        // `unknown` in TypeScript; thrown values are Error records.
        const sym = lower.checker.getSymbolAtLocation(v.name)!;
        lower.types.override(sym, errorType);
        const local = b.local((v.name as ts.Identifier).text, errorType, true);
        outer.push({ local });
        lower.bindings.set(sym, { kind: 'local', owner: b, local });
        emit(set(local, at(error)));
      }
      statement(st.catchClause!.block);
      emit(...jump(after));
      cur = after;
      return;
    }
    return fail(st, 'This statement cannot contain await yet');
  };

  const body = ts.isBlock(decl.body!) ? decl.body.statements : undefined;
  if (body) for (const st of body) statement(st);
  else {
    const e = skip(decl.body as ts.Expression);
    if (ts.isAwaitExpression(e)) emit(...settle('fulfil', awaitValue(e.expression)));
    else if (!containsAwait(e)) emit(...s.asyncReturn(e, e));
    else fail(e, 'await inside an expression body is planned for later');
  }
  // Falling off the end fulfils with undefined (TypeScript makes it
  // unreachable for other result types).
  emit(
    ...(value === VOID
      ? settle('fulfil', { op: 'undefined', type: VOID })
      : [{ op: 'return' } as Stmt]),
  );

  // Dispatch: the state blocks, then the exception routing of the try ranges.
  let dispatch: Stmt[] = [];
  for (let k = states.length - 1; k >= 0; k--)
    dispatch = [
      {
        op: 'if',
        test: { op: 'eq', left: at(state), right: lit(k) },
        then: states[k],
        ...(dispatch.length ? { else: dispatch } : {}),
      },
    ];
  const caught = s.local('$caught', errorType);
  let route: Stmt[] = [
    { op: 'expr', value: builtin('promise.fail', [at(promise), { op: 'local', local: caught }]) },
    { op: 'return' },
  ];
  // Innermost try first: ranges are nested, so the narrower one is tested first.
  for (const t of [...tries].sort((x, y) => y.to - y.from - (x.to - x.from)))
    route = [
      {
        op: 'if',
        test: {
          op: 'and',
          left: { op: 'ge', left: at(state), right: lit(t.from) },
          right: { op: 'lt', left: at(state), right: lit(t.to) },
        },
        then: [set(error, { op: 'local', local: caught }), ...jump(t.handler)],
        else: route,
      },
    ];
  const machineBody: Stmt[] = [
    {
      op: 'while',
      label: machine,
      test: lit(true),
      body: [{ op: 'try', body: dispatch, catch: { local: caught, body: route } }],
    },
  ];
  const sIndex = lower.reserve();
  lower.functions[sIndex] = {
    name: s.name,
    ...(b.component !== undefined ? { component: b.component } : {}),
    ...(s.captures.length ? { captures: s.captures } : {}),
    params: [],
    locals: s.locals,
    result: VOID,
    body: remapLocals(machineBody, i => s.final(i)),
  };
  const machineClosure: Expr = {
    op: 'closure',
    function: sIndex,
    captures: s.captureSources.map(c => c.local),
  };

  // The function body: locals, continuations, the machine, its first step.
  const out: Stmt[] = outer.map(
    ({ local, init }) => ({ op: 'let', local, ...(init ? { value: init } : {}) }) as Stmt,
  );
  for (const r of resumes) out.push({ op: 'let', local: r.local, value: r.init() });
  out.push({
    op: 'let',
    local: reject,
    value: closure('reject', [errorType], f => [
      {
        op: 'assign',
        target: { place: 'local', local: f.resolve(b, error) },
        value: { op: 'local', local: 0 },
      },
      { op: 'assign', target: { place: 'local', local: f.resolve(b, thrown) }, value: lit(true) },
      callStep(f),
    ]),
  });
  out.push({ op: 'assign', target: { place: 'local', local: step }, value: machineClosure });
  out.push({
    op: 'expr',
    value: { op: 'call-value', callee: { op: 'local', local: step }, args: [] },
  });
  if (!discard) out.push({ op: 'return', value: { op: 'local', local: promise } });
  return out;
}

function skip(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}
