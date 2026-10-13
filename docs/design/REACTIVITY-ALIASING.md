# Reactivity: deep state, aliasing and staleness

Status: design of the reactivity workstream (2026-10-13), implemented in the steps below; each step records its commit and verification when it lands. It refines the deep-state model of [M3](M3-COMPONENTS.md#svelte-deep-state-ownership) and the reactivity model of [M4](M4-EFFECTS.md#reactivity-model) without changing the serialised IR (schema 5 stays). Framework facts are from the pinned runtimes: Svelte 5.57.1 for the fixtures (5.49.2 for the north star's examples; where they differ it is said), Vue 3.5.43/3.5.24, React 19.3.0, observed in Chromium 153 by the cases named here.

## The trigger

Case `symbol-context`'s first version (2026-10-13, evidence `artifacts/carousel/conformance-v1-stale/`): a provider passes its `$state` object through a context, a consumer holds it in a `const` and renders `{tone.count}`. After a click Chromium shows the new count, the native app keeps showing 0. The interim guard (`shares_mutated_proxy`, `validate.rs`, merged in `1e742eb`) rejects such constants.

**Root cause.** Natively a template binding re-evaluates when its *guard* holds: a dirty bit of a cell it reads, changed template locals, or a write of a reactive class field (`cx.rh`). A cell's dirty bit follows its tracking mode: a `proxied` cell is dirty after any write through a proxy (`owned`), an `identity` cell only when it is set to another value. A constant holding another cell's proxy is `identity`, never set, so a binding that reaches the proxy only through it never re-evaluates. The mutation itself is tracked correctly: the proxy's slots count writes, and effects and derived values, which record what they read at run time, see it. Only the static guard of template bindings ties reactivity to the *cell* through which the value was reached instead of to the *value*.

**The interpreter agrees with Chromium here, not with native:** it renders the whole tree in every flush pass, so every binding sees every change. That is the reference model's simplification of update granularity, which is sound only where re-evaluating a binding more often shows nothing new; the validator's `E_REACTIVITY` checks exist to keep programs inside that domain. The bug is that the static guard under-approximated, which neither the differential test (no fixture had the shape) nor the validator caught.

## How Svelte's reactivity works (the oracle)

From the pinned sources (`svelte/src/internal/client/proxy.js`, `reactivity/sources.js`, `runtime.js`) and the cases below:

1. **Signals** are sources (`$state` variables, the per-property sources of proxies, an array proxy's `length`, a proxy's `version` for its key set), derived values, and reactive class fields. Props are getters over the parent's expressions; plain `let`/`const` variables, class fields without runes, Maps, Sets, class instances and raw objects are not signals.
2. **Proxies** (`proxy(v)` of plain objects and arrays) are *overlays*: each property is a source created at the first access through the proxy (read, `in`, write, delete), initialised from the target at that moment; an array's `length` source is created with the proxy. Writes through the proxy set its sources and never write the target. `proxy(p)` of a proxy is `p`; a raw value stored again gets a new proxy; a nested plain value is proxied when its property's source is created, so two proxies of one raw object, and a raw object reached again through a cycle, are different proxies with independent sources.
3. **Readers** are effects (user effects, template effects, block effects) and derived values. A reader depends on the signals it read in its last run, except signals created during that run and reads inside `untrack`. It does not matter how the reader reached the proxy (a `$state` variable, a constant, a context, a prop, a class field, a Map, a closure, a function's result).
4. **Self-invalidation**: an effect that changes, during its run, a signal it read in its previous run or reads in this one runs again (`mark_reactions` marks it, `schedule_possible_effect_self_invalidation` after the run). This holds for proxy property sources as for variables.
5. **Template granularity**: each block (component fragment, `{#if}` branch, `{#each}` item, snippet) has one template effect for all its text and attribute updates; expressions containing a call are memoized as derived values passed to it (`$.template_effect(fn, [() => f(x)])`). A non-call expression is re-evaluated whenever its block's effect re-runs; a call expression only when what it read changed.
6. **Teardowns** (effect cleanups, `onDestroy`) read signals as they were before the flush: `old_values` holds the value before the first write since the last flush (5.57.1; 5.49.2 keeps the value before the *last* write), for proxy property sources as for variables.

## Decisions

**R1. Reactivity belongs to the value, not to the cell that reached it.** A proxy (Svelte) or a reactive object (Vue `ref` contents) carries its signals: per-slot write counters in `runic_js::heap` (fields; an array's length and elements). Every reader depends on the slots it reads through such an object, wherever it got the object. Tracking modes keep their meaning for the cell's *own* signal and for what a cell stores (`proxied`: overlays of plain objects and arrays; `deep`: marked reactive), and no longer decide whether reads *through* the value are dependencies.

**R2. Template bindings re-evaluate after writes to reactive heap objects they may read through.** A binding whose expression, or a function it calls (derived functions included), may read a slot of a value that may be a proxy or a reactive object adds the reactive-heap flag `cx.rh` to its guard: true in a flush pass after a write through a proxy, a reactive class field write, or (Vue) a heap mutation since the previous pass. *May be a proxy* is a type fact computed once per program (`runic_ir` `ReactiveTypes`): the plain record and array types that deep state can hold (from `proxied` cells and `$state` class fields, through plain records, arrays, nullable and union types; never through class instances, maps, sets or promises, which proxies do not wrap), and, for Vue, every heap type reachable from `deep` cells. A read is a field `get` or `index` of such a type, a `for-of` over one, or a built-in given a value that can hold one. Re-evaluating a binding is unobservable where templates are pure (R7), so the guard may over-approximate; this replaces the interim guard `shares_mutated_proxy`, and costs no more than today's rule that makes every `proxied` cell dirty after any proxy write. Effects and derived values already track proxy slots at run time (M4) and keep doing so.

**R3. Proxies are overlays.** `JsRef::proxy` (and so `Own::own` for proxied cells, `$state` fields and stores into proxies) creates an object with its own storage and its own signals:
- a record overlay copies a field from its target, proxying a nested plain value, at the field's first access through the overlay (a whole read, such as a spread, `JSON.stringify` or `structuredClone`, accesses every field); writes go to the overlay only;
- an array overlay takes its target's length and elements when it is created (Svelte's eager `length`) and proxies an element at its first access; a later in-place change of the *target* array (not through the overlay) is reported unsupported at run time (`RunicUnsupportedError`; the interpreter stops with `E_UNSUPPORTED`): Svelte would show the target's new elements at indices not yet read while keeping the old length, which a typed array cannot hold.

This gives Svelte's observable identity (a new proxy per store of a raw value and per lazy path through a cycle, the case `ownership-cycles` gap) and its ownership: the raw object stays as it was (reset values, defaults: case `proxy-target`), a raw write before the first read is visible and one after it is not (case `proxy-lazy`, and `ownership`'s write right after `push`). Vue's `deep` cells are unchanged: Vue's reactive proxies write through to their target, which in-place marking models.

**R4. Self-invalidation.** An effect that changes a signal (a cell, a reactive field slot, a proxy slot) it read in its previous or current run is due again in the next pass, for cells and heap slots alike. Today cells re-run only when written after the read, and heap slots never (case `effect-self`: Svelte logs `len 5 | … | len 4 | … | len 3`, native `len 5`). Each run keeps a write log (instance cells and heap slots changed by the run); at the end of the run the effect is due again where the log meets its previous or new dependencies. Objects created by the run are not dependencies (Svelte does not track sources a reaction created).

**R5. Teardowns read deep state as before the flush.** Where `schedule.cleanupReadsPrevious` holds (Svelte), reads through a proxy while a cleanup or `onDestroy` runs give the slot's value before the first write since the last flush, as Svelte's `old_values` do (case `teardown-proxy`: `cleanup 0/0` where native shows `0/1`, `destroy 3 3` where native shows `13 3`). An overlay keeps a before-image from its first write after a flush ended until the next flush ends, only in programs whose cleanups may read through proxies (R2's type fact over the cleanup functions). The 5.49.2 rule (the value before the last write) differs for cells and slots alike; the adapter will select it by version (a schedule policy) when an example depends on it.

**R6. What a mutation notifies is decided by the mutated object.** The validator classifies each in-place mutation by the origin of the object: *through a proxy* (a `proxied` cell that is not a prop, a `$state` field, a value read from either, a constant or context whose every source is one: R8), *raw*, or *unknown*. Only raw and unknown mutations of values a template may read are rejected, as today. A `proxied` **prop** holds whatever its sites pass: raw objects included (case `prop-raw`: a child mutating a raw object through its prop is not reactive in Svelte, and Svelte shows the value when its block re-renders for another reason, which native bindings do not reproduce), so it counts as *through a proxy* only where every site passes a proxy or a value read from one.

**R7. Templates are pure, and their reads are dependencies.** The three models (Svelte's per-block template effects with memoized calls, the interpreter's full re-render, native per-binding guards) agree exactly when every value a template expression reads changes only together with a signal the expression depends on. Besides the existing rejections (written non-reactive cells, raw mutations, host services, `lastIndex`, Date setters, maps and sets in state, dynamic values), an **untracked read** in a template (`untrack(() => …)` reached from a template expression, directly or through calls) of a value that may change is `E_REACTIVITY`: Svelte memoizes the expression and never shows the change, the interpreter shows it at the next flush and native when the untracked cell is dirty (case `untrack-template`).

**R8. Aliases of deep state.** Constants, contexts and function results whose every source is deep state are *through a proxy* (R6), so writes through them (`ctx.count += 1` of a context's `$state` object, case `alias-writes`) are accepted instead of being rejected as raw mutations. The validator follows values through `context.set`/`context.get` by key, constants never set, and the results and parameters of functions (all call sites); anything else stays *unknown*.

**R9. Frameworks keep their own models; the shared layers keep the mechanisms.** The adapters choose what a cell stores and how it is dirtied (`proxied` overlays for Svelte `$state`, `deep` marking for Vue `ref`, `identity` + `readonly` for React); the backend never branches on frameworks: R2's type fact, R3's overlays (only `proxied` stores create them), R4 and R5 are generic, gated by the program's tracking modes and schedule policies.

## What the IR expresses

No schema change. The meaning of existing constructs is made precise (docs/IR.md):
- `proxied` cells and `state` class fields store overlays (R3); `deep` cells mark what they hold reactive.
- Reads through overlays and reactive objects are dependencies of effects, derived values and template bindings, wherever the value is held (R1, R2).
- An effect run that changes what it read is due again (R4); cleanups under `cleanupReadsPrevious` read overlays' before-images (R5).

## What the validator proves

For every template expression of an accepted program: whenever the value it computes may change between two flush passes, (a) the framework re-evaluates it (the change is a write to a signal it depends on), (b) the interpreter re-evaluates it (always), and (c) native re-evaluates it (its guard holds). (c) is now structural: guards cover cells by dirty bits and reactive heap reads by `cx.rh`. The validator proves (a) by rejecting the changes that notify no signal the expression reads: written non-reactive cells, raw and unknown in-place mutations (R6), untracked reads (R7), host services, `lastIndex`, Date setters, maps and sets inside proxied state, dynamic values changed in place, plain class fields written after construction. Writes that Svelte refuses (`state_unsafe_mutation`) stay rejected as before.

## What stays rejected or reported, and why

| Pattern | Outcome | Why |
|---|---|---|
| A raw (non-proxy) object mutated in place while a template reads it, also through a `proxied` prop that may hold it | `E_REACTIVITY` | Not a signal in any framework; the frameworks show it when the block re-renders for another reason, at points native bindings do not reproduce |
| `untrack` of a changing value in a template | `E_REACTIVITY` | Svelte memoizes the expression (R7) |
| An array changed in place after a proxy over it was created, other than through the proxy | run time (`RunicUnsupportedError`) | Svelte's overlay would show new elements under the old length (R3) |
| Maps and Sets in `$state` mutated, class instances in `$state` mutated in place | `E_REACTIVITY` (unchanged) | Proxies do not wrap them |
| Teardown reads under Svelte 5.49.2's last-write rule | not modelled yet (5.57.1's rule) | Version policy, added when an example needs it |

## Steps

1. **R1/R2**: reactive-heap guards for template bindings; remove `shares_mutated_proxy` (cases `alias-reads`, `alias-vue`). Done ([results](../../conformance/results/reactivity.md#step-1-reads-through-aliases-r1r2)).
2. **R4**: self-invalidation through write logs, cells and heap (case `effect-self`).
3. **R3**: overlays in `runic_js::heap`, for the interpreter and generated code alike (cases `proxy-target`, `proxy-lazy`; `ownership`, `ownership-cycles` without its known gap).
4. **R6/R7**: proxied props from raw sources and untracked template reads (cases `prop-raw`, `untrack-template` as expected rejections).
5. **R5**: before-images for teardowns (case `teardown-proxy`).
6. **R8**: aliases of deep state as proxies (case `alias-writes`).
7. React and Vue audit (below).

Each step runs the node and Rust tests, the differential on the affected fixtures, conformance with pixels on the new and the existing reactivity cases, and the example census where it can reject programs.

## Cross-framework semantics matrix

What each framework does, what the native model does, and the case that detects a difference. *Verified* rows were observed in Chromium; the others are read from the pinned sources and get a case before they are relied on.

| Semantics | Svelte 5 | Vue 3.5 | React 19 | Native model | Case |
|---|---|---|---|---|---|
| Deep mutation seen through an alias (constant, context/inject, class field, Map, closure) | yes, per property (verified) | yes, through the reactive proxy (`ref` contents) | no deep reactivity: state is replaced (`E_READONLY` on mutation) | R1/R2 | `alias-reads`, `vue-alias` (planned) |
| Write through an alias of deep state | reactive (verified) | reactive | — | R6/R8 | `alias-writes` |
| Raw object after storing it in state | target untouched; per-property snapshot at first read (verified) | proxy writes through to the target; raw writes not tracked | state is the object; mutation rejected | R3 (Svelte), in-place marking (Vue) | `proxy-target`, `proxy-lazy` |
| Proxy identity | new proxy per raw store and per lazy path; `proxy(p) === p` | one reactive proxy per raw object (`reactiveMap`) | identity of the object | R3; Vue: shared storage | `ownership`, `ownership-cycles` |
| Effect writing what it read | re-runs (cells and proxies; verified) | `watchEffect` re-runs once per flush (`ALLOW_RECURSE` off: no self-trigger while running) | `useEffect` with the value in deps re-runs after the next render | R4 | `effect-self`, `vue-effect-self` (planned) |
| Teardown/cleanup reads | values before the flush, proxies included (verified, 5.57.1) | live values (`onWatcherCleanup` runs before the re-run) | the render's closure (snapshot) | R5; `cleanupReadsPrevious` per adapter | `teardown-proxy` |
| Template granularity | per block, calls memoized (verified) | per component render | per component render (with children) | per binding, validator R7 | `untrack-template`, `prop-raw` |
| Derived caching | `$derived`: recomputed lazily, `===` | `computed`: lazy, `Object.is` | render constants every render; `useMemo` rejected | derived functions | `derived-timing`, `derived-equality` |
| Shallow state | `$state.raw`: identity only | `shallowRef`: identity only (`.value` replace) | — | `identity` cells | `vue-shallow` (planned) |
| Stale closures | live reads | live reads | the render snapshot | snapshot reads | `closures` |
| Keyed list item identity after replacing an item with the same key | block kept, item updated | vnode patched | fiber kept, props updated | locals updated, `tl` | `keyed-replace` (planned) |
