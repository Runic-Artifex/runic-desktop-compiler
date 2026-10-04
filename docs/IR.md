# Runic IR v4

This is the serialized contract between the frontend adapters and the Rust backend (D1). Its types live in `crates/runic-ir` (`src/lib.rs`), and that crate is the authority whenever this document and the code disagree. The `runic-ir` validator and reference interpreter define its meaning. The code generator in `crates/runic-codegen` must agree with that interpreter (D8).

Schema 4 was introduced in M1 and extended additively in M2 with values, statements and functions ([design](design/M2-VALUES.md)) in M3 with component instances, lists, slots, refs and more events ([design](design/M3-COMPONENTS.md)), and in M4 with scheduling, effects, derived values, promises and host services ([design](design/M4-EFFECTS.md)). The frontends in `frontend/` emit it directly. Older schema 2/3 artifacts are still accepted and migrated with `runic_ir::migrate`.

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
  "globals":   [ { "name": "DEFAULTS", "type": T, "init": Expr } ],  // module constants, evaluated once in order
  "components": [ Component, … ],
  "root": 0,                         // index of the mounted component
  "containerAttrs": { "data-v-app": "" },  // optional: attributes the framework sets on #root at mount
  "restoreFocus": true,              // optional: refocus an element a list move blurred (React DOM)
  // schedule.controlledRestore: restore controlled values after every event (React)
  "schedule": {                      // optional: the framework's update scheduling (defaults shown)
    "flush": "microtask",            // or "event-microtask": a default task outside input events
    "checkpoint": "dispatch",        // or "listener": a microtask checkpoint after each listener
    "changeWithClick": false,        // a checkbox's change listeners run in the click dispatch
    "cleanups": "interleaved",       // or "batched": a phase's cleanups (also of destroyed instances) before its effects
    "postWritesDeferred": false,     // writes from post effects update in a later default task
    "mount": "microtask",            // when the mount's effects run: "sync" | "microtask" | "task"
    "cleanupReadsPrevious": false    // cleanups read state as before the running flush
  }
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
| function | `{"fn": {"params": [T…], "result": T}}` | reference-counted closure (a component function's closure keeps its instance) |
| element | `"element"` | opaque element handle (refs), identity equality |
| attribute bag | `"attrs"` | `js::Attrs`: ordered `(name, value)` entries (attribute text, absent, boolean presence, or an `on<event>` listener); compared by entries, listeners by function identity (M5) |
| event | `"event"` | `js::Event`: the event object of a dispatch, read through `event.*` built-ins; identity equality (M5) |
| regexp | `"regexp"` | `js::RegExp`: a RegExp object (pattern, flags and a mutable `lastIndex`), read and used through `regexp.*` built-ins; identity equality (M5) |
| promise | `{"promise": T}` | `JsPromise<T>`: pending or settled, reactions run as microtasks; identity equality; never a promise of a promise |

Literal values (`lit`) are numbers, strings and booleans. String literals are Unicode text; a literal containing a lone surrogate is rejected by the frontend (`E_STRING`), although computed strings may contain one.

## Functions

```jsonc
{ "name": "total", "component": 0,            // optional: the component whose cells it may read and write
  "captures": [Local], "params": [Local], "locals": [Local],
  "result": "number", "body": [Stmt],
  "derived": true }                            // optional: a cached derived value of its component
Local = { "name": "sum", "type": "number", "boxed": false }
```

The local index space of a function is `captures`, then `params`, then `locals`. `boxed` marks a local that a closure captures and mutates, so it is shared by reference; unboxed captures are copied when the closure is created. Module-level functions have no `component`.

A `derived` function (Svelte `$derived`, Vue `computed`; no parameters) is cached per instance: it is recomputed when what it read changed, and a recomputation with the same (SameValue) result keeps its value, so dependents re-run only when its value changed.

## Components and instances

```jsonc
{
  "name": "Row",
  "cells":    [ { "name": "label", "type": "string", "init": Expr, "prop": "label", "tracking": "identity" } ],
  "handlers": [ { "event": "click", "params": [Local], "locals": [Local], "body": [Stmt] } ],
  "template": [ Node ],
  "templateLocals": [Local],                       // list items, slot params, template temporaries
  "slots": [ { "name": "row", "params": [T…] } ],  // slots the template renders
  "effects": [ { "run": 7, "phase": "post", "deps": { "kind": "tracked" },
                 "unmount": { "removal": "after", "order": "post" } } ]
}
```

- **Instances.** Every component can be instantiated many times; the root has one instance. An instance owns one value per cell, is created when its `component` node mounts (props, then cell initialisers) and destroyed with that node. Instance identity is the parent instance, the node, and the list keys and slot renderers on the path between them. Functions with `component: k` run in an instance of `k`.
- **Cells** are the instance's reactive state. `init` may only read cells declared earlier. A cell with `prop` receives that prop from the parent (`init` is its default): when the parent's value changes (SameValue) the cell is set and becomes dirty; a write by the child calls the parent's `bind` closure if there is one.
- **Tracking** decides when a write makes a cell dirty for bindings: `identity` (default) when the new value is not SameValue to the old one; `deep` also after any heap mutation since the last flush (Vue `ref`; what it holds is marked reactive); `proxied` (Svelte `$state`) stores proxies of plain objects and arrays (a new identity over the same storage) and is dirty after mutations through proxies; `none` never. `readonly` cells (React state and props) must not be mutated in place.
- **Handlers** run when an event reaches a listener. Their local index space is `params` (the listener's `args`), then `locals`. `event` is the event object; `payload` is a shorthand for the input value (`input`), the new checked state (`change`, boolean) or `event.key` (`keydown`). The listeners of one event share a task unless `schedule.checkpoint` is `listener`; document and window listeners each run as a callback of their own.
- **Flushes.** The first write after a flush queues a flush job (`schedule.flush`). A flush runs passes until effects stop writing: commit the state (render snapshots), update the tree (pre effects run as each instance updates or is created), run cleanups of destroyed instances, then layout and post effects children first. Closures created while a snapshot is current keep it (React reads).
- **Effects.** `run` is a function of the component returning nothing or a cleanup; with `values` dependencies it may take the new values and the previous ones. `phase` is `pre`, `layout` or `post`; `deps` is `tracked` (the cells, derived values and heap slots the last run read), `once`, `always` (after every update of the instance or an ancestor) or `values` (`{"values": [Expr], "initial": bool}`, compared with `Object.is`). `unmount` places the cleanup at destruction: before or after DOM removal, at the pre- or post-order position of the destroyed subtree.
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
| `local {local}`, `payload` | local type / event payload | |
| `attrs {items}` | attrs | An attribute bag from items in order, each `{name, value}` (value: string, `maybe<string>`, boolean, or for `on<event>` names a function taking the event or nothing) or `{spread}` (a bag); a later entry of a name wins |
| `event` | event | The event object of the running handler (handlers only; closures read it through a local) |
| `global {global}` | global type | A module constant |
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
| `closure {function, captures, stable?}` | fn | A function value; `captures` are the caller's local indices. `stable`: one function object per instance (or program), for script-level functions of Svelte and Vue and module functions |
| `builtin {name, args, type}` | `type` | A catalogue built-in (below) |
| `with {local, value, body}` | type of `body` | Bind `value` to `local`, then evaluate `body` |
| `mapped {rule, guard, fast, reference}` | type of `reference` | Only in migrated schema 3 programs |

**Built-ins** are a catalogue in `runic-ir` (`builtins.rs`) with type rules, interpreter implementations in `runic-js` and Rust spellings in `runic-codegen`. The families are `Math.*` (except `random`), `Number`/number methods, string methods, array methods (including callbacks and in-place mutation), `Array.from`/`Array.isArray`, `Object.keys/values/entries/assign`, `JSON.stringify`/`JSON.parse` into a declared type, `Map`/`Set`, `structuredClone` and the global conversion functions. The full list is in [M2-VALUES](design/M2-VALUES.md); each family has Node-generated test vectors in `crates/runic-js/tests/vectors/`. M4 adds host operations: `timer.timeout/interval/frame/clear`, `clock.now/date`, `microtask.queue`, `storage.get/set/remove/clear` (localStorage), `promise.new/resolve/reject/then/catch/finally/all` with the internal `promise.pending/fulfil/adopt/fail` of async functions, and `flush.tick` (a microtask running any pending flush, then fulfilling) and `flush.after` (fulfilled when the pending flush ends). M5 adds the event object members `event.type/key/code/ctrlKey/shiftKey/altKey/metaKey/repeat/clientX/clientY/button/buttons/deltaX/deltaY/target/currentTarget/defaultPrevented/value/checked` (`value`/`checked`: the target control's state at dispatch; `currentTarget` is null after the dispatch) and `event.preventDefault/stopPropagation/stopImmediatePropagation`, and `window.listen/unlisten` and `document.listen/unlisten` (`addEventListener`/`removeEventListener`: a literal event kind and a listener taking the event or nothing, identified by its function value; adding a registered listener again does nothing).

**Regular expressions** (M5) have exact ECMAScript semantics without a JS engine: `runic_js::regexp` implements RegExpBuiltinExec (`lastIndex`, global and sticky), `@@replace` with GetSubstitution (`$$`, `$&`, `` $` ``, `$'`, `$n`, `$nn`, `$<name>`), `@@split`, `@@match`, `@@matchAll` and `@@search` around the `regress` engine, matching UTF-16 code units (code points with `u`), so indices and `lastIndex` count code units. Vectors from Node cover them (`tests/vectors/regexp.json`, including every case-insensitive character pair). The built-ins:

- `regexp.new(source, flags)`: a literal or `new RegExp(source, flags)`. Flags are a literal (`dgimsuy`; `v` is rejected); a literal pattern is compiled at build time (`E_REGEXP`), a runtime one throws `SyntaxError` as in JavaScript.
- `regexp.source/flags/global/ignoreCase/multiline/dotAll/unicode/unicodeSets/sticky/hasIndices/lastIndex/toString` `(re)`, `regexp.set-lastIndex(re, n)`, `regexp.test(re, s)`, `regexp.exec(re, s)`.
- `string.regexp-replace/regexp-replaceAll(s, re, r)` with a string `r`, or a function `r` and the literal capture count `n`: `r` takes the match, the `n` captures, the position and the string (or a prefix of them; the groups object is unsupported); `replaceAll` throws `TypeError` without `g`.
- `string.regexp-match(s, re)`, `string.regexp-matchAll(s, re)` (all matches as an array: matching runs on a copy, so iterating eagerly is not observable), `string.regexp-search(s, re)`, `string.regexp-split(s, re, limit?)`.
- Match arrays are arrays of the captures (index 0: the match). Their extra properties are read through `match.index/input(m)` (`maybe<number>`/`maybe<string>`: undefined for other arrays, such as the result of a global `match`), `match.has-groups(m)` and `match.group(m, name)` (a literal name; undefined for a group that did not participate; `TypeError` when the pattern has no named groups, like `m.groups.name`).

Captures that do not participate are undefined. Results declare their elements: `maybe<string>`, or `string` where the frontend proved from a pattern known at build time (a literal, or a const holding one) that every capture participates in every match (not inside an alternative, a group quantified with minimum 0 or a negative lookaround); a capture that does not participate then throws `TypeError`, which proven patterns never do. `exec` and `match` return `maybe<array<…>>`, `matchAll` `array<array<…>>` and `split` `array<…>` in either form; replacement function parameters for captures are `string` or `maybe<string>` alike. The frontend reads `m[k]` that TypeScript types as `string` as `string` only where the pattern proves capture `k` present, keeps it nullable where undefined is handled (`??`, conditions, `!`, templates) and rejects it otherwise.

Where `regress` deviates, `runic_js::regexp` corrects it, verified by the vectors: without `u`, an escaped surrogate pair is two characters; case-insensitive matching without `u` treats ı ſ ϴ ẞ Ω K Å and the Greek letters with iota subscript as matching only themselves (they are replaced, in the input and the pattern, by caseless stand-ins from a block of code units the input does not use); with `u` and `i`, `\W` in a class keeps ſ and K out; with a Unicode flag, a `lastIndex` inside a surrogate pair moves to the pair's start (V8); syntax errors carry V8's message for the error kinds the vectors cover (the message of rarer invalid runtime patterns may be worded differently).

## Template

```jsonc
Node =
  { "kind": "element", "tag": "button",
    "attrs": [ { "name": "class", "value": Expr } ],     // string, Maybe<string> (absent when nullish) or boolean
    "props": [ { "name": "value", "value": Expr } ],     // live properties: value (text inputs), checked (checkboxes)
    "listeners": [ { "event": "click", "handler": 0, "args": [Expr] } ],
    "ref": 3,                                            // a cell of type element | null | undefined
    "children": [ Node ] }
| { "kind": "text", "parts": [ Expr ] }                  // concatenation of string parts
| { "kind": "if", "test": Expr, "then": [ Node ], "else": [ Node ] }
| { "kind": "each", "items": Expr, "item": 4, "index"?: 5, "key"?: Expr,
    "reorder"?: "lis" | "forward" | "stash", "body": [ Node ], "else"?: [ Node ] }
| { "kind": "component", "component": 1,
    "props": [ { "name": "label", "value": Expr, "bind"?: Expr } ],
    "slots": [ { "name": "row", "params": [6], "body": [ Node ] } ] }
| { "kind": "slot", "name": "row", "args": [Expr], "fallback": [ Node ] }
```

- **Tags** come from an allow-list in `validate.rs`.
- **Ids** may be dynamic; probes and conformance address the first element with an id in tree order, like `getElementById`.
- **Listeners:** at most one per element and event kind; `args` are evaluated at dispatch in the template scope. Events are `click`, `dblclick`, `contextmenu`, `input` (text inputs), `change` (checkboxes), `keydown` and `keyup` (from the focused element, before default actions), `pointerdown/up/move`, `mousedown/up/move`, `wheel` (all bubbling) and `pointerenter/leave`, `mouseenter/leave` (not bubbling). Listeners run target first, then on the ancestors, then on the document and the window; `stopPropagation` ends the walk after the current element and `stopImmediatePropagation` at once. A cancelled event (`preventDefault`) skips its default actions: the checkbox toggle (reverted), button activation, text insertion, focus moving on mousedown, scrolling. Event sequences follow Chromium (docs/design/M5-PLATFORM.md). Activation, focus, Tab order and the disabled/readonly checks belong to the runtime's DOM semantics.
- **Live properties:** `value` and `checked` are controlled. With `schedule.controlledRestore` (React) they are restored after every dispatch, also when it wrote no state; otherwise a value is applied when it differs from the one last applied, and what the user typed or toggled stays until then (Svelte, Vue). Equal values are left untouched, preserving selection and composition. Checkboxes require `checked`.
- **Lists:** blocks are matched by `key` (SameValueZero; duplicates throw `RunicKeyError`) or by index. Reused blocks keep their nodes, instances and state; `reorder` names the framework's keyed diff, which decides which blocks move (a moved focused element is blurred, as in Chromium).
- **Slots:** a component node's slot definitions run in the parent instance with `params` bound to the child's slot arguments; a child without content for a slot renders its `fallback`.
- **Spread:** an element's `spread` (an attribute bag) applies after its `attrs`, whose names it never holds (the frontend guarantees this from every call site). Its attributes are set or removed, and its `on<event>` entries are listeners of the element, re-registered when the bag changes. A component's rest props are a prop cell of type `attrs` with `prop: "..."`; the call site passes the bag as the prop `...`.
- **Class toggles** (`classes`): when the `class` value changes, the attribute is the value with names switched on appended and names switched off removed where they stand as words (Svelte's `to_class`); otherwise each changed toggle applies `classList.toggle`.
- **Managed inline style** (`styleText`, `styles`): when the style value changes, the value's declarations not given as properties, then the properties, are set through `cssText` (Svelte's `to_style`); otherwise changed properties are set or removed (`setProperty`/`removeProperty`). Serialisation is the CSSOM's (`runic-css`, Stylo).
- **Refs** hold the element while it is mounted and `null` after removal; `element.focus`/`element.blur` apply in order when the running callback returns (the DOM does not change while it runs).

## Validation limits

The validator caps a program at 4,096 template nodes, 1,024 cells per component, 1,024 handlers, 4,096 functions, expression and statement depth 96, 2^20 expressions and 4 MiB of CSS. Each limit has a diagnostic. These are resource limits, not semantic assumptions. Two semantic checks reject what the backend cannot reproduce: in-place mutation of `readonly` cells (`E_READONLY`), and template reads of values that change without making anything dirty (`E_REACTIVITY`: written `none` cells, identity-tracked references mutated in place, maps and sets mutated inside proxied state, mutated globals, RegExps whose `lastIndex` changes: exec, test, replace or match with a global or sticky RegExp, or setting `lastIndex`, unless the cell or global always holds a literal without `g` and `y`), which the frameworks would show only when neighbouring state re-renders. Diagnostics carry the source location of the statement, cell, handler or element they concern, falling back to the enclosing function or element.

## Snapshots

The interpreter's and probe's state snapshots contain the DOM, the root instance's `cells`, and `instances`: every other live instance in tree order as `{ "component": name, "cells": [...] }`. Element handles appear as `"element"`, event objects as `"event"`, RegExps as their `toString()`.

## Correctness

`runic_ir::interp` executes a program against an abstract DOM. `conformance/differential.mjs` runs generated code and the interpreter on seeded random event traces and compares DOM and cells after every step. The conformance harness tests both against the original frameworks in Chromium.
