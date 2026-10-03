# M4 design input: effect, flush and timer ordering

Status: research for [M4](../ROADMAP.md#m4-effects-time-and-async). Nothing here is implemented. It records the scheduling behaviour the M4 effect, time and async model must reproduce, per framework, as a browser shows it.

Versions: React/React DOM 19.3.0 (scheduler 0.28.0), Vue 3.5.43, Svelte 5.57.1 (runes, `experimental.async` off), Chromium 153.0.8010.12 headless from the dev shell. The probes ran the development builds that Vite serves, like the conformance harness. Production builds differ only in the loop guards noted below.

Evidence labels:
- **verified (Pn)**: observed in probe Pn ([Probes](#probes)).
- **from source**: read in the pinned package, cited as `package/path: function`. Vue ships bundles only, so `@vue/runtime-core/dist/runtime-core.esm-bundler.js` (rt-core) and `@vue/reactivity/dist/reactivity.esm-bundler.js` (reactivity) are cited by function name. React DOM is cited from `react-dom/cjs/react-dom-client.production.js` (rdc); the development build has the same structure.

## Probes

Each framework has one probe app (scratch, not committed: `/tmp/m4probe`). The tree is `App` → `Panel` (`{#if show}` / `v-if` / `show &&`) → `Child A`, `Child B` and a keyed list `L1`, `L2`. Every component logs setup or render, its effects and cleanups, and its own element's `textContent` or `isConnected` into a module-level array. The marker helper `tasks(tag)` schedules one `queueMicrotask`, one `setTimeout(0)`, one `MessageChannel` message and one `requestAnimationFrame`, each of which logs `tag`. A Playwright runner clicks with trusted input, waits 250 ms and two frames, then dumps the log.

| Probe | Action |
|---|---|
| P1 mount | Load the page. `main` logs before and after mounting and calls `tasks('module')` first. |
| P2 inc | Handler: queues a microtask (and Vue `nextTick`/Svelte `tick`) before the first write, writes `count` twice, reads it back, queues the same callbacks again after the write, then `tasks('h')`. |
| P3 chain | Handler writes `a`; an effect writes `b = a*10` and calls `tasks('in-effect')`; another effect logs `b` and the DOM text of `b`. This uses React `useEffect`, a Vue pre watcher and a Svelte `$effect`. |
| P4 lchain/pchain | The same with React `useLayoutEffect`, a Vue `flush:'post'` watcher and a Svelte `$effect.pre`. |
| P5 await | Handler writes `x`, `await`s (`null`, `nextTick()`, `tick()`), then writes `y`. React also logs `window.event` after the `await`. |
| P6 timer | Handler sets a `setTimeout(0)` whose callback writes `x`, queues a microtask that reads the DOM, then calls `tasks('t')`. |
| P7 toggle ×2 | Unmounts `Panel`, then mounts it again. |
| P8 Svelte order | Adds an `$effect` that reads `b` and is declared *before* the effect that writes `b`. |

"Before paint" is judged by the next `requestAnimationFrame` callback. The rendering update runs rAF callbacks before style, layout and paint, so work logged before the first rAF of a frame happens before that frame's paint.

## 1. When does each framework flush?

| | React 19 | Vue 3.5 | Svelte 5 |
|---|---|---|---|
| Scheduling trigger | The first `setState` calls `ensureRootIsScheduled` → `scheduleImmediateRootScheduleTask` → one `queueMicrotask` (rdc). That microtask renders synchronously only for sync lanes; other lanes become a Scheduler task. | The first write calls `queueJob` → `queueFlush` → `resolvedPromise.then(flushJobs)` (rt-core). | The first write calls `Batch.ensure()` → `queue_micro_task` → one `queueMicrotask` (`svelte/src/internal/client/reactivity/batch.js`, `dom/task.js`). |
| Discrete events (click, keydown) | `resolveUpdatePriority` reads `window.event` and picks SyncLane. Render, commit, layout and passive effects all run in that microtask, before paint. Verified (P2). | Microtask flush. Verified (P2). | Microtask flush. Verified (P2). |
| Timer, network and other non-event code | DefaultLane: render runs in a Scheduler task posted through `MessageChannel` after the current microtasks. Verified (P6): a microtask queued after the write still sees the old DOM. | Microtask flush, the same as for events. Verified (P6): a microtask queued after the write sees the new DOM. | Microtask flush. Verified (P6). |
| Microtask queued in the handler *before* the first write | Runs before the flush. Verified (P2). | Runs before the flush. Verified (P2). | Runs before the flush. Verified (P2). |
| Microtask queued *after* the first write | Runs after the flush. Verified (P2). | Runs after the flush. Verified (P2). | Runs after the flush. Verified (P2). |
| Batching of several writes in one handler | One render. Updaters apply in order. Verified (P2: two `setCount(c=>c+1)` give one render with 2). | One flush; each component renders once. Verified (P2). | One batch; each effect runs once. Verified (P2). |
| Value read back in the handler after a write | The render's closure value (old). Verified (P2: `count=0`). | The new value. Verified (P2). | The new value. Verified (P2). |
| Derived value read in the handler after a write | n/a: render constants are recomputed on the next render. | `computed` is recomputed lazily on that read, once; render reuses the cache. Verified (P2). | `$derived` is recomputed lazily on that read, once; the template reuses it. Verified (P2). |
| Initial mount | `root.render()` uses DefaultLane: render, commit and layout run in a later Scheduler task, after the module's microtask, timeout and message. Passive effects follow later (see §2). Verified (P1). | `app.mount()` is fully synchronous: setup, render, `onMounted`, all before `mount()` returns. Verified (P1). | `mount()` synchronously runs scripts, `$effect.pre` and templates. `$effect`/`onMount` run in a microtask after microtasks queued earlier, before rAF. Verified (P1). |

## 2. React 19

**Discrete update, all in React's microtask** (verified P2). The source is `commitRoot`, `flushMutationEffects`, `flushLayoutEffects` and `flushSpawnedWork` in rdc; `flushSpawnedWork` ends with `0 !== (pendingEffectsLanes & 3) && flushPendingEffects()`.

| Step | Order |
|---|---|
| 1 Handler | Runs with closure values. Updates are queued and the DOM is unchanged. |
| 2 Render | Parent before children, siblings and list items in order (App, Panel, A, B, L1, L2). |
| 3 Mutation | DOM writes. **Layout cleanups of updated components** run here, children first (A, B, L1, L2, Panel), before any layout effect. |
| 4 Layout effects | Children first (A … L2, Panel, App). They see the new DOM. |
| 5 Passive cleanups, then passive effects | *All* cleanups (children first), then *all* effects (children first). They are not interleaved per component. Both see the new DOM. |
| 6 | The remaining microtasks, then rAF and timers. |

**Mount** (verified P1, P7): render parent-first, layout effects children-first, then passive effects children-first.

**Unmount** (verified P7; source `commitDeletionEffectsOnFiber`, `commitPassiveUnmountEffectsInsideOfDeletedTree_begin`):
- Layout cleanups run **parent first** (Panel, A, B, L1, L2) while the DOM is still connected.
- The DOM is removed.
- Passive cleanups run **parent first** with the DOM disconnected.
- After a click, all of this happens in the same microtask.

**Values observed:** effects and cleanups close over their own render. On re-run, the cleanup logged `count=0` and the new effect `count=2`. A `setTimeout` created in the handler logs `count=0` (verified P2).

**Effects that write state:**
- `useLayoutEffect` → `setState` gets SyncLane. React re-renders and commits synchronously inside the current commit (`flushSyncWorkAcrossRoots_impl` in `flushSpawnedWork`), before any microtask (verified P4).
- `useEffect` → `setState`: `flushPassiveEffects` sets update priority to at least Default (`ReactDOMSharedInternals.p = 32 > renderPriority ? 32 : renderPriority`), so the re-render runs in a later Scheduler task (from source).
  - In P3 the re-render came after the effect's microtask, after a rAF (so after a paint) and after the earlier timeout and message markers.
  - The effects of that commit ran in yet another task. The Scheduler yields after a commit because `requestPaint` sets `needsPaint`; see `scheduler/cjs/scheduler.production.js: shouldYieldToHost`. Verified (P3).
- Loop guards (from source):
  - More than 50 nested sync updates throw error 185 (`getRootForUpdatedFiber`).
  - Passive update loops only log a development console error after 50 (`NESTED_PASSIVE_UPDATE_LIMIT`).

**Async:**
- An `await` continuation inside a click handler runs during the click's microtask checkpoint, where `window.event` is still `click`. Updates after the `await` are therefore still SyncLane and render in a microtask queued at that `setState`. Verified (P5: `window.event=click`; the `y` render precedes the `after-setY` microtask).
- Updates before and after an `await` are **separate renders**, the first one before the continuation (verified P5).
- After a real task boundary (a timer or I/O), updates are DefaultLane:
  - Render and layout run in a Scheduler task after the current microtasks. In P6 this was also after the timeout and message markers queued by the same callback, and before the next rAF; neither is guaranteed.
  - Passive effects follow in that or a later task (verified P6).

## 3. Vue 3.5

**Update flush** (verified P2). The queue is sorted by instance uid, so parents come before children, and a pre job (flag 2) comes before the same component's render job (rt-core `queueJob`, `findInsertionIndex`, `flushJobs`, `flushPreFlushCbs`, `flushPostFlushCbs`).

| Step | Order |
|---|---|
| 1 Handler | `flush:'sync'` watchers run inline on **every** write (P2: twice, with v=1 then v=2), before the DOM changes. Reads return new values. |
| 2 | Microtasks and `nextTick` callbacks registered before the first write run first. |
| 3 Pre phase plus render, depth-first | App pre watchers and `watchEffect` in creation order → App render → patching a child updates its props, which runs that child's pre watchers (`updateComponentPreRender` → `flushPreFlushCbs(instance)`) → child `onBeforeUpdate` → child render, recursively. Pre watchers see the **old** DOM. |
| 4 Post phase | Post callbacks run in **insertion order**. `flush:'post'` watchers are queued when triggered, `updated` hooks after each component's patch. Observed: post-watch App, post-watch A, updated A, post-watch B, updated B, …, updated Panel, updated App. All see the new DOM. |
| 5 | Other microtasks. `nextTick` registered *after* the write chains on the flush promise, so it runs after the flush **and** after microtasks queued during the handler (P2: `h:micro` before `nextTick-after-set`). |

**Watcher cleanups** (`onWatcherCleanup`) run immediately before the same watcher's next run, interleaved per watcher. A `watch` callback re-runs (and cleans up) only if the source value changed (`hasChanged`) (reactivity `watch` job; verified P2).

**Mount** (verified P1, P7):
- Inside `mount()`, depth-first: setup → `watchEffect` first run (synchronous, no DOM yet) → render, per component, parent first.
- `onMounted` runs children first (A, B, L1, L2, Panel, App) in the synchronous post flush.

**Unmount** (verified P7; rt-core `unmountComponent`): `onBeforeUnmount` (parent) → `scope.stop()` (parent watcher cleanups) → per child, depth-first: `onBeforeUnmount`, then its watcher cleanups.
- All of these see the DOM connected.
- The DOM is removed next.
- `onUnmounted` then runs **children first** in the post flush, with the DOM disconnected.
- Quirk (verified, with `onRenderTriggered`): a watcher cleanup run by `scope.stop()` is not tracking-paused (reactivity `watch`: `effect.onStop`). A reactive read there is tracked by the render effect that is patching at that moment (in P7, App, which owns the `v-if`), so that component can render a second time in the same flush.

**Effects that write state:**
- Pre watcher → write: the written state's watchers run in the same flush before the render. There is one render (verified P3).
- Post watcher → write: `flushJobs` loops after the post phase, so the second render happens in the same microtask, before any other microtask (verified P4).
- Loop guard: development only, 100 runs per job (`checkRecursiveUpdates`). Production has none (from source).

**Async:** each write after an `await` schedules its own microtask flush. `await nextTick()` resumes after the flush (verified P5).

## 4. Svelte 5 (runes, non-async mode)

**Update flush** (verified P2; `batch.js: Batch.#process`, `#traverse`, `flush_queued_effects`):

| Step | Order |
|---|---|
| 1 Handler | Writes are visible at once. `$derived` recomputes lazily on read. The DOM is unchanged. |
| 2 | Microtasks queued before the first write. |
| 3 Traversal: render effects run in tree order during the walk | App `$effect.pre` → Panel pre → A pre, A template → B … → L2 template → **App template**. A component's template effect is created after the static child components in its template, so it comes after them. Each `$effect.pre` runs its own cleanup immediately before re-running. Pre effects see the **old** DOM of their component. |
| 4 User effects, in tree order | `$effect` and `onMount` (which is a `user_effect`) were created at the end of component init (`context.js: pop`), so they follow the component's children: A, B, L1, L2, Panel, App. Within a component the order is declaration order. Each cleanup runs immediately before its own re-run. They see the new DOM. |
| 5 | Other microtasks. `tick()` resolves after these (see Async). |

**Mount** (verified P1):
- During `mount()`: script, then `$effect.pre`, which runs synchronously at creation before the component's DOM exists, then template.
- These run parent first, interleaved depth-first.
- `$effect`/`onMount` run in the flush microtask, children first, declaration order within each component.

**Unmount** (verified P7; `effects.js: destroy_effect`): the DOM is removed **first**, then teardowns run. Each effect tears down its children before itself, so per component the order is:
- `$effect.pre` cleanups (declared before the template);
- child components, recursively;
- the component's own `$effect`/`onMount`/`onDestroy` cleanups, in declaration order.

Every teardown sees the DOM disconnected. All of this is synchronous in the flush microtask.

**Effects that write state:**
- A write inside `$effect` happens after the traversal, when `current_batch` is null. It creates a new batch that is processed **synchronously in the same microtask**: there is no new microtask while `is_processing` (`Batch.ensure`).
- Order dependence (verified P3, P8): the user-effect list for the current pass is collected before effects run, and each effect is checked for dirtiness when its turn comes.
  - An effect *later* in the list that depends on the written state runs in the **current** pass, before the DOM reflects the write (`effect b=10 dom=0`).
  - An effect *earlier* in the list runs in the next pass, after the template update (`early effect b=10 dom=10`).
- A write inside `$effect.pre` happens during traversal: template effects later in the tree update in the same walk, and `$effect`s see the new DOM (verified P4).
- Loop guard: 1000 iterations of the process loop throw `effect_update_depth_exceeded` (`batch.js: infinite_loop_guard`).

**Async:**
- `tick()` is `await Promise.resolve(); flushSync()` (`runtime.js: tick`, non-async mode). It always settles at least two microtask hops later, so even `tick()` called *before* a write resolves after the flush. Vue `nextTick` called before a write resolves before the flush (verified P2).
- `await tick()` resumes with the DOM updated (verified P5).
- `experimental.async` changes this model: render effects are deferred and `tick` races rAF against `setTimeout`. The adapters must reject it.

## 5. Cross-framework summary of what effects observe

| Effect kind | DOM when it runs | Values |
|---|---|---|
| React `useLayoutEffect` | new; on unmount cleanup, still connected | its render's closure |
| React `useEffect` | new; on unmount cleanup, disconnected | its render's closure; cleanup sees the previous render |
| Vue pre `watch`/`watchEffect` | old (before the component renders); none on the first setup run | live reactive values |
| Vue `flush:'post'` watch, `onUpdated`, `onMounted` | new | live |
| Vue `onBeforeUnmount` / `onUnmounted` | connected / disconnected | live |
| Svelte `$effect.pre` | old; none at mount | live |
| Svelte `$effect`, `onMount` | new, except for the same-pass write case in §4 | live |
| Svelte teardowns, `onDestroy` | disconnected | live; the cleanup closure sees the value captured at its run |

## 6. Timers and the native event loop

These requirements come from the HTML event loop as Chromium implements it; the ordering claims are verified by the marker helper.
- **Microtask checkpoint after every callback.** Every event listener, timer, rAF callback and message handler ends with a full microtask drain. All three frameworks flush inside such a drain: React for discrete updates, Vue and Svelte always.
- **Flush before the next frame.** In every click probe, all framework work (except React's default-lane work) finished before the first rAF. The native loop must run the flush before it builds the next frame. React's default-lane work may land after a paint, so conformance may only compare its final state.
- **Unspecified relative orders.** Conformance must not assert these:
  - `setTimeout(0)` against rAF: P2 had rAF first in all three frameworks, P1 had timeout first for Vue.
  - `setTimeout(0)` against `MessageChannel`: observed timeout first, but they are separate task sources.
  - The React Scheduler task against timers.
- **`setTimeout`/`setInterval`** follow HTML timer ordering: by deadline, then by scheduling order. Timers nested more than 5 deep are clamped to at least 4 ms. An interval keeps firing until cleared, so cleanup must clear it (from the HTML spec).
- **rAF** fires once per frame. Callbacks registered during a rAF callback run in the next frame.
- **React's internal tasks** need a native "default-priority task" queue: renders for non-event updates, passive effects after such commits, and re-renders from `useEffect` writes. It runs after the current microtasks; its order against timers is unspecified.

Harness implications:
- Order cases should log into a module-level array that a final "dump" click copies into state. Logging into reactive state would itself change scheduling.
- Cases that observe the DOM from effects need a minimal element read (`textContent`, `isConnected`), which is beyond the current opaque `element` type.
- Timer cases need a `wait` action, or deterministic virtual time in both runs.

## 7. Proposed M4 conformance cases

1. **effects-mount-order** (all): App → Panel → A, B and a keyed list of two items, each with every effect kind.
   - React: render parent-first, layout effects children-first, passive effects children-first.
   - Vue: setup, `watchEffect` and render depth-first parent-first; `onMounted` children-first, all before `mount()` returns.
   - Svelte: script and `$effect.pre` parent-first; `$effect`/`onMount` children-first, declaration order within a component.
2. **effects-update-batching** (all): one click writes `count` twice. Each effect runs once with the final value.
   - React runs all cleanups and then all effects, children first; each cleanup logs the previous value.
   - Vue and Svelte interleave each cleanup directly before its own re-run.
   - Vue `flush:'sync'` logs twice, once per write.
3. **effects-unmount-order** (all): toggling hides `Panel`.
   - React: layout cleanups parent-first, then passive cleanups parent-first.
   - Vue: `onBeforeUnmount` and watcher cleanups depth-first pre-order, then `onUnmounted` children-first.
   - Svelte: Panel `$effect.pre` cleanup; each child's pre, effect, `onMount` and `onDestroy` cleanups; then Panel's effect and `onDestroy` cleanups.
   - A second toggle remounts with fresh state and repeats the mount order.
4. **effects-dom-visibility** (all; needs element reads): each effect records its element's text and connection.
   - React layout and passive effects see new text. On unmount, layout cleanups see the DOM connected and passive cleanups disconnected.
   - Vue pre watchers see old text and post watchers new. `onBeforeUnmount` sees the DOM connected, `onUnmounted` disconnected.
   - Svelte `$effect.pre` sees old text and `$effect` new; teardowns see the DOM disconnected.
5. **microtask-vs-flush** (all): the handler queues a microtask before and after its first write. Each records a module-level counter of effect runs. Expected: the earlier microtask sees 0 and the later one 1 in all frameworks.
6. **nexttick-tick** (Vue, Svelte): `nextTick`/`tick` before and after the write, with `queueMicrotask` markers.
   - Vue: before-`nextTick` runs before the flush; after-`nextTick` runs after the flush and after a microtask queued later in the handler.
   - Svelte: both `tick()` callbacks run after the flush and after the handler's later microtasks.
7. **effect-writes-state** (all): an effect derives `b` from `a` after a click.
   - Vue and Svelte: `b`'s effects and render finish in the same microtask, with one Vue render.
   - React `useEffect`: a microtask queued inside the effect sees the old `b`; `b` renders later. Assert only the final state and that `b`'s effect runs exactly once.
8. **layout-effect-writes-state** (React): `setState` in `useLayoutEffect` re-renders and runs the follow-up layout effect before a microtask queued in the handler.
9. **post-watcher-writes-state** (Vue): a `flush:'post'` watcher writes state. The second render and its `onUpdated` complete before the handler's microtask.
10. **svelte-effect-declaration-order** (Svelte; needs element reads): an `$effect` declared after the writer sees the stale DOM; one declared before it sees the updated DOM. Both run before the handler's microtask.
11. **await-in-handler** (all): write `x`, `await`, write `y`.
    - In every framework `x` is flushed before the continuation runs, and `y` is flushed before a microtask queued after it.
    - React renders twice; its closure still reads the old `x` after the `await`.
12. **timer-update** (all): a `setTimeout(0)` callback writes state and then queues a microtask.
    - Vue and Svelte: the microtask sees the effect counter incremented.
    - React: it does not, because the render runs in a later task.
    - All three are flushed by the second following animation frame.
13. **stale-closure-timer** (React): a click starts `setTimeout` reading `count`, then increments. The timeout logs the old value; a functional update in the timeout uses the latest value.
14. **interval-lifecycle** (all; 7GUIs Timer shape): an effect starts `setInterval` and its cleanup clears it.
    - After `wait` the tick count is positive.
    - Changing the dependency restarts the interval once.
    - After unmount no further ticks are logged.
15. **derived-timing** (all): a `computed`/`$derived` with a counting getter.
    - Reading it in the handler after a write recomputes it once, and the render does not recompute it.
    - A derived nobody reads is never evaluated.
    - A React render constant is evaluated once per render of its component.
16. **list-item-effects** (all; record before relying on it): keyed list reorder, insert and remove.
    - Expected: moved items do not re-run effects, new items mount in list order, and removed items clean up in list order.
    - This is not yet probed; record it in the browser first.
17. **effect-self-loop** (expected rejection or runtime error): an effect that unconditionally writes its own dependency.
    - React throws error 185 after 50 sync updates.
    - Svelte throws `effect_update_depth_exceeded`.
    - Vue only warns in development.
    - The compiler should reject it with a source-located diagnostic, or report the framework's error, never loop.
