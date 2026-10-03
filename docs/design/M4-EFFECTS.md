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

**Values.** `Promise<T>` is an IR type. A promise is pending, fulfilled with a `T` or rejected with an exception value; reactions run as microtasks in registration order. Built-ins: `Promise.resolve`, `Promise.reject`, `new Promise(executor)`, `then`/`catch`/`finally`, `Promise.all`/`allSettled`/`race`/`any`, `queueMicrotask`.

**Async functions** are lowered by the shared language layer, not by the backend. An `async` function becomes an ordinary IR function returning a `Promise<T>`; each `await` splits the body into continuation closures registered with `then`, as Regenerator does:

- locals live across an `await` are boxed (the existing closure machinery);
- `try`/`catch`/`finally` around an `await` becomes rejection and settlement handlers;
- a loop containing `await` becomes a recursive continuation;
- `return` resolves and `throw` rejects the function's promise.

This keeps the IR, the interpreter and codegen free of suspension: they only need promises, closures and the scheduler. The ordering is exactly JavaScript's as long as each `await` costs the same number of microtask ticks as in V8 (one for an awaited native promise, `await v` on a non-promise resolves through `Promise.resolve`). Conformance includes cases that interleave two async chains to pin this down.

React's closures over a render's state stay a question for the reactivity model below: a continuation created during an event handler reads state through the same read rules as the handler (React: the render snapshot of the render that created the handler).

## Host services: localStorage

`localStorage.getItem/setItem/removeItem/clear/key/length` with string values. Native apps persist to a per-app file in the platform data directory, written after each task that changed it; the probe and the interpreter use an in-memory store that a case can seed (`"storage": { … }`), as the browser harness does through `page.addInitScript`. The `storage` event (other windows) is out of scope.

## Effects

*To be completed from [M4-ORDERING](M4-ORDERING.md)*: the IR describes effects in framework-neutral terms (when they run relative to updates and paint, how dependencies are found, cleanup order), and the adapters map `$effect`/`$effect.pre`/`onMount`/`onDestroy`, `useEffect`/`useLayoutEffect`, and `watch`/`watchEffect`/`onMounted`/`onUnmounted` onto them.

## Reactivity model

Effects observe dirtiness, so the M3 approximations have to go first:

- **Dependency tracking at run time.** Svelte effects and deriveds, Vue `watchEffect` and `computed` track the signals they actually read in their last run. Native code records cell reads while an effect or derived runs (a tracking frame in the context) instead of using the static read set, which is a superset.
- **Derived slots.** Deriveds and React render constants are stored per instance and recomputed when a dependency changed (Svelte, Vue) or once per render (React), so their identity is stable within an update and they run once per update instead of once per read.
- **Update granularity.** Template bindings refresh with each framework's grouping: a Svelte block's template effect, a Vue component render, a React component render that also re-renders children. Values read without reactivity then refresh as in the framework.
- **Precise deep tracking.** Mutations mark the cells whose proxies (Svelte) or reactive objects (Vue) were mutated, instead of every deep cell.

## Work order

1. Scheduler, virtual clock, timers, `wait` in all three harness sides; 7GUIs Timer.
2. Promises and the async lowering, with ordering cases.
3. Reactivity model (tracking frames, derived slots, granularity).
4. Effects per framework, against the M4-ORDERING cases.
5. `localStorage`; TodoMVC with persistence in all three frameworks.
