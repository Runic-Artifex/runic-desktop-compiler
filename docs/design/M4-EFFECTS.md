# M4 design: effects, time and async

Status: design for M4 ([roadmap](../ROADMAP.md#m4-effects-time-and-async)). Framework scheduling facts come from [M4-ORDERING](M4-ORDERING.md), which records what the pinned React, Vue and Svelte versions do in Chromium.

## Goals

- Timers, animation frames, promises and `async`/`await` with JavaScript's task and microtask ordering.
- Effects with each framework's timing, dependency rules and cleanup order.
- The reactivity refinements carried over from M3: derived values computed once per update, each framework's update granularity, and effects that depend on dirtiness only through precise dependencies.
- `localStorage` as the first host service.
- Deterministic verification: virtual time in the native probe and the interpreter, Playwright's fake clock in the browser.

## Time and the event loop

The runtime gains a single-threaded event loop with JavaScript's structure:

- **Tasks** (macrotasks): input events, timer callbacks (`setTimeout`, `setInterval`) ordered by due time and then by creation order, and host callbacks.
- **Microtasks**: promise reactions and `queueMicrotask`, drained completely after every task and after every handler.
- **Animation frames**: `requestAnimationFrame` callbacks run once per frame before rendering, in registration order, with the frame time.
- **Rendering** happens after the microtask queue is empty. Framework flushes are expressed as tasks or microtasks with the framework's timing (see Effects).

Native apps take time from the system clock and wake winit for the next timer or frame. The probe and the interpreter use a **virtual clock**: time only advances through a `wait` action (`{ "kind": "wait", "ms": 100 }`), which runs every timer and frame that becomes due, in order. The browser harness installs Playwright's fake clock and implements `wait` with `clock.runFor`, so all three sides see the same timeline. Frames are driven at 60 Hz of virtual time in all three.

`Date.now()` and `performance.now()` read the same clock (virtual under test). Wall-clock formatting (`Date` objects, `Intl`) stays in M5.

## Promises and async functions

**Values.** `Promise<T>` is an IR type (`T` is never itself a promise; TypeScript flattens). A promise is pending, fulfilled with a `T` or rejected with an exception value. Native code represents it as a shared cell (`JsPromise<T>`) holding its state and pending reactions; identity is reference identity.

**Operations** (built-ins, each with ECMAScript's job ordering):

| Built-in | Semantics |
|---|---|
| `promise.new(executor)` | calls `executor(resolve, reject)` synchronously; an exception rejects (unless already resolved) |
| `promise.resolve(v)` | `v` itself when it is a promise, otherwise a fulfilled promise |
| `promise.reject(e)` | a rejected promise |
| `promise.then(p, onFulfilled?, onRejected?)` | a new promise; when `p` settles, one microtask runs the handler and resolves the new promise with its result |
| `promise.catch`, `promise.finally` | `then` with the spec's wrappers (`finally` passes the original outcome through after its callback's promise settles) |
| `promise.all`, `allSettled`, `race`, `any` | as specified, each element through `Promise.resolve` and `then` |

Resolving a promise with another promise adopts it through a `NewPromiseResolveThenableJob`: one microtask to call `then`, one more for the reaction, so adoption costs two ticks. Callbacks whose static result type is `Promise<U>` are typed `Promise<U>`; a callback whose result may or may not be a promise (`U | Promise<U>`) is rejected. Unhandled rejections are reported like uncaught exceptions and are not observable to the program.

**Async functions** are lowered by the shared language layer, so the IR, the interpreter and codegen only need promises, closures and the scheduler:

- The function returns `promise.new`, and its body runs synchronously inside the executor until the first `await`.
- The body becomes a state machine: a resume closure created once per call, whose locals are boxed captures, dispatching on a state local inside a labelled loop. A statement that contains an `await` is split at the `await`; the code before it stores the next state and registers the resume closure with `promise.then(promise.resolve(e), resume, fail)`, which costs one tick after `e` settles, as in V8.
- Control structures that contain an `await` (`if`, loops, `for-of`, `switch`, `try`/`catch`) become explicit state transitions: the loop's continue jumps to the condition's state, `break` to the state after it. Statements without `await` stay structured.
- `return v` resolves the function's promise with `v` (adopting a returned promise: two extra ticks, as specified); an uncaught exception rejects it. A `try` around an `await` records, per state, the state of its `catch` block; the resume closure catches exceptions and continues there or rejects.
- First version: `await` as a statement, in `const x = await e`, `x = await e` and `return await e`, and as the whole condition or iterable of a control statement. `await` nested inside other expressions, `finally` blocks that contain or enclose an `await`, `for await`, async generators and async arrow functions used as event handlers' return values (handlers ignore results) follow; until then they are rejected with a diagnostic.

React closures follow the snapshot rule: a continuation is created by the handler or effect it belongs to and reads that render's snapshot (case `await-in-handler`). Svelte `tick()` and Vue `nextTick()` become promises resolved by the framework's flush (`tick`: after the flush, two microtask hops; `nextTick`: chained on the pending flush), per [M4-ORDERING §3–4](M4-ORDERING.md).

## Host services: localStorage

`localStorage.getItem/setItem/removeItem/clear` with string values, items in insertion order. `key()` and `length` are rejected for now (Chromium orders keys by its own map), as is the `storage` event (other windows).

- **Native apps** keep the items of an app in `$XDG_DATA_HOME/runic/<title>/localStorage.json` (`~/.local/share` by default; the title with other characters than letters, digits, `-` and `_` replaced), written after every change as UTF-16 code units so any string survives.
- **Probes and the interpreter** keep them in memory, seeded by the case (`"storage": { key: value }`); the browser harness seeds through `page.addInitScript` once per tab. `measure.mjs` runs apps with a fresh data directory.
- **`reload`** starts the app again on the same storage: the browser reloads the page, the probe and the interpreter create a new app instance. Timers and the clock start again natively, while Chromium's `Date.now()` continues; cases with `reload` must not depend on time.

## Updates are flushed in a microtask

Today a handler runs and the tree updates right after it. In all three frameworks the update instead runs in a microtask queued by the first state write ([ordering §1](M4-ORDERING.md#1-when-does-each-framework-flush)), so microtasks queued before that write run before the update and those queued after it run after. M4 makes the flush a scheduled job:

- The first cell write after a flush queues one **flush job**. A flush applies pending writes, runs pre effects, updates the tree, runs the remaining effects and repeats while effects made new writes (a loop guard throws after 1000 passes, Svelte's limit; React's 50 and Vue's development-only 100 are recorded as deviations).
- Where the job is queued is a program policy (`schedule.flush`), named for behaviour rather than frameworks:
  - `microtask` (Vue, Svelte): always a microtask.
  - `event-microtask` (React): a microtask while an input event task (and its microtask checkpoint) runs; otherwise a **default task**, a macrotask that runs after the current microtasks. Its order against timers is unspecified, and conformance never asserts it.
- Dirtiness is computed per flush instead of per handler: the state of every live instance is recorded after a flush and compared at the next one.

The initial mount is the first flush. Its post effects run synchronously (`schedule.mountEffects: "sync"`, Vue) or in a microtask after the mount (`"microtask"`, Svelte; React mounts in a default task). Mount is observable only through microtasks a component script queues, so the first cases do not depend on it.

## React render snapshots

React reads state through the render's closure: a handler sees the state of the last commit, and closures created in it (a `setTimeout` callback, an `await` continuation, an effect) keep the state of *their* render even after later commits ([ordering §2](M4-ORDERING.md#2-react-19), "Values observed"). M2's snapshot is "the committed state outside handlers", which is the same for handlers but wrong for such closures once time passes.

- An instance's snapshot becomes an immutable value replaced at each commit (`Rc<Snap{k}>`), not a struct updated in place.
- `snapshot` reads in a handler body read the instance's current snapshot. A closure or effect function created while a snapshot is current captures it, and its `snapshot` reads use the captured one.
- Derived render values (component-body constants) are functions of the snapshot, so they follow the same rule.

This is the reference interpreter's definition too, so the differential test covers it, and the `stale-closure-timer` and `await-in-handler` cases check it against React.

## Effects

An effect is a component function that runs after (or before) an update when its dependencies changed, and may return a cleanup function. Components gain:

```jsonc
"effects": [ {
  "run": 12,                 // component function: () -> void | () -> fn() -> void
  "phase": "pre" | "layout" | "post",
  "deps": "tracked" | "once" | "always" | { "values": [Expr], "initial": true },
  "unmount": { "removal": "before" | "after", "order": "pre" | "post" }
} ]
```

- **`phase`** places the effect in a flush:
  - `pre` effects run in tree order (parent first), each right before its instance's template updates. Vue `watch`/`watchEffect`, Svelte `$effect.pre`.
  - `layout` effects run after the DOM is updated, children first. React `useLayoutEffect`.
  - `post` effects run after all layout effects, children first, in declaration order within an instance. React `useEffect`, Vue `onMounted`, Svelte `$effect`/`onMount`.
- **`deps`**:
  - `tracked`: the cells and heap slots the last run read (see the reactivity model).
  - `once`: runs at mount only.
  - `always`: runs after every update of its instance (React effects without a dependency array).
  - `values`: runs when an expression's value changed by `Object.is` (React dependency arrays, Vue `watch` sources). `initial: false` skips the mount run (Vue `watch` without `immediate`). Callbacks that receive the new and old values get them as parameters.
- **Cleanup** is the function the previous run returned. Whether cleanups interleave with re-runs is a program policy, `schedule.cleanups`:
  - `interleaved` (Vue, Svelte): each cleanup runs right before its own effect re-runs.
  - `batched` (React): all cleanups of a phase run first, children first, then all effects.
- **`unmount`** says when an effect's cleanup runs as its instance is destroyed:
  - `removal`: before or after the DOM is removed.
  - `order`: in the pre-order or post-order position of a walk of the destroyed instances.

| | phase | deps | unmount |
|---|---|---|---|
| React `useLayoutEffect` | layout | values, or always | before, pre |
| React `useEffect` | post | values, or always | after, pre |
| Vue `watchEffect`, `watch` | pre | tracked; values with `initial` from `immediate` | before, pre |
| Vue `onMounted` / `onBeforeUnmount` / `onUnmounted` | post | once | before, pre / after, post |
| Svelte `$effect.pre` | pre | tracked | after, pre |
| Svelte `$effect`, `onMount`, `onDestroy` | post | tracked / once | after, post |

`onDestroy(f)`, `onBeforeUnmount(f)` and `onUnmounted(f)` lower to a `once` effect whose run returns `f`.

**Not in the first pass** (rejected with diagnostics): Vue `flush: 'post'` and `flush: 'sync'` watchers and `onUpdated`/`onBeforeUpdate` (their insertion-order and inline semantics differ from the phases above), `deep` watchers of objects, `watch` of reactive objects, `useInsertionEffect`, Svelte `$effect.root`/`$effect.tracking`/`$inspect`, and effects that read the DOM (element reads are M5). Writes to state from an effect are supported; the next pass of the same flush handles them, with each framework's position rules ([ordering §2–4](M4-ORDERING.md)). React's `useEffect` writes re-render in a default task.

## Reactivity model

Effects observe dirtiness, so the M3 approximations have to go first:

- **Dependency tracking at run time.** Svelte effects and deriveds, Vue `watchEffect` and `computed` track the signals they actually read in their last run. Native code records cell reads while an effect or derived runs (a tracking frame in the context) instead of using the static read set, which is a superset.
- **Derived slots.** Deriveds and React render constants are stored per instance and recomputed when a dependency changed (Svelte, Vue) or once per render (React), so their identity is stable within an update and they run once per update instead of once per read.
- **Update granularity.** Template bindings refresh with each framework's grouping: a Svelte block's template effect, a Vue component render, a React component render that also re-renders children. Values read without reactivity then refresh as in the framework.
- **Precise deep tracking.** Mutations mark the cells whose proxies (Svelte) or reactive objects (Vue) were mutated, instead of every deep cell.

## Work order

1. Scheduler, virtual clock, timers, `wait` in all three harness sides (done for Svelte).
2. Microtasks and the flush job; React render snapshots.
3. Reactivity model (tracking frames, derived slots, granularity).
4. Effects per framework, against the [M4-ORDERING](M4-ORDERING.md#7-proposed-m4-conformance-cases) cases; 7GUIs Timer in all three frameworks.
5. Promises and the async lowering, with the ordering cases that interleave chains.
6. `localStorage`; TodoMVC with persistence in all three frameworks.

Effects come before promises because the Timer and persistence examples need them, while promises matter first for the application bridge (M7).
