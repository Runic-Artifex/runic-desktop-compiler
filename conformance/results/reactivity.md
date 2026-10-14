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
| `alias-writes` (Svelte), writes through `const ctx = getContext(…)` | owner and readers update | `E_REACTIVITY` (`ctx is mutated in place`) | fixed, step 6 (R8) |
| `proxy-target` | `$state(INITIAL)` leaves `INITIAL` untouched; a reset to it shows the original items; defaults and nested raw objects stay | interpreter (and native: same heap model) write through to the raw object | fixed, step 4 (R3) |
| `proxy-lazy` | a raw write after the proxy read the property stays invisible | interpreter shows it at the next render | fixed, step 4 (R3) |
| `effect-self` (Svelte) | effects writing what they read re-run: `len 5 \| … \| len 4 \| … \| len 3`, also through proxies; one writing back the value it read runs once more | cells re-run, proxies never (`len 5`, values `4 3 4`) | fixed, step 2 (R4) |
| `push-effect` (Svelte) | an effect pushing to a `$state` array runs again (`push` reads the length) until it stops pushing | ran once | fixed, step 2 (R4) |
| `effect-self` (Vue) | a `watchEffect` does not re-run for its own writes | rejected by the Vue adapter (`E_EFFECT`), as designed | expected rejection |
| `teardown-proxy` | cleanups and `onDestroy` read proxy properties as before the flush (`cleanup 0/0`, `destroy 3 3`) | proxies read current values (`0/1`, `13 3`; a derived value its cache, `d0`) | fixed, step 5 (R5) |
| `untrack-template` | `{untrack(() => x)}` never updates (memoized call) | interpreter updates at every render, native when `x` is dirty | rejected, step 3 (R7) |
| `prop-raw` | a child mutating a raw object through its prop shows it only when its block re-renders for another prop | interpreter shows it at once; native when any proxy is written | rejected, step 3 (R6) |
| `raw-target-vue` | a raw write to a deep ref's target is not tracked and shows at the component's next render | interpreter (and native) show it at once; a recorded M4 deviation | rejected, step 3 (R6 for Vue) |
| `shallow-vue` | a `shallowRef` mutated in place shows at the next render | rejected (`E_REACTIVITY`) | expected rejection |
| `collections-vue` | Maps, Sets and arrays a deep ref holds are reactive, nested too | interpreter agrees | regression case |
| `keyed-replace`, `derived-arrays`, `shared-state` (Svelte) | keyed blocks keep child state when an item is replaced; derived values over arrays changed in place; module state shared by instances | interpreter agrees | regression cases |
| `deep-tracking` (Svelte), after step 4 | an effect reading `items[0].done` runs again when the item is toggled | the proxy of `items[0]`, made by the effect's first read, was no dependency of it (R3 with R4) | fixed |
| `alias-writes-vue` | writes through a constant, a parameter and a result holding a ref's contents update its readers | `E_REACTIVITY` (`alias is mutated in place`) | fixed (R8 for Vue) |
| `staleness` (React) | immutable updates, effects keeping their render's props, a mount timeout reading the mount's state, bail-out on equal state, value updates vs updaters | interpreter agrees | regression case |
| `effect-self-react` | an effect whose dependencies include the state it sets runs again after the next commit (passive in a later task, layout before the passive effects), an updater that settles commits nothing, a chain from mount | interpreter agrees | regression case (step 7) |
| `unmount-updates` (React) | cleanups at unmount update the parent (passive: rendered after the passive flush; layout: rendered with them, after), not their own unmounted state; a cleanup reads a ref live | interpreter agrees | regression case (step 7) |
| `teardown-vue` | cleanups read live values, through a ref's proxy and a computed value; unmount hooks read the last render's props | interpreter agrees (once the computed is rendered, below) | regression case (step 7) |
| `watch-order-vue` | a handler writing `b`, then `a` runs `watch(b)` before `watch(a)`: `a2`, `b2 \| effect 2 \| a2` | declaration order: `b2`, `a2 \| b2 \| effect 2` | rejected (R10) |
| `watch-cleanup-computed-vue` | a computed first evaluated in a watchEffect's cleanup moves the watchEffect behind the next watcher: `cleanup 0 d2 \| watch 1 \| watch 2 \| cleanup 1 d4 \| …` | `… \| cleanup 1 d4 \| watch 2 \| …` | rejected (R10) |
| `watch-instances-deep-vue` | watchers a write triggers run by instance creation: `row 1 3 \| row 2 3 \| row 3 3 \| row 0 3` | document order: `row 0 3 \| row 3 3 \| row 1 3 \| row 2 3` | rejected (R10) |
| `watch-declared`, `watch-instances` (Vue) | the shapes R10 accepts run in declaration and document order | interpreter agrees | regression cases |
| `equal-writes-vue` | a write of the value a deep ref's slot holds notifies nothing | the watchEffect reading it runs again (`run 0 1 0`) | open (step 7 resume list) |

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
  Native conformance and the differential: [final verification](#final-verification).

## Step 5: teardowns read deep state as before the flush (R5)

Proxies keep a before-image from their first write after a flush ended
until the next flush ends, in programs whose cleanups read the values before
the flush (Svelte) and that have proxies; reads through a proxy while a
cleanup or `onDestroy` runs give it, and a derived value read then is
computed afresh from those values, neither from nor into its cache (Svelte
re-executes a derived value that depends on old values).

- `teardown-proxy`: `cleanup 0/0 0/0 d0`, `cleanup 1/1 1/1 d2`,
  `destroy 3 3 | cleanup 3/3 3/3 d6`, as in Chromium (before: the proxies'
  current values, `0/1`, `1/3`, `destroy 13 3 | cleanup 3/13`, and the
  derived value's cache, `d0` throughout).
- `tests/reactivity.test.mjs` checks the case in the interpreter;
  `npm test` 487/487, `cargo test --workspace` (182) pass. Native
  conformance and the differential: [final verification](#final-verification).

## Step 6: writes through aliases of deep state (R8)

The validator proves values proxies where every source is deep state:
constants never set, `context.get` of keys every `context.set` of which
stores one, results and parameters of functions every return and direct
call of which give one (a fixpoint from none); writes through them are
writes through the proxy.

- `alias-writes`: lowers and passes (before: `E_REACTIVITY`, `ctx is
  mutated in place`); a constant of a raw object mutated in place stays
  rejected.
- `tests/reactivity.test.mjs` checks the case in the interpreter and that a
  constant of a raw object mutated in place stays rejected; `npm test`
  487/487, `cargo test --workspace` (182) pass.

## Lazy proxies an effect takes are its dependencies

The first native run of steps 4–6 (`artifacts/reactivity/final`, stopped
after 38 runs, 34 passing) failed case `deep-tracking` (Svelte) at both
viewports: the effect reading `items[0].done` did not run again when the
item was toggled (Chromium logs `first true`; native and the interpreter
nothing). Its first
run made the proxy of `items[0]` at the element's first access (R3), and
R4's rule that objects a run created are not its dependencies dropped the
read. Svelte creates a proxy's lazy sources in the reaction that created
the proxy (`with_parent` in `proxy.js`); a proxy made while another takes a
slot now counts as created with that one. The same run failed case
`alias-writes` on two text expectations only (`1` where the owner shows
`1 `, its items empty: Chromium and native agree); the expectations now
hold the space.

## R8 for Vue: writes through aliases of a ref's contents

What a Vue deep ref holds is its reactive proxy, so writes through a
constant, a function's parameter or its result holding it are tracked
(case `alias-writes-vue` in Chromium: owner and alias update; after the ref
is given a new object the constant keeps the old one, whose writes update
its own readers only). They were rejected (`E_REACTIVITY`, `alias is
mutated in place`); R8's proof now counts a `deep` cell that is not a prop
as a proxy source. A raw object a ref holds and changed through another
reference stays rejected (R6). Vue refs in plain modules (a `.ts` module
importing `vue`, state shared by components) are `E_DEPENDENCY`: a gap
row.

## Final verification

On the branch rebased onto main 092e1ca, with every step:

- Conformance with pixels at 800x600 and 420x600 (98 runs,
  `artifacts/reactivity/final2`): `deep-tracking`, `alias-writes`,
  `alias-writes-vue`, `proxy-target`, `proxy-lazy`, `teardown-proxy`,
  `ownership`, `ownership-cycles` (without its known gap), `alias-reads`,
  `alias-vue`, `symbol-context`, `effect-self`, `push-effect`, `effects`,
  `effect-root`, `effect-order`, `derived-timing`, `derived-equality`,
  `reactive-classes`, `class-hierarchy`, `unions`, `dyn-values`,
  `bind-chains`, `id-counter`, `keyed-replace`, `derived-arrays`,
  `shared-state`, `collections-vue`, `staleness`, `todomvc`, `7guis-crud`,
  `7guis-cells`, `bits-dialog`, `bits-select`, `bits-tooltip`,
  `bits-dropdown-menu`, `portal`: all 98 pass.
- Differential (interpreter vs native, 20 traces x 25 actions):
  `deep-tracking-svelte`, `proxy-target-svelte`, `proxy-lazy-svelte`,
  `teardown-proxy-svelte`, `alias-writes-svelte`, `alias-writes-vue`,
  `ownership-svelte`, `alias-reads-svelte`, `symbol-context-svelte`,
  `effect-self-svelte`, `reactive-class-svelte`: 5720 steps, complete, no
  failure.
- `npm test` 489/489, `cargo test --workspace` (182) pass.
- Example census: 404 examples, the same 280 lowered with the same first
  blockers as main's latest census (`artifacts/script-dom/census-2`), after
  steps 4–6 (`census-4`) and after the two fixes (`census-5`): nothing
  gained, nothing lost.

Rebased again onto main f9aaada (script DOM slice 2, defaulted parameters,
package constants): `npm test` 506/506 and `cargo test --workspace` (183)
pass, and conformance with pixels passes all 24 runs of `deep-tracking`,
`proxy-target`, `proxy-lazy`, `teardown-proxy`, `alias-writes`,
`alias-writes-vue`, `effect-self`, `push-effect`, `ownership-cycles`,
`script-dom-announcer` and `script-dom-nodes` (`artifacts/reactivity/rebase2`).

## Step 7: React and Vue audit

Each row of the [cross-framework matrix](../../docs/design/REACTIVITY-ALIASING.md#cross-framework-semantics-matrix)
the remaining plan named, run in Chromium and the interpreter first
(`conformance/interp-vs-browser.mjs <case> --show`, which now prints the
browser's text per step).

React (all agree; regression cases):
- `effect-self-react`: an effect whose dependencies include the state it
  sets runs again after the next commit, each run logged after its commit.
  A passive chain logs `commit 1023 | n 1 | commit 2023 | n 2 | …`. A layout
  chain runs synchronously and, with both chains in one handler, before the
  passive effects: `commit 1123 | m 1 | n 1 | commit 2223 | …`. An updater
  without dependencies that stops changing the state commits nothing, and a
  chain from mount settles before the first action.
- `unmount-updates`: at unmount, a passive cleanup's update of the parent
  renders after the passive flush, and its own (unmounted) update does
  nothing. A layout cleanup's update renders with them, after them:
  `commit hidden 1 [a0b0] [] | a cleanup 2 | … | commit hidden 1 [a0b0aa1bb1] [ab]`.
  A cleanup reads the ref's current value (`a cleanup 2` after two clicks),
  and a cleanup run because a dependency changed updates the parent too.
- `useRef` (and module state) read or written while rendering, including
  through a callback a child calls while rendering, were already located
  rejections (`E_REF`, `E_REACTIVITY`); `tests/reactivity.test.mjs` now pins
  them.

Vue:
- `teardown-vue` agrees: a watchEffect's `onWatcherCleanup` and a watch
  callback's `onCleanup` read live values, through the ref's proxy and a
  computed value (`cleanup 0/1 0/1 d2`); at unmount `onBeforeUnmount`,
  `onUnmounted` and a watcher cleanup read the last render's props and live
  values through them (`before unmount 13 3`).
- Its first draft, where the computed value was read only in the cleanup,
  differed in order (Chromium `watch cleanup 1/3 3 | cleanup 1/3 1/3 d6`,
  natively the reverse). Vue queues a component's watchers in the order a
  flush triggers them, and a computed value first evaluated inside a
  watchEffect's run takes over the links it shares with it
  (`dep.activeLink`), so the watchEffect subscribes again at the tail. Two
  fixtures confirm each effect: `watch-order-vue` (write order:
  `b2 | effect 2 | a2`, natively `a2 | b2 | effect 2`, and the final status
  differs) and `watch-cleanup-computed-vue` (`cleanup 0 d2 | watch 1 | watch 2 | cleanup 1 d4`).
- Across instances, `watch-instances-deep-vue` differs: watchers a write
  triggers run by instance creation (`row 1 3 | row 2 3 | row 3 3 | row 0 3`),
  natively in document order. Watchers a prop update triggers run while the
  parent patches each instance, in document order, as natively (case
  `watch-instances`).
- Decision (user, 2026-10-14, ROADMAP): a located rejection now (R10,
  `frontend/adapters/vue-watch-order.ts`), the exact model as a later
  schedule policy. Accepted shapes, each checked in Chromium: case
  `watch-declared` (a later watcher's signals a subset of what an earlier
  one reads in every run, through a ref and a prop's record field, in both
  write orders; two watchers no handler triggers together), `teardown-vue`
  (a settled computed value in a cleanup) and `watch-instances`. Expected
  rejections: `watch-order-vue`, `watch-cleanup-computed-vue`,
  `watch-instances-deep-vue`, and `deep-tracking-vue`. That last one moved
  from accepted: three watchEffects over deep refs log into one array, and
  their signals are array elements and lengths, which the analysis does not
  tell apart. It left case `deep-tracking`, whose Svelte fixture stays.
- No other fixture changes: lowering every Vue fixture before and after
  the check differs only in `deep-tracking-vue` and the new fixtures.
- Found while checking `reverse`: a write of the value a deep ref's slot
  holds notifies nothing in Vue, natively a watchEffect reading it ran
  again (`equal-writes-vue`); fixed below.

## Equal writes and per-element array methods (R4)

A write of a value equal to the one a slot holds now changes nothing for
objects deep reactive state reaches (Vue: SameValue, as `hasChanged`), as
it already did for proxies (Svelte: `===`); `JsRef::equal_write` tells the
rule. `reverse`, `sort` and `fill` read and set element by element, as the
proxies' traps see them, writing only the elements that change, and `fill`
stores the value into each element as a set does.

- `equal-writes` (Vue 3.5 in Chromium): a field, an element and a ref set
  to their values, a palindrome reversed and a push leave the watchEffect
  alone; reversing `[1, 2, 1, 9]` runs it once (`run 0 9 0`). Before, the
  interpreter (and native code, the same heap model) ran it after the
  equal writes and the palindrome's reversal (`run 0 1 0`, 3 mismatches).
- `array-writes` (Svelte 5.57.1 in Chromium): the effect reading the
  middle element stays after `reverse`, `sort` and a `fill` of its value,
  and `fill({ n: 5 })` stores a proxy per index (`6 5` after one write).
  Before: `mid 2` after each method and `6 6` (11 mismatches).
- Gap row added: `pop`, `shift`, `unshift`, `splice` and `copyWithin` still
  read and write the whole array natively.
