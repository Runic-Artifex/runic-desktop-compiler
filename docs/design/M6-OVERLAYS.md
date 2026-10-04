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
