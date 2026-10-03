# M2 design: values, functions and the new frontend

Status: accepted design for M2 (2026-10-03). This document is the interface that implementation work, including delegated work, builds against. [IR.md](../IR.md) becomes authoritative for each part once it is implemented.

## Goals

Lower ordinary TypeScript/JavaScript in components and modules: locals, control flow, functions and closures, objects, arrays, `Map`/`Set`, strings, numbers with JavaScript semantics, and the common built-ins. Types come from the TypeScript checker. Anything that cannot be typed statically is rejected with a source-located diagnostic; M6 adds QuickJS islands for such code (D7).

The driving examples are 7GUIs Counter and Temperature Converter, plus `examples/m2-values` (a ledger that exercises objects, arrays and string formatting without list rendering). Each exists in Svelte (lead, D14), React and Vue.

## Value model (D16)

| TypeScript type | IR type | Generated Rust | Semantics |
|---|---|---|---|
| `number` | `"number"` | `f64` | IEEE double with JS operators; `runic-js` provides `ToString`, `ToNumber`, `toFixed`, etc. |
| `string` | `"string"` | `JsString` (`Rc<[u16]>`) | Immutable UTF-16 sequence, exact JS indexing and lengths. It converts to UTF-8 only at the DOM boundary (lone surrogates become U+FFFD there, as in browsers). |
| `boolean` | `"boolean"` | `bool` | |
| `T \| null \| undefined` and optional properties | `{"maybe": T}` | `Maybe<T>` = `Undefined \| Null \| Some(T)` | `null` and `undefined` remain distinct (`String(null)`, `=== null`, `??`, `?.`). |
| `T[]` | `{"array": T}` | `JsArray<T>` = `Rc<RefCell<Vec<T>>>` | Reference identity; `===` compares identity. |
| object type with known properties | `{"record": r}` | `Rc<RefCell<Record_r>>` | Reference identity; fields are typed. A record is a structural type deduplicated by property names and types. |
| `Map<K,V>` / `Set<T>` | `{"map": [K, V]}` / `{"set": T}` | insertion-ordered (`indexmap`) | Keys use SameValueZero; keys are limited to `number`, `string`, `boolean` and reference types (by identity). |
| function types | `{"fn": {"params": [...], "result": T}}` | `Rc<dyn Fn(...) -> Result<T, Throw>>` | Closures capture variables by reference. Captured and mutated locals are boxed (`Rc<RefCell<_>>`). |
| `any`, `unknown`, unions not listed above, `symbol`, `bigint`, classes | — | — | `E_TYPE_UNSUPPORTED` (classes are planned within M2 if time permits, otherwise M6) |

Literal union types (`'a' | 'b'`) map to their base type. Discriminated unions of object types are deferred: they become a tagged record family later (M3/M6).

Reference cycles leak under `Rc`. That is acceptable for M2 because UI state rarely forms cycles; it is recorded as a known limitation. A cycle-collecting heap is an M10 option.

**Exceptions.** Every IR function may throw. Generated functions return `Result<T, Throw>`, where `Throw` carries a `JsValue`-like error. M2 supports throwing `Error`/`TypeError`/`RangeError` objects with a message, catching them, and `finally`. An uncaught exception in a handler aborts the handler atomically (cells unchanged), logs an error, and the app continues, matching the browser, where an exception in an event listener does not stop the page. Framework error boundaries arrive in M4.

## Reactivity of structured values

Cells can hold any type. The IR records each cell's tracking mode:

- **`"identity"`** (React `useState`, Vue `shallowRef`, Svelte `$state.raw`): the cell is dirty only when assigned a value that is not SameValue to the old one. Mutating an object held by the cell does not update the UI (React's observable behaviour).
- **`"deep"`** (Svelte `$state` proxies, Vue `ref`/`reactive`): additionally, any mutation of a heap value during a handler marks every deep cell of a reference type dirty. Bindings then recompute and write only changed DOM values. This over-approximates which cells changed, which is harmless for rendering. It is **not** acceptable for effects, so M4 must refine it (reachability or proxy identity) before effects depend on dirtiness.

Svelte's deep proxies give a proxied object a different identity from the raw object. M2 accepts `$state(...)` initialised with fresh literals, and values flowing in and out of deep state as long as identity comparisons between proxied and raw objects cannot occur; otherwise it emits `E_PROXY_IDENTITY`. `$state.raw` cells must not be mutated through their value (`E_RAW_MUTATION`); reassignment is fine.

## IR additions (schema 4, additive)

```jsonc
"records":   [ { "name": "Item", "fields": [ { "name": "label", "type": "string" } ] } ],
"functions": [ { "name": "total", "params": [ { "name": "items", "type": {"array": {"record": 0}} } ],
                 "locals": [ { "name": "sum", "type": "number", "boxed": false } ],
                 "result": "number", "body": [Stmt], "captures": [ … ] } ],
"cells":     [ { …, "tracking": "deep" | "identity" } ]
```

Handlers gain `params`/`locals` the same way; their body may use every statement.

**Statements:**
- `let`: `{local, value}`
- `assign`: `{target: Place, value}`, where a place is a local, a cell, `field(obj, i)` or `index(arr, i)`
- `expr`: `{value}`
- `if`, `while` (with `test`, `body`, optional `update` for `for` loops), `for-of` (over arrays, maps, sets, strings)
- `break` / `continue` (optional `label`), `return`, `throw`
- `try`: `{body, catch: {local, body}?, finally?}`
- `switch` (lowered by frontends to `if` chains, preserving fallthrough explicitly)

**Expressions** (added to M1's):
- `local`, `undefined`, `null`
- `record`: `{record, fields}`; `array`: `{items: [Expr | {spread: Expr}]}`
- `get`: `{object, field}`; `index`: `{array, index}`
- `call`: `{function, args}`; `call-value`: `{callee, args}`; `closure`: `{function, captures}`
- `builtin`: `{name, args}`
- `typeof`; `div`, `rem`, `pow`, bitwise operators and unsigned shift
- `strict-eq` on all types (replacing the `eq` restriction to one type); `loose` equality only between number/string/boolean/nullish, where JS semantics are well defined, otherwise rejected
- `nullish` (`??`), `optional` (`?.` as `{optional: Expr, then: Expr}` in Maybe form)
- `to-number` (`Number(x)`, unary `+`), `to-boolean`, and template literals (lowered to `concat` plus `to-string`)

**Built-ins** are a catalogue in `runic-ir` (`builtins.rs`): name, signature, effect, interpreter implementation and Rust spelling. For each M2 family:

| Family | Contents |
|---|---|
| `Math.*` | all functions except `random` (deterministic tests need a seed hook, so `Math.random` is M5) |
| `Number` | `isNaN`, `isFinite`, `isInteger`, `parseFloat`, `parseInt`, `toFixed`, `toString(radix)`, `toPrecision` |
| `String.prototype` | `length`, `at`, `charAt`, `charCodeAt`, `codePointAt`, `slice`, `substring`, `indexOf`, `lastIndexOf`, `includes`, `startsWith`, `endsWith`, `trim*`, `toUpperCase`/`toLowerCase` (Unicode default case mapping), `padStart`/`padEnd`, `repeat`, `split` (string separator), `replace`/`replaceAll` (string pattern), `localeCompare` (root collation is M5; M2 uses code-unit order and diagnoses explicit locales) |
| `Array.prototype` | `length`, `at`, `push`, `pop`, `shift`, `unshift`, `slice`, `splice`, `concat`, `indexOf`, `includes`, `find`, `findIndex`, `findLast`, `some`, `every`, `filter`, `map`, `reduce`, `forEach`, `join`, `reverse`, `sort` (with comparator; stable), `toSorted`, `toReversed`, `with`, `fill`, `flat`(1), `flatMap`, `keys`/`values`/`entries` in `for-of` |
| `Array` | `Array.from` (array/string/set/map), `Array.isArray` (statically known) |
| `Object` | `keys`, `values`, `entries`, `assign`, spread for records |
| `JSON` | `stringify` for typed values; `parse` into a declared record/array type with runtime shape checking (`E_JSON_SHAPE` thrown as a `SyntaxError`-like error) |
| `Map`/`Set` | construction, `get`/`set`/`has`/`delete`/`clear`/`size`, iteration |
| `RegExp` | M5 (needs a JS-compatible engine); `E_REGEXP` until then |

Every built-in has differential tests against Node: vectors generated by `crates/runic-js/tests/vectors.mjs` and committed as JSON.

## New frontend (TypeScript)

`frontend/` contains type-stripped TypeScript run directly by Node 24 and checked by `tsc --noEmit` in `npm test`:

| Module | Responsibility |
|---|---|
| `frontend/ir.ts` | Schema 4 TypeScript types mirroring `runic-ir`, plus builders |
| `frontend/types.ts` | TypeScript checker types → IR types, with records deduplicated per program |
| `frontend/language.ts` | Shared lowering of TS/JS statements and expressions over a `Scope` that resolves identifiers to locals, cells (through adapter hooks), module bindings, functions or built-ins |
| `frontend/modules.ts` | Module graph: immutable module constants and functions become IR functions/constants. This replaces `compiler/modules.mjs`. |
| `frontend/adapters/svelte.ts` | First adapter on the new frontend; React and Vue follow |

Adapters provide only framework semantics: cell declarations and tracking modes, read and write semantics (`snapshot`/`current`, setter queues), derived values, the template and the event-to-handler mapping. All ordinary code goes through `language.ts`.

The old `compiler/adapters/*.mjs` keep serving the existing fixtures until the new adapter for that framework passes the same tests and conformance cases. Then the old adapter and the schema 3 path are deleted. The mapping validator moves onto the interpreter when `ir.mjs` is deleted.

## Work split

1. **Standalone:**
   - `runic-js` value types (`JsString`, `Maybe`, `JsArray`, `Throw`)
   - the IR additions with validator and interpreter
   - code generation for statements and functions
   - the frontend skeleton (`ir.ts`, `types.ts`, `language.ts`) and the Svelte adapter
2. **Parallel subagents**, once the value types and the built-in catalogue signature format are frozen: built-in families in `runic-js` and the interpreter (Number/Math, String, Array, JSON/Object/Map/Set), each with Node-generated test vectors. Each subagent works in a worktree on `crates/runic-js` and `crates/runic-ir/src/builtins/<family>.rs` only.
3. **After Svelte passes the examples:** React and Vue adapters on the new frontend.
