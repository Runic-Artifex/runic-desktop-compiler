// The order of a Vue component's watchers in a flush
// (docs/design/REACTIVITY-ALIASING.md, "Watcher order").
//
// runtime-core queues the pre jobs of one instance in the order they are
// triggered (queueJob, findInsertionIndex): by the order of the flush's
// writes and, for one write, by the order of the written signal's
// subscribers. A write notifies its signals in one batch (endBatch), in
// which a subscriber reached later comes first; subscribers are in the order
// they began to depend on the signal (Vue's dep links), and a watcher that
// stops reading a signal, or whose link is taken over by a computed value
// evaluated for the first time inside the watcher's run (`dep.activeLink`),
// subscribes again at the tail. Runic runs an instance's due watchers in
// declaration order. Both orders agree for a watcher W_i declared before
// W_j when their effects commute, or when every flush that may trigger both
// is one where:
//
// - every signal of W_j that the flush may write is a ref, a prop or a
//   record field reached through one, whose writes notify one signal per
//   batch, and W_i reads it unconditionally in every run (it subscribed
//   first, at its creation, and keeps its link);
// - W_i depends on no computed value (a computed's subscribers are notified
//   at the computed's own position among the written signal's subscribers);
// - W_i's cleanups, which run inside its tracked run for watchEffect,
//   evaluate computed values only where their links are settled: read
//   unconditionally at the root of their component's template, with a fixed
//   set of signals.
//
// Other pairs of watchers whose effects do not commute are rejected
// (E_EFFECT). Modelling Vue's queue order instead would need a schedule
// policy (docs/gaps/FRAMEWORKS.md).
import type { Component, Expr, Fn, Global, Node, RecordType, Source, Stmt, Type } from '../ir.ts';

type Key = string;
const key = (k: number, c: number): Key => `${k}:${c}`;
type Obj = Record<string, unknown>;

export interface WatchOrderInput {
  components: Component[];
  functions: Fn[];
  records: RecordType[];
  globals: Global[];
  /** Setup constants of a component: cells that are not Vue signals. */
  plain: (component: number, cell: number) => boolean;
  /** Cells Vue writes itself while rendering (template refs). */
  runtimeWritten: (component: number, cell: number) => boolean;
  fail: (code: string, message: string, source?: Source) => never;
}

/** A place where code runs: a function, or a handler of a component (its own local space). */
interface Ctx {
  /** The component whose cells `cell` names. */
  component?: number;
  /** Prefix of the local slots of the running body. */
  slot: string;
}

/** Function values a local slot may hold. */
interface FnSet {
  fns: Set<number>;
  unknown: boolean;
}

/** What code may do, through the functions it reaches. */
interface Effects {
  reads: Set<Key>;
  writes: Set<Key>;
  /** Heap mutations of any object (plain ones included: logs). */
  heapW: boolean;
  /** Heap mutations of objects that may be reactive. */
  reactiveW: boolean;
  heapR: boolean;
  /** Host services: timers, microtasks, promises, storage, the DOM, … */
  host: boolean;
  /** Calls of function values the analysis does not resolve. */
  unknown: boolean;
  /** Computed values evaluated. */
  computeds: Set<number>;
}

/** What a flush may write. */
interface Writes {
  cells: Set<Key>;
  reactiveW: boolean;
  unknown: boolean;
}

const MUTATORS =
  /^(array\.(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set)|map\.(set|delete|clear)|set\.(add|delete|clear))$/;
/** Built-ins whose callbacks run later, not during the call. */
const DEFERRED = /^(timer|microtask|promise)\./;
const HOST =
  /^(timer|microtask|promise|storage|clipboard|history|location|document|element|focus|media|resize|console|host|window|fetch|image|scroll|layout)\./;
/** Built-ins that never throw for well-typed arguments (and run no callbacks). */
const TOTAL =
  /^(math\.|string\.|maybe\.|array\.(push|join|length|includes|index-of|last-index-of|slice|concat|at|pop|shift|unshift|reverse|fill|splice)$)/;

const each = (x: unknown, visit: (o: Obj) => boolean | void): void => {
  if (Array.isArray(x)) return x.forEach(y => each(y, visit));
  if (!x || typeof x !== 'object') return;
  const o = x as Obj;
  if (visit(o) === false) return;
  for (const v of Object.values(o)) if (v && typeof v === 'object') each(v, visit);
};

export function checkWatcherOrder(input: WatchOrderInput): void {
  const { components, functions, records, globals, plain, runtimeWritten, fail } = input;
  const fnCtx = (f: number): Ctx => ({ component: functions[f]?.component, slot: `f${f}` });
  const captures = (f: number) => functions[f]?.captures?.length ?? 0;

  // --- Component sites: where each prop gets its value ---
  const sites = new Map<number, { parent: number; props: { name: string; value: Expr }[] }[]>();
  const templateExprs: { component: number; value: unknown }[] = [];
  components.forEach((c, k) => {
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        switch (n.kind) {
          case 'element':
            templateExprs.push({ component: k, value: { ...n, children: undefined } });
            walk(n.children);
            break;
          case 'text':
          case 'html':
            templateExprs.push({ component: k, value: n });
            break;
          case 'if':
            templateExprs.push({ component: k, value: n.test });
            walk(n.then);
            walk(n.else);
            break;
          case 'each':
            templateExprs.push({ component: k, value: [n.items, n.key] });
            walk(n.body);
            walk(n.else);
            break;
          case 'slot':
            templateExprs.push({ component: k, value: n.args });
            walk(n.fallback);
            break;
          case 'component': {
            const list = sites.get(n.component) ?? [];
            list.push({ parent: k, props: n.props ?? [] });
            sites.set(n.component, list);
            templateExprs.push({ component: k, value: n.props });
            for (const s of n.slots ?? []) walk(s.body);
            break;
          }
        }
      }
    };
    walk(c.template);
  });

  // --- Function values held by locals (flow-insensitive, to a fixpoint) ---
  const slots = new Map<string, FnSet>();
  const slotOf = (s: string): FnSet => {
    let v = slots.get(s);
    if (!v) slots.set(s, (v = { fns: new Set(), unknown: false }));
    return v;
  };
  /** Functions whose parameters the runtime or unknown code may supply. */
  const escaping = new Set<number>();
  for (const c of components) for (const e of c.effects ?? []) escaping.add(e.run);
  each(functions, o => {
    if (o.op === 'closure') escaping.add(o.function as number);
  });
  functions.forEach((f, i) => {
    if (f?.derived || escaping.has(i))
      for (let p = 0; p < (f?.params.length ?? 0); p++)
        slotOf(`f${i}#${captures(i) + p}`).unknown = true;
  });
  // Handlers take what their listeners pass.
  components.forEach((c, k) =>
    c.handlers.forEach((h, i) =>
      (h.params ?? []).forEach((_, p) => (slotOf(`h${k}.${i}#${p}`).unknown = true)),
    ),
  );
  const propSources = (k: number, cell: number, seen = new Set<string>()): FnSet => {
    const out: FnSet = { fns: new Set(), unknown: false };
    const id = key(k, cell);
    if (seen.has(id)) return out;
    seen.add(id);
    const c = components[k].cells[cell];
    const list = sites.get(k) ?? [];
    if (!list.length) out.unknown = true;
    for (const s of list) {
      const given = s.props.find(p => p.name === c.prop);
      const v = given
        ? valuesOf(given.value, { component: s.parent, slot: 'template' }, seen)
        : valuesOf(c.init, { component: k, slot: 'template' }, seen);
      v.fns.forEach(f => out.fns.add(f));
      out.unknown ||= v.unknown;
    }
    return out;
  };
  const valuesOf = (e: Expr | undefined, ctx: Ctx, seen?: Set<string>): FnSet => {
    const out: FnSet = { fns: new Set(), unknown: false };
    const add = (v: FnSet) => {
      v.fns.forEach(f => out.fns.add(f));
      out.unknown ||= v.unknown;
    };
    if (!e) return out;
    switch (e.op) {
      case 'closure':
        out.fns.add(e.function);
        break;
      case 'local':
        if (ctx.slot === 'template') out.unknown = true;
        else add(slotOf(`${ctx.slot}#${e.local}`));
        break;
      case 'some':
      case 'unwrap':
      case 'upcast':
      case 'downcast':
        add(valuesOf(e.value, ctx, seen));
        break;
      case 'cond':
        add(valuesOf(e.then, ctx, seen));
        add(valuesOf(e.else, ctx, seen));
        break;
      case 'and':
      case 'or':
      case 'nullish':
        add(valuesOf(e.left, ctx, seen));
        add(valuesOf(e.right, ctx, seen));
        break;
      case 'with':
        add(valuesOf(e.body, ctx, seen));
        break;
      case 'cell':
        if (
          ctx.component !== undefined &&
          components[ctx.component].cells[e.cell].prop !== undefined
        )
          add(propSources(ctx.component, e.cell, seen));
        else out.unknown = true;
        break;
      case 'undefined':
      case 'null':
        break;
      default:
        out.unknown = true;
    }
    return out;
  };
  const bodies: { stmts: Stmt[]; ctx: Ctx }[] = [
    ...functions.map((f, i) => ({ stmts: f?.body ?? [], ctx: fnCtx(i) })),
    ...components.flatMap((c, k) =>
      c.handlers.map((h, i) => ({ stmts: h.body, ctx: { component: k, slot: `h${k}.${i}` } })),
    ),
  ];
  for (let changed = true; changed;) {
    changed = false;
    const flow = (s: string, v: FnSet) => {
      const t = slotOf(s);
      for (const f of v.fns)
        if (!t.fns.has(f)) {
          t.fns.add(f);
          changed = true;
        }
      if (v.unknown && !t.unknown) changed = t.unknown = true;
    };
    for (const { stmts, ctx } of bodies)
      each(stmts, o => {
        switch (o.op) {
          case 'let':
            if (o.value) flow(`${ctx.slot}#${o.local}`, valuesOf(o.value as Expr, ctx));
            break;
          case 'assign': {
            const t = o.target as { place: string; local?: number };
            if (t.place === 'local') flow(`${ctx.slot}#${t.local}`, valuesOf(o.value as Expr, ctx));
            break;
          }
          case 'with':
          case 'optional':
            flow(`${ctx.slot}#${o.local}`, valuesOf(o.value as Expr, ctx));
            break;
          case 'for-of':
            flow(`${ctx.slot}#${o.local}`, { fns: new Set(), unknown: true });
            break;
          case 'match-union':
          case 'match-class':
            for (const c of o.cases as { local: number }[])
              flow(`${ctx.slot}#${c.local}`, valuesOf(o.value as Expr, ctx));
            break;
          case 'closure': {
            const g = o.function as number;
            (o.captures as number[]).forEach((l, i) =>
              flow(`f${g}#${i}`, slotOf(`${ctx.slot}#${l}`)),
            );
            break;
          }
          case 'call': {
            const g = o.function as number;
            (o.args as Expr[]).forEach((a, i) =>
              flow(`f${g}#${captures(g) + i}`, valuesOf(a, ctx)),
            );
            break;
          }
          case 'call-value':
            for (const g of valuesOf(o.callee as Expr, ctx).fns)
              (o.args as Expr[]).forEach((a, i) =>
                flow(`f${g}#${captures(g) + i}`, valuesOf(a, ctx)),
              );
            break;
        }
      });
  }

  // --- Effects of code (through the functions it reaches) ---
  const freshGlobal = (g: number) => ['array', 'record', 'lit'].includes(globals[g]?.init.op);
  /** Whether mutating `e` may change a reactive object (not a fresh plain constant). */
  const mayBeReactive = (e: Expr | undefined, ctx: Ctx): boolean => {
    if (e?.op === 'cell' && ctx.component !== undefined) {
      const cell = components[ctx.component].cells[e.cell];
      return !(plain(ctx.component, e.cell) && ['array', 'record'].includes(cell.init.op));
    }
    if (e?.op === 'global') return !freshGlobal(e.global);
    return true;
  };
  const local = new Map<string, Effects & { reach: Set<number> }>();
  const localEffects = (stmts: unknown, ctx: Ctx): Effects & { reach: Set<number> } => {
    const r: Effects & { reach: Set<number> } = {
      reads: new Set(),
      writes: new Set(),
      heapW: false,
      reactiveW: false,
      heapR: false,
      host: false,
      unknown: false,
      computeds: new Set(),
      reach: new Set(),
    };
    const k = ctx.component;
    each(stmts, o => {
      switch (o.op) {
        case 'cell':
          if (k !== undefined) r.reads.add(key(k, o.cell as number));
          break;
        case 'set':
          if (k !== undefined) r.writes.add(key(k, o.cell as number));
          break;
        case 'assign': {
          const t = o.target as { place: string; cell?: number; object?: Expr; array?: Expr };
          if (t.place === 'cell' && k !== undefined) r.writes.add(key(k, t.cell!));
          else if (t.place !== 'local') {
            r.heapW = true;
            if (mayBeReactive(t.object ?? t.array, ctx)) r.reactiveW = true;
          }
          break;
        }
        case 'get':
        case 'index':
        case 'for-of':
          r.heapR = true;
          break;
        case 'builtin': {
          const name = o.name as string;
          const args = o.args as Expr[];
          if (MUTATORS.test(name)) {
            r.heapW = true;
            if (mayBeReactive(args[0], ctx)) r.reactiveW = true;
          } else if (/^(array|map|set|json|object)\./.test(name)) r.heapR = true;
          if (HOST.test(name)) r.host = true;
          break;
        }
        case 'call': {
          const g = o.function as number;
          r.reach.add(g);
          if (functions[g]?.derived) r.computeds.add(g);
          break;
        }
        case 'closure':
          r.reach.add(o.function as number);
          return false;
        case 'call-value': {
          const v = valuesOf(o.callee as Expr, ctx);
          v.fns.forEach(f => r.reach.add(f));
          if (v.unknown) r.unknown = true;
          break;
        }
        case 'mount':
          r.unknown = true;
          break;
      }
    });
    return r;
  };
  const fnLocal = (f: number) => {
    const id = `f${f}`;
    if (!local.has(id)) local.set(id, localEffects(functions[f]?.body ?? [], fnCtx(f)));
    return local.get(id)!;
  };
  const effectsOf = (roots: { value: unknown; ctx: Ctx }[]): Effects => {
    const out: Effects = {
      reads: new Set(),
      writes: new Set(),
      heapW: false,
      reactiveW: false,
      heapR: false,
      host: false,
      unknown: false,
      computeds: new Set(),
    };
    const seen = new Set<number>();
    const queue: number[] = [];
    const merge = (e: Effects & { reach: Set<number> }) => {
      e.reads.forEach(x => out.reads.add(x));
      e.writes.forEach(x => out.writes.add(x));
      e.computeds.forEach(x => out.computeds.add(x));
      out.heapW ||= e.heapW;
      out.reactiveW ||= e.reactiveW;
      out.heapR ||= e.heapR;
      out.host ||= e.host;
      out.unknown ||= e.unknown;
      for (const f of e.reach)
        if (!seen.has(f)) {
          seen.add(f);
          queue.push(f);
        }
    };
    for (const r of roots) merge(localEffects(r.value, r.ctx));
    while (queue.length) merge(fnLocal(queue.shift()!));
    return out;
  };

  // --- The signals a watcher depends on ---
  /** A record field path from a cell (`state.value.a.b`), as a signal token. */
  const pathOf = (e: Expr, ctx: Ctx): { token: string; type: Type } | undefined => {
    if (e.op === 'cell' && ctx.component !== undefined)
      return {
        token: `${key(ctx.component, e.cell)}`,
        type: components[ctx.component].cells[e.cell].type,
      };
    if (e.op === 'get') {
      const base = pathOf(e.object, ctx);
      const t = base?.type;
      const r =
        t && typeof t === 'object' && ('record' in t || 'class' in t)
          ? records['record' in t ? t.record : t.class]
          : undefined;
      if (!base || !r || r.tuple) return undefined;
      return { token: `${base.token}.${e.field}`, type: r.fields[e.field].type };
    }
    return undefined;
  };
  /** Whether a read of `e` (a receiver) cannot be of reactive state. */
  const raw = (e: Expr | undefined, ctx: Ctx) => !mayBeReactive(e, ctx);
  const isSignal = (ctx: Ctx, cell: number) =>
    ctx.component !== undefined && !plain(ctx.component, cell);

  /**
   * The signals code reads while Vue tracks it: `c:` refs and props,
   * `p:` record fields reached from a cell, `k:` computed values, `heap`
   * other reactive reads (array elements and lengths, iteration, …),
   * `unknown` for calls the analysis does not resolve.
   */
  const trackedCache = new Map<number, Set<string>>();
  const tracked = (roots: unknown, ctx: Ctx, out: Set<string>, seen: Set<number>): Set<string> => {
    each(roots, o => {
      switch (o.op) {
        case 'cell':
          if (isSignal(ctx, o.cell as number))
            out.add(`c:${key(ctx.component!, o.cell as number)}`);
          break;
        case 'get': {
          const p = pathOf(o as Expr, ctx);
          if (p) out.add(`p:${p.token}`);
          else if (!raw(o.object as Expr, ctx)) out.add('heap');
          break;
        }
        case 'index':
          if (!raw(o.array as Expr, ctx)) out.add('heap');
          break;
        case 'for-of':
          if (!raw(o.iterable as Expr, ctx)) out.add('heap');
          break;
        case 'builtin': {
          const name = o.name as string;
          const args = o.args as Expr[];
          if (/^(array|map|set|json|object)\./.test(name) && !raw(args[0], ctx)) out.add('heap');
          if (!DEFERRED.test(name))
            for (const a of args) if (a.op === 'closure') follow(a.function, out, seen);
          for (const a of args) if (a.op !== 'closure') tracked(a, ctx, out, seen);
          return false;
        }
        case 'call': {
          const g = o.function as number;
          if (functions[g]?.derived) out.add(`k:${g}`);
          else follow(g, out, seen);
          break;
        }
        case 'call-value': {
          const v = valuesOf(o.callee as Expr, ctx);
          v.fns.forEach(f => follow(f, out, seen));
          if (v.unknown) out.add('unknown');
          break;
        }
        case 'closure':
          return false;
        case 'mount':
          out.add('unknown');
          break;
      }
    });
    return out;
  };
  const follow = (f: number, out: Set<string>, seen: Set<number>) => {
    if (seen.has(f)) return;
    seen.add(f);
    tracked(functions[f]?.body ?? [], fnCtx(f), out, seen);
  };
  const trackedFn = (f: number) => {
    if (!trackedCache.has(f))
      trackedCache.set(f, tracked(functions[f]?.body ?? [], fnCtx(f), new Set(), new Set([f])));
    return trackedCache.get(f)!;
  };

  /**
   * The signals code reads in every run: those read before any branch,
   * loop, exit or operation that may throw (a run that stops early drops the
   * links it did not read again). `complete`: the code ran to its end.
   */
  interface Must {
    tokens: Set<string>;
    complete: boolean;
  }
  const mustCache = new Map<number, Must>();
  const mustFn = (f: number, stack: Set<number>): Must => {
    if (mustCache.has(f)) return mustCache.get(f)!;
    if (stack.has(f)) return { tokens: new Set(), complete: false };
    stack.add(f);
    const m: Must = { tokens: new Set(), complete: false };
    m.complete = mustStmts(functions[f]?.body ?? [], fnCtx(f), m.tokens, stack, new Set());
    stack.delete(f);
    mustCache.set(f, m);
    return m;
  };
  /** Statements in order; false where a later statement may not run. */
  const mustStmts = (
    stmts: Stmt[],
    ctx: Ctx,
    out: Set<string>,
    stack: Set<number>,
    nonNull: Set<number>,
  ): boolean => {
    for (const s of stmts) {
      switch (s.op) {
        case 'let':
          if (s.value && !eager(s.value, ctx, out, stack, nonNull)) return false;
          break;
        case 'expr':
          if (!eager(s.value, ctx, out, stack, nonNull)) return false;
          break;
        case 'set':
          if (!eager(s.value, ctx, out, stack, nonNull)) return false;
          break;
        case 'assign': {
          const t = s.target;
          if (t.place === 'field' && !eager(t.object, ctx, out, stack, nonNull)) return false;
          if (
            t.place === 'index' &&
            !(eager(t.array, ctx, out, stack, nonNull) && eager(t.index, ctx, out, stack, nonNull))
          )
            return false;
          if (!eager(s.value, ctx, out, stack, nonNull)) return false;
          break;
        }
        case 'if': {
          if (!eager(s.test, ctx, out, stack, nonNull)) return false;
          // `if (maybe.is-nullish(x)) … else …` (cleanup registration): x is present in `else`.
          const t = s.test as Obj;
          const tested =
            t.op === 'builtin' &&
            t.name === 'maybe.is-nullish' &&
            (t.args as Expr[])[0]?.op === 'local'
              ? (t.args as { local: number }[])[0].local
              : undefined;
          const otherwise = new Set(nonNull);
          if (tested !== undefined) otherwise.add(tested);
          if (!safe(s.then, ctx, stack, nonNull) || !safe(s.else ?? [], ctx, stack, otherwise))
            return false;
          break;
        }
        case 'return':
          return s.value ? eager(s.value, ctx, out, stack, nonNull) : true;
        default:
          if (s.op === 'while') eager(s.test, ctx, out, stack, nonNull);
          if (s.op === 'for-of') eager(s.iterable, ctx, out, stack, nonNull);
          return false;
      }
    }
    return true;
  };
  /** A block that always runs to its end and reads nothing that matters. */
  const safe = (stmts: Stmt[], ctx: Ctx, stack: Set<number>, nonNull: Set<number>): boolean =>
    stmts.every(s => {
      const sink = new Set<string>();
      switch (s.op) {
        case 'let':
          return !s.value || eager(s.value, ctx, sink, stack, nonNull);
        case 'assign':
          return s.target.place === 'local' && eager(s.value, ctx, sink, stack, nonNull);
        case 'expr':
          return eager(s.value, ctx, sink, stack, nonNull);
        case 'if':
          return (
            eager(s.test, ctx, sink, stack, nonNull) &&
            safe(s.then, ctx, stack, nonNull) &&
            safe(s.else ?? [], ctx, stack, nonNull)
          );
        default:
          return false;
      }
    });
  /** Evaluate `e` in order, adding the signals it reads; false where it may throw. */
  const eager = (
    e: Expr,
    ctx: Ctx,
    out: Set<string>,
    stack: Set<number>,
    nonNull: Set<number>,
  ): boolean => {
    const go = (x: Expr) => eager(x, ctx, out, stack, nonNull);
    const quiet = (x: Expr) => eager(x, ctx, new Set(), stack, nonNull);
    switch (e.op) {
      case 'lit':
      case 'undefined':
      case 'null':
      case 'local':
      case 'payload':
      case 'event':
      case 'global':
      case 'closure':
        return true;
      case 'cell':
        if (isSignal(ctx, e.cell)) out.add(`c:${key(ctx.component!, e.cell)}`);
        return true;
      case 'not':
      case 'neg':
      case 'to-string':
      case 'to-number':
      case 'to-boolean':
      case 'utf16-length':
      case 'typeof':
      case 'bit-not':
        return go(e.arg);
      case 'and':
      case 'or':
      case 'nullish':
        return go(e.left) && quiet(e.right);
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'rem':
      case 'pow':
      case 'min':
      case 'max':
      case 'concat':
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge':
      case 'bit-and':
      case 'bit-or':
      case 'bit-xor':
      case 'shl':
      case 'shr':
      case 'ushr':
        return go(e.left) && go(e.right);
      case 'cond':
        return go(e.test) && quiet(e.then) && quiet(e.else);
      case 'get': {
        if (!go(e.object)) return false;
        const p = pathOf(e, ctx);
        if (p) out.add(`p:${p.token}`);
        else if (!raw(e.object, ctx)) out.add('heap');
        return true;
      }
      case 'some':
      case 'upcast':
        return go(e.value);
      case 'unwrap':
        return go(e.value) && e.value.op === 'local' && nonNull.has(e.value.local);
      case 'record':
        return e.fields.every(go);
      case 'array':
        return e.items.every(i =>
          'spread' in i ? go(i.spread) && (out.add('heap'), false) : go(i),
        );
      case 'with':
        return go(e.value) && go(e.body);
      case 'optional':
        return go(e.value) && quiet(e.then);
      case 'call': {
        if (!e.args.every(go)) return false;
        const f = functions[e.function];
        if (f?.derived) {
          out.add(`k:${e.function}`);
          return mustFn(e.function, stack).complete;
        }
        const m = mustFn(e.function, stack);
        m.tokens.forEach(t => out.add(t));
        return m.complete;
      }
      case 'call-value':
        go(e.callee) && e.args.every(go);
        return false;
      case 'builtin':
        return e.args.every(go) && TOTAL.test(e.name) && !e.args.some(a => a.op === 'closure');
      default:
        // index, downcast, matches, mount, attrs, …: may throw or depend on what is not modelled.
        if (e.op === 'index') go(e.array) && go(e.index) && (raw(e.array, ctx) || out.add('heap'));
        return false;
    }
  };

  // --- Computed values whose links are settled ---
  /** Whether the template of component `k` reads computed `f` unconditionally at its first render. */
  const rootReads = new Map<number, Set<string>>();
  const templateRoot = (k: number): Set<string> => {
    if (rootReads.has(k)) return rootReads.get(k)!;
    const out = new Set<string>();
    const ctx: Ctx = { component: k, slot: 'template' };
    const stack = new Set<number>();
    const none = new Set<number>();
    const walk = (nodes: Node[] | undefined): boolean => {
      for (const n of nodes ?? []) {
        switch (n.kind) {
          case 'element': {
            const exprs = [
              ...(n.attrs ?? []).map(a => a.value),
              ...(n.classes ?? []).map(a => a.value),
              ...(n.styles ?? []).map(a => a.value),
              ...(n.styleText ? [n.styleText] : []),
              ...(n.spread ? [n.spread] : []),
            ];
            if (!exprs.every(x => eager(x, ctx, out, stack, none))) return false;
            if (!walk(n.children)) return false;
            break;
          }
          case 'text':
            if (!n.parts.every(x => eager(x, ctx, out, stack, none))) return false;
            break;
          case 'component':
            if (!(n.props ?? []).every(p => eager(p.value, ctx, out, stack, none))) return false;
            break;
          case 'if':
            if (!eager(n.test, ctx, out, stack, none)) return false;
            break;
          case 'each':
            if (!eager(n.items, ctx, out, stack, none)) return false;
            break;
          default:
            return false;
        }
      }
      return true;
    };
    walk(components[k].template);
    rootReads.set(k, out);
    return out;
  };
  const settled = (f: number): boolean => {
    const fn = functions[f];
    if (!fn?.derived || fn.component === undefined) return false;
    const all = trackedFn(f);
    const must = mustFn(f, new Set());
    return (
      [...all].every(t => (t.startsWith('c:') || t.startsWith('p:')) && must.tokens.has(t)) &&
      templateRoot(fn.component).has(`k:${f}`)
    );
  };

  // --- Watchers, flushes and the check ---
  interface Watcher {
    e: NonNullable<Component['effects']>[number];
    src: Set<string>;
    must: Set<string>;
    effects: Effects;
    /** Why W cannot come first by subscription order, if it cannot. */
    first?: string;
  }
  const watcherOf = (k: number, e: Watcher['e']): Watcher => {
    const ctx: Ctx = { component: k, slot: `f${e.run}` };
    const stack = new Set<number>();
    let src: Set<string>;
    const must = new Set<string>();
    if (e.deps.kind === 'values') {
      src = tracked(e.deps.values, { component: k, slot: 'template' }, new Set(), new Set());
      for (const v of e.deps.values)
        if (!eager(v, { component: k, slot: 'template' }, must, stack, new Set())) break;
    } else {
      src = trackedFn(e.run);
      mustFn(e.run, stack).tokens.forEach(t => must.add(t));
    }
    const effects = effectsOf([{ value: functions[e.run]?.body ?? [], ctx }]);
    let first: string | undefined;
    const computed = [...src].find(t => t.startsWith('k:'));
    if (computed)
      first = `it depends on the computed value ${functions[Number(computed.slice(2))].name}`;
    else if (src.has('unknown')) first = 'it calls functions the compiler does not resolve';
    else if (e.deps.kind === 'tracked') {
      // Cleanups run inside the next tracked run of a watchEffect.
      const k2 = [...effects.computeds].find(f => !settled(f));
      if (k2 !== undefined)
        first = `it evaluates the computed value ${functions[k2].name} outside its tracked reads (in a cleanup or a callback), which takes over the links it shares with this watcher where it is evaluated for the first time`;
    }
    return { e, src, must, effects, first };
  };
  const conflict = (a: Effects, b: Effects): string | undefined => {
    const meets = (x: Set<Key>, y: Set<Key>) => [...x].some(v => y.has(v));
    if (a.unknown || b.unknown) return 'call functions the compiler does not resolve';
    if (meets(a.writes, b.writes) || meets(a.writes, b.reads) || meets(b.writes, a.reads))
      return 'write state the other reads or writes';
    if ((a.heapW && (b.heapW || b.heapR)) || (b.heapW && a.heapR))
      return 'change objects (a plain log, module state) the other reads or changes';
    if (a.host && b.host) return 'use host services (timers, microtasks, storage, the DOM)';
    return undefined;
  };

  // Writes every flush may contain: watchers, lifecycle hooks, the render, Vue's own prop and ref updates.
  const always: Writes = { cells: new Set(), reactiveW: false, unknown: false };
  const addWrites = (w: Writes, e: Effects) => {
    e.writes.forEach(x => w.cells.add(x));
    w.reactiveW ||= e.reactiveW;
    w.unknown ||= e.unknown;
  };
  components.forEach((c, k) => {
    c.cells.forEach((cell, i) => {
      if (cell.prop !== undefined || runtimeWritten(k, i)) always.cells.add(key(k, i));
    });
    for (const e of c.effects ?? [])
      if (!e.render)
        addWrites(always, effectsOf([{ value: functions[e.run]?.body ?? [], ctx: fnCtx(e.run) }]));
    addWrites(
      always,
      effectsOf([{ value: c.cells.map(x => x.init), ctx: { component: k, slot: 'template' } }]),
    );
  });
  for (const t of templateExprs)
    addWrites(
      always,
      effectsOf([{ value: t.value, ctx: { component: t.component, slot: 'template' } }]),
    );
  // One flush per handler (each listener ends with a microtask checkpoint), with what every flush may contain.
  const flushes: Writes[] = [always];
  /** The cells each handler flush writes itself (parallel to flushes[1..]). */
  const handlerWrites: Set<Key>[] = [];
  components.forEach((c, k) =>
    c.handlers.forEach((h, i) => {
      const w: Writes = {
        cells: new Set(always.cells),
        reactiveW: always.reactiveW,
        unknown: always.unknown,
      };
      const e = effectsOf([{ value: h.body, ctx: { component: k, slot: `h${k}.${i}` } }]);
      addWrites(w, e);
      flushes.push(w);
      handlerWrites.push(e.writes);
    }),
  );
  const computedTriggered = new Map<number, (w: Writes) => boolean>();
  /** The signals of `src` that flush `w` may write. */
  const triggered = (src: Set<string>, w: Writes): string[] =>
    [...src].filter(t => {
      if (w.unknown || t === 'unknown') return true;
      if (t === 'heap') return w.reactiveW;
      if (t.startsWith('c:')) return w.cells.has(t.slice(2));
      if (t.startsWith('p:')) {
        const [k, rest] = t.slice(2).split(':');
        return w.cells.has(`${k}:${rest.split('.')[0]}`) || w.reactiveW;
      }
      if (t.startsWith('k:')) {
        const f = Number(t.slice(2));
        if (!computedTriggered.has(f)) {
          const deps = trackedFn(f);
          computedTriggered.set(f, x => triggered(deps, x).length > 0);
        }
        return computedTriggered.get(f)!(w);
      }
      return true;
    });

  const watchersOf = components.map((c, k) =>
    (c.effects ?? [])
      .filter(
        e =>
          e.phase === 'pre' && !e.render && (e.deps.kind === 'tracked' || e.deps.kind === 'values'),
      )
      .map(e => watcherOf(k, e)),
  );
  components.forEach((c, k) => {
    const watchers = watchersOf[k];
    for (let j = 1; j < watchers.length; j++)
      for (let i = 0; i < j; i++) {
        const [a, b] = [watchers[i], watchers[j]];
        const why = conflict(a.effects, b.effects);
        if (!why) continue;
        for (const w of flushes) {
          const ta = triggered(a.src, w);
          const tb = triggered(b.src, w);
          if (!ta.length || !tb.length) continue;
          const missing = tb.find(
            t => !(t.startsWith('c:') || t.startsWith('p:')) || !a.must.has(t),
          );
          const reason =
            a.first ??
            (missing === undefined
              ? undefined
              : missing.startsWith('c:') || missing.startsWith('p:')
                ? `a flush may write ${describe(missing)}, which this watcher depends on and the earlier one does not read in every run`
                : `a flush may write what this watcher depends on through ${missing === 'heap' ? 'array elements, lengths or iteration' : missing.startsWith('k:') ? `the computed value ${functions[Number(missing.slice(2))].name}` : 'calls the compiler does not resolve'}`);
          if (reason === undefined) continue;
          fail(
            'E_EFFECT',
            `Vue may run this watcher before the one at line ${a.e.source?.line}: it queues a component's watchers in the order a flush triggers them (the order of the writes, and for one write the order the watchers began to depend on it), Runic in declaration order, and both ${why}; Runic can prove the order only where every signal of this watcher a flush may write is a ref, prop or record field the earlier watcher reads in every run, and the earlier one depends on no computed value (here ${reason})`,
            b.e.source,
          );
        }
      }
  });

  // --- Watchers of different instances ---
  // Vue runs the queued watchers of an instance its render patches while it
  // patches it (updateComponentPreRender), in document order; other queued
  // watchers run by instance uid, which is creation order (case
  // watch-instances; fixture watch-instances-deep-vue in Chromium). Runic
  // runs instances in document order. An instance created after one that
  // follows it in the document (in a branch or list region that one is not
  // in, or another item of the same list) may then run its watchers out of
  // order, unless both are children of that template triggered only through
  // their props: one render of the parent patches both, in document order
  // (descendants further down are patched by their own parents' renders,
  // which run by uid when they re-render for their own state).
  const subtrees = new Map<number, Set<number>>();
  const subtree = (k: number): Set<number> => {
    if (subtrees.has(k)) return subtrees.get(k)!;
    const out = new Set<number>([k]);
    subtrees.set(k, out);
    const walk = (nodes: Node[] | undefined) => {
      for (const n of nodes ?? []) {
        if (n.kind === 'component') {
          subtree(n.component).forEach(x => out.add(x));
          for (const s of n.slots ?? []) walk(s.body);
        }
        if (n.kind === 'element') walk(n.children);
        if (n.kind === 'if') (walk(n.then), walk(n.else));
        if (n.kind === 'each') (walk(n.body), walk(n.else));
        if (n.kind === 'slot') walk(n.fallback);
      }
    };
    walk(components[k].template);
    return out;
  };
  /** Whether every signal of `tokens` is a prop of its component (updated while the parent patches it). */
  const propsOnly = (tokens: string[]) =>
    tokens.every(t => {
      if (!t.startsWith('c:')) return false;
      const [k, cell] = t.slice(2).split(':').map(Number);
      return components[k].cells[cell].prop !== undefined;
    });
  /** Own cells of component `k`: per instance, so two instances never share them. */
  const own = (e: Effects, k: number): Effects => {
    const mine = (x: Key) => x.startsWith(`${k}:`);
    return {
      ...e,
      reads: new Set([...e.reads].filter(x => !mine(x))),
      writes: new Set([...e.writes].filter(x => !mine(x))),
    };
  };
  const ownTriggered = (src: Set<string>, w: Writes, k: number, writes: Set<Key>) =>
    // The other instance's own cells are written only by what every flush may contain.
    triggered(src, {
      ...w,
      cells: new Set(
        [...w.cells].filter(x => !x.startsWith(`${k}:`) || always.cells.has(x) || !writes.has(x)),
      ),
    });
  components.forEach((p, parent) => {
    type Site = { component: number; regions: number[]; source?: Source };
    const list: Site[] = [];
    let region = 0;
    const walk = (nodes: Node[] | undefined, regions: number[]) => {
      for (const n of nodes ?? []) {
        switch (n.kind) {
          case 'component':
            list.push({ component: n.component, regions, source: n.source });
            for (const s of n.slots ?? []) walk(s.body, [...regions, ++region]);
            break;
          case 'element':
            walk(n.children, regions);
            break;
          case 'if':
            walk(n.then, [...regions, ++region]);
            walk(n.else, [...regions, ++region]);
            break;
          case 'each': {
            const r = ++region;
            eachRegions.add(r);
            walk(n.body, [...regions, r]);
            walk(n.else, [...regions, ++region]);
            break;
          }
          case 'slot':
            walk(n.fallback, [...regions, ++region]);
            break;
        }
      }
    };
    const eachRegions = new Set<number>();
    walk(p.template, []);
    const pairs: [Site, Site][] = [];
    list.forEach((s, i) => {
      if (s.regions.some(r => eachRegions.has(r))) pairs.push([s, s]);
      for (const t of list.slice(i + 1))
        if (s.regions.some(r => !t.regions.includes(r))) pairs.push([s, t]);
    });
    for (const [early, late] of pairs)
      for (const a of subtree(early.component))
        for (const b of subtree(late.component))
          for (const wa of watchersOf[a])
            for (const wb of watchersOf[b]) {
              const why = conflict(
                a === b ? own(wa.effects, a) : wa.effects,
                a === b ? own(wb.effects, b) : wb.effects,
              );
              if (!why) continue;
              for (const [h, w] of flushes.entries()) {
                const handler = h === 0 ? undefined : handlerWrites[h - 1];
                const ta = triggered(wa.src, w);
                const tb =
                  a === b && handler ? ownTriggered(wb.src, w, b, handler) : triggered(wb.src, w);
                const children = a === early.component && b === late.component;
                if (!ta.length || !tb.length || (children && propsOnly(ta) && propsOnly(tb)))
                  continue;
                fail(
                  'E_EFFECT',
                  `Vue may run the watcher at ${components[a].name} line ${wa.e.source?.line} of an instance created here after those of instances that follow it in the document${early === late ? ' (other items of this list)' : ` (${components[late.component].name}, line ${late.source?.line})`}, such as the watcher at ${components[b].name} line ${wb.e.source?.line}: it runs watchers a write triggers by instance creation order (those a prop update triggers while it patches the instance), Runic in document order, and both ${why}`,
                  early.source,
                );
              }
            }
  });

  function describe(t: string): string {
    const [k, rest] = t.slice(2).split(':');
    const [cell, ...fields] = rest.split('.');
    const c = components[Number(k)].cells[Number(cell)];
    let type: Type = c.type;
    const names = fields.map(f => {
      const r =
        type && typeof type === 'object' && ('record' in type || 'class' in type)
          ? records['record' in type ? type.record : type.class]
          : undefined;
      const field = r?.fields[Number(f)];
      type = field?.type ?? 'number';
      return field?.name ?? f;
    });
    return [c.name, ...names].join('.');
  }
}
