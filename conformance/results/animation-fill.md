# animation-fill-mode: forwards and both (2026-10-14)

CSS compatibility slice 3a: the compiler's fill-mode guards (collect.mjs `unsupportedTimeBased`, also through `var()`; runic-css `inline.rs` for inline styles) and the runtime's `getAnimations()` report are lifted. No fork change: the pinned Stylo fork (`c7f58a4e`, from `715f4d98` *Retain filled animations and catch up iteration phase*) already keeps a finished CSS animation until it is cancelled, and cancels CSS animations on `display: none`.

Chromium 153.0.8010.12, CPU renderer.

## Chromium (measured on a scratch page, real time)

- A finished `forwards` or `both` animation stays in `element.getAnimations()`: the same object, `playState` `finished`, `pending` false. An unfilled one is no longer listed (`playState` `finished` on the held object).
- `finished` resolves at the same point with and without fill: in the update step of the first frame after the end (before that frame's animation frame callbacks). `both` with a 100 ms delay ends 100 ms later.
- After the end, an unrelated restyle keeps the fill and the listing; `animation-fill-mode: none` unlists it and drops the fill (`playState` stays `finished`); `display: none` or another `animation-name` cancels it (`playState` `idle`; its resolved `finished` promise is unchanged), and shown again the element starts a new animation from its first keyframe.
- Animation events are out of scope (they stay rejected, `E_EVENT`).

## Runtime change

`runic-runtime` `animations`: a CSS animation Stylo reports finished stays tracked (it used to end when Stylo dropped it at the next restyle, which the fork no longer does); its finish settles at the frame's animation step as before; `getAnimations()` lists it while the element's fill for it is `forwards` or `both`; `playState` reads `finished`; one the app first takes after its end has its promise resolved at once; a later cancellation is `idle`. The generated `anim_settle` keeps the object of such a retained animation, so later calls return the same object.

## Verification

- **Case `animation-fill`** (fixtures `animation-fill-svelte`, `-react`, `-vue`; 16 actions on virtual time; pixel regions per row): forwards after the end, through a hover and a class toggle; `both` with a 150 ms delay before the start, mid-way and after the end; `90ms 2 alternate forwards` (ends on the first keyframe); the fill through `var(--fill)`; an inline fill set to `none` after the end and back; a static inline `both`; `display: none` and shown again; another `animation-name`. Semantics, geometry and pixels pass at 800x600 and 420x600 for all three: whole-page MAE at most 0.184/255, region MAE at most 0.158/255 (`row-both`).
- **Case `animation-fill-api`** (fixture `animation-fill-api-svelte`, 23 actions, 8 `expectedText` checks): `getAnimations()`/`playState` of seven elements and of the held objects, object identity, the frame at which `finished` resolves (not at 1176 ms, at the 1184 ms frame after the 1180 ms end), a late `getAnimations()` after the end (its `.then` runs in the same task: `asked late`), fill `none` and back, `display: none`, a restart and a rename. Passes at both viewports; page MAE at most 0.33/255, region MAE at most 0.158/255.
- **Case `animations`** (unchanged, Svelte, React, Vue): passes, region MAE at most 0.498/255 as before.
- **bits-ui presence** (the runtime now keeps finished animations tracked): cases `bits-accordion`, `bits-accordion-multiple`, `bits-collapsible`, `bits-dialog`, `bits-dropdown-menu`, `bits-popover`, `bits-select`, `bits-sheet`, `bits-tooltip` pass all 18 runs (semantics, geometry, pixels).
- At `89dfe54` every fixture is rejected at build time (`E_CSS_PROPERTY`: their stylesheets fill forwards), and the runtime reported `getAnimations()` on any element whose fill was `forwards` or `both`.
- `npm test`: 509 pass. `node compiler/cargo.mjs test --offline --workspace`: 189 pass.
- Rendering reductions (`RUNIC_FORKS_DIR=… node conformance/css-animations.mjs`: `fill_forwards_survives_restyle`, `fill_both_before_and_after`, `cancellation_name_and_display_reset`, `late_frame_alternate_iterations`): 40 of 40 steps pass, pixel MAE 0.
- Differential (`node conformance/differential.mjs fixtures/animation-fill-{svelte,react,vue} fixtures/animation-fill-api-svelte`): the three rendering fixtures pass 20 traces x 25 actions each (1560 steps, 0 failures); `animation-fill-api-svelte` is incomplete, as every program reading `getAnimations()` (the interpreter has no style engine).

## Found on the way

React's and Vue's style objects write a shorthand through CSSOM; Chromium serializes `animation` with every longhand, Stylo without the initial ones, so the `style` attribute text differs (docs/gaps/PLATFORM.md). The React and Vue fixtures therefore set only `animation-fill-mode` inline.

## Still reported or rejected

Animation and transition events (`E_EVENT`), scroll-driven animations, `transition-behavior: allow-discrete`, animations of pseudo-elements in `getAnimations()`, other Animation members (`E_MEMBER`). Reported at run time: `animation.finished` read again after a cancellation (Chromium returns a new promise; the runtime keeps the settled one).
