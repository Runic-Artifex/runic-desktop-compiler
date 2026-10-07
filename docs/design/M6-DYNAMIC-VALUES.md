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

## Results (2026-10-07)

The spike is implemented behind the opt-in. Adopting it amends D16; that decision is the user's.

**Acceptance.**

1. **The target passes.** `pagination-demo` compiles from bits-ui's published source and shadcn-svelte's unmodified wrappers with no new inference rule. Case `bits-pagination` passes all gates at both viewports. One general lowering was added on the way: a dictionary read with a constant key in `frontend/packs/choice.ts` (`paginationAttrs[this.opts.type]`), which static programs use too.
2. **The test suites pass.** `tests/dynamic-values.test.mjs` (four tests: objects, arrays, runtime keys and operators; a checked mismatch; record copies; state changed in place). Case `dyn-values` (fixture `dyn-values-svelte`) passes all gates at both viewports. In the differential, both new fixtures pass, `dyn-values-svelte` and `dyn-mismatch-svelte` (the latter differential only, as the browser carries on with the mistyped value), 20 traces each. `bits-pagination-svelte` is incomplete there, as every bits-ui fixture is (T1).
3. **Nothing changes without the opt-in.**
   - `cargo test` and `npm test` pass.
   - The differential passes 172 fixtures (169 before, plus the 3 new) with 0 failures.
   - Full conformance with pixels passes 469 runs (465 before, plus the 4 new) with the same 7 known gaps.
   - One static regression found on the way was fixed before these runs: array destructuring defaults, which `bits-dropdown-menu` uses.
4. **Cost.**
   - **The hand-typed comparison could not be built.** Without dynamic values, bits-ui's Pagination does not fail with a diagnostic: the union census (`frontend/unions.ts` `trace`) runs for over 30 minutes. That is so even with `getPageItems` hand-typed and `PageItem` declared as one record, as there are more unions behind it. That is now a [gap register](../gaps/LANGUAGE.md#value-model-and-types-v1-v2) row. So the size is compared with other bits-ui apps instead (release, stripped, CPU renderer on Xvfb, median of 7 runs):

     | App | Size | First frame |
     |---|---|---|
     | bits-pagination-svelte (dynamic) | 15.99 MiB | 33.7 ms |
     | bits-collapsible-svelte | 15.90 MiB | 33.8 ms |
     | bits-tabs-svelte | 14.54 MiB | 36.2 ms |
     | bits-toggle-group-single-svelte | 14.37 MiB | 30.0 ms |
     | dyn-values-svelte (dynamic) | 13.79 MiB | 24.1 ms |
     | closures-svelte (baseline) | 13.60 MiB | 23.3 ms |

     Dynamic values cost about 0.2 MiB where a program uses them (`dyn-values` against a static app of similar size). Pagination is within the range of the static bits-ui apps, and first frames are within the noise.
   - **Lines of compiler change:** about 3,300, all shared rather than per component.
     - `runic-js` `dynamic.rs`: 1,170, of which about 115 are tests.
     - The interpreter's `interp_dyn.rs`: 490.
     - Codegen: 330 in `dynamic.rs` and 20 elsewhere; the runtime 30.
     - The IR: 580, of which 403 are the validator.
     - Frontend: 720, of which 546 are in `language.ts`.

     The review's estimate for one hard component under the static model is 1,200–1,800 lines. The tier's lines are spent once.

**Answers.**

- **Library code without new rules.** Mostly yes. Pagination needed none. Every fix during the spike was a general lowering of `dyn` (boundaries at returns, initialisers and arrow bodies; `??`, `||` and conditionals of mixed types; `Object.keys`; calls through `o[k]`), not a rule for a pattern. The boundary moves some work: where dynamic values meet static records, the validator must prove copies unobservable (`E_DYN_COPY`), and its proof is coarse (program-wide).
- **Duplicated semantics.** `runic-js` gained one generic implementation of the abstract operations (ToPrimitive, ToString, ToNumber, `+`, comparisons, `==`) and of array and string methods over a `DynValue` trait. The interpreter and generated code share it. The typed operations were not duplicated, but methods on dynamic receivers are a second catalogue that only partly matches the static one.
- **Binary size and speed.** Above: about 0.2 MiB, with no measurable start-up cost.
- **The inference rules in `package-modules.ts`.** They remain. The dynamic mode only applies where no static type is found (`tryMap` still prefers static types), so the rules keep static code static, faster and checked at build time. Retiring them would only be safe where a dynamic fallback exists, that is in every program with the opt-in.

**What remains** (all in the [gap register](../gaps/LANGUAGE.md#dynamic-values-opt-in-spike)):

- React and Vue adapters.
- Dynamic values in state that change in place (rejected; deep dynamic proxies would cover them).
- Finer copy proofs.
- clsx values.
- Methods on dynamic receivers verified by a case.
- Curried untyped calls.
- Bitwise operators.
- Separately, the static union census does not terminate in practical time on Pagination.
