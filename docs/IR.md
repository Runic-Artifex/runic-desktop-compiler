# Runic IR v4

This is the serialized contract between the frontend adapters and the Rust backend (D1). Its types live in `crates/runic-ir` (`src/lib.rs`), and that crate is the authority whenever this document and the code disagree. The `runic-ir` validator and reference interpreter define its meaning. The code generator in `crates/runic-codegen` must agree with that interpreter (D8).

Schema 4 was introduced in M1 and extended additively in M2 with values, statements and functions ([design](design/M2-VALUES.md)) in M3 with component instances, lists, slots, refs and more events ([design](design/M3-COMPONENTS.md)), and in M4 with scheduling, effects, derived values, promises and host services ([design](design/M4-EFFECTS.md)); M6 adds class records. The frontends in `frontend/` emit it directly. Older schema 2/3 artifacts are still accepted and migrated with `runic_ir::migrate`.

## Program

```jsonc
{
  "schema": 4,
  "meta": { "title": "…", "sourceHash": "<sha256>", "frontend": {…}, "provenance": […], "mappings": [{ "id": "clsx@2.1.1", "version": 1, "sha256": "…" }] },
  "renderer": "cpu",                 // D12: "cpu" | "gpu"
  "capabilities": ["dom", "css", "window", "click", "keyboard", "text-input"],
  "styles": { "css": "…", "assets": [{ "path": "assets/x.woff2", "sha256": "…", "bytes": 1234, "mime": "font/woff2" }] },
  "records":   [ { "name": "Item", "fields": [ { "name": "label", "type": "string" } ] } ],  // "class": true marks class instances (M6)
  "functions": [ Function, … ],
  "globals":   [ { "name": "DEFAULTS", "type": T, "init": Expr } ],  // module constants, evaluated once in order
  "components": [ Component, … ],
  "root": 0,                         // index of the mounted component
  "containerAttrs": { "data-v-app": "" },  // optional: attributes the framework sets on #root at mount
  "restoreFocus": true,              // optional: refocus an element a list move blurred (React DOM)
  // schedule.controlledRestore: restore controlled values after every event (React)
  // schedule.commitEventsIgnored: events dispatched during the DOM update reach only window and document listeners (React DOM disables its event system while it commits)
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

`meta.mappings` lists the mapping packs ([D9](design/M6-LIBRARIES.md#mapping-packs-d9)) the frontend used: `<package>@<version>`, the pack format version (1) and the SHA-256 of the pack module. It is provenance only: packs lower to ordinary IR (expressions, functions and template nodes), so the backend never sees a package.

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
| date | `"date"` | `js::Date`: a Date object (a mutable time value), read and changed through `date.*` built-ins; identity equality; `to-string` is `toString()`, `to-number` the time value (M5) |
| promise | `{"promise": T}` | `JsPromise<T>`: pending or settled, reactions run as microtasks; identity equality; never a promise of a promise |

**Class instances** (M6, [design](design/M6-LIBRARIES.md#library-code-steps-3-to-6)) are records with `"class": true`: nominal (the frontend never shares a class record with a structurally equal one), with one field per instance field, `#private` ones included under their `#name`. Methods, accessors and constructors are ordinary functions (a method takes the instance as its first parameter; a constructor returns it), so the interpreter and code generator need no other construct. Class records differ from plain ones in three ways: deep state never proxies them (Svelte's `$state` proxies plain objects and arrays only, so a `proxied` cell holds the instance itself, and mutating it in place while the template reads it is `E_REACTIVITY`); they are not plain data (`JSON.stringify`, `JSON.parse`, `structuredClone` and `Object.keys`/`values` reject them); and `to-string` of one is `E_CLASS` (its `toString` method would not be dispatched).

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
- **Effects.** `run` is a function of the component returning nothing or a cleanup; with `values` dependencies it may take the new values and the previous ones. `phase` is `pre`, `layout` or `post`; `deps` is `tracked` (the cells, derived values and heap slots the last run read), `once`, `always` (after every update of the instance or an ancestor) or `values` (`{"values": [Expr], "initial": bool}`, compared with `Object.is`). `unmount` places the cleanup at destruction: before or after DOM removal, at the pre- or post-order position of the destroyed subtree. An effect with `render: true` (at most one per component; a tracked pre effect without a cleanup) stands for the instance's render (Vue's render effect: it reads what the template reads): each of its runs is a re-render.
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
| `attrs {items, merge?}` | attrs | An attribute bag from items in order, each `{name, value}` (value: string, `maybe<string>`, boolean, or for `on<event>` names a function taking the event or nothing) or `{spread}` (a bag); a later entry of a name wins. With `merge: true` (Vue's `mergeProps`), an entry, or each resolved entry of a spread, combines with an earlier one of its name in place: `class` keeps the earlier value when both are equal and otherwise joins the non-empty trimmed values with a space (absent counts as empty); other names take the later value |
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

**Built-ins** are a catalogue in `runic-ir` (`builtins.rs`) with type rules, interpreter implementations in `runic-js` and Rust spellings in `runic-codegen`. The families are `Math.*` (except `random`), `Number`/number methods, string methods, array methods (including callbacks and in-place mutation), `Array.from`/`Array.isArray`, `Object.keys/values/entries/assign`, `JSON.stringify`/`JSON.parse` into a declared type, `Map`/`Set`, `structuredClone` and the global conversion functions. The full list is in [M2-VALUES](design/M2-VALUES.md); each family has Node-generated test vectors in `crates/runic-js/tests/vectors/`. M4 adds host operations: `timer.timeout/interval/frame/clear`, `clock.now/date`, `microtask.queue`, `storage.get/set/remove/clear` (localStorage), `promise.new/resolve/reject/then/catch/finally/all` with the internal `promise.pending/fulfil/adopt/fail` of async functions, and `flush.tick` (a microtask running any pending flush, then fulfilling) and `flush.after` (fulfilled when the pending flush ends). M5 adds the event object members `event.type/key/code/ctrlKey/shiftKey/altKey/metaKey/repeat/clientX/clientY/button/buttons/deltaX/deltaY/target/currentTarget/defaultPrevented/value/checked` (`value`/`checked`: the target control's state at dispatch; `currentTarget` is null after the dispatch) and `event.preventDefault/stopPropagation/stopImmediatePropagation`, and `window.listen/unlisten` and `document.listen/unlisten` (`addEventListener`/`removeEventListener`: a literal event kind and a listener taking the event or nothing, identified by its function value; adding a registered listener again does nothing). Dates (`date.*`) and locale-sensitive formatting and collation (`intl.*`) follow the regular expressions below, and the host services `console.*`, `clipboard.*`, `history.*`, `location.*` and `random.*` after them.

**Host services** (M5, [design](design/M5-PLATFORM.md#host-services)) follow the `localStorage` shape: built-ins in their own namespace, one `runic-runtime` module each (OS-backed in apps, in memory and seeded by the case in probes), modelled by the interpreter.

- `console.log/info/warn/error/debug(args…)`: one or more strings, numbers, booleans or nullable ones. The line is the arguments' ToString joined with spaces: Chromium's console message text (also Playwright's `msg.text()`; `-0` prints `0`). A first argument of string type followed by more arguments must be a string literal without `%` (Chromium keeps a format string in its message text and converts the arguments of `%d`/`%i`/`%f`/`%s`, while DevTools substitutes them). Apps write the line to stderr.
- `clipboard.write(text)` → `promise<void>`, `clipboard.read()` → `promise<string>` (`navigator.clipboard.writeText/readText`). The promise settles in a host task after the running task (Chromium's reply comes from the browser process: after `setTimeout(0)` and message tasks, in either order with animation frames). A clipboard holds text: lone surrogates become U+FFFD. An operation while another is pending throws `RunicHostError` (Chromium settles overlapping operations in an order depending on their kinds). Apps use the OS clipboard; a failure rejects with a `NotAllowedError`, and a clipboard without text reads as empty.
- `history.push(url?)`, `history.replace(url?)` (`pushState`/`replaceState` with a null state): the URL resolves against the current one (WHATWG URL parsing, plus Chromium's escaping of `^` and `|` in paths; an empty URL keeps the current one, fragment included); no events. Absolute URLs, other origins and lone surrogates in the path throw `RunicHistoryError` (Chromium throws a SecurityError naming the origin). Pushing truncates later entries; at most 50 entries are kept.
- `history.back()`, `history.forward()`, `history.go(n)` (a non-zero integer literal; `go(0)` reloads): a traversal in a host task after the running task. Out of range does nothing. It fires `popstate` at the window, then, when the URLs differ only in their fragments (absent and empty differ), `hashchange` as a task of its own. A traversal while another is pending throws `RunicHistoryError` (Chromium may drop the second). `history.length()` is the entry count.
- `location.pathname/search/hash()` (`search` and `hash` are empty for an empty query or fragment) and `location.set-hash(v)`: a fragment navigation unless the fragment already is `v` without one leading `#` (an absent fragment counts as empty). It pushes an entry, or replaces the current one while the document loads (the mount), then fires `popstate` at once, nested in the setter with no microtask checkpoint, and queues `hashchange`. A second fragment navigation while loading throws `RunicHistoryError` (Chromium delays the `hashchange` of loading-time navigations past the load event, in an order not modelled). `location.href` and other origin-dependent members are rejected by the frontend.
- `random.number()` (`Math.random()`) and `random.uuid()` (`crypto.randomUUID()`): apps use OS randomness; probes and the interpreter use `runic_js::random` (SplitMix64 seeded by the case's `seed`, default 1; a number is the top 53 bits over 2^53, a UUID two outputs big-endian with the version 4 and variant bits), restarted with each app instance (`reload`).
- Templates and derived values must not use these built-ins, directly or through the functions they call (`E_REACTIVITY`): their values change without notifying the framework, and derived values are computed when read.

The session history outlives app instances: a probe `reload` starts a new document at the current entry; a traversal to an entry of an earlier document is outside the model (the probe stops, the interpreter rejects the step).

**Regular expressions** (M5) have exact ECMAScript semantics without a JS engine: `runic_js::regexp` implements RegExpBuiltinExec (`lastIndex`, global and sticky), `@@replace` with GetSubstitution (`$$`, `$&`, `` $` ``, `$'`, `$n`, `$nn`, `$<name>`), `@@split`, `@@match`, `@@matchAll` and `@@search` around the `regress` engine, matching UTF-16 code units (code points with `u`), so indices and `lastIndex` count code units. Vectors from Node cover them (`tests/vectors/regexp.json`, including every case-insensitive character pair). The built-ins:

- `regexp.new(source, flags)`: a literal or `new RegExp(source, flags)`. Flags are a literal (`dgimsuy`; `v` is rejected); a literal pattern is compiled at build time (`E_REGEXP`), a runtime one throws `SyntaxError` as in JavaScript.
- `regexp.source/flags/global/ignoreCase/multiline/dotAll/unicode/unicodeSets/sticky/hasIndices/lastIndex/toString` `(re)`, `regexp.set-lastIndex(re, n)`, `regexp.test(re, s)`, `regexp.exec(re, s)`.
- `string.regexp-replace/regexp-replaceAll(s, re, r)` with a string `r`, or a function `r` and the literal capture count `n`: `r` takes the match, the `n` captures, the position and the string (or a prefix of them; the groups object is unsupported); `replaceAll` throws `TypeError` without `g`.
- `string.regexp-match(s, re)`, `string.regexp-matchAll(s, re)` (all matches as an array: matching runs on a copy, so iterating eagerly is not observable), `string.regexp-search(s, re)`, `string.regexp-split(s, re, limit?)`.
- Match arrays are arrays of the captures (index 0: the match). Their extra properties are read through `match.index/input(m)` (`maybe<number>`/`maybe<string>`: undefined for other arrays, such as the result of a global `match`), `match.has-groups(m)` and `match.group(m, name)` (a literal name; undefined for a group that did not participate; `TypeError` when the pattern has no named groups, like `m.groups.name`).

Captures that do not participate are undefined. Results declare their elements: `maybe<string>`, or `string` where the frontend proved from a pattern known at build time (a literal, or a const holding one) that every capture participates in every match (not inside an alternative, a group quantified with minimum 0 or a negative lookaround); a capture that does not participate then throws `TypeError`, which proven patterns never do. `exec` and `match` return `maybe<array<…>>`, `matchAll` `array<array<…>>` and `split` `array<…>` in either form; replacement function parameters for captures are `string` or `maybe<string>` alike. The frontend reads `m[k]` that TypeScript types as `string` as `string` only where the pattern proves capture `k` present, keeps it nullable where undefined is handled (`??`, conditions, `!`, templates) and rejects it otherwise.

Where `regress` deviates, `runic_js::regexp` corrects it, verified by the vectors: without `u`, an escaped surrogate pair is two characters; case-insensitive matching without `u` treats ı ſ ϴ ẞ Ω K Å and the Greek letters with iota subscript as matching only themselves (they are replaced, in the input and the pattern, by caseless stand-ins from a block of code units the input does not use); with `u` and `i`, `\W` in a class keeps ſ and K out; with a Unicode flag, a `lastIndex` inside a surrogate pair moves to the pair's start (V8); syntax errors carry V8's message for the error kinds the vectors cover (the message of rarer invalid runtime patterns may be worded differently).

**Dates** (M5) follow V8 (`runic_js::date`, a port of V8's date code and its `Date.parse`, pinned by Chromium vectors in `tests/vectors/date.json`). The built-ins:

- `date.new(tv)`: a Date holding TimeClip(`tv`). The frontend lowers `new Date()` to `date.new(clock.date)`, `new Date(s)` to `date.new(date.parse(s))`, `new Date(d)` to `date.new(date.getTime(d))`, `new Date(n)` to `date.new(n)`; `Date()` is the `toString` of the current time.
- `date.local(y, m, d, h, min, s, ms)` and `date.utc(…)`: the time value of components in local time (`new Date(y, m, …)`) or UTC (`Date.UTC`); the frontend supplies the defaults. `date.parse(s)`: `Date.parse`, ISO strings and V8's legacy formats (`Jan 2 2026`, `2026/01/02 10:00 PM`, `toString`/`toUTCString` output, …).
- `date.getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/getMilliseconds(d)`, their `getUTC…` forms, `date.getTimezoneOffset(d)` and `date.getTime(d)` (also `valueOf`).
- `date.setFullYear/setMonth/setDate/setHours/setMinutes/setSeconds/setMilliseconds(d, …)`, their `setUTC…` forms and `date.setTime(d, t)`: change the Date and return its new time value (V8's argument handling and local-time arithmetic).
- `date.toString/toDateString/toTimeString/toUTCString(d)` as V8 prints them (`toGMTString` is `toUTCString`), `date.toISOString(d)` (RangeError for an invalid date) and `date.toJSON(d)` (`maybe<string>`: null for an invalid date; the frontend accepts it only where null is handled).

Local time uses the environment's time zone: the manifest's `timezone` in probes and the interpreter (default UTC), the system zone in production (`TZ`, `/etc/localtime`; unknown zones fall back to UTC). Offsets come from the IANA database bundled with `jiff` (2026c, rearguard like ICU); a local time in a gap or fold takes the offset before the transition (ICU's `UCAL_TZ_LOCAL_FORMER`, V8's choice); instants beyond years ±9999 move by 400-year cycles. `toString` names the zone in the default locale with names read from Chromium (`runic_js::intl` data), standard or daylight saving time as V8 decides it (outside 1970–2038 in an equivalent year). 589 of the 598 bundled zones match Chromium at every sample instant; the others (Morocco and Western Sahara, America/Vancouver, America/Edmonton and their aliases, Europe/Chisinau) differ from Chromium's older time zone data in offsets or names. They are unverified: probes and the interpreter refuse them as a case's `timezone` and the validator as a `timeZone` literal, while production uses the bundled rules. `Date` values are not JSON-serialisable (`JSON.stringify` and `structuredClone` reject them), and `+` with a number is rejected (JavaScript concatenates).

**Intl** (M5): formatting and collation for the verified locales en-US, en-GB, de-DE, fr-FR and ja-JP (and en, de, fr, which format as en-US, de-DE and fr-FR):

- `intl.format-date(tv, options, locale?)`: `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` (of `date.getTime(d)`) and `Intl.DateTimeFormat#format` (of a Date, a number, or the clock).
- `intl.format-number(x, options, locale?)`: `Number.prototype.toLocaleString` and `Intl.NumberFormat#format`.
- `intl.compare(a, b, options, locale?)`: `localeCompare` with locales or options and `Intl.Collator#compare` (also as a comparator value: the frontend makes a function); `string.localeCompare(a, b)` collates for the default locale.

`options` is a literal string `m=<method>;loc=<tag>;<option>=<value>…` (methods: dates `d`, `t`, `a`, `f`; numbers `n`, `f`; collation `l`, `c`); the validator parses it with `runic_js::intl` (`E_INTL`). A literal locale is part of it; a locale computed at runtime is the last argument and must name a verified locale when the program runs, else a RangeError is thrown (no other data is verified). Without either, the default locale is the manifest's `locale` (default en-US) in probes and the system's (`LC_ALL`, `LC_TIME`, `LANG`; unverified locales fall back to en-US) in production. Supported options:

- dates: `weekday`, `year`, `month`, `day`, `hour`, `minute`, `second`, `hour12`, or `dateStyle` with `timeStyle` `medium`/`short` (and `hour12`); `timeZone` (a verified IANA name). The defaults follow ECMA-402's ToDateTimeOptions for each method. Rejected: `timeStyle` `full`/`long`, `timeZoneName`, `era`, `hourCycle`, `fractionalSecondDigits`, `dayPeriod`, calendars and numbering systems.
- numbers: `style` `decimal`, `percent`, `currency` (USD, EUR, GBP, JPY, CHF, CNY, INR, CAD, AUD) with `currencyDisplay` `symbol`, `narrowSymbol`, `code`; `minimumIntegerDigits`, `minimum`/`maximumFractionDigits`, `minimum`/`maximumSignificantDigits` (ECMA-402 2023 resolution; out-of-range values are rejected), `useGrouping`. Rejected: other notations, `signDisplay`, units, rounding options.
- collation: `sensitivity`, `numeric`, `caseFirst`, `ignorePunctuation`, `usage: "sort"`.

Formats reproduce Chromium from locale data generated from it (`crates/runic-js/tests/vectors/intl.mjs` → `src/intl/data.rs`): every supported component combination's pattern, checked against Chromium at ~50 instants, number symbols and affixes, zone names. Numbers use ICU's model (shortest round-trip digits, half-expand rounding). Collation is ICU4X (`icu_collator` 2.3.1, compiled CLDR data). All of it is pinned by Chromium vectors (`tests/vectors/intl.json`). Intl objects are not IR values: `new Intl.DateTimeFormat(…)` with literal arguments, directly or through a `const`, is folded into its uses; other uses, other Intl constructors and `formatToParts`/`resolvedOptions` are rejected. `toLocaleUpperCase`/`toLocaleLowerCase` without a locale or with a verified literal one are `toUpperCase`/`toLowerCase` (no verified locale has special case mappings).

## Template

```jsonc
Node =
  { "kind": "element", "tag": "button",
    "attrs": [ { "name": "class", "value": Expr } ],     // string, Maybe<string> (absent when nullish) or boolean
    "props": [ { "name": "value", "value": Expr } ],     // live properties: value, checked, defaultValue, selectValue
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

- **Tags** come from an allow-list in `validate.rs` (`TAGS`), which includes the inline SVG elements below.
- **Inline SVG** (M5): `svg`, `g`, `path`, `circle`, `ellipse`, `line`, `polyline`, `polygon` and `rect` (`SVG_TAGS`) are created in the SVG namespace. Blitz renders an `<svg>` as a replaced element: it serialises the subtree's attributes, with `currentColor` replaced by each element's computed CSS `color`, and draws them with usvg into the content box (`object-fit: contain`), clipped by the UA rule `svg { overflow: hidden }` that Chromium also has. So the validator accepts only what both engines read the same way (`E_SVG`):
  - Placement: an `<svg>` is not inside another; the other SVG elements are children of `<svg>` or `<g>`; shapes have no children; an `<svg>` holds no HTML elements, components or slot outlets, and text only if it is literal HTML whitespace. `if` and `each` nodes may stand anywhere among them.
  - An `<svg>` needs a string `viewBox`. Its attributes are `xmlns` (only the literal `http://www.w3.org/2000/svg`), `width`, `height` (CSS sizes in both engines; author CSS may override them), `viewBox`, `class`, `id`, `role` (M6), the paint attributes and `aria-*`/`data-*`. Attributes that Chromium applies to the outer box but Blitz only to the drawing (`opacity`, `transform`, `display`, `style`, `color`, …) are rejected.
  - Paint attributes on every SVG element: `fill`, `fill-opacity`, `fill-rule`, `stroke`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-miterlimit`, `stroke-dasharray`, `stroke-dashoffset`, `stroke-opacity`. Besides them and `class`, `aria-*`, `data-*`: `g` takes `opacity`, `transform`; each shape also its geometry (`path` `d`; `circle` `cx`, `cy`, `r`; `ellipse` `cx`, `cy`, `rx`, `ry`; `line` `x1`, `y1`, `x2`, `y2`; `polyline`/`polygon` `points`; `rect` `x`, `y`, `width`, `height`, `rx`, `ry`). No `id` (SVG children have no layout boxes in Blitz), `style` or `color` (`currentColor` is resolved from CSS `color` before usvg sees the attribute).
  - Values are strings or nullable strings (absent when nullish), static or bound; boolean values are rejected.
  - No listeners, spreads (they may carry listeners), refs or managed inline styles: Blitz hit-tests an inline `<svg>` as one box, where Chromium targets the painted shape. Class toggles are allowed.
  - Attribute changes, children added or removed and style changes inside an `<svg>` make Blitz serialise and parse it again.
- **Ids** may be dynamic; probes and conformance address the first element with an id in tree order, like `getElementById`.
- **Listeners:** at most one per element and event kind; `args` are evaluated at dispatch in the template scope. Events are `click`, `dblclick`, `contextmenu`, `input` (text inputs), `change` (checkboxes), `keydown` and `keyup` (from the focused element, before default actions), `pointerdown/up/move`, `mousedown/up/move`, `wheel` (all bubbling) and `pointerenter/leave`, `mouseenter/leave` (not bubbling). `popstate` and `hashchange` (M5) are fired at the window only: `window.listen` takes them, element and document listeners do not. Listeners run target first, then on the ancestors, then on the document and the window; `stopPropagation` ends the walk after the current element and `stopImmediatePropagation` at once. A cancelled event (`preventDefault`) skips its default actions: the checkbox toggle (reverted), button activation, text insertion, focus moving on mousedown, scrolling. Event sequences follow Chromium (docs/design/M5-PLATFORM.md). Activation, focus, Tab order and the disabled/readonly checks belong to the runtime's DOM semantics.
- **Selects:** `select` with `option` children; its `value` is the shown option's (a value no option has shows none: `""`; uncontrolled, the chosen option while it exists, else the first enabled one; option values default to their collapsed text). Picking an option dispatches `input` then `change`. A focused closed select changes with arrows, Home, End and typeahead (Linux Chromium); a press opens its popup, which takes the key downs, moves a highlight shown in the control, and commits on Enter (then a `click`), Escape or any press.
- **Radio buttons:** `input type="radio"` takes `checked` and `change` as a checkbox does. Its group is the radios with the same `name` in the same form owner (none: the document). Checking one unchecks the others without events; a click on an unchecked radio dispatches `click`, `input` and `change` to it only, a click on a checked one only `click`, and a cancelled click restores the group. Arrow keys move to the next or previous enabled radio of the group (wrapping), check it and dispatch `click`, `input`, `change`; Tab enters a group once, at its checked radio or else the first (last with Shift) one. A radio button checked by script (`checked` set true) unchecks the others of its group (the radios with its name in the same tree, also a detached one being built), without events; a checked radio button that becomes connected does the same, one by one in tree order, so the last checked one stays checked.
- **Live properties:** `value` and `checked` are controlled. With `schedule.controlledRestore` (React) they are restored after every dispatch that ran listeners, also when it wrote no state, and at every update (not between a picked option's `input` and `change`); otherwise a value is applied when it differs from the one last applied, and what the user typed or toggled stays until then (Svelte; Vue checkboxes). An element with `restore: "render"` also applies its `value` at every re-render of its instance (each run of the component's `render` effect), where the live value differs (Vue patching `value` of text inputs, text areas and selects). Equal values are left untouched, preserving selection and composition. Checkboxes and radio buttons require `checked`. A select controlled with `selectValue` instead of `value` shows the first option with that value, else the first enabled option, else keeps its selection (React DOM's `updateOptions`). A text area may also have `defaultValue` (with `value`): its text content (children), set when it changes and applied before `value`, which starts from it (React DOM keeps it equal to the controlled value).
- **Lists:** blocks are matched by `key` (SameValueZero; duplicates throw `RunicKeyError`) or by index. Reused blocks keep their nodes, instances and state; `reorder` names the framework's keyed diff, which decides which blocks move (a moved focused element is blurred, as in Chromium).
- **Slots:** a component node's slot definitions run in the parent instance with `params` bound to the child's slot arguments; a child without content for a slot renders its `fallback`.
- **Spread:** an element's `spread` (an attribute bag) applies after its `attrs`, whose names it never holds (the frontend guarantees this from every call site). Its attributes are set or removed, and its `on<event>` entries are listeners of the element, re-registered when the bag changes. A component's rest props are a prop cell of type `attrs` with `prop: "..."`; the call site passes the bag as the prop `...`.
- **Class toggles** (`classes`): when the `class` value changes, the attribute is the value with names switched on appended and names switched off removed where they stand as words (Svelte's `to_class`); otherwise each changed toggle applies `classList.toggle`.
- **Managed inline style** (`styleText`, `styles`): when the style value changes, the value's declarations not given as properties, then the properties, are set through `cssText` (Svelte's `to_style`); otherwise changed properties are set or removed (`setProperty`/`removeProperty`). With `styleUpdate: "replace"` (Vue's `patchStyle`) an element has either a style text, set through `cssText` when it changes (an empty text is an empty attribute; becoming nullish after a non-empty text removes the attribute), or properties, which are all set again in order at mount and whenever one changes, after removing the nullish ones (from the first update on): a nullish or empty value removes the property, a value ending in `!important` (JavaScript's `/\s*!important$/`) sets it important, an invalid value changes nothing; property names are CSS or custom properties. Without `styleText` (and without `styleUpdate`) there is no style value (React DOM's `setValueForStyles`): each property is set through the CSSOM's `setProperty` when its value changed, initially when defined, so a property set again is appended; an absent or empty value removes it. Serialisation is the CSSOM's (`runic-css`, Stylo).
- **Refs** hold the element while it is mounted and `null` after removal. `element.focus`/`element.blur` move focus at once: the `blur`, `focusout`, `focus` and `focusin` listeners run nested in the call, with no microtask checkpoint.
- **Layout reads and scrolling** (CSSOM View) read the native layout after resolving it:
  - `element.getBoundingClientRect` returns a record of `x, y, width, height, top, right, bottom, left` (numbers, in that order) in layout units of 1/64 px.
  - `element.<metric>` for `offsetWidth/Height/Left/Top`, `clientWidth/Height/Left/Top`, `scrollWidth/Height`, `scrollTop/Left`: integers pixel-snapped as Blink snaps them (offsets relative to the `offsetParent`, ignoring scrolling).
  - `element.set-scrollTop/set-scrollLeft`, `element.scrollTo/scrollBy(left, top)` (each `maybe<number>`; absent keeps that axis or does not move it) and `element.scrollIntoView(block, inline)` (literal `start`, `center`, `end` or `nearest`) scroll at once, to whole pixels, clamped. `scrollIntoView` aligns the element in every scroll container from the element outwards, then in the viewport.
  - `window.innerWidth/innerHeight/scrollX/scrollY` and `window.scrollTo/scrollBy` do the same for the viewport.
  - Smooth scrolling is rejected.
  - The reference interpreter has no layout: these built-ins throw `RunicLayoutError` there, and the differential harness reports programs using them as incomplete. They are checked against Chromium only.
- **Focus:** controls and elements with `tabindex` are focusable. Mousedown focuses the pressed one (or nothing); Tab follows the sequential order (positive `tabindex` first, then tree order) and leaves the document past the end. Every move dispatches `blur` and `focusout` on the old element, then `focus` and `focusin` on the new one, naming each other as `relatedTarget`. When an update removes the focused element (or an ancestor), or a keyed diff moves its block, Chromium dispatches `blur` and `focusout` (no related target) at once, while the element is still in the document: their listeners run nested in the update, before the block is disposed. With `restoreFocus` (React DOM), an element blurred by a move is focused again after the DOM update, with `focus` and `focusin` run nested. With `schedule.commitEventsIgnored` these focus events reach only window and document listeners. A cancelled or removed target has no default action. A focused control that becomes disabled keeps focus until the rendering step, whose focus fixup (after animation frames in Chromium) blurs it with `blur` and `focusout` as events of their own; the runtime also blurs a focused element that lost its box (hidden by CSS), which the interpreter, having no style, does not model.
- **Scroll events:** a scroller whose offset changed (by script or by the user) has a pending `scroll` event. The rendering step after the task dispatches them in order, once per scroller however often it moved. An element's `scroll` event does not bubble. The viewport's event targets the document and reaches the document's listeners, then the window's. A layout (a frame's, or one forced by a layout read) clamps a scroll offset that a content change left past the end of its range, so reads see the clamped offset at once; the frame after the change queues that scroller's `scroll` event once its layout is done, and the rendering step of the frame after dispatches it (Chromium 153). Probes run two frames (rendering step, then layout) after every action, as the browser harness waits for two animation frames; windowed apps run the rendering step and the layout before painting. A probe's pointer action requires a target fully visible in its scroll containers and the viewport: Playwright would scroll it into view first (`DOM.scrollIntoViewIfNeeded`, Chromium's center-if-needed alignment), which probes do not model. Like layout reads, programs with `scroll` listeners are checked against Chromium only.
- **Media query lists** (type `media-query`, compared by identity): `media.query(q)` (`matchMedia(q)`, a literal query of the supported features) creates one. `media-query.matches` evaluates the query when read. `media-query.listen/unlisten(list, f)` add or remove a `change` listener, identified by its function value; adding it again does nothing. When the viewport or the user preferences change, the rendering step does three things in order: it dispatches the window's `resize` event (when the size changed); it runs the scroll steps; it fires `change` at each list whose state differs from when it was created or last notified, oldest list first, each listener a callback of its own. The event has `type` `change` and `event.matches`. `resize` listeners belong to the window. Probes change the environment with the actions `resize` (`width`, `height`) and `emulate` (`colorScheme`, `reducedMotion`, `contrast`); the browser harness uses Playwright's `setViewportSize` and `emulateMedia`.

## Validation limits

The validator caps a program at 4,096 template nodes, 1,024 cells per component, 1,024 handlers, 4,096 functions, expression and statement depth 96, 2^20 expressions and 4 MiB of CSS. Each limit has a diagnostic. These are resource limits, not semantic assumptions. Two semantic checks reject what the backend cannot reproduce: in-place mutation of `readonly` cells (`E_READONLY`), and template reads of values that change without making anything dirty (`E_REACTIVITY`: written `none` cells, identity-tracked references mutated in place, maps and sets mutated inside proxied state, mutated globals, RegExps whose `lastIndex` changes: exec, test, replace or match with a global or sticky RegExp, or setting `lastIndex`, unless the cell or global always holds a literal without `g` and `y`; Dates changed in place by a setter; host services, M5), which the frameworks would show only when neighbouring state re-renders; derived values must not use host services either. Diagnostics carry the source location of the statement, cell, handler or element they concern, falling back to the enclosing function or element.

## Snapshots

The interpreter's and probe's state snapshots contain the DOM, the root instance's `cells`, and `instances`: every other live instance in tree order as `{ "component": name, "cells": [...] }`. Element handles appear as `"element"`, event objects as `"event"`, RegExps as their `toString()`, Dates as their ISO string (or `"Invalid Date"`).

Effects outside the DOM appear under `host` (M5), as in the browser harness's snapshots, each field omitted at its default and `host` omitted when all are: `console` (the lines since the previous step, `{ "level": "log" | "info" | "warn" | "error" | "debug", "text": … }`), `clipboard` (default `""`), `href` (the location without the origin, default `"/"`) and `historyLength` (default 1). Texts holding a lone surrogate appear as `{ "units": [UTF-16 code units] }`. The probe and interpreter take the case environment as `--url` (start location, default `/`), `--clipboard` (default empty) and `--seed` (default 1), besides `--storage`; `back` and `forward` actions traverse the session history as the user does.

## Correctness

`runic_ir::interp` executes a program against an abstract DOM. `conformance/differential.mjs` runs generated code and the interpreter on seeded random event traces and compares DOM and cells after every step. The conformance harness tests both against the original frameworks in Chromium.
