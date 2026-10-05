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
- **Presence** needs `element.getAnimations()` for real: the running CSS animations and transitions of an element, with `finished` settling at their end on the runtime's timeline. This needs a fork accessor for Blitz's animation set. Until then, the current empty-only implementation stays, and running animations are reported unsupported.
- **`esm-env`** is a pack: `BROWSER` true, `DEV` false.

## Order

1. Imperative mounts (portals) and `document.body`.
2. `ResizeObserver`, the floating-ui platform pack, and `@floating-ui/core` from source. Tooltip and Popover are the first cases.
3. `tabbable` and `MutationObserver`, the focus scope, dismissal and scroll lock. Dialog and DropdownMenu are the cases.
4. `getAnimations` with the fork accessor, for presence with tw-animate-css's exit animations.

Each component gets a case against Chromium from its shadcn-svelte demo, with keyboard interaction.

## Status (2026-10-05, branch `m6-overlays`)

**Step 1: imperative mounts. Done** (case `portal`, differential `portal-svelte`; [IR](../IR.md#components-and-instances)).
- The IR has *mount sites*: a component lists the components its functions mount, with the slot content it provides. A `mount` expression in one of its functions creates an instance of a site's component with props evaluated once and contexts from a `context.all` value (`getAllContexts`). Snippets passed in are slot content of the mounting component, so they keep its scope. New types: `mounted` and `contexts`; new built-ins: `mounted.unmount`, `context.all` and `document.body`.
- Refinements of the decision above:
  - The target must be the body. Another element is reported unsupported at run time, because its owner's updates would interleave with the mounted content.
  - As in Svelte, a mounted instance lives until it is unmounted, not until its creating effect ends. bits-ui unmounts in the effect's cleanup.
  - The content comes before an anchor of its own as the body's last child, updates after the root in every flush pass, and runs its post effects in the pass after its mount.
- The Svelte adapter lowers `mount`, `unmount` and `getAllContexts`, and lowers top-level calls of a component script (runed's `watch`) as creation-time cells.
- `document.querySelector` covers only the literal selectors `body` and `#id`.
- Conditions known at build time are folded, so esm-env's `DEV` checks are not lowered. esm-env 1.2.2 is a pack.
- **bits-ui's own `Portal` does not compile.** It resolves its target through `resolvePortalToProp`, whose type is a box of `PortalTarget = Element | string`. That union is outside the value model: `E_TYPE_UNSUPPORTED` at `bits/utilities/config/prop-resolvers.js:37`. Every overlay reaches this first.
  - The `portal` case verifies the same code with the target fixed to the body.
  - Unblocking it needs a value-model decision. Options: a typed union of `element | string` (discriminated by `typeof`, as class references are by class), or a union prop typed by the values that reach it (no site passes `to`, and no `BitsConfig` sets a default).

**Step 2. Partly done.**
- **`ResizeObserver`: done** (case `resize-observer`).
  - Chromium's behaviour, measured: every new observation is reported, 0×0 included. Callbacks run after animation frame callbacks, each followed by a microtask checkpoint. The device-pixel content box is snapped at the box's position (100.5px at x=7 is 101).
  - Delivery is round by round, deepest targets first, with a layout between rounds. The loop error is written to stderr.
  - The probe now runs two frames before its first snapshot, as the browser harness does.
- **`@floating-ui/core` does not compile from source.** Its declarations use types outside the value model:
  - `ReferenceElement`, `FloatingElement`, `getOffsetParent` and `isElement` are typed `any`;
  - platform methods and middleware return `Promisable<T>` (`T | Promise<T>`);
  - middleware options are `Derivable<T>` (`T | (state) => T`);
  - `MiddlewareData` has an `any` index signature.

  Its code also uses `await` nested in expressions, computed keys (`{ [axis]: … }`), string-indexed reads (`rects.reference[length]`) and spreads into a dictionary of records of different types (`middlewareData[name] = { ...middlewareData[name], ...data }`).
  - Proposal: give `@floating-ui/core` a pack too. Its positioning math (computePosition, offset, flip, shift with limitShift, size, arrow, hide) would be native in `runic-js`, validated by vectors against the real package in Node with fixed rectangles.
  - That is a change of the decision above, so it is left to the main session.
- **`@floating-ui/dom` platform and `autoUpdate` packs: not started.** They need the core first.
  - `autoUpdate`'s default `layoutShift: true` uses `IntersectionObserver`.
  - `ancestorScroll` needs scroll listeners on overflow ancestors. Script-added element listeners cover only `beforematch` today.
- **Versions.** The north star pins core 1.7.3, dom 1.7.4 and utils 0.2.10. This repository's lockfile resolves 1.8.0, 1.8.0 and 0.2.12 through bits-ui's `^1.7.1`. Pin the north star's versions as devDependencies with the packs.

**Cases Tooltip and Popover: not reached.**
- The shadcn-svelte Tooltip's arrow has the class `fill-foreground`. Its CSS `fill` is rejected (`E_CSS_PROPERTY`: Blitz draws inline SVG from attributes).
- Behind that comes the Portal union above, then the floating layer (`@floating-ui/dom` has no pack).
- Both contents also render `PopperLayerInner`, which always instantiates step 3's layers (`ScrollLock`, `FocusScope`, `EscapeLayer`, `DismissibleLayer`, `TextSelectionLayer`). Their sources use, among others:
  - module statements (`globalThis.bitsEscapeLayers ??= new Map()`);
  - `new KeyboardEvent(e.type, e)`;
  - a `Proxy` (`createWrappedEvent`);
  - `instanceof PointerEvent`;
  - `for…in`;
  - `SvelteMap` and module-level `$state` (`body-scroll-lock`);
  - tabbable;
  - MutationObserver's `childList`.
- tw-animate-css's presence animations were therefore not reached.
