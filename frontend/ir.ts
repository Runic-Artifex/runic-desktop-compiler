// Runic IR schema 4 as TypeScript types. Mirrors crates/runic-ir/src/lib.rs;
// the Rust validator is authoritative. See docs/IR.md and
// docs/design/M2-VALUES.md.

export const SCHEMA = 4;

export interface Source {
  file: string;
  line: number;
  column: number;
}

export type Type =
  | 'number'
  | 'string'
  | 'boolean'
  | { maybe: Type }
  | { array: Type }
  | { record: number }
  | { map: [Type, Type] }
  | { set: Type }
  | { promise: Type }
  | { fn: { params: Type[]; result: Type } }
  /** An element handle (DOM ref). */
  | 'element'
  | 'void';

export type Literal = boolean | number | string;

export type Read = 'current' | 'snapshot';

export type Expr =
  | { op: 'lit'; value: Literal }
  | { op: 'undefined'; type: Type }
  | { op: 'null'; type: Type }
  | { op: 'cell'; cell: number; read?: Read }
  | { op: 'global'; global: number }
  | { op: 'local'; local: number }
  | { op: 'payload' }
  | {
      op:
        | 'not'
        | 'neg'
        | 'to-string'
        | 'to-number'
        | 'to-boolean'
        | 'utf16-length'
        | 'typeof'
        | 'bit-not';
      arg: Expr;
    }
  | {
      op:
        | 'add'
        | 'sub'
        | 'mul'
        | 'div'
        | 'rem'
        | 'pow'
        | 'min'
        | 'max'
        | 'concat'
        | 'eq'
        | 'ne'
        | 'lt'
        | 'le'
        | 'gt'
        | 'ge'
        | 'and'
        | 'or'
        | 'nullish'
        | 'bit-and'
        | 'bit-or'
        | 'bit-xor'
        | 'shl'
        | 'shr'
        | 'ushr';
      left: Expr;
      right: Expr;
    }
  | { op: 'cond'; test: Expr; then: Expr; else: Expr }
  | { op: 'mapped'; rule: string; guard: Expr; fast: Expr; reference: Expr }
  | { op: 'record'; record: number; fields: Expr[] }
  | { op: 'array'; type: Type; items: (Expr | { spread: Expr })[] }
  | { op: 'get'; object: Expr; field: number }
  | { op: 'index'; array: Expr; index: Expr }
  | { op: 'some'; value: Expr }
  | { op: 'optional'; value: Expr; local: number; then: Expr }
  | { op: 'call'; function: number; args: Expr[] }
  | { op: 'call-value'; callee: Expr; args: Expr[] }
  | { op: 'closure'; function: number; captures: number[]; stable?: boolean }
  | { op: 'builtin'; name: string; args: Expr[]; type: Type }
  /** Evaluate `value`, bind it to `local`, then evaluate `body` (sequencing with a temporary). */
  | { op: 'with'; local: number; value: Expr; body: Expr }
  /** Unwrap a Maybe; throws TypeError when nullish (`x!` then member access). */
  | { op: 'unwrap'; value: Expr };

export type Place =
  | { place: 'local'; local: number }
  | { place: 'cell'; cell: number }
  | { place: 'field'; object: Expr; field: number }
  | { place: 'index'; array: Expr; index: Expr };

export type Stmt = (
  | { op: 'set'; cell: number; value: Expr }
  | { op: 'let'; local: number; value?: Expr }
  | { op: 'assign'; target: Place; value: Expr }
  | { op: 'expr'; value: Expr }
  | { op: 'if'; test: Expr; then: Stmt[]; else?: Stmt[] }
  | { op: 'while'; test: Expr; body: Stmt[]; update?: Stmt[]; label?: string }
  | { op: 'for-of'; local: number; iterable: Expr; body: Stmt[]; label?: string }
  | { op: 'break' | 'continue'; label?: string }
  | { op: 'return'; value?: Expr }
  | { op: 'throw'; value: Expr }
  | { op: 'try'; body: Stmt[]; catch?: { local?: number; body: Stmt[] }; finally?: Stmt[] }
) & { source?: Source };

export interface Local {
  name: string;
  type: Type;
  boxed?: boolean;
}

/** Local index space of a function: [...captures, ...params, ...locals]. */
export interface Fn {
  /** A cached derived value of its component (`$derived`, `computed`). */
  derived?: boolean;
  name: string;
  /** Component whose cells the function reads and writes, if any. */
  component?: number;
  captures?: Local[];
  params: Local[];
  locals: Local[];
  result: Type;
  body: Stmt[];
  source?: Source;
}

export interface RecordType {
  name: string;
  fields: { name: string; type: Type }[];
}

export interface Cell {
  /** Must not be mutated in place (React state and props). */
  readonly?: boolean;
  name: string;
  type: Type;
  init: Expr;
  tracking?: 'deep' | 'identity' | 'none' | 'proxied';
  domain?: { kind: 'text'; maxUtf16: number };
  /** The prop this cell receives from its parent (`init` is the default). */
  prop?: string;
  source?: Source;
}

/** A module constant (evaluated once at startup). */
export interface Global {
  name: string;
  type: Type;
  init: Expr;
  source?: Source;
}

export interface Handler {
  name?: string;
  event: 'click' | 'input' | 'change' | 'keydown';
  /** Values passed by the listener; the local index space is params, then locals. */
  params?: Local[];
  locals?: Local[];
  body: Stmt[];
  source?: Source;
}

export interface Attr {
  name: string;
  value: Expr;
}

export type Node =
  | {
      kind: 'element';
      tag: string;
      attrs?: Attr[];
      props?: Attr[];
      listeners?: Listener[];
      /** A cell holding this element while mounted (null after removal). */
      ref?: number;
      children?: Node[];
      source?: Source;
    }
  | { kind: 'text'; parts: Expr[]; source?: Source }
  | { kind: 'if'; test: Expr; then: Node[]; else?: Node[]; source?: Source }
  | {
      kind: 'component';
      component: number;
      props?: { name: string; value: Expr; bind?: Expr }[];
      /** Parent-owned content for the child's slots; params are template locals. */
      slots?: { name: string; params?: number[]; body: Node[] }[];
      source?: Source;
    }
  | { kind: 'slot'; name: string; args?: Expr[]; fallback?: Node[]; source?: Source }
  | {
      kind: 'each';
      items: Expr;
      item: number;
      index?: number;
      key?: Expr;
      /** Which reused blocks a keyed update moves (the framework's keyed diff). */
      reorder?: 'lis' | 'forward' | 'stash';
      body: Node[];
      else?: Node[];
      source?: Source;
    };

export interface Listener {
  event: 'click' | 'input' | 'change' | 'keydown';
  handler: number;
  args?: Expr[];
}

export interface Component {
  name: string;
  cells: Cell[];
  handlers: Handler[];
  template: Node[];
  templateLocals?: Local[];
  /** Slots the template renders, with the types of their arguments. */
  slots?: { name: string; params?: Type[] }[];
  /** Effects of each instance, in declaration order. */
  effects?: Effect[];
}

/**
 * A component function run around updates when its dependencies changed;
 * a returned function is its cleanup (docs/design/M4-EFFECTS.md).
 */
export interface Effect {
  run: number;
  phase: 'pre' | 'layout' | 'post';
  deps:
    { kind: 'tracked' | 'once' | 'always' } | { kind: 'values'; values: Expr[]; initial?: boolean };
  unmount: { removal: 'before' | 'after'; order: 'pre' | 'post' };
  source?: Source;
}

/** The framework's update scheduling (docs/design/M4-EFFECTS.md). */
export interface Schedule {
  /** `event-microtask`: a microtask during input events, otherwise a default-priority task. */
  flush?: 'microtask' | 'event-microtask';
  /** `listener`: a microtask checkpoint after each listener instead of after each event. */
  checkpoint?: 'dispatch' | 'listener';
  /** A checkbox's `change` listeners run in the `click` dispatch. */
  changeWithClick?: boolean;
  /**
   * `batched`: all cleanups of a phase run before its effects, in one walk
   * (children first) that includes the layout and post cleanups of
   * instances destroyed by the update: at each instance the destroyed
   * subtrees under it, then its live children, then its own cleanups.
   */
  cleanups?: 'interleaved' | 'batched';
  /** Writes from post effects update in a later default-priority task. */
  postWritesDeferred?: boolean;
  /** When the initial mount's effects run (default: a microtask). */
  mount?: 'sync' | 'microtask' | 'task';
  /** Cleanups read state as it was before the running flush's writes. */
  cleanupReadsPrevious?: boolean;
}

export interface Program {
  schema: 4;
  meta: {
    title: string;
    sourceHash: string;
    frontend: unknown;
    provenance?: unknown;
    mappings?: { id: string; version: number; sha256: string }[];
  };
  renderer?: 'cpu' | 'gpu';
  capabilities: string[];
  styles: { css: string; assets: { path: string; sha256: string; bytes: number; mime: string }[] };
  records?: RecordType[];
  functions?: Fn[];
  globals?: Global[];
  components: Component[];
  root: number;
  containerAttrs?: Record<string, string>;
  /** Refocus an element blurred by a list move after each update (React DOM). */
  restoreFocus?: boolean;
  /** When updates run relative to tasks and microtasks (default: microtask flush, one checkpoint per event). */
  schedule?: Schedule;
}

export const lit = (value: Literal): Expr => ({ op: 'lit', value });
export const str = (value: string): Expr => ({ op: 'lit', value });
