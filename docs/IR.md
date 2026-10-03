# Runic IR v4

This is the serialized contract between the frontend adapters and the Rust backend (D1). Its types live in `crates/runic-ir` (`src/lib.rs`), and that crate is the authority whenever this document and the code disagree. The `runic-ir` validator and reference interpreter define its meaning. The code generator in `crates/runic-codegen` must agree with that interpreter (D8).

Schema 4 was introduced in M1 and extended additively in M2 with values, statements and functions ([design](design/M2-VALUES.md)). The frontends in `frontend/` emit it directly. Older schema 2/3 artifacts are still accepted and migrated with `runic_ir::migrate`.

## Program

```jsonc
{
  "schema": 4,
  "meta": { "title": "…", "sourceHash": "<sha256>", "frontend": {…}, "provenance": […], "mappings": [] },
  "renderer": "cpu",                 // D12: "cpu" | "gpu"
  "capabilities": ["dom", "css", "window", "click", "keyboard", "text-input"],
  "styles": { "css": "…", "assets": [{ "path": "assets/x.woff2", "sha256": "…", "bytes": 1234, "mime": "font/woff2" }] },
  "records":   [ { "name": "Item", "fields": [ { "name": "label", "type": "string" } ] } ],
  "functions": [ Function, … ],
  "components": [ Component, … ],
  "root": 0,                         // index of the mounted component
  "containerAttrs": { "data-v-app": "" }   // optional: attributes the framework sets on #root at mount
}
```

CSS refers to embedded assets as `url("runic-asset:<index>")`. The runtime resolves them from bytes compiled into the binary. Every object rejects unknown fields.

## Types and values

Types follow the value model (D16, [M2-VALUES](design/M2-VALUES.md)). Unit types serialize as strings and the others as single-key objects:

| Type | JSON | Native representation |
|---|---|---|
| number | `"number"` | `f64` with JavaScript semantics (`NaN`, `-0`, shortest round-trip `toString`) |
| string | `"string"` | `JsString`: immutable UTF-16, so indexing and `.length` count code units |
| boolean | `"boolean"` | `bool` |
| no value | `"void"` | result type of functions without a value |
| nullable | `{"maybe": T}` | `Maybe<T>`: `undefined`, `null` or a value |
| array | `{"array": T}` | `JsRef<Vec<T>>`: shared, mutable, identity equality |
| record | `{"record": i}` | generated struct behind `JsRef` (index into `records`) |
| map / set | `{"map": [K, V]}` / `{"set": T}` | insertion-ordered, SameValueZero keys |
| function | `{"fn": {"params": [T…], "result": T}}` | reference-counted closure |

Literal values (`lit`) are numbers, strings and booleans. String literals are Unicode text; a literal containing a lone surrogate is rejected by the frontend (`E_STRING`), although computed strings may contain one.

## Functions

```jsonc
{ "name": "total", "component": 0,            // optional: the component whose cells it may read and write
  "captures": [Local], "params": [Local], "locals": [Local],
  "result": "number", "body": [Stmt] }
Local = { "name": "sum", "type": "number", "boxed": false }
```

The local index space of a function is `captures`, then `params`, then `locals`. `boxed` marks a local that a closure captures and mutates, so it is shared by reference; unboxed captures are copied when the closure is created. Module-level functions have no `component`.

## Components

```jsonc
{
  "name": "App",
  "cells":    [ { "name": "count", "type": "number", "init": Expr, "tracking": "identity" } ],
  "handlers": [ { "event": "click" | "input", "locals": [Local], "body": [Stmt] } ],
  "template": [ Node ]
}
```

- **Cells** are the component's reactive state. `init` may only read cells declared earlier.
- **Tracking** decides when a write makes a cell dirty: `identity` (default) when the new value is not SameValue to the old one; `deep` also after any heap mutation during the handler (Svelte `$state`, Vue `ref`); `none` never (a plain variable whose changes do not update the UI).
- **Handlers** run synchronously when an event reaches a listener. `input` handlers receive the control's new value as `payload` (type string). The handler commits after its body finishes: every dirty cell's bindings update once.
- **Domains** (`{ "kind": "text", "maxUtf16": 256 }`) appear only in migrated schema 3 programs; they constrain a text cell on every write.

## Statements

| Statement | Meaning |
|---|---|
| `{ "op": "set", "cell": i, "value": e }` | Write cell `i`. Later `current` reads observe the write. |
| `{ "op": "let", "local": i, "value"?: e }` | Initialise a local |
| `{ "op": "assign", "target": Place, "value": e }` | Place is `{local}`, `{cell}`, `{object, field}` or `{array, index}` |
| `{ "op": "expr", "value": e }` | Evaluate for effects |
| `{ "op": "if", "test": e, "then": […], "else": […] }` | |
| `{ "op": "while", "test": e, "body": […], "update": […], "label"? }` | `for` loops put their update in `update`, which `continue` still runs |
| `{ "op": "for-of", "local": i, "iterable": e, "body": […], "label"? }` | Over arrays, sets and strings (by code point); maps through `keys()`/`values()` |
| `{ "op": "break" \| "continue", "label"? }` | |
| `{ "op": "return", "value"? }`, `{ "op": "throw", "value": e }` | |
| `{ "op": "try", "body": […], "catch"?: { "local"?, "body" }, "finally"?: […] }` | |

Frontends lower `switch` to `if` chains with explicit fall-through, compound assignments and `++`/`--` to `assign`, and destructuring to `let` sequences. Exceptions are values of any type; `RangeError`/`TypeError` thrown by built-ins are records with `name` and `message`.

## Expressions

Every expression has a statically known type, which the validator infers and checks.

| Expression | Type | Meaning |
|---|---|---|
| `lit {value}`, `undefined {type}`, `null {type}` | value / `type` | Literals; `undefined`/`null` carry their Maybe type |
| `cell {cell, read: "current" \| "snapshot"}` | cell type | `current`: latest value, including writes earlier in this handler. `snapshot`: the value the last render observed (React state). In templates and initialisers both mean the committed value. |
| `local {local}`, `payload` | local type / string | |
| `not`, `neg`, `bit-not`, `to-string`, `to-number`, `to-boolean`, `typeof`, `utf16-length` `{arg}` | | `!`, unary `-`, `~`, `String(x)`, `Number(x)`, `Boolean(x)`, `typeof`, `.length` |
| `add`, `sub`, `mul`, `div`, `rem`, `pow`, `min`, `max`, `bit-and`, `bit-or`, `bit-xor`, `shl`, `shr`, `ushr` `{left, right}` | number | JavaScript number operators |
| `concat {left, right}` | string | `+` on strings |
| `eq`, `ne` | boolean | `===`/`!==` on equal types (identity for heap values; Maybe compares its states) |
| `lt`, `le`, `gt`, `ge` | boolean | Ordering of numbers (and strings by code units, via built-ins) |
| `and`, `or` | boolean | Short-circuit on booleans; other operand types are lowered with `with` and `cond` |
| `nullish {left, right}` | type of `right` | `??` |
| `cond {test, then, else}` | type of `then` | `?:` |
| `record {record, fields}`, `array {type, items}` | record / array | Construction; array items may be `{spread: e}` |
| `get {object, field}`, `index {array, index}` | field / element type | Field read; checked array read (out of range throws `RangeError`, see deviations) |
| `some {value}`, `unwrap {value}` | Maybe / inner | Wrap into Maybe; unwrap (throws `TypeError` when nullish) |
| `optional {value, local, then}` | Maybe | `?.`: undefined when `value` is nullish, otherwise `then` with the unwrapped value in `local` |
| `call {function, args}`, `call-value {callee, args}` | result type | Direct and indirect calls |
| `closure {function, captures}` | fn | A function value; `captures` are the caller's local indices |
| `builtin {name, args, type}` | `type` | A catalogue built-in (below) |
| `with {local, value, body}` | type of `body` | Bind `value` to `local`, then evaluate `body` |
| `mapped {rule, guard, fast, reference}` | type of `reference` | Only in migrated schema 3 programs |

**Built-ins** are a catalogue in `runic-ir` (`builtins.rs`) with type rules, interpreter implementations in `runic-js` and Rust spellings in `runic-codegen`. The families are `Math.*` (except `random`), `Number`/number methods, string methods, array methods (including callbacks and in-place mutation), `Array.from`/`Array.isArray`, `Object.keys/values/entries/assign`, `JSON.stringify`/`JSON.parse` into a declared type, `Map`/`Set`, `structuredClone` and the global conversion functions. The full list is in [M2-VALUES](design/M2-VALUES.md); each family has Node-generated test vectors in `crates/runic-js/tests/vectors/`.

## Template

```jsonc
Node =
  { "kind": "element", "tag": "button",
    "attrs": [ { "name": "class", "value": Expr } ],     // string or boolean; boolean attrs are present iff true
    "props": [ { "name": "value", "value": Expr } ],     // live DOM properties (text input value)
    "listeners": [ { "event": "click", "handler": 0 } ],
    "children": [ Node ] }
| { "kind": "text", "parts": [ Expr ] }                  // concatenation of string parts
| { "kind": "if", "test": Expr, "then": [ Node ], "else": [ Node ] }
```

- **Tags** come from an allow-list in `validate.rs`. M3 adds `each` (keyed lists), `component`, `slot` and `region` nodes.
- **Element identity:** an element's `id` attribute must be a literal and unique within the program, because probes and conformance address elements by id.
- **Listeners:** at most one per element and event kind. Activation behaviour (Enter/Space on buttons, click focus, Tab order) and the disabled/readonly checks belong to the runtime's DOM semantics, not to the IR.
- **Text inputs:** a `value` prop is a live, controlled property: after every dispatch the runtime re-synchronises the control with the prop's value (equal values are left untouched, preserving selection and composition).

## Validation limits

The validator caps a program at 4,096 template nodes, 1,024 cells per component, 1,024 handlers, 4,096 functions, expression and statement depth 96, 2^20 expressions and 4 MiB of CSS. Each limit has a diagnostic. These are resource limits, not semantic assumptions. Diagnostics carry the source location of the statement, cell, handler or element they concern, falling back to the enclosing function or element.

## Correctness

`runic_ir::interp` executes a program against an abstract DOM. `conformance/differential.mjs` runs generated code and the interpreter on seeded random event traces and compares DOM and cells after every step. The conformance harness tests both against the original frameworks in Chromium.
