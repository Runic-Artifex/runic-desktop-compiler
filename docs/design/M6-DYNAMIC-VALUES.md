# M6: dynamic values (spike design)

Design for the time-boxed spike the user approved on 2026-10-07 after the [approach review](../research/APPROACH-REVIEW.md). It adds a dynamic value type to the IR, so that code whose values have no static type compiles to checked dynamic operations instead of needing a pattern-specific inference rule. Default builds still contain no JavaScript engine (D7). Adopting the result would amend D16; the spike reports back first.

## The target

shadcn-svelte's `pagination-demo` over bits-ui's Pagination ([gap register](../GAPS.md), L2). Its first blocker (`E_TYPE_UNSUPPORTED`, `bits/pagination/pagination.svelte.js:248`) is typical:
- **Untyped package code.** `getPageItems` fills an untyped array (`const pageItems = []`) with page objects (`{ type: "page", value, key }`) and ellipsis objects (`{ type: "ellipsis", key }`), from a nested function with an untyped parameter.
- **A type outside the static model.** The declaration file types the result as `PageItem = Page | Ellipsis`, a union the IR cannot represent (V1). The wrappers read `page.type` and `page.value` from it in TypeScript.

Today this needs at least three new inference rules and union support. With dynamic values it should need none.

## Semantics

- **The type.** A new IR type `dyn` holds any JavaScript value:
  - `undefined`, `null`, booleans, numbers, strings;
  - plain objects (string-keyed properties in insertion order) and arrays (dense, as elsewhere);
  - functions;
  - a static value boxed with its type (a record, an element, an event, a promise, a class instance, a map, …).
- **Operations follow ECMAScript**, implemented once in `runic-js`:
  - `dyn.get`/`dyn.set` with property keys;
  - `dyn.call` with `this` and arguments;
  - `dyn.method` (a built-in method by name on the receiver's kind, e.g. array `push`/`map`/`sort`, string `slice`);
  - the operators with their abstract operations (`ToPrimitive`, `ToNumber`, `ToString`, `IsLooselyEqual` excluded unless needed);
  - `typeof`, truthiness, `Array.isArray`, object and array literals, `in`, spread.
- **Boxed static values** answer by their static type. A record's fields by name, a class instance's fields and methods by name. Other static kinds expose only what the existing builtins expose: their members are dispatched to those builtins, and anything else throws `RunicUnsupportedError`.
- **Boundaries are checked, never approximated.**
  - `dyn.from(v)` boxes a static value.
  - `dyn.to(T, v)` gives a static `T` when the dynamic value fits it: a number for `number`, an object whose properties fit a record's fields for a record, a boxed value of type `T`, and so on.
  - A value that does not fit throws `RunicUnsupportedError` with the expected and actual shapes, and the runtime reports it. It is never coerced. JavaScript would have carried on with the value, so a mismatch is behaviour the static side cannot hold, exactly what a diagnostic reports today, only later.
- **Where the frontend uses `dyn`.** The value model types a value `dyn` where it now rejects it: `any`/`unknown` that no rule types, unions outside the static model (`E_TYPE_UNION`), and untyped parameters and fields. During the spike this is behind an opt-in (`runic.json` `"dynamicValues": true`), so every existing fixture compiles exactly as before. Static types stay wherever they are known.
- **Reactivity.** A `dyn` value in reactive state is held by identity (like `$state.raw`). In-place mutation of a dynamic object or array reached from state is rejected by the validator (`E_REACTIVITY`), as it is for raw state today. Deep proxies of dynamic objects are not part of the spike.
- **Templates.**
  - Text and attributes convert a `dyn` with `ToString`; `{#if}` uses truthiness.
  - `{#each}` iterates dynamic arrays.
  - Keys compare dynamic values with SameValueZero.
  - Components receive `dyn` props as `dyn`.

## Implementation

| Layer | Change |
|---|---|
| `runic-ir` | `Type::Dyn`; the `dyn.*` operations as built-ins with type rules; validator: boundaries, the reactivity rule above |
| interpreter | `Val` is already dynamic: `dyn` values are `Val`s; the operations call the same `runic-js` functions as generated code |
| `runic-js` | `Dyn` (the value enum), its object model (ordered properties, prototypes for built-in methods by kind) and the operations; vectors from Node for the abstract operations |
| `runic-codegen` | `Dyn` as a Rust type; `dyn.*` operations to `runic_js::dyn` calls; closures as `Rc<dyn Fn(&mut Cx, Dyn, Vec<Dyn>) -> Result<Dyn, Throw>>` |
| frontend | `TypeMapper` yields `dyn` instead of failing (behind the opt-in); lowering of member access, calls, operators and literals on `dyn` operands; boxing and checked unboxing where static and dynamic meet |

## Acceptance

1. **The target passes.** `pagination-demo` compiles with no new inference rule and passes a `bits-pagination` conformance case (page links, previous and next, at both viewports, all gates).
2. **The test suites pass.** The differential test passes on a fixture exercising dynamic values (objects, arrays, functions, boundaries, a rejected mismatch).
3. **Nothing changes without the opt-in.** `npm test`, `cargo test` and the full conformance suite are unchanged.
4. **Cost is measured.** The spike measures release size and first-frame time of the target with dynamic values against the same app with a hand-typed copy of `getPageItems`, and records the lines of compiler change. That is the number the review compared: 1,200–1,800 per hard component today.

**The time box** is about one working day of implementation. If it runs over, the spike stops and reports what remains.

## Questions the spike answers

- Does library code compile without new rules once values may be dynamic, or does the boundary (dynamic to static) move the work rather than remove it?
- How much of `runic-js`'s typed semantics has to be duplicated for dynamic receivers?
- What does it cost in binary size and speed?
- Can the inference rules in `frontend/package-modules.ts` be retired, or do they remain as an optimisation?
