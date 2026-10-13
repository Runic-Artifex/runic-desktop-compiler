# Reactivity: deep state, aliasing and staleness (2026-10-13)

Results of the workstream designed in
[REACTIVITY-ALIASING](../../docs/design/REACTIVITY-ALIASING.md), step by step.
Chromium 153.0.8010.12, CPU renderer; Svelte 5.57.1, Vue 3.5.43 and React
19.3.0 for the fixtures. Evidence under `artifacts/reactivity/` of the main
tree (not committed).

## Findings

Adversarial fixtures, first run in Chromium and the reference interpreter
(native where it lowers), before any fix:

| Case | Chromium | Interpreter / native before | Outcome |
|---|---|---|---|
| `alias-reads` (Svelte) | every alias of the context's `$state` object updates | interpreter agrees; native: every reader but the owner stays 0 (7 elements) | fixed, step 1 |
| `alias-vue` | every alias of a deep ref's proxy updates | interpreter agrees | covered by step 1 (deep refs) |
| `alias-writes` (Svelte), writes through `const ctx = getContext(…)` | owner and readers update | `E_REACTIVITY` (`ctx is mutated in place`) | gap (R8) |
| `proxy-target` | `$state(INITIAL)` leaves `INITIAL` untouched; a reset to it shows the original items; defaults and nested raw objects stay | interpreter (and native: same heap model) write through to the raw object | fixed, step 4 (R3) |
| `proxy-lazy` | a raw write after the proxy read the property stays invisible | interpreter shows it at the next render | fixed, step 4 (R3) |
| `effect-self` (Svelte) | effects writing what they read re-run: `len 5 \| … \| len 4 \| … \| len 3`, also through proxies; one writing back the value it read runs once more | cells re-run, proxies never (`len 5`, values `4 3 4`) | fixed, step 2 (R4) |
| `push-effect` (Svelte) | an effect pushing to a `$state` array runs again (`push` reads the length) until it stops pushing | ran once | fixed, step 2 (R4) |
| `effect-self` (Vue) | a `watchEffect` does not re-run for its own writes | rejected by the Vue adapter (`E_EFFECT`), as designed | expected rejection |
| `teardown-proxy` | cleanups and `onDestroy` read proxy properties as before the flush (`cleanup 0/0`, `destroy 3 3`) | proxies read current values (`0/1`, `13 3`) | step 5 (R5) |
| `untrack-template` | `{untrack(() => x)}` never updates (memoized call) | interpreter updates at every render, native when `x` is dirty | rejected, step 3 (R7) |
| `prop-raw` | a child mutating a raw object through its prop shows it only when its block re-renders for another prop | interpreter shows it at once; native when any proxy is written | rejected, step 3 (R6) |
| `raw-target-vue` | a raw write to a deep ref's target is not tracked and shows at the component's next render | interpreter (and native) show it at once; a recorded M4 deviation | rejected, step 3 (R6 for Vue) |
| `shallow-vue` | a `shallowRef` mutated in place shows at the next render | rejected (`E_REACTIVITY`) | expected rejection |
| `collections-vue` | Maps, Sets and arrays a deep ref holds are reactive, nested too | interpreter agrees | regression case |
| `keyed-replace`, `derived-arrays`, `shared-state` (Svelte) | keyed blocks keep child state when an item is replaced; derived values over arrays changed in place; module state shared by instances | interpreter agrees | regression cases |
| `staleness` (React) | immutable updates, effects keeping their render's props, a mount timeout reading the mount's state, bail-out on equal state, value updates vs updaters | interpreter agrees | regression case |

## Step 1: reads through aliases (R1/R2)

Template bindings that may read a slot of a value deep state can hold
(`runic_ir::reactive::ReactiveHeap`) re-evaluate after writes through
proxies, reactive class fields and (deep refs) heap mutations, whatever cells
they read; the interim guard `shares_mutated_proxy` is gone.

- `alias-reads`: before the fix, semantics failed at both viewports
  (`artifacts/reactivity/step1-alias-reads-before`); after it, semantics,
  geometry and pixels pass at 800x600 and 420x600 with 13 independent text
  expectations.
- `alias-vue`: semantics, geometry and pixels pass at both viewports, with 6
  text expectations (a deep ref's proxy in a constant, an object field and
  a function).
- Differential (interpreter vs native, 20 traces x 25 actions):
  `alias-reads-svelte`, `symbol-context-svelte`, `ownership-svelte`,
  `deep-tracking-svelte`: 2080 steps, no failure.
- Regression with pixels (54 runs): `7guis-crud`, `alias-reads`,
  `alias-vue`, `bind-chains`, `class-hierarchy`, `deep-tracking`,
  `derived-equality`, `derived-timing`, `dyn-values`, `effects`, `id-counter`,
  `ownership`, `ownership-cycles` (its known gap, as before),
  `reactive-classes`, `symbol-context`, `todomvc`, `unions`: all pass.
- `npm test` 472/472; `cargo test --workspace` all pass.

The adversarial cases of the other findings land with the step that fixes
or rejects them.

## Step 2: effects writing what they read (R4)

An effect run that changed a cell, a reactive field slot or a proxy slot it
read in that run or its previous one is due again in the next pass; cell
versions and heap write stamps tell writes after the run started
(`runic_runtime::self_invalidated`); proxies the run created are not
dependencies; a field or element write through a proxy of a `===` value
changes nothing.

- `effect-self`: the interpreter and native now log Svelte's order exactly
  (`len 5 | count 5 | box 5 | mirror 0 0 | len 4 | … | len 3 | count 3 | box 3`;
  the mirror effect, writing back the value it read, runs once more and
  stops). Before: `len 5` once, values `4 3 4`.
- `push-effect`: an effect pushing to a `$state` array runs again until it
  stops pushing (`50` entries, as in Chromium; before: 1). A unit test of
  `$effect.root` (`tests/effect-root.test.mjs`) pushed to a `$state` log in
  an effect without `untrack` and expected one run: Svelte runs it again
  (`effect_update_depth_exceeded` without a bound); the test now writes the
  log untracked, as case `effect-root`'s fixture always did.
- The Vue fixture of `effect-self` is an expected rejection (`E_EFFECT`: a
  `watchEffect` does not re-run for its own writes, `len 5 | count 5 | box 5`
  in Chromium).
- Conformance with pixels, steps 2 and 3 together (62 runs,
  `artifacts/reactivity/step23`): `effect-self`, `push-effect`, `effects`,
  `effect-writes-state`, `effect-order`, `effect-root`, `derived-timing`,
  `deep-tracking`, `reactive-classes`, `todomvc`, `7guis-crud`,
  `alias-reads`, `alias-vue`, `bits-dialog`, `bits-select`, `bits-tooltip`,
  `bits-dropdown-menu`, `portal`, `timers`, and the new cases
  `keyed-replace`, `derived-arrays` and `shared-state`: all pass.
- Differential (interpreter vs native, 20 traces x 25 actions):
  `effect-self-svelte`, `push-effect-svelte`, `keyed-replace-svelte`,
  `derived-arrays-svelte`, `shared-state-svelte`, `staleness-react`,
  `collections-vue`: 3640 steps, no failure.
- `npm test` 479/479 and `cargo test --workspace` (178) pass with steps 2
  and 3.

## Step 3: raw props, raw ref targets and untracked template reads (R6, R7)

Rejections (`E_REACTIVITY`, located), each checked in Chromium first:
`{untrack(() => …)}` reached from a template expression (`untrack-template`:
Svelte memoizes the expression); a child mutating a prop where a site passes
a raw object or a default object applies (`prop-raw`); a raw object a Vue ref
holds changed through another root (`raw-target-vue`, until now a recorded M4
deviation). A prop whose value has an unknown origin (a derived value's
items, as TodoMVC's `{#each shown as todo}`) stays accepted. `shallow-vue`
(a `shallowRef` mutated in place) stays an expected rejection.

- `tests/reactivity.test.mjs` checks each rejection and its source location,
  and that a child mutating a `$state` object passed as its prop is
  accepted.
- No program that lowered before is rejected: the example census
  (`artifacts/reactivity/census-2`) lowers the same 280 programs as main
  (before props passed by imperatively mounted content were included; the
  census after step 6 covers them).

## Regression cases (cross-framework audit)

Rows of the [cross-framework matrix](../../docs/design/REACTIVITY-ALIASING.md#cross-framework-semantics-matrix)
where the native model already agreed with the framework, each run in
Chromium and the interpreter first, kept as regression cases:

- `keyed-replace` (Svelte): an item replaced by a new object of the same key
  keeps its block and its child's state, an item mutated in place updates,
  a sort in place moves blocks, a rebuilt array keeps every block.
- `derived-arrays` (Svelte): derived values over a `$state` array changed in
  place (a filter, the array itself, a sorted copy, a sum, a counted
  length) through `push`, `splice`, `sort` and an element write.
- `shared-state` (Svelte): module state (a `$state` object and array, a
  class with `$state` fields) written by two instances and read by them and
  the root, one instance destroyed and created again.
- `collections-vue`: Maps, Sets and arrays a deep ref holds, also nested in
  an object, after `set`, `add`, `push` and element writes, read by the
  template and a computed value.
- `staleness` (React): six text expectations (immutable item updates reach
  keyed rows, an effect without dependencies keeps its first render's
  props, a timeout started at mount reads the mount's state, setting a state
  to its value commits nothing, two value updates in one handler give one
  increment and two updaters two). Its first run failed on the expectations
  only: the fixture's log began with a space, in Chromium and natively
  alike; the log now starts without it.

Conformance with pixels at 800x600 and 420x600: all pass
(`artifacts/reactivity/step23`, `step23-staleness`, `step23-collections`);
the differential of their fixtures is in step 2.

## Step 4: proxies as overlays (R3)

`JsRef::proxy` makes an object with its own storage and signals, taking a
field (an element) of the value it was made of at its first access and
never writing that value; probes and snapshots read without taking; an array
changed in place other than through its proxy while elements are pending is
reported (`RunicUnsupportedError`, the interpreter `E_UNSUPPORTED`).

- `proxy-target`: the raw array, the defaults object and a nested raw object
  keep their values; a reset to the raw array shows its original items
  (before: `3 true`, `a+,b,c`, `Ada! 2` in the interpreter, natively the
  same heap model).
- `proxy-lazy`: a raw write after the proxy read the property stays
  invisible (before: `first*`).
- `ownership-cycles`: a raw object reached again through a cycle is a new
  proxy, as in Svelte; the case's known gap is gone.
- `tests/reactivity.test.mjs` checks both cases in the interpreter and the
  report of an array changed in place under its proxy; `npm test` 486/486,
  `cargo test --workspace` (181) pass after rebasing onto main 092e1ca.
  Native conformance and the differential: with steps 5 and 6 (step 6).
