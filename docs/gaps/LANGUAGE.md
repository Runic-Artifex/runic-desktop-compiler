# Gaps: values, types and the language

Part of the [gap register](../GAPS.md). Every row is behaviour the compiler rejects with a located diagnostic (or reports at run time) today, with the reason and, where known, what covering it would take. Locations are as of commit `9add179` (2026-10-07); `file:line` points at the main rejection, further sites are merged into the row.

Clusters (see [GAPS](../GAPS.md#clusters)): **V1** unions, **V2** untyped values, **V3** classes, **V4** constructs, **V5** async, **V6** modules.

## Value model and types (V1, V2)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| A union reached by values of several members (Accordion/ToggleGroup mixing `single` and `multiple`, a multiple Select, Slider's `number \| number[]`) | E_TYPE_UNION | The IR has no sum type; the census picks one member per program | Compile a component per member (decided 2026-10-05, "layer 2", not started), or an IR union type | unions.ts:157; svelte.ts:3155,3162,3221; CONTRACT (ToggleGroup, Accordion, Select) |
| The union census on bits-ui's Pagination without dynamic values (`Page \| Ellipsis` and the unions behind it): no diagnostic, the compiler runs for over 30 minutes | — (hangs) | `trace` follows sites and branches without memoising, so its work grows exponentially (depth limit 40) | Memoise `trace` per node, path and strictness, with the depth cut-off kept sound; until then, dynamic values | unions.ts:557 (`trace`) |
| Unions other than nullable, literal, widest-member or narrowable (`string \| number`, node-or-function props) | E_TYPE_UNION | "M2 supports nullable types and literal unions" | As above | types.ts:499 |
| Recursive unions (`ClassValue = … \| ClassValue[]`) | E_TYPE_UNION | No recursive types | IR recursive types or a dynamic tier | types.ts:211 |
| `any`/`unknown` values that no rule types | E_TYPE_UNSUPPORTED | "need a static type (or a JS island, M6)" | Inference rules per pattern (current practice), a dynamic value tier, or islands | types.ts:225 |
| `let x;` without a type or initialiser (where no assignment types it) | E_TYPE_UNSUPPORTED | No type | Assignment-based inference (exists for null-initialised lets and match results) | language.ts:3290 |
| Always-`null` values; `never` (untyped empty arrays) | E_TYPE_UNSUPPORTED | No useful type | Inference from uses | types.ts:231,233 |
| `bigint`, `symbol` (incl. `Symbol` keys; the site has 4, the editor 2) | E_TYPE_UNSUPPORTED | Not in the value model | New value kinds | types.ts:239 |
| Unbound type parameters, conditional and indexed types, other intersections (a primitive with properties: branded `string & { brand: … }`; `string & {}` is covered) | E_TYPE_UNSUPPORTED | "Unsupported type T" | Wider type mapping | types.ts:296 |
| Tuples with optional or rest items; heterogeneous tuples' length, iteration, spreads, string conversion, `JSON.stringify`, `Object.*` | E_TYPE_UNSUPPORTED / E_IR | JavaScript treats them as arrays | Tuple operations | types.ts:637; validate.rs:637-652; CONTRACT |
| Overloaded function values; `Promise<Promise<T>>`; `matchAll` iterators and Intl objects as values; `Error` (non-lib) and `HTMLElement` values | E_TYPE_UNSUPPORTED / E_REGEXP / E_INTL | Not modelled | Per kind | types.ts:657,688,702,717,724 |
| Computed-key read of a record whose fields differ in type; an object spread whose key presence is untracked | E_MEMBER / E_OBJECT | Typed records | A dynamic tier, or per-key cond (exists for same-typed fields) | language.ts:2086,3683,3691 |
| Object literals in another key order than the declared type; literals as class instances; conditional spreads; mixed getters | E_OBJECT | Key order is observable | Per-literal records | language.ts:11040-11316, 12076-12239 |
| `+` and equality across types; `??` and conditionals whose sides differ in type; `filter(Boolean)` mixing types | E_OPERATOR / E_TYPE_UNION | Typed operators | Unions or a dynamic tier | language.ts:6422,6592,6639,6688,4885,5211 |
| Untyped functions (parameters not inferable) used as values; recursive untyped functions outside package modules | E_FUNCTION / E_TYPE_UNSUPPORTED | "add parameter types" | Inference (package modules have call-site inference) | language.ts:6022-6034,10017,10073,10204; classes.ts:1732 |
| Prop domains: open values, text mixed with expressions, more than 4096 combinations | E_PACK (via domains) | Build-time evaluation needs finite sets | Run-time evaluation of the pack (as for `cn`) | domains.ts:315,320; choice.ts:358-557 |
| Array holes, non-index properties, `undefined` reads past the end where the element type cannot hold it | RangeError at run time | Dense typed arrays | — (inherent) | runic-js array_ops.rs:120-145 |
| `-0` as a Map/Set key; transcendentals one ulp off V8 | — | Low priority; libm vs V8 | If observed | m2 results |
| Lone-surrogate string literals | E_STRING | Inherent at the DOM boundary | — | language.ts:6798 |
| Dictionary keys naming `Object.prototype` members, `__proto__` writes | run time | Not modelled | — | CONTRACT |
| Typed arrays, `arguments`, `for…in` over records, mixed-type tables, `crypto.getRandomValues` | E_* | The IR does not model them | Packs | CONTRACT; language.ts:7067 |
| Converting Map, Set, functions, class instances, mixed tuples to strings; non-primitives other than Date to numbers | E_IR / E_CLASS | `toString` not dispatched | Dispatch | validate.rs:618-679 |
| Throwing non-Error values; non-Error catch bindings | E_IR | Errors are records | A dynamic tier | validate.rs:1594-1617 |
| `JSON.stringify` with a replacer, of Map/Set/Date/class instances; `JSON.parse` without a declared type | E_BUILTIN | Typed JSON | Replacers; dynamic parse | builtins.rs:345-362,1571-1595 |
| `Object.keys/values` of class instances or mixed records; `structuredClone` of Dates and class instances; `Array.from` over Maps, iterables, `{length}`; `flat(depth)`; number methods beyond toFixed/toString/toPrecision/toExponential | E_BUILTIN | Not in the catalogue | Catalogue entries with vectors | builtins.rs:367-386,1423-1468,1596-1614,1975 |

### Dynamic values (opt-in spike)

With `runic.json` `"dynamicValues": true` ([design](../design/M6-DYNAMIC-VALUES.md), adopted as an opt-in, D16), untyped values compile to the `dyn` type instead of the V2 rejections above. These are the gaps inside that mode, as of the spike (2026-10-07).

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| The opt-in in React and Vue programs | — | Only the Svelte adapter sets it; the spike's target is Svelte | Set `types.dynamic` in the other adapters, with cases | svelte.ts (`graph.config.dynamicValues`) |
| A dynamic value in state changed in place (`o.k = 2`, `arr.push(x)` on a `dyn` in `$state`) | E_REACTIVITY | Dynamic values are held by identity; no proxy notifies their changes | Dynamic objects and arrays that notify their cell (deep proxies) | validate.rs (`dyn_roots`) |
| Copying a dynamic object into a record where the copy is observable: the record is mutated, compared or kept by identity, boxed again where the program compares dynamic values by identity, or the program sets properties of any dynamic object | E_DYN_COPY | A copy is a different object; the proof is program-wide and coarse | Origins per copy (as for in-place mutation), or records backed by the dynamic object | validate.rs:1930 (`dyn_copies`) |
| `class={x}` of a dynamic value that is not a string (clsx objects and arrays) | RunicUnsupportedError at run time | The checked unboxing to a string; clsx values are not supported statically either (F1) | clsx over dynamic values | svelte.ts:4865 |
| Methods of dynamic receivers: no case calls one (arrays of dynamic items use the static array methods). `runic-js` implements arrays' push, pop, shift, join, slice, indexOf, includes, lastIndexOf, forEach, map, filter, find, findIndex, some, every, reduce, sort, reverse, concat and strings' case, trim, slice, includes, startsWith, endsWith, indexOf (unit tests cover push and sort); others throw RunicUnsupportedError at run time | — | Implemented as the spike needed them | A case, then further methods with vectors from Node | runic-js dynamic.rs (`array_method`, `string_method`) |
| Calling a function an untyped call returns (`twice(f)(x)`) | E_CALL | The callee is neither a binding nor a member | `dyn.call` of any dynamic callee | language.ts:9851 |
| Bitwise and shift operators on dynamic values (arithmetic, `+`, comparisons, equality and `==` are covered) | E_OPERATOR | Not needed yet | The remaining operators in runic-js | language.ts (`dynBinary`) |

## Language constructs (V4)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Rest parameters (functions, constructors) other than a callback's or a tuple type's | E_FUNCTION / E_CLASS | "planned for later" | Array parameters | language.ts:723; classes.ts:2016 |
| Logical assignment `&&=`, `\|\|=`, `??=` (except module `globalThis.x ??=`) | E_ASSIGN | "planned for later" | Desugaring | language.ts:4336 |
| Assignments, `++`/`--`, comma expressions used as values | E_ASSIGN_EXPR / E_EXPRESSION | Statements only | `with` expressions | language.ts:5285,6258-6272 |
| `in`; `instanceof` other than classes, elements, events | E_EXPRESSION | "planned for later" | Record shapes (static), dynamic values | language.ts:6439-6564 |
| Generators, `yield`, iterator protocol beyond a fresh iterator's first `next()`; for-of over iterators/NodeLists | E_EXPRESSION / E_ITERATE | Not lowered (a `function*` is caught only at its `yield`) | State machines | language.ts:5088,5288,3088; classes.ts:1212 |
| Object-literal getters and setters (except objects of a declared type) | E_OBJECT | Not lowered | Records with accessor functions | language.ts:11040+ |
| Closures capturing a per-iteration `let` | E_LOOP_CAPTURE | "planned for later" | Fresh bindings per iteration | language.ts:2641 |
| Destructuring: of strings/arrays beyond `length`, of events, of getter objects, computed keys, tuple overruns, rest of class instances, defaults in nested patterns; destructuring without an initialiser; destructuring declarations in component bodies (Svelte other than `$props()`, React `const { a } = useX()`, Vue `toRefs`) | E_DESTRUCTURE / E_STATEMENT / E_DECLARATION / E_COMPONENT | Per form | Per form | language.ts:4003-4191,3419; svelte.ts:3428; react.ts:1125; vue.ts:2835 |
| `delete` other than dictionary entries | E_EXPRESSION | — | — | language.ts:3568 |
| Statements: for-of without one declared variable, labels on non-loops, destructured catch bindings, `enum` (in functions and modules), `debugger`, namespaces, class declarations below the top level | E_STATEMENT / E_CLASS / E_MODULE | — | Per kind; enums are cheap | language.ts:2683-2850; modules.ts:477 |
| Function properties assigned other than right after the declaration | E_FUNCTION_PROPERTY | — | — | language.ts:3465-3518 |
| Tagged templates, class expressions, `import()`, `import.meta` (except `glob`), `new.target`, `eval`/`new Function` (zod probes it) | E_EXPRESSION | No JS engine for `eval` | Per kind; `eval` never | language.ts:5288; research/M6-SVELTEKIT |
| RegExp `v` flag, RegExp statics, match-array properties beyond index/input/groups, possibly-undefined captures, replacer rest/groups parameters, `matchAll` outside for-of | E_REGEXP | Verified subset | Vectors | language.ts:12921-13336; validate.rs:254-284 |
| `setTimeout` extra arguments; spread arguments into host methods or into calls with unknown parameters | E_CALL / E_HOST | — | — | language.ts:7001,7058,10404-10420 |
| `break`/`continue`/`return` out of `try/finally` | E_CODEGEN | Codegen | Labelled blocks | runic-codegen expr.rs:1118-1138 |

## Classes (V3)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| A second instantiation of a generic class; extending a generic class | E_CLASS | One instantiation per program | Per-instantiation records | classes.ts:329-402,701 |
| Library base classes (`extends Error`, `extends MediaQuery`, `HTMLElement`, `Map`) and instances of `.d.ts`-only classes | E_CLASS | "mapping packs will provide them"; errors are plain records | Packs giving class records; changing `Error` touches every `catch` | classes.ts:707,736 |
| Class expressions, anonymous/default-exported classes, decorators, `accessor`/`declare`, computed or quoted names, overloads, static blocks, static and abstract accessors, index signatures, mixins, cross-module or later-declared bases | E_CLASS | Not lowered | Per kind | classes.ts:704-1466 |
| Unbound methods as values, `bind()` beyond the covered forms, `C.name`/`prototype`, classes as values | E_CLASS | Classes are not values | Function values per method | classes.ts:3041-3672,3428; language.ts:6040 |
| Fields typed `any`/`unknown` that no assignment types | E_CLASS | "needs a type" | Inference (exists for package modules) | classes.ts:1390 |
| Instances cloned, spread, stringified, `Object.*` | E_CLASS | Not plain data | — | classes.ts:3798 |
| Static reactive fields (Svelte rejects them); static fields in component-script classes; assigning statics | E_CLASS | — | — | classes.ts:931,1537-1576,3203 |
| A derived field of a component-script class read in another component | E_CLASS | "declare the class in a .svelte.ts module" | — | classes.ts:3015 |
| An inherited field declared again other than as covered (with an initialiser of a type the base field does not take, a rune on either side, a parameter property, a name with an accessor or method in the chain, or a base constructor that uses `this` before it is set again) | E_CLASS | The field would differ in type or kind, or its base value is observable | Per case: one record of both types, accessor overrides | classes.ts (`fieldOverride`, `constructorSteps`) |
| `this` in callbacks during construction, before `super()`, in function expressions; field-order hazards | E_CLASS | Observable construction order | — | classes.ts:2324-2792 |

## Async (V5)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| `await` nested in expressions, conditions, loop headers, destructuring; `finally` around `await`; `for await`; await loops over maps/sets; function declarations in async functions; closures over loop variables across `await` | E_ASYNC | The async transform covers statement positions | A general CPS/state-machine transform | async.ts:160-534; language.ts:2665,5095 |
| Promise statics other than `resolve/reject/all` (`allSettled`, `race`, `any`, `withResolvers`) | E_BUILTIN | "planned for later" | Builtins with vectors | language.ts:8924 |
| An async function without a Promise result type | E_ASYNC | — | — | language.ts:829 |

## Modules (V6)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| `export default` in plain modules; default imports of plain modules | E_IMPORT | Message still says "planned for M3" | — | modules.ts:383 |
| Top-level statements other than declarations (expressions, if, loops, enums with a misleading message, top-level await) | E_MODULE | "planned for M4" (stale) | Module initialisation order | modules.ts:477 |
| `var`; destructured module `let`; consts without initialisers; module cycles; namespaces as values; side-effect imports other than CSS; `export *` of a package | E_MODULE / E_IMPORT | — | — | modules.ts:210-477; types.ts:513 |
| More than 256 app modules or modules over 1 MiB; source packages over 2048 modules | E_RESOURCE | Bounds | Raise with chunked codegen (M7) | collect.mjs:311,320 |
| IR bounds: 4096 template nodes per program, depth 96, 1024 cells per component, 4096 functions, 4 MiB CSS | E_RESOURCE | Bounds | Chunked codegen, per-route modules (M7) | validate.rs:6-12 |
