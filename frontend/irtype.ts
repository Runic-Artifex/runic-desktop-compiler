// IR types of lowered expressions (a TypeScript mirror of the inference in
// crates/runic-ir/src/validate.rs and builtins.rs). The frontend prefers
// TypeScript's types; where TypeScript only knows `any` (untyped JavaScript,
// JSON, catch bindings), decisions use these types instead.
import type { Expr, Fn, Global, RecordType, Type } from './ir.ts';

export interface TypeEnv {
  local(index: number): Type;
  cell(index: number): Type;
  records: RecordType[];
  functions: Fn[];
  globals: Global[];
}

const N: Type = 'number';
const S: Type = 'string';
const B: Type = 'boolean';
const isObj = (t: Type, key: string): boolean => typeof t === 'object' && key in t;
export const maybeInner = (t: Type): Type | undefined =>
  typeof t === 'object' && 'maybe' in t ? t.maybe : undefined;
export const arrayElement = (t: Type): Type | undefined =>
  typeof t === 'object' && 'array' in t ? t.array : undefined;
export const fnResult = (t: Type): Type | undefined =>
  typeof t === 'object' && 'fn' in t ? t.fn.result : undefined;

/** Whether class record `r` is `c` or one of its subclasses (M6 inheritance). */
export function extendsClass(r: number, c: number, records: RecordType[]): boolean {
  for (let x: number | undefined = r, n = 0; x !== undefined && n <= records.length; n++) {
    if (x === c) return true;
    x = records[x].extends;
  }
  return false;
}

/**
 * The class records a value of type `t` can be an instance of (abstract ones
 * included), ascending; undefined for types that are not class-typed
 * (mirrors `Program::class_members`).
 */
export function classMembers(t: Type, records: RecordType[]): number[] | undefined {
  if (typeof t !== 'object') return undefined;
  const subtree = (c: number) => records.map((_, r) => r).filter(r => extendsClass(r, c, records));
  if ('record' in t) return records[t.record]?.class ? [t.record] : undefined;
  if ('class' in t) return subtree(t.class);
  if ('classes' in t) return [...new Set(t.classes.flatMap(subtree))].sort((a, b) => a - b);
  return undefined;
}

/** The classes a value of type `t` can have (not abstract). */
export function concreteMembers(t: Type, records: RecordType[]): number[] | undefined {
  return classMembers(t, records)?.filter(r => !records[r].abstract);
}

/** A record describing the fields `get` reads on a value of type `t` (a class reference: its first member). */
export function fieldRecord(t: Type, records: RecordType[]): number | undefined {
  if (typeof t !== 'object') return undefined;
  if ('record' in t) return t.record;
  if ('class' in t || 'classes' in t) return classMembers(t, records)?.[0];
  return undefined;
}

/**
 * `v` (of type `have`) where a value of type `want` is expected: a Maybe
 * wraps it, a class instance widens to a class reference (`upcast`). Other
 * values are returned as they are.
 */
export function fitType(v: Expr, have: Type, want: Type, records: RecordType[]): Expr {
  if (JSON.stringify(have) === JSON.stringify(want)) return v;
  const wi = maybeInner(want);
  const hi = maybeInner(have);
  if (wi !== undefined && hi === undefined && have !== 'void')
    return { op: 'some', value: fitType(v, have, wi, records) };
  const [h, w] = wi !== undefined && hi !== undefined ? [hi, wi] : [have, want];
  // A member (or a narrower union) where a union is expected (M6 unions).
  const wu = unionMembers(w);
  if (wu) {
    const key = (t: Type) => JSON.stringify(t);
    const hu = unionMembers(h) ?? [h];
    if (key(h) !== key(w) && hu.every(m => wu.some(x => key(x) === key(m))))
      return { op: 'upcast', value: v, type: want };
    return v;
  }
  const hm = classMembers(h, records);
  const wm = classMembers(w, records);
  if (
    hm &&
    wm &&
    typeof w === 'object' &&
    ('class' in w || 'classes' in w) &&
    hm.every(r => wm.includes(r))
  )
    return { op: 'upcast', value: v, type: want };
  return v;
}

/** The members of union type `t` (M6 unions), if it is one. */
export function unionMembers(t: Type): Type[] | undefined {
  return typeof t === 'object' && 'union' in t ? t.union : undefined;
}

/** The rank of `t` among a union's members (number, string, boolean, element, record), if it can be one. */
export function unionRank(t: Type): number | undefined {
  if (t === 'number') return 0;
  if (t === 'string') return 1;
  if (t === 'boolean') return 2;
  if (t === 'element') return 3;
  if (typeof t === 'object' && 'record' in t) return 4;
  return undefined;
}

/** `v` (of type `have`) widened to class type `want` where it is a narrower class type; otherwise `v`. */
export function upcastTo(v: Expr, have: Type, want: Type, records: RecordType[]): Expr {
  const strip = (t: Type) => maybeInner(t) ?? t;
  // (Also a member value, or a narrower union, as a union: M6 unions.)
  if (unionMembers(strip(want))) return fitType(v, have, want, records);
  if (!classMembers(strip(want), records) || !classMembers(strip(have), records)) return v;
  return fitType(v, have, want, records);
}

export function irType(e: Expr, env: TypeEnv): Type {
  switch (e.op) {
    case 'lit':
      return typeof e.value === 'number' ? N : typeof e.value === 'string' ? S : B;
    case 'undefined':
    case 'null':
      return e.type;
    case 'cell':
      return env.cell(e.cell);
    case 'global':
      return env.globals[e.global].type;
    case 'local':
      return env.local(e.local);
    case 'event':
      return 'event';
    case 'attrs':
      return 'attrs';
    case 'payload':
    case 'to-string':
    case 'typeof':
    case 'concat':
      return S;
    case 'not':
    case 'slot-provided':
    case 'to-boolean':
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
    case 'and':
    case 'or':
      return B;
    case 'neg':
    case 'to-number':
    case 'utf16-length':
    case 'bit-not':
    case 'add':
    case 'sub':
    case 'mul':
    case 'div':
    case 'rem':
    case 'pow':
    case 'min':
    case 'max':
    case 'bit-and':
    case 'bit-or':
    case 'bit-xor':
    case 'shl':
    case 'shr':
    case 'ushr':
      return N;
    case 'nullish':
      return irType(e.right, env);
    case 'cond':
      return irType(e.then, env);
    case 'mapped':
      return irType(e.reference, env);
    case 'record':
      return { record: e.record };
    case 'array':
      return e.type;
    case 'get': {
      const r = fieldRecord(irType(e.object, env), env.records);
      return r !== undefined ? env.records[r].fields[e.field].type : 'void';
    }
    case 'upcast':
    case 'downcast':
      return e.type;
    case 'match-class':
    case 'match-union':
      return e.cases.length ? irType(e.cases[0].body, env) : irType(e.else!, env);
    case 'index':
      return arrayElement(irType(e.array, env)) ?? 'void';
    case 'some':
      return { maybe: irType(e.value, env) };
    case 'optional':
      return irType(e.then, env);
    case 'unwrap':
      return maybeInner(irType(e.value, env)) ?? 'void';
    case 'call':
      return env.functions[e.function]?.result ?? 'void';
    case 'call-value':
      return fnResult(irType(e.callee, env)) ?? 'void';
    case 'closure': {
      const f = env.functions[e.function];
      return { fn: { params: f.params.map(p => p.type), result: f.result } };
    }
    case 'builtin':
      return e.type;
    case 'with':
      return irType(e.body, env);
    case 'mount':
      return 'mounted';
  }
}

/**
 * The result type of a builtin from its argument types (subset mirrored from
 * builtins.rs, for calls whose TypeScript result type is `any`).
 */
/** Event object members (`event.*` built-ins) and their types. */
/** Element metrics read from the native layout (runic_ir::builtins::ELEMENT_METRICS). */
export const ELEMENT_METRICS = [
  'offsetWidth',
  'offsetHeight',
  'offsetLeft',
  'offsetTop',
  'clientWidth',
  'clientHeight',
  'clientLeft',
  'clientTop',
  'scrollWidth',
  'scrollHeight',
  'scrollTop',
  'scrollLeft',
];
/** Window metrics (runic_ir::builtins::WINDOW_METRICS). */
export const WINDOW_METRICS = [
  'innerWidth',
  'innerHeight',
  'scrollX',
  'scrollY',
  'devicePixelRatio',
];

export const EVENT_MEMBERS: Record<string, Type> = {
  type: S,
  key: S,
  code: S,
  ctrlKey: B,
  shiftKey: B,
  altKey: B,
  metaKey: B,
  repeat: B,
  isComposing: B,
  clientX: N,
  clientY: N,
  button: N,
  buttons: N,
  deltaX: N,
  deltaY: N,
  detail: N,
  pointerType: S,
  pointerId: N,
  // Animation and transition events (CSS slice 3b).
  elapsedTime: N,
  animationName: S,
  propertyName: S,
  pseudoElement: S,
  defaultPrevented: B,
  // M6 script DOM, slice 3.
  isTrusted: B,
  bubbles: B,
  cancelable: B,
  timeStamp: N,
  target: 'element',
  relatedTarget: { maybe: 'element' },
  currentTarget: { maybe: 'element' },
  value: S,
  checked: B,
  matches: B,
  preventDefault: 'void',
  stopPropagation: 'void',
  stopImmediatePropagation: 'void',
};

/** Members of animation objects (`animation.*` built-ins, M6) and their types. */
export const ANIMATION_MEMBERS: Record<string, Type> = {
  finished: { promise: 'animation' },
  playState: S,
  pending: B,
};

/**
 * Members of image objects (`new Image()`, M6 images) read and written
 * through `image.*` built-ins: the built-in's name and the member's type.
 */
export const IMAGE_MEMBERS: Record<string, { name: string; type: Type }> = {
  src: { name: 'src', type: S },
  crossOrigin: { name: 'cross-origin', type: { maybe: S } },
  referrerPolicy: { name: 'referrer-policy', type: S },
};

/** Whether `t` contains a dynamic value (M6 spike). */
export function containsDyn(t: Type): boolean {
  if (t === 'dyn') return true;
  if (typeof t !== 'object') return false;
  if ('maybe' in t) return containsDyn(t.maybe);
  if ('array' in t) return containsDyn(t.array);
  if ('set' in t) return containsDyn(t.set);
  if ('promise' in t) return containsDyn(t.promise);
  if ('map' in t) return containsDyn(t.map[0]) || containsDyn(t.map[1]);
  if ('fn' in t) return t.fn.params.some(containsDyn) || containsDyn(t.fn.result);
  return false;
}

export function builtinType(name: string, args: Type[]): Type | undefined {
  const [ns, method] = name.includes('.') ? (name.split('.', 2) as [string, string]) : ['', name];
  const recv = args[0];
  if (ns === 'Math' || (ns === 'Number' && !method.startsWith('is')))
    return method === 'parseFloat' || method === 'parseInt' ? N : N;
  if (ns === 'Number') return B;
  if (ns === '')
    return (
      { parseInt: N, parseFloat: N, isNaN: B, isFinite: B, String: S, Number: N, Boolean: B }[
        name
      ] ?? (name === 'structuredClone' ? recv : undefined)
    );
  if (ns === 'number') return S;
  // Array.from of an array, a set or a string: a new array of its items.
  if (ns === 'Array' && method === 'from' && recv !== undefined && args.length === 1) {
    if (recv === S) return { array: S };
    if (typeof recv === 'object' && 'array' in recv) return recv;
    if (typeof recv === 'object' && 'set' in recv) return { array: recv.set };
  }
  // Events script creates (M6 script DOM, slice 3).
  if (ns === 'event' && ['new', 'custom', 'create', 'keyboard'].includes(method)) return 'event';
  if (ns === 'event')
    // (`composedPath()[0]`: undefined once the dispatch is over.)
    return method === 'path-target' ? { maybe: 'element' } : EVENT_MEMBERS[method];
  // RegExp members (match results depend on the pattern: the frontend
  // declares them where it lowers the call).
  if (ns === 'regexp')
    return (
      (
        {
          new: 'regexp',
          source: S,
          flags: S,
          toString: S,
          lastIndex: N,
          'set-lastIndex': 'void',
          test: B,
        } as Record<string, Type>
      )[method] ?? (method === 'exec' ? undefined : B)
    );
  // Dates (docs/IR.md): Date objects and time values.
  if (ns === 'date') {
    if (method === 'new') return 'date';
    if (method === 'toJSON') return { maybe: S };
    if (method.startsWith('to')) return S;
    return N;
  }
  if (ns === 'intl') return method === 'compare' ? N : S;
  if (ns === 'match')
    return (
      { index: { maybe: N }, input: { maybe: S }, 'has-groups': B, group: { maybe: S } } as Record<
        string,
        Type
      >
    )[method];
  // Map and Set methods (an untyped receiver: bits-ui's global layer maps).
  if (ns === 'map' && recv && typeof recv === 'object' && 'map' in recv) {
    const [k, v] = recv.map;
    return (
      {
        get: { maybe: v },
        set: recv,
        has: B,
        delete: B,
        clear: 'void',
        size: N,
        keys: { array: k },
        values: { array: v },
        'dictionary-keys': { array: k },
        'dictionary-values': { array: v },
      } as Record<string, Type>
    )[method];
  }
  if (ns === 'set' && recv && typeof recv === 'object' && 'set' in recv)
    return (
      {
        add: recv,
        has: B,
        delete: B,
        clear: 'void',
        size: N,
        values: { array: recv.set },
      } as Record<string, Type>
    )[method];
  if (ns === 'string' && method === 'regexp-search') return N;
  if (ns === 'string' && method.startsWith('regexp-replace')) return S;
  if (ns === 'string' && method.startsWith('regexp-')) return undefined;
  if (ns === 'string') {
    if (['at', 'index'].includes(method)) return { maybe: S };
    if (method === 'codePointAt') return { maybe: N };
    if (['charCodeAt', 'indexOf', 'lastIndexOf', 'localeCompare'].includes(method)) return N;
    if (['includes', 'startsWith', 'endsWith', 'lt', 'le', 'gt', 'ge'].includes(method)) return B;
    if (method === 'split') return { array: S };
    return S;
  }
  if (ns === 'array' && recv) {
    const el = arrayElement(recv);
    if (!el) return undefined;
    const cb = args[1] ? fnResult(args[1]) : undefined;
    switch (method) {
      case 'length':
      case 'push':
      case 'unshift':
      case 'indexOf':
      case 'lastIndexOf':
      case 'findIndex':
      case 'findLastIndex':
        return N;
      case 'get':
      case 'at':
      case 'pop':
      case 'shift':
      case 'find':
      case 'findLast':
        return { maybe: el };
      case 'includes':
      case 'some':
      case 'every':
        return B;
      case 'forEach':
        return 'void';
      case 'join':
        return S;
      case 'map':
        return cb ? { array: cb } : undefined;
      case 'flatMap':
        return cb && isObj(cb, 'array') ? cb : undefined;
      case 'reduce':
      case 'reduceRight':
        return args[2] ?? el;
      case 'flat':
        return arrayElement(el) ? el : undefined;
      default:
        return recv;
    }
  }
  return undefined;
}
