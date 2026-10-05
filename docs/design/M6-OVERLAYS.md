# M6 step 7: the overlay host layer

What bits-ui's overlays need (Dialog, AlertDialog, Popover, Tooltip, DropdownMenu, Select, Sheet, HoverCard, ContextMenu): its utilities `portal`, `floating-layer`, `focus-scope`, `dismissible-layer`, `escape-layer`, `scroll-lock`, `presence-layer` and `text-selection-layer`, over `@floating-ui/dom`, `tabbable` and a handful of DOM APIs. bits-ui itself keeps compiling from source; these decisions cover what sits under it.

## Decisions

- **Portals are imperative mounts.** bits-ui's `Portal` calls Svelte's `mount(PortalConsumer, { target, props: { children }, context: getAllContexts() })` and `unmount` from a `watch`.
  - The IR gets an *imperative instance*: a component known at compile time, mounted under an element value (`document.body`, or a `querySelector` result with a constant selector), with the given props and a context map.
  - Its lifecycle belongs to the effect that created it. Snippets passed in keep their owner's scope, as in Svelte.
  - `getAllContexts` returns the caller's context map.
  - `document.body` and constant-selector `querySelector` become element built-ins.
- **floating-ui.**
  - `@floating-ui/core` is pure positioning math and compiles from source: `computePosition` and the middleware bits-ui uses (`offset`, `flip`, `shift` with `limitShift`, `size`, `arrow`, `hide`).
  - `@floating-ui/dom`'s *platform* becomes a pack over native layout reads: element rects, clipping ancestors (overflow), offset parents, scroll offsets, viewport size, and the computed-style values it reads. It is validated against the real package on fixtures.
  - `autoUpdate` is a pack: scroll listeners on the overflow ancestors, window resize, and `ResizeObserver` on the reference and floating elements.
- **`ResizeObserver`** (carried from M5) is delivered in the rendering step after layout and before paint, as Chromium delivers it, with the content and border box sizes. **`IntersectionObserver`** follows the same frame model if a reached path needs it.
- **`tabbable`** is a pack over the runtime's own focusability and Tab order (M5), validated against the real package.
- **`MutationObserver`** covers the child-list and attribute observations the focus scope makes, delivered as microtasks after the DOM change, as in Chromium. Other options are rejected.
- **Focus scopes and dismissal** compile from bits-ui's source over these: document `focusin`/`pointerdown` listeners, the `Escape` layer stack, and `document.activeElement`.
- **Scroll lock** sets `overflow: hidden` on the body and compensates the scrollbar width. Chromium's scrollbar width in the conformance browser must be measured; Blitz's overlay scrollbars take no width. A difference is a recorded gap, not a silent offset.
- **Presence** needs `element.getAnimations()` for real: the running CSS animations and transitions of an element, with `finished` settling at their end on the runtime's timeline, through the fork's accessor for Blitz's animation set. Done in step 4 (below).
- **`esm-env`** is a pack: `BROWSER` true, `DEV` false.

## Order

1. Imperative mounts (portals) and `document.body`.
2. `ResizeObserver`, the floating-ui platform pack, and `@floating-ui/core` from source. Tooltip and Popover are the first cases.
3. `tabbable` and `MutationObserver`, the focus scope, dismissal and scroll lock. Dialog and DropdownMenu are the cases.
4. `getAnimations` with the fork accessor, for presence with tw-animate-css's exit animations.

Each component gets a case against Chromium from its shadcn-svelte demo, with keyboard interaction.

## Decisions after step 1 (2026-10-05)

- **Unions outside the value model** (bits-ui's `PortalTarget = Element | string`, Slider's `number | number[]`, ToggleGroup's and Accordion's `string | string[]`) are resolved without a general sum type in the IR, in two layers:
  - **Narrowing.** A union-typed value takes the member type of the values that reach it: a prop from its sites and its default, a box from its getter, a local from its initialiser and assignments, as discriminated props already do. Tests on the member (`typeof to === "string"`, `Array.isArray(v)`) then fold at build time. This covers Portal (no site passes `to`, so the default `"body"` decides).
  - **Specialisation.** Where different sites pass different members (a program with both a `single` and a `multiple` ToggleGroup, which every shadcn-svelte page family with both demos is), the component is compiled once per member combination that reaches it, with the classes it instantiates and the contexts it sets. Specialised components are ordinary IR components, so the backend does not change. A value whose member is only known while the program runs is still rejected (`E_TYPE_UNION`).
- **`@floating-ui/core` is a pack**, not compiled from source (its declarations and code are far outside the language subset, listed under step 2). The positioning math (`computePosition` and the middleware bits-ui uses: `offset`, `flip`, `shift` with `limitShift`, `size`, `arrow`, `hide`) is native in `runic-js`. It is validated by vectors computed with the real package in Node, with fixed rectangles. The `@floating-ui/dom` platform and `autoUpdate` stay packs over native layout reads as decided; `IntersectionObserver` joins `ResizeObserver`'s frame model for `autoUpdate`'s `layoutShift`. The packs pin the north star's versions (core 1.7.3, dom 1.7.4, utils 0.2.10).
- **CSS on SVG content** (the Tooltip arrow's `fill-foreground`, toggle-demo's icon fill) is a Blitz fork patch: serialise each SVG element's computed SVG properties for usvg ([gaps](../BLITZ-GAPS.md)). Landed (2026-10-05, fork `a7b87f6`, case `blitz-svg-css`): `fill`, `stroke` and their longhands are accepted; markers, geometry properties and paint servers stay rejected.

## Status (2026-10-05, branch `m6-overlays`)

**Step 1: imperative mounts. Done** (case `portal`, differential `portal-svelte`; [IR](../IR.md#components-and-instances)).
- The IR has *mount sites*: a component lists the components its functions mount, with the slot content it provides. A `mount` expression in one of its functions creates an instance of a site's component with props evaluated once and contexts from a `context.all` value (`getAllContexts`). Snippets passed in are slot content of the mounting component, so they keep its scope. New types: `mounted` and `contexts`; new built-ins: `mounted.unmount`, `context.all` and `document.body`.
- Refinements of the decision above:
  - The target must be the body. Another element is reported unsupported at run time, because its owner's updates would interleave with the mounted content.
  - As in Svelte, a mounted instance lives until it is unmounted, not until its creating effect ends. bits-ui unmounts in the effect's cleanup.
  - The content comes before an anchor of its own as the body's last child, updates after the root in every flush pass, and runs its post effects in the pass after its mount.
- The Svelte adapter lowers `mount`, `unmount` and `getAllContexts`, and lowers top-level calls of a component script (runed's `watch`) as creation-time cells.
- `document.querySelector` takes a selector of the supported subset (since `m6-overlays-2`, also computed when the program runs: bits-ui resolves its portal target in a derived value).
- Conditions known at build time are folded, so esm-env's `DEV` checks are not lowered. esm-env 1.2.2 is a pack.
- **bits-ui's own `Portal` compiles** since the union narrowing below (branch `m6-overlays-2`): the `portal` case renders `import { Portal } from 'bits-ui'` unchanged.

## Status (branch `m6-overlays-2`)

**Unions, layer 1 (narrowing): done** (`frontend/unions.ts`). A union's census finds the values reaching its slots (assignments, initialisers, arguments, returns, object literal properties, component props from their sites, boxes and getters), traced through constants, props, boxes and options; a union no value reaches takes its first member. Member tests fold at build time (`staticTruth`). Two members reaching a union is `E_TYPE_UNION`, naming a site of each; layer 2 (specialisation) is not started.

**Step 2: done for floating-ui** (case `floating`, both viewports, all gates).
- `@floating-ui/core` 1.7.3's positioning math is native (`runic_js::floating`): `computePosition` as a resumable computation (each `await` of the package a microtask) with offset, shift (limitShift), flip, size, arrow, hide and custom middleware; 401 vectors from the real package in Node (`crates/runic-js/tests/vectors/floating.mjs`).
- `@floating-ui/dom` 1.7.4's platform reads the native layout (`runic_runtime::floating`): Chromium's offset parents (measured: transforms, filters, `will-change`, `contain`, fixed elements), clipping ancestors with the per-call cache, scale, `isRTL`, the conversion to viewport coordinates, Chromium's serialisation of resolved lengths. 24 layouts and 52 offset-parent cases compared exactly with the real package in Chromium (runtime unit tests).
- `autoUpdate` is a port of 1.7.4's (`frontend/packs/floating-ui-dom-1.7.4/auto-update.ts`, compiled with the program): ancestor `scroll` listeners added by script, the window's and the visual viewport's `resize` (the visual viewport's after the window's, measured), ResizeObserver, IntersectionObserver for `layoutShift`, the animation-frame loop.
- **IntersectionObserver** joins ResizeObserver's frame model ([IR](../IR.md#template)): updated after the ResizeObserver deliveries, notified in a host task after the frame. Chromium notifies observers with a document root in the order of its observer set, not their creation order: the `floating` case runs one `layoutShift` observer at a time, and the difference is in the contract.
- Gaps found by the platform's comparison: fractional lengths (known), absolutely positioned content left out of scroll sizes, inline boxes ([gaps](../BLITZ-GAPS.md)). Positions computed before Chromium has loaded the web font differ (known gap "Web fonts while the app mounts"): the case's references have fixed sizes.

**Cases Tooltip and Popover: in progress.** The Popover fixture (`fixtures/bits-popover-svelte`, shadcn-svelte's popover-demo, vendored as the other bits-* fixtures) lowers through `useFloating`, the floating layer's state and content (`FloatingContentState`, with runed's `ElementSize` as a pack port) and stops in the scroll lock (`internal/body-scroll-lock.svelte.js`): bits-ui's `SharedState` is a generic class (`get(...args: Parameters<T>): ReturnType<T>`), which neither the declaration-file annotation of package modules nor the class lowering covers yet. Behind it come the focus scope (`tabbable`, MutationObserver's `childList`, `CustomEvent`), the escape, dismissible and text-selection layers (`globalThis.x ??= new Map()`, `new KeyboardEvent`, `instanceof PointerEvent`, a `Proxy`), presence (`getAnimations`) and, for Tooltip, `TimeoutFn` and the safe polygon. The Tooltip arrow's `fill-foreground` stays rejected until the SVG CSS fork patch lands.

**Step 4: `getAnimations` for presence. Done for the content animations** (branch `m6-presence`; [design](M6-LIBRARIES.md#animations), [contract](../CONTRACT.md)).
- Animation objects are an IR type with `finished`, `playState` and `pending`; the runtime matches Stylo's animations to them after every style resolution and settles `finished` with Chromium's timing (cancellations at the cancelling style resolution, finishes at the frame's animation step, before it renders).
- bits-ui's `PresenceManager` and `AnimationsComplete` run unchanged: cases `bits-accordion` and `bits-accordion-multiple` with the site's tw-animate-css content animations (their ease-out mid-animation frames included, with the Stylo fork's easing), and `bits-collapsible` with an animated collapsible (linear), opened, closed and reversed while running.
- Found on the way: Stylo cancels an animation without recascading its element, so bits-ui's measurement (`animation-name: none`, then `getBoundingClientRect`) read the animated height. The runtime restyled such elements again until the Stylo fork recascaded them itself; Stylo's easing epsilon is fixed there too ([fixed in the Stylo fork](../BLITZ-GAPS.md#fixed-in-the-stylo-fork)).
- The overlays' enter and exit (tw-animate-css `animate-in`/`animate-out`) wait for the overlays themselves (steps 2 and 3).
