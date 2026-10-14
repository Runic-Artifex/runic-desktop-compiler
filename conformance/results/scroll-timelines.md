# Scroll-driven animations (2026-10-14)

CSS compatibility slice 3b, part 2: `animation-timeline: scroll(self|nearest|root, block|inline|x|y)` with `animation-range` of lengths and percentages, as Chromium 153 runs them; the driving example is shadcn-svelte's `scroll-fade` utility as Tailwind CSS 4 compiles it.

Chromium 153.0.8010.12, CPU renderer. Forks (signed, not pushed): Stylo branch `scroll-timelines` (`69e86890`, `cabc1323`, `580f2760`, `63886038` on `animation-events` `fa4e9652`), Blitz branch `scroll-timelines` (`50a1d812`, `8572b83c` on `animation-events` `767545c0`).

## Chromium (measured on scratch pages)

30 scenarios (scroll offsets set from script, values read with `getComputedStyle`):

- **Progress** is (offset − start) / (end − start), the offset measured from the scroll origin and the range resolved against the maximum scroll offset: percentages of the maximum, lengths in pixels, `normal` 0% and 100%. Keyframe easing and fill apply as for time.
- **Time-based timing** becomes proportions of the range: the total is delay + iterations × duration (2 s with a 1 s delay: the first third is the delay); an `auto` duration divides the range among the iterations and ignores the delay.
- **The active interval** ends exclusively, except at the timeline's end (offset = maximum) when the range ends there.
- **Inactive timelines** (the scroller is not a scroll container, or does not overflow in the axis): no effect, whatever the fill. `overflow: hidden` is a scroll container.
- `scroll(nearest)` without an ancestor scroller is the root (the viewport); `inline`/`x` in a right-to-left scroller measure from the right-hand origin.
- `@supports (animation-timeline: scroll())` is true.
- Chromium fires `animationstart`, `animationiteration`, `animationend` and `animationcancel` for scroll-driven animations by rules of their own (elapsed times in converted units, a start and an end again when scrolled back before the range): not modelled, reported.

## Implementation

- **Stylo fork**: servo parses the `animation-range` shorthand and `animation-duration: auto` (serialised `0s`; Chromium prints `auto`); a style change updates every running animation of an element (servo stopped after the first, so later names were neither updated nor started: this changes time-based animations too); an animation records its timeline at its start and a scroll-driven one is computed statelessly from the timeline sample the embedder sets (`Animation::unsupported_timeline` for named and view timelines, named ranges, and timings that do not convert).
- **Blitz fork**: scroll-driven animations are out of ticks and animation events; each timeline is sampled from its scroller before style and after layout (up to four restyle and layout passes when a sample changed), so a scroll alone needs no second pass; `BaseDocument::scroll_driven_animations` lists them with what is unsupported and whether they are paused.
- **Compiler** (`compiler/collect.mjs` `unsupportedScrollDriven`, `runic_css::inline::unsupported_scroll_driven`): accepts `animation-timeline` entries of `auto` or `scroll()` with at most one scroller and one axis keyword, and range entries of `normal` or a length-percentage (`calc()`, `min()`, `max()`, `clamp()`, `var()`); rejects `view()`, named timelines, `none`, `var()` in `animation-timeline`, named ranges (also through a custom property the stylesheet sets), `scroll-timeline*`, `view-timeline*` and `timeline-scope`.
- **Runtime** (`runic_runtime::scroll_driven`): after each style resolution, reports once each what has no effect (the forks' reasons), paused scroll-driven animations, animation event listeners on the path of an element with one, and `element.getAnimations()` on such an element (its scroll-driven animations are no longer tracked with time semantics). Natively a wheel turn queues a scroll for the rendering step, which resolves and asks for a redraw; programmatic scrolling redraws after the handler.
- **Harness**: seeks only animations on the document timeline.

## Verification

- **Case `scroll-timeline`** (`scroll-timeline-svelte`, 14 actions: wheel turns over nine scrollers, `scrollTop`, a growing range, `scrollLeft` past the end, wheel turns to the end): semantics, geometry and pixels pass at 800x600 and 420x600 (2 of 2 runs; largest region MAE 0.32/255).
- **Case `scroll-fade`** (`scroll-fade-svelte`, the five shadcn-svelte examples, 13 wheel turns to the middle and the end): semantics, geometry and pixels pass at 800x1400 and 420x1700 (2 of 2 runs; largest region MAE 2.76/255, the horizontal scroller's mask edge at mount). The masks, gradients and `mask-composite: intersect` match.
- **Re-screen** (the Stylo fix changes multi-animation updates; no existing fixture lists more than one animation name on one element, only `scroll-fade-svelte` does): `animation-events`, `animation-fill`, `animation-fill-api`, `animations` (18 of 18 runs); `tailwind-animate`, `shimmer`, `bits-dialog`, `bits-collapsible`, `bits-accordion`, `floating`, `sticky` (14 of 14); `scroll-events`, `scroll-lane`, `scroll-timeline`, `scroll-fade` (12 of 12): 44 of 44 runs pass semantics, geometry and pixels.
- `npm test`: 520 pass. `node compiler/cargo.mjs test --offline --workspace`: 194 pass (193 before, plus the runtime's scroll-driven report test).
- **Differential** (`scroll-timeline-svelte`, `scroll-fade-svelte`): 0 failures; `scroll-timeline-svelte` incomplete (it writes `scrollTop`, which already marks it layout-dependent), `scroll-fade-svelte` compared 20 mount steps (no event handlers, so no generated actions; the interpreter compares the DOM, not animated styles). No change to `conformance/differential.mjs` was needed.

## Still reported or open

`view()` and named timelines, named ranges, `timeline-scope` (rejected); a named range through `var()`, infinite or zero iteration counts, zero durations and negative delays on a scroll timeline, play state and timeline changes after the start, paused scroll-driven animations, vertical writing-mode scrollers, events of scroll-driven animations and `getAnimations()` on their elements (reported); `animation-duration: auto` read back (`0s`). Right-to-left inline-block content in a scroller is laid out left to right by Parley (a retained "RTL atomic flow" gap: the `rtl` scroller of the case holds one block).
