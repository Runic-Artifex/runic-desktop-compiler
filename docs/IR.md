# Runic IR v4

This is the serialized contract between the frontend adapters and the Rust backend (D1). Its types live in `crates/runic-ir` (`src/lib.rs`), and that crate is the authority whenever this document and the code disagree. The `runic-ir` validator and reference interpreter define its meaning. The code generator in `crates/runic-codegen` must agree with that interpreter (D8).

Schema 4 introduces the program, component, cell, handler and template structure that later milestones extend. M1 implements the subset needed by the existing fixtures. Schema 3 IR (still emitted by the JS adapters) is migrated with `runic_ir::migrate::from_schema3`.

## Program

```jsonc
{
  "schema": 4,
  "meta": { "title": "…", "sourceHash": "<sha256>", "frontend": {…}, "provenance": […], "mappings": […] },
  "renderer": "cpu",                 // D12: "cpu" | "gpu"
  "capabilities": ["dom", "css", "window", "click", "keyboard", "text-input"],
  "styles": { "css": "…", "assets": [{ "path": "assets/x.woff2", "sha256": "…", "bytes": 1234, "mime": "font/woff2" }] },
  "components": [ Component, … ],
  "root": 0                          // index of the mounted component
}
```

CSS refers to embedded assets as `url("runic-asset:<index>")`. The runtime resolves them from bytes compiled into the binary.

## Types and values

The types are `"number"` (IEEE-754 double with JavaScript semantics), `"string"` (a JavaScript string; for now a sequence of Unicode scalar values, with lengths measured in UTF-16 code units) and `"boolean"`. M2 adds `null`/`undefined`, structs, arrays, optionals and unions.

## Components

```jsonc
{
  "name": "App",
  "cells":    [ { "name": "count", "type": "number", "init": Expr, "domain"?: Domain } ],
  "handlers": [ { "name"?: "…", "event": "click" | "text-input", "body": [Stmt] } ],
  "template": [ Node ]
}
```

- **Cells** are the component's reactive state. `init` may only read cells declared earlier.
- **Domains** constrain a cell's values. `{ "kind": "text", "maxUtf16": 256 }` marks a single-line editable text cell: no control characters, at most `maxUtf16` code units, enforced on every write.
- **Handlers** run synchronously when an event reaches a listener. `text-input` handlers receive the control's new value as `payload` (type string).

## Statements

| Statement | Meaning |
|---|---|
| `{ "op": "set", "cell": i, "value": Expr }` | Write cell `i`. Later `current` reads in the same handler observe the write. |

The handler commits after its body finishes. Every cell whose value changed is marked dirty, and the template updates once. M2 adds locals, `if`, loops, and function calls.

## Expressions

Every expression has a statically known type, which the validator infers and checks.

| Expression | Type | Meaning |
|---|---|---|
| `{ "op": "lit", "value": v }` | type of `v` | Literal |
| `{ "op": "cell", "cell": i, "read": "current" \| "snapshot" }` | cell type | `current`: latest value, including writes earlier in this handler. `snapshot`: value at handler entry, i.e. the value the last render observed. In templates and initialisers both mean the committed value. |
| `{ "op": "payload" }` | string | Event payload; only in `text-input` handlers |
| `{ "op": "not" \| "neg" \| "to-string" \| "utf16-length", "arg": e }` | boolean / number / string / number | JS `!`, unary `-`, `String(x)`, `.length` |
| `{ "op": "add" \| "sub" \| "mul" \| "min" \| "max", "left": a, "right": b }` | number | JS arithmetic. `min`/`max` follow `Math.min`/`Math.max` (NaN propagates; `-0 < +0`). |
| `{ "op": "concat", "left": a, "right": b }` | string | String concatenation |
| `{ "op": "eq" \| "ne" \| "lt" \| "le" \| "gt" \| "ge", … }` | boolean | `===`/`!==` on equal types; ordering on numbers |
| `{ "op": "and" \| "or", … }` | boolean | Short-circuit on booleans |
| `{ "op": "cond", "test": t, "then": a, "else": b }` | type of `a` | `t ? a : b` |
| `{ "op": "mapped", "rule": "id@v", "guard": g, "fast": f, "reference": r }` | type of `r` | A validated mapping. Evaluates to `f` when `g` holds and to `r` otherwise; both branches are equal whenever `g` holds, which is what acceptance proves. Codegen may drop `r` only when `g` is constant true. |

The schema 3 operations `boolean-text` and `select` migrate to `to-string` and `cond`.

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

- **Tags** come from an allow-list (currently the schema 3 set). M3 adds `each` (keyed lists), `component`, `slot` and `region` nodes.
- **Element identity:** an element's `id` attribute must be a literal and unique within the program, because probes and conformance address elements by id.
- **Listeners:** at most one per element and event kind. Activation behaviour (Enter/Space on buttons, click focus, Tab order) and the disabled/readonly checks belong to the runtime's DOM semantics, not to the IR.
- **Text inputs:** an `input` with a `value` prop must bind a text-domain cell and have a `text-input` listener whose handler sets that cell from `payload`. That keeps the Phase 2 controlled-input contract.

## Validation limits

The validator caps the program at: 4,096 template nodes, 256 cells per component, 1,024 handlers, expression depth 64 and 4 MiB of CSS. Each limit has a diagnostic. These are resource limits, not semantic assumptions.

The schema 3 limits on number ranges (`|state| ≤ 64`, exact integers ≤ 10^6) are *not* part of schema 4. Numbers follow JavaScript double semantics, so overflow and precision behave as they do in the browser. Until M2 rewrites the frontends, the JS adapters still enforce the schema 3 limits before migration.

## Correctness

`runic_ir::interp` executes a program against an abstract DOM. Generated code is tested against it on random event traces (`cargo test -p runic-codegen`). The conformance harness tests both against the original frameworks in Chromium.
