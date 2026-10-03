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
    case 'payload':
    case 'to-string':
    case 'typeof':
    case 'concat':
      return S;
    case 'not':
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
      const t = irType(e.object, env);
      return typeof t === 'object' && 'record' in t
        ? env.records[t.record].fields[e.field].type
        : 'void';
    }
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
  }
}

/**
 * The result type of a builtin from its argument types (subset mirrored from
 * builtins.rs, for calls whose TypeScript result type is `any`).
 */
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
