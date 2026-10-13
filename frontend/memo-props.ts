// Component props whose value changes module state (Svelte; bits-ui's id
// counter: `value={value ?? heading ?? `----${useId()}`}` in shadcn-svelte's
// CommandGroup, where `useId` increments `globalThis.bitsIdCounter.current`).
//
// Svelte 5.49.2 memoizes a component attribute whose expression has a call
// (`Memoizer.add`, compiler/phases/3-transform/client/visitors/shared/
// utils.js:33-49, from component.js:171-190; `has_call` is set for a call
// unless its callee is an unbound global, 2-analyze/visitors/
// CallExpression.js:264-272): the prop is `get value() { return $.get($1) }`
// over `let $1 = $.derived(() => …)`, created in the block that renders the
// component. A derived is computed when first read, and one that read no
// signal is never computed again ("deriveds without dependencies should
// never be recomputed", internal/client/reactivity/deriveds.js:369-373).
// The child first reads the prop where its `$props()` declares it with a
// default or `$bindable`: `$.prop` reads `props[key]` at once
// (internal/client/reactivity/props.js:311-318), after the code before it.
//
// The IR passes props by value: the parent evaluates them when the child is
// created, before the child's cells initialise. Where a value writes module
// state, the frontend models the prop as Svelte does, a derived value of the
// parent instance (an IR `derived` function), and proves that the writes
// happen at the same point of their order as in Svelte:
//
// - the value reads no state (`counterWrites`: no cells, template locals,
//   reactive fields, arrays, maps; only primitive fields of globals holding
//   plain records of primitives), so its derived has no dependencies and
//   both compute it once per derived;
// - the component sits at the top level of its parent's template, outside
//   blocks that render again (`{#if}`, `{#each}`, `{#key}`, snippets), so
//   the derived lives as long as the parent instance, as Svelte's does;
// - the child declares the prop with a default or `$bindable`, and nothing
//   the child runs before that declaration (its earlier cells, through calls
//   and closures) names the globals the value writes (`namesGlobals`);
// - those globals never escape (`escapes`: every reference reads or writes
//   one of their fields), so only code naming them reaches them; and the
//   program tracks only proxies and reactive fields in derived values (it
//   has `$state` or reactive fields: codegen's `owned_only`), so the plain
//   global the derived reads is no dependency.
import type { Expr, Fn, Global, Local, Place, RecordType, Stmt, Type } from './ir.ts';

const primitive = (t: Type): boolean =>
  t === 'number' ||
  t === 'string' ||
  t === 'boolean' ||
  (typeof t === 'object' && 'maybe' in t && primitive(t.maybe));
/** Built-ins of primitive values that read nothing else. */
const PURE_BUILTIN = /^(string|Math|maybe|number)\./;
const UNARY = new Set([
  'not',
  'neg',
  'to-string',
  'to-number',
  'to-boolean',
  'utf16-length',
  'typeof',
  'bit-not',
]);
const BINARY = new Set([
  'add',
  'sub',
  'mul',
  'div',
  'rem',
  'pow',
  'min',
  'max',
  'concat',
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'and',
  'or',
  'nullish',
  'bit-and',
  'bit-or',
  'bit-xor',
  'shl',
  'shr',
  'ushr',
]);

export interface ProgramParts {
  functions: Fn[];
  globals: Global[];
  records: RecordType[];
}

/** The globals a value writes and reads. */
export interface GlobalWrites {
  writes: Set<number>;
  reads: Set<number>;
}

/**
 * The globals `e` (lowered in a template; its own temporaries bound by
 * `with` and `optional`) writes and reads, where it reads no state and
 * writes only fields of globals holding plain records of primitives;
 * undefined where it reaches anything else.
 */
export function counterWrites(e: Expr, p: ProgramParts): GlobalWrites | undefined {
  const out: GlobalWrites = { writes: new Set(), reads: new Set() };
  const visiting = new Set<number>();
  const plainGlobal = (x: Expr): number | undefined => {
    if (x.op !== 'global') return undefined;
    const t = p.globals[x.global]?.type;
    if (typeof t !== 'object' || !('record' in t)) return undefined;
    const r = p.records[t.record];
    if (!r || r.class || r.tuple || r.extends !== undefined) return undefined;
    return r.fields.every(f => !f.reactive && primitive(f.type)) ? x.global : undefined;
  };
  /** `bound`: the template value's own temporaries (undefined in a function). */
  const expr = (x: Expr, bound: Set<number> | undefined): boolean => {
    const o = x as unknown as Record<string, Expr>;
    switch (x.op) {
      case 'lit':
      case 'undefined':
      case 'null':
        return true;
      case 'local':
        // A function's locals are all primitive (checked at its entry).
        return !bound || bound.has(x.local);
      case 'get': {
        const g = plainGlobal(x.object);
        if (g === undefined) return false;
        out.reads.add(g);
        return true;
      }
      case 'some':
      case 'unwrap':
        return expr(x.value, bound);
      case 'cond':
        return expr(x.test, bound) && expr(x.then, bound) && expr(x.else, bound);
      case 'with':
        return expr(x.value, bound) && expr(x.body, bound && new Set(bound).add(x.local));
      case 'optional':
        return expr(x.value, bound) && expr(x.then, bound && new Set(bound).add(x.local));
      case 'builtin':
        return PURE_BUILTIN.test(x.name) && x.args.every(a => expr(a, bound));
      case 'call':
        return x.args.every(a => expr(a, bound)) && fn(x.function);
      default:
        if (UNARY.has(x.op)) return expr(o.arg, bound);
        if (BINARY.has(x.op)) return expr(o.left, bound) && expr(o.right, bound);
        return false;
    }
  };
  const place = (t: Place): boolean => {
    if (t.place === 'local') return true;
    if (t.place !== 'field') return false;
    const g = plainGlobal(t.object);
    if (g === undefined) return false;
    out.writes.add(g);
    return true;
  };
  const stmts = (body: Stmt[]): boolean =>
    body.every(s => {
      switch (s.op) {
        case 'let':
        case 'return':
          return !s.value || expr(s.value, undefined);
        case 'assign':
          return place(s.target) && expr(s.value, undefined);
        case 'expr':
          return expr(s.value, undefined);
        case 'if':
          return expr(s.test, undefined) && stmts(s.then) && stmts(s.else ?? []);
        default:
          return false;
      }
    });
  const fn = (index: number): boolean => {
    const f = p.functions[index];
    // (A recursive call may not end; a derived value has its own cache.)
    if (!f || f.derived || visiting.has(index)) return false;
    const locals: Local[] = [...(f.captures ?? []), ...f.params, ...f.locals];
    if (!locals.every(l => !l.boxed && primitive(l.type)) || !primitive(f.result)) return false;
    visiting.add(index);
    try {
      return stmts(f.body);
    } finally {
      visiting.delete(index);
    }
  };
  return expr(e, new Set()) ? out : undefined;
}

/**
 * A derived function of component `component` returning `e`, its
 * temporaries (template locals, typed by `templateLocals`) renumbered as
 * the function's locals.
 */
export function derivedOf(
  e: Expr,
  name: string,
  component: number,
  result: Type,
  templateLocals: Local[],
): Fn {
  const locals: Local[] = [];
  const renumber = new Map<number, number>();
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(visit);
    if (!x || typeof x !== 'object') return x;
    const o = x as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) copy[k] = k === 'type' ? v : visit(v);
    if (
      (o.op === 'with' || o.op === 'optional' || o.op === 'local') &&
      typeof o.local === 'number'
    ) {
      let to = renumber.get(o.local);
      if (to === undefined) {
        to = locals.length;
        locals.push({ ...templateLocals[o.local] });
        renumber.set(o.local, to);
      }
      copy.local = to;
    }
    return copy;
  };
  const value = visit(e) as Expr;
  return {
    name,
    component,
    params: [],
    locals,
    result,
    body: [{ op: 'return', value }],
    derived: true,
    derivedStrict: true,
  };
}

/**
 * Whether evaluating `exprs` may reach code naming one of `globals`
 * (through calls, closures, which may run at once, and derived values), or
 * code it cannot see (calls of function values, mounts): the reason, or
 * undefined.
 */
export function namesGlobals(
  exprs: Expr[],
  globals: Set<number>,
  functions: Fn[],
): string | undefined {
  const seen = new Set<number>();
  let reason: string | undefined;
  const visit = (x: unknown): void => {
    if (reason || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(visit);
    const o = x as Record<string, unknown>;
    if (o.op === 'global' && globals.has(o.global as number)) {
      reason = 'refers to the module state the value changes';
      return;
    }
    if (o.op === 'call-value') {
      reason = 'calls a function value';
      return;
    }
    if (o.op === 'mount') {
      reason = 'mounts a component';
      return;
    }
    if ((o.op === 'call' || o.op === 'closure') && typeof o.function === 'number') {
      if (!seen.has(o.function)) {
        seen.add(o.function);
        visit(functions[o.function]?.body);
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== 'type') visit(v);
  };
  exprs.forEach(visit);
  return reason;
}

/**
 * Whether a reference to one of `globals` anywhere in `program` (any part:
 * functions, cells, templates, globals' initialisers) is used other than to
 * read or write one of its fields, so that the object could be reached
 * through an alias.
 */
export function escapes(program: unknown, globals: Set<number>): boolean {
  let found = false;
  const isGlobal = (x: unknown) => {
    const o = x as { op?: string; global?: number } | undefined;
    return o?.op === 'global' && globals.has(o.global as number);
  };
  const visit = (x: unknown): void => {
    if (found || !x || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(visit);
    const o = x as Record<string, unknown>;
    if (isGlobal(o)) {
      found = true;
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'type') continue;
      // `get` of a field, and a field place, of the global.
      if (k === 'object' && (o.op === 'get' || o.place === 'field') && isGlobal(v)) continue;
      visit(v);
    }
  };
  visit(program);
  return found;
}
