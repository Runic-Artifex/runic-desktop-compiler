# React regions: React Compiler's reactive scopes vs our dependency guards

Status: research spike for M3 ([roadmap](../ROADMAP.md#m3-components-and-lists), [M3 design](../design/M3-COMPONENTS.md) work order step 6), 2026-10-03. This report changes no code. It feeds the M4 effects design and M10 optimisation.

## Summary

- React Compiler (RC) and our backend solve different problems. RC caches *JavaScript values* (intermediate values, closures, JSX elements) across re-renders of a component so that React's reconciler can skip unchanged subtrees. We never re-render. Each template binding is guarded by the cells its expression may read, and it writes to the DOM only when its value changes.
- For DOM update granularity, our model is already as fine as RC's on every React fixture, and finer on most of them. RC's scopes are coarsened by mutable-range merging, by its conservative handling of unknown calls and by the absence of memoization inside loops and `map` callbacks.
- RC is finer in three respects:
  - It computes a render value once per render, where we compute it once per binding that reads it.
  - It skips unchanged subtrees in O(1), where we visit every scope and guard on every event.
  - Its dependencies are identities and property paths, where our deep-tracked cells all become dirty on any heap mutation.
- The important findings concern semantics, not performance. Our React model already differs from React in ways RC would not fix:
  - derived `const` values are evaluated once per read, not once per render;
  - allocation identity does not change when the owning component renders;
  - there is no notion of "this instance rendered", which useEffect and useMemo depend on;
  - closures read the latest snapshot instead of the snapshot of the render that created them.

  These must be settled in M4. RC's *rules* (frozen props and state, pure render) are what make fine-grained guards exact, so we should borrow them as diagnostics.
- **Recommendation:** do not adopt RC or its scope inference. In M4, borrow:
  - the Rules-of-React validations;
  - render-value slots with a per-adapter recompute policy;
  - memo slots for `useMemo`/`useCallback`, using RC's `$[i] !== dep` pattern.

  In M10, borrow subtree-level guards and per-block list bailout. The details are in [Recommendation](#recommendation).

## Method

- **Sources.** RC sources are read at `facebook/react@278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee` (main, 2026-10-02). Paths below are relative to [`compiler/packages/babel-plugin-react-compiler/src/`](https://github.com/facebook/react/tree/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src). The per-pass documentation lives in [`docs/passes/`](https://github.com/facebook/react/tree/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/docs/passes).
- **Compiler output.** The released `babel-plugin-react-compiler@1.0.0` (npm `latest`) was run with default options and `panicThreshold: 'all_errors'` on every React fixture and example. This happened in a throwaway directory outside the repository, which has since been deleted.
- **Our side.** It is read from `crates/runic-codegen/src/lib.rs` (`function_reads`, `Gen::deps`, `Gen::guard`, `Gen::item`, `end_i{k}`, `dispatch`) and `frontend/adapters/react.ts`. The adapter was run on the fixtures to inspect the emitted IR. No native build was run.

## React Compiler's pipeline (scope-relevant passes)

The order of the passes is fixed in `Entrypoint/Pipeline.ts` (`runWithEnvironment`).

| Phase | Pass (file, function) | What it decides |
|---|---|---|
| HIR | `HIR/BuildHIR.ts` `lower`; `SSA/EnterSSA.ts` `enterSSA` | Builds a control-flow graph of instructions over `Place`s in SSA form. Order of evaluation is preserved. |
| Effects | `Inference/AnalyseFunctions.ts` `analyseFunctions`; `Inference/InferMutationAliasingEffects.ts` `inferMutationAliasingEffects` | Abstract interpretation that assigns aliasing effects (`Create`, `Capture`, `Alias`, `Freeze`, `Mutate*`, `MutateFrozen`, `Impure`, `Render`) to every instruction. Props, hook results and JSX operands are *frozen*. An unknown function is assumed to `MutateTransitiveConditionally` its arguments ([MUTABILITY_ALIASING_MODEL.md](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/Inference/MUTABILITY_ALIASING_MODEL.md)). |
| Ranges | `Inference/InferMutationAliasingRanges.ts` `inferMutationAliasingRanges` | Builds a data-flow graph from those effects. Each identifier gets a `mutableRange` (`[start, end)` instruction ids), extended backwards through aliases by later mutations. `MutateFrozen` and `MutateGlobal` become errors here. |
| Reactivity | `Inference/InferReactivePlaces.ts` `inferReactivePlaces` | Fixpoint over the CFG. Params, hook results and `use` are reactive sources; reactivity flows through data, mutable alias groups and reactive control flow (post-dominator frontiers). Values whose type is stable (`setState`, `useRef()`) are not reactive. |
| Scopes 1/4 | `ReactiveScopes/InferReactiveScopeVariables.ts` `inferReactiveScopeVariables`, `findDisjointMutableValues` | Uses union-find to group values that are mutated together. Each group becomes a `ReactiveScope` whose range is the union of its members' ranges. |
| Scopes 2–4 | `AlignMethodCallScopes`, `AlignObjectMethodScopes`, `AlignReactiveScopesToBlockScopesHIR`, `HIR/MergeOverlappingReactiveScopesHIR.ts`, `HIR/BuildReactiveScopeTerminalsHIR.ts` | Widens scopes to block boundaries ("you cannot memoize half of a loop") and merges overlapping scopes so that scopes are disjoint or nested. Then inserts `scope` terminals. |
| Flattening | `ReactiveScopes/FlattenReactiveLoopsHIR.ts`, `FlattenScopesWithHooksOrUseHIR.ts` | Removes scopes inside loops (there is no per-iteration cache) and scopes that contain hook calls (hooks cannot be called conditionally). |
| Dependencies | `HIR/PropagateScopeDependenciesHIR.ts` `propagateScopeDependenciesHIR`; `HIR/DeriveMinimalDependenciesHIR.ts` `ReactiveScopeDependencyTreeHIR` | A scope's inputs are values declared before it and read inside it, as *property paths* (`ReactiveScopeDependency {identifier, path}`, for example `items.length`). Paths are truncated to what is safe to evaluate and minimised. Dependencies of nested scopes propagate to their parents. |
| Pruning | `PruneNonEscapingScopes`, `PruneNonReactiveDependencies`, `PruneUnusedScopes`, `MergeReactiveScopesThatInvalidateTogether`, `PruneAlwaysInvalidatingScopes` (all in `ReactiveScopes/`) | Memoizes only values that escape (returned, or passed to hooks) and drops dependencies that are not reactive. Merges scopes with identical dependencies. Drops scopes that depend on unmemoized fresh allocations (`isAlwaysInvalidatingType`). |
| Codegen | `ReactiveScopes/CodegenReactiveFunction.ts` `codegenFunction`, `codegenReactiveScope` | Emits `const $ = _c(n)` (`c` from `react/compiler-runtime`, which is `useMemoCache`) and one block per scope: `if ($[i] !== dep …) { recompute; store deps and outputs } else { load outputs }`. Scopes without dependencies compare against `Symbol.for("react.memo_cache_sentinel")`. |
| Validation | `Validation/ValidateNoRefAccessInRender.ts`, `ValidateNoSetStateInRender.ts`, `ValidatePreservedManualMemoization.ts`, `Inference/DropManualMemoization.ts` | Rejects reads and writes of refs during render and unconditional `setState` in render. Re-derives `useMemo`/`useCallback` and checks that the memoization guarantees are preserved. `validateNoImpureFunctionsInRender` exists but is off by default (`HIR/Environment.ts`). |

RC's own [design goals](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/docs/DESIGN_GOALS.md) state two limits. First, its correctness depends on the Rules of React. Second, perfectly minimal recomputation is a non-goal. A Rust port is in progress in the same repository (`compiler/crates/react_compiler_*`, with Babel, SWC and OXC frontends; [crates/TODO.md](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/crates/TODO.md)).

## Our model, for comparison

- **Read sets.** `function_reads` computes, for each IR function, the cells it reads transitively. A call through a function value makes the set unknown, and an unknown set disables the guard.
- **Guards.** `Gen::deps` takes the union of the direct cell reads and the read sets of the called or closed-over functions. `Gen::guard` turns that into `d[c] || … || tl`, where `tl` means the template locals were reassigned.
- **DOM writes.** Text and attribute bindings also compare against their last written value before touching the DOM. Controlled-input values are re-synchronised on every dispatch (`sync_s`).
- **Dirty bits.** After a handler, `end_i{k}` sets dirty bits by SameValue against the pre-handler state. Deep cells are additionally dirty whenever the global heap mutation epoch moved (`runic-js` `mutation_epoch`).
- **Update traversal.** The update walks the whole scope tree from the root (`update_s{root}`). Keyed lists re-evaluate `items` when their guard fires and then update every retained block with `tl = true`. Children get prop pushes guarded by the parent's dependencies, and then update against their own dirty bits.
- **React adapter.**
  - `useState` gives identity-tracked cells; reference-typed props are tracked deep.
  - Reads go through the per-instance render snapshot.
  - Each component-body `const` becomes a zero-parameter *derived function*, and every read of it is a call (`language.ts`, binding kind `derived`).

## Comparison on this repository's React apps

For each event, the table shows what RC's output invalidates and what our generated code evaluates. In both columns, "re-evaluates" means JavaScript work. DOM writes are equal in both models, because React's reconciler and our value caches both write only what changed.

| App, event | React Compiler (1.0.0 output) | Ours |
|---|---|---|
| 7GUIs Counter, click | Rebuilds the `<input>` element (deps `[count]`). Static `<h1>` and the handler are cached forever. React reconciles `<main>`. | One guard, `d[count]` (plus input sync). |
| 7GUIs Temperature, type °C | Rebuilds the celsius `<input>` and the status `<p>` (deps `celsius`, `fahrenheit`). `fromCelsius`/`fromFahrenheit` are cached forever, because they capture only setters and module functions. | Status text guard `d[celsius] \|\| d[fahrenheit]`. Equivalent. |
| Ledger, type in draft | One merged outer scope with deps `[added, draft, entries]` re-runs `entries.reduce` twice, `entries.filter`, `describe(unpaid)` and the `addPreset`/`addDraft` closures. `categoriesOf` is cached in a nested scope. | Only the bindings that read `draft` (the input and the Add button's `disabled`). **Ours is finer.** |
| Ledger, add/pay/remove | Each derived value is computed once. | `unpaid` is computed 3× (count text, `describe(unpaid)`, Pay `disabled`). **RC is finer.** |
| Components, type name | `add` is recreated (deps `items, name, next`), so the controls `<div>` is rebuilt and reconciled. The summary and the `<Editor>` element are rebuilt, and `Editor` re-renders. | Summary text and the `value` prop push, then the Editor input sync. **Ours is finer.** |
| Components, any `items` change | `remove`/`up` are recreated, so every `<Row>` gets new callback props and re-renders. Row's internal scopes hit for unchanged rows. | The list is reconciled by key and every block is updated with `tl`. The callback props change identity, but no guarded binding reads them. **Ours is finer** (no child re-render). |
| Reorder, change mode | The whole `items.map(...)` is rebuilt (deps `[items, mode]`, because each item's closure captures `mode`), and React reconciles all six `<li>`. | Only the `Mode:` text. **Ours is finer.** |
| Reorder, click item | The list is rebuilt and reconciled. | Keyed reconcile and move. Per-block bindings are re-checked. |

The coarse ledger scope comes from mutable ranges, not from reactivity. Here is RC's output, abridged:

```js
if ($[1] !== added || $[2] !== draft || $[3] !== entries) {
  const total = entries.reduce(_temp, 0);
  unpaid = entries.filter(_temp2);
  ... function addPreset() {...}  function addDraft() {...} ...
  t3 = describe(unpaid);
```

Two mechanisms were confirmed by editing a copy of the example:

- `total.toFixed(2)` is a method call on a value of unknown type, which RC conservatively treats as a possible mutation. It sits late in the JSX, so it stretches `total`'s range over everything in between.
- `describe(unpaid)` is an unknown local function call, so it extends `unpaid`'s range in the same way.

Nested scopes (the closures) then propagate their dependencies (`added`, `draft`) to the outer scope. Hoisting `.toFixed(2)` into the `const` declarations and removing the `describe` call yields per-value scopes keyed on `entries` alone. Our language layer knows these values are numbers and that module functions only read, so it never needs mutable ranges.

### Where RC's analysis is finer than ours

1. **Shared render values.** RC (and plain React) evaluates a component-body `const` once per render. We evaluate it once per guarded binding that reads it, and again in each handler that reads it.
2. **Subtree skipping.** A memoized JSX element lets React bail out of a whole subtree in O(1). Our update visits every scope, every child component and every list block on every event and tests each guard (`update_s` is called unconditionally for children and for all blocks in the `else` branch of `each`). This is negligible for the fixtures, but it is O(bindings) per keystroke for the M5 virtualized list.
3. **Dependency precision for reference values.** RC compares identities and property paths (`items.length`). Our deep cells are dirty after *any* heap mutation, including writes to a fresh local array such as `moved` in `components-react`'s `up`. No current React fixture passes a reference-typed prop (all prop cells are identity-tracked), but React TodoMVC (`todo` objects) will. For other read paths the difference is computation only, because our value caches already suppress DOM writes.

### Where ours is equivalent or finer

1. **No re-render and no reconciliation.** A changed cell re-evaluates only the bindings that read it, and there is no element allocation or diffing.
2. **Types and purity knowledge.** Our scopes cannot be widened by "unknown call may mutate", as shown by the ledger example.
3. **Lists and closures.** RC does not memoize inside loops or `map` callbacks (`FlattenReactiveLoopsHIR`), and closures that capture a reactive value invalidate the whole list (reorder). Our block bindings are guarded individually, and listeners read their values at dispatch, so a changed closure costs nothing.
4. **Callback props.** RC must recreate callbacks whose captured state changed, which re-renders every child that receives one. Our function-typed prop cells change, but nothing guarded reads them.
5. **Static content.** Both models build static content once: RC with sentinel scopes, ours through `Gen::is_static`.

## Semantics: where our model differs from React

RC is meant to be unobservable for code that follows the Rules of React, so it cannot repair any of the gaps below. Several of them need a render model of our own before M4 adds effects.

| # | Behaviour | React | Ours today | Does RC help? | Needed for |
|---|---|---|---|---|---|
| S1 | Identity and evaluation count of a render `const` | Evaluated once per render. `const o = {x: n}` gives `o === o` true within a render, and `<C a={o} b={o}/>` passes one object. | Evaluated once per read. Two reads give two objects, so `o === o` is false. Expensive derivations repeat. | No (RC keeps React's semantics) | Correctness now; also M5 `Math.random`/`Date` in render |
| S2 | Allocation identity across renders | Every render of the owner creates new literals, arrays and closures. | A literal with no cell reads is static and evaluated once at mount. Otherwise it is re-created only when its dependencies are dirty. This is observable today by storing a prop in state and comparing it after a parent re-render. | RC *changes* this: its memoized allocations keep their identity. | Correctness; M4 effect dependencies |
| S3 | Render occurrence (counts) | An instance renders when its own state changed (with the `Object.is` bailout), or when its parent rendered and the element is not the same object and not blocked by `React.memo`. `children` created by the grandparent keep their element identity and do not re-render. | There is no "instance rendered" notion. | No. The rules come from React's reconciler, and RC changes the counts: an effect whose dependency array holds a fresh object fires on every render in plain React, but only when the inputs change under RC. | M4: `useEffect` without dependencies, dependency comparison, cleanup order |
| S4 | `useMemo`/`useCallback` | Cached per instance, compared with `Object.is`; identity is stable while the dependencies are unchanged. | Not supported. | Its codegen pattern (`$[i] !== dep`) is the exact semantics to copy. | M4 (with the other hooks) |
| S5 | Closures that outlive their render (timers, effects, `await`) | See the values of the render that created them (stale closures, e.g. `setInterval(() => setCount(count + 1))` with `[]` deps stops at 1). | Read the instance's *latest* snapshot. This is identical today only because every closure runs synchronously right after the render that created it. | No | M4 timers, async and effects |
| S6 | Mutation of props or state without a setter | Invisible until something re-renders. | Deep tracking shows it at once (the M3 deviation). | RC *rejects* it: `MutateFrozen`, including in handlers and closures (fixtures `error.modify-state`, `error.invalid-function-expression-mutates-immutable-value`, `error.invalid-mutation-in-closure`). | Exactness of identity tracking; removes the deviation |
| S7 | Impure render, ref access in render, `setState` in render | The result depends on the render count. | Evaluated per guard, so the result depends on the guard. | RC rejects these (`ValidateNoRefAccessInRender`, `ValidateNoSetStateInRender`, the `Impure` effect). | M3 refs, M4, M5 `Date`/`Math.random` |

**Outside React, the same issue as S1 applies.** Svelte `$derived` and Vue `computed` are cached by their frameworks until their dependencies change. Ours "recompute on read" ([CONTRACT](../CONTRACT.md)), so `$derived(items.filter(...))` read twice gives two arrays, where Svelte returns one. The fix below covers all three frameworks with a policy flag.

**Which React is the reference.** The conformance harness runs plain React 19.3.0 through Vite, without RC. An app whose build enables `babel-plugin-react-compiler` has different render counts and identities (S2 and S3). Matching it exactly would require RC's own scope decisions, and the ledger example shows how those depend on statement order and unknown calls. Such builds should be rejected with a diagnostic until a decision is made.

## Recommendation

**Do not adopt** RC, either as a source pre-pass or by reimplementing its scope inference. Its output is imperative, cache-indexed component bodies that only make sense under re-render plus reconciliation. Lowering that output would mean accepting arbitrary imperative render bodies through D5 regions, and on these apps it would make updates coarser. Its central machinery (aliasing effects, mutable ranges, scope alignment and merging, escape pruning, memo-cache codegen, JSX outlining) answers "which JS values can be reused across re-renders", which is not a question we have.

**Borrow:**

| Item | Idea from | Effort | Milestone |
|---|---|---|---|
| B1. **Rules of React as diagnostics** in the React adapter. Reject mutation of frozen values (values from props, state and hook results, followed through locals, fields and elements) anywhere, including handlers. Also reject ref reads/writes during render, `setState` during render, and impure calls in render. Then React reference props become `identity`-tracked, which removes the M3 deviation and the global-epoch cost for React. Our IR has no unknown calls, so a provenance pass with per-function mutation summaries suffices; full aliasing effects are not needed. | `InferMutationAliasingEffects` (`Freeze`, `MutateFrozen`), validation passes | 3–5 days | M4 (this is the "refine deep tracking before effects" item in [M2 results](../../conformance/results/m2.md)) |
| B2. **Render-value slots.** Materialise derived values once per update in instance-owned slots (computed in the update pass when their guard fires; bindings and handlers read the slot). An adapter-selected recompute policy: `deps` for Svelte `$derived` and Vue `computed`, `render` for React (recompute when the instance renders, so that allocations get fresh identity as in S2). This fixes S1, S2 and the Svelte/Vue identity gap, and removes repeated derivations. It needs an IR construct with interpreter semantics and differential coverage. | Scope outputs cached in `$` | ~1 week | M4 |
| B3. **Instance-rendered bit** for React: own state dirty after the `Object.is` bailout, or the parent rendered, with the slot owner deciding for `children`/slot content; `React.memo` later. Effects, effect dependencies and B2's `render` policy key off it. | React reconciler rules (not RC) | 3–5 days within the effects design | M4 |
| B4. **`useMemo`/`useCallback`** as memo slots with explicit dependencies compared by `Object.is`, using RC's `if ($[i] !== dep)` shape. | `codegenReactiveScope`, `ValidatePreservedManualMemoization` | 2–3 days on top of B2 | M4 |
| B5. **Per-render closure capture.** A closure created during render captures that render's snapshot, for example an `Rc` snapshot version per render. Listeners stay as they are. | RC's model of function expressions as values whose dependencies are their captured reactive values | 3–5 days | M4 (timers, async) |
| B6. **Hierarchical guards.** At codegen time, compute each scope's dependency union (including child prop guards) and skip the whole `update_s` of a scope, component or list block when nothing it reads is dirty. Under B1's frozen rule, also skip a retained list block whose item and index are SameValue. | Memoized JSX and element-identity bailout | 2–3 days | M10, or M5 if the 10,000-row list needs it |
| B7. **Path-level dependencies for deep state** (Svelte/Vue). A mutation dirties `(cell, path)` instead of the global epoch, and bindings record their read paths. | `ReactiveScopeDependency.path`, `DeriveMinimalDependenciesHIR` | 1–2 weeks | M4 if effects need it for Svelte/Vue, otherwise M10 |

**Also:**

- Detect `babel-plugin-react-compiler` in a collected app's Vite or Babel configuration and reject it (`E_FRONTEND`) until a policy exists. This is about half a day, in M6 when real app configurations are collected.
- Watch RC's Rust port for M13. If our frontends move to oxc, its validation passes could become a lint stage.
- After this spike, the "React regions" item in M3 needs no further work. B1–B5 belong in the M4 design, and B6–B7 in M10.

## Sources

- React Compiler, `facebook/react@278794d`: [Pipeline.ts](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/Entrypoint/Pipeline.ts), [HIR.ts](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/HIR/HIR.ts) (`ReactiveScope`, `ReactiveScopeDependency`, `MutableRange`), [MUTABILITY_ALIASING_MODEL.md](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/Inference/MUTABILITY_ALIASING_MODEL.md), [pass docs](https://github.com/facebook/react/tree/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/docs/passes) (09–11, 15–27, 31, 44, 48, 49, 53), [CodegenReactiveFunction.ts](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/ReactiveScopes/CodegenReactiveFunction.ts), [PruneNonEscapingScopes.ts](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/ReactiveScopes/PruneNonEscapingScopes.ts), [Environment.ts](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/HIR/Environment.ts), [DESIGN_GOALS.md](https://github.com/facebook/react/blob/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/docs/DESIGN_GOALS.md), [error fixtures](https://github.com/facebook/react/tree/278794d7dee9cd2a3a2aaf9f0b2a4b8b747d74ee/compiler/packages/babel-plugin-react-compiler/src/__tests__/fixtures/compiler).
- React semantics: [useState](https://react.dev/reference/react/useState) (`Object.is` bailout), [useEffect](https://react.dev/reference/react/useEffect) (dependencies, re-run after every render without them), [useMemo](https://react.dev/reference/react/useMemo), [memo](https://react.dev/reference/react/memo), [React Compiler](https://react.dev/learn/react-compiler).
- This repository: `crates/runic-codegen/src/lib.rs` (`function_reads`, `Gen::deps`, `Gen::guard`, `Gen::item`, `component_state`/`end_i{k}`, `generate`/`dispatch`), `crates/runic-js/src/heap.rs` (`mutation_epoch`), `frontend/adapters/react.ts` (`lowerComponent`), `frontend/language.ts` (`derived` bindings), `fixtures/*-react`, `examples/*-react`.
