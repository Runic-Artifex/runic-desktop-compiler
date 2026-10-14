# M6: libraries, CSS pipeline, SvelteKit

> **Status note (2026-10-07).** Statuses below date from when each section was written, and later work superseded several: filters and backdrop filters are drawn by the renderer forks; Stylo is forked and size container queries are supported; the Switch geometry gap and lucide icons under oklch were fixed in the Blitz fork; the Popover, Tooltip, DropdownMenu, Select and Command have cases; `$effect.root` is implemented. The current state is in [CONTRACT](../CONTRACT.md); what is open is in the [gap register](../GAPS.md).

**Exit** (roadmap): the shadcn-svelte site's component examples render from source, the corpus coverage report (including the three shadcn sources) is committed, and island counts are recorded as the baseline to reduce from. The north star changed on 2026-10-04 (roadmap decision log); the research below was done on the Translations Editor, whose stack (SvelteKit, Svelte 5, bits-ui, Tailwind 4, lucide, tailwind-variants) is the shadcn-svelte site's, so its findings carry over.

Research behind this plan:
- [M6-LIBRARIES](../research/M6-LIBRARIES.md): what the editor reaches in bits-ui, lucide, svelte-toolbelt, runed, floating-ui and the class utilities, and which features those sources use;
- [M6-CSS](../research/M6-CSS.md): the editor's Tailwind 4 output on Stylo and Blitz;
- [BLITZ-GAPS](../BLITZ-GAPS.md): the fork.

## Decisions

- **Animations and transitions move from M10 into M6**, as far as the editor needs them: transitions, the tw-animate-css `enter`/`exit` keyframes, `animate-spin` and `animate-pulse`.
  - Blitz already runs Stylo's animations from a clock. The runtime drives that clock from its event loop: real time natively, virtual time in probes.
  - Conformance compares settled states as now, and intermediate frames at chosen virtual times.
  - `element.getAnimations()`, which bits-ui awaits before it unmounts a closed overlay, reads Stylo's running animations.
  - Stripping time-based CSS would be an approximation, so it is not an option.
  
  Implemented as described in [Animations](#animations), except the animation events, which stay rejected; `getAnimations()` came with the overlays (M6 step 7).
- **No islands for the editor.** bits-ui, svelte-toolbelt and runed touch the DOM and compile natively. The editor's island baseline is zero. QuickJS islands (D7) are built for the corpus, opt-in.
- **Mapping packs** for the class utilities (`clsx`, `tailwind-merge`, `tailwind-variants`) and for `@lucide/svelte` icons:
  - The utilities' sources use typed arrays, `arguments`, `for-in` and mixed-type tables, which the IR does not model. Their call shapes in the editor are narrow.
  - Each pack is pinned to a package version and validated against the real package on generated vectors, as `RegExp` and `Intl` were.
  - `tailwind-variants` bundles its own merge. Whether it agrees with `tailwind-merge` is measured before one merge implementation serves both.
  - Lucide icons expand to the existing inline-SVG lowering. `role` joins the SVG attribute allow-list (ARIA, no rendering effect).
- **The Blitz fork carries the CSS fixes the editor needs.** Patches needing Stylo changes (`field-sizing`, `line-clamp`, `text-wrap: balance`, container queries) are rejected with diagnostics in M6 rather than forking Stylo.

## Mapping packs (D9)

A pack covers one package at one version. It is how the compiler handles a library it does not compile from source.

- **Identity.** A bare import resolves, through the collector, to a package directory. Its `package.json` name and exact version select the pack: `clsx@2.1.1`. A different version fails with `E_PACK_VERSION`; there is no range matching. A package without a pack is compiled from source (step 3), or rejected until then.
- **Registry.** `frontend/packs/` holds one module per pack. Each declares:
  - its package and version;
  - its exports;
  - for each export, how calls lower. Shapes a pack does not cover are rejected with a located `E_PACK` diagnostic, as for any other unsupported code.
- **Lowering.** One of three, per call shape:
  1. **IR expressions.** The call becomes ordinary IR. Example: `clsx` with literal and conditional arguments becomes string concatenation.
  2. **Build-time evaluation.** When every argument is a compile-time constant, the frontend calls the real package in Node and inlines the result. This is exact by construction and deterministic, since the package is pinned. Examples: `twMerge` and `tv()` with literal class strings. Arguments that range over finite sets of values (conditionals over literals, literal-union and boolean values) are enumerated: the package runs once per combination and the program selects the result with the tests JavaScript evaluates (`frontend/packs/choice.ts`).
  3. **Native built-ins.** For dynamic arguments, built-ins in the `pack.<name>.*` namespace. They are implemented in Rust, in `runic-js` or a pack crate, shared by the interpreter and generated code, as `RegExp` and `Intl` are.
- **Components.** A pack can also supply component expansions. `@lucide/svelte/icons/<name>` expands to the icon's inline-SVG nodes, read from the package's own icon data at the pinned version. `@tabler/icons-svelte` 3.40.0 (2026-10-12) is the same kind of pack: its components are legacy-mode Svelte (`$$props`, `<slot/>`), which the adapter does not lower from source, while each icon is static `iconNode` data around one pinned `Icon.svelte`.
- **Source packages beyond bits-ui** (2026-10-12). `svelte-sonner` 1.2.1 joined `frontend/sources.ts`: it meets the preconditions (`"sideEffects": false`, `dist` JavaScript with declaration files, runes mode). vaul-svelte, paneforge and mode-watcher do not declare `"sideEffects": false`, so lowering only reached declarations is not shown to equal running their modules; they stay `E_DEPENDENCY` with that reason until a pack or a reviewed side-effect check covers them. Since 2026-10-13 that check exists (`frontend/module-effects.ts`) and the three are source packages: for a package without `"sideEffects": false`, the top-level code of every module a bundle evaluates (in bundle order, from the entry) must be inert, so that lowering only reached declarations, later, is unobservable; the first code that is not is `E_MODULE` where it stands ([CONTRACT](../CONTRACT.md#packages)).
- **Validation.** Each native built-in passes vectors generated by running the real package in Node:
  - a generator script under `conformance/packs/`, run explicitly, never during builds;
  - committed vector files, kept small;
  - Rust tests.
  
  Conformance fixtures then use the package in Chromium.
- **Discovery.** Model-assisted pack discovery proposes packs and never accepts them (D9). It is a separate operation (step 10).

## Work order

Steps 0 to 2 can run in parallel. Steps 3 to 6 share the language layer and IR, and go in order.

0. **Blitz fork** (in progress).
   - **Done on `runic`** (each with its case, [BLITZ-GAPS](../BLITZ-GAPS.md#fixed-in-the-fork)):
     - hit testing of scrolled containers;
     - 1/64 px shrink-to-fit rounding, with whole-pixel option widths for the runtime's selects;
     - Chromium's line breaks;
     - placeholders;
     - `:has()` with coarse invalidation;
     - `:focus-visible` (the runtime applies Blink's modality rule), `:focus-within` and `:placeholder-shown`;
     - `woff2-variations` and `data:` font sources (the collector accepts the hint; no rewrite needed);
     - `text-overflow: ellipsis`.
   - **Next:** button content centring (found on the way), then the lower-value items below.
   - **Rejected instead:** `filter` and `backdrop-filter`. vello_cpu 0.3 panics on colour-matrix filters and draws only the first function of a list, so the CPU renderer's `filters` feature stays off until it supports them.
   - **Lower value for the editor:** text input line height, inline control baselines and the focus ring. Tailwind's preflight sets explicit line heights and draws its own rings, so these come later.
1. **CSS pipeline.**
   - The collector runs the app's CSS plugins (`@tailwindcss/vite`).
   - It accepts `@layer`, `@property` and `@supports`, and SvelteKit's per-route stylesheets in order.
   - Stylo becomes the build-time oracle: every rule or declaration it drops is a located diagnostic, except an allow-list of drops verified equivalent in Chromium. A hand-kept list names the properties Blitz computes but ignores, and shrinks as fork patches land.
   - Rules are first reported, then pruned by reachability once class strings are analysable (step 2).
2. **Packs:** `clsx`, `tailwind-merge`, `tailwind-variants` and `@lucide/svelte`, with vector validation against the pinned packages. This gives an intermediate milestone: app screens without bits-ui.
3. **Library modules:**
   - package `exports` resolution;
   - `.svelte.js`/`.svelte.ts` rune modules;
   - untyped `dist` JavaScript, typed by inference, because the shipped `.d.ts` files omit computed keys and attachments;
   - re-export barrels;
   - `<script module>`;
   - `<A.B>` component tags.
4. **Classes and object semantics:**
   - classes with fields, `$state`/`$derived` fields, `#private` names, getters and setters, and statics;
   - `Symbol` keys, computed keys and `in`.
5. **Svelte library features:**
   - context (`setContext`/`getContext` with Symbol keys);
   - `$props.id()`, `$effect.root`, `untrack` and `svelte/events`;
   - `SvelteMap` and `MediaQuery`;
   - function bindings and `<svelte:element>`.
6. **Attribute bags.** The central IR design item:
   - records of mixed value types with listeners and symbol-keyed attachments;
   - `mergeProps`;
   - spreads onto elements;
   - bags passed to `child` snippets.
   
   Designed standalone before any adapter work.
7. **Overlay host layer:**
   - portals into `body`;
   - floating-ui's host APIs: `ResizeObserver`, `IntersectionObserver`, `getComputedStyle`, `visualViewport`;
   - focus scopes: `MutationObserver`, `createTreeWalker` and tabbable's queries;
   - dismissal through document listeners;
   - scroll lock;
   - presence with `getAnimations`.
   
   `ResizeObserver` comes from M5.
8. **SvelteKit SPA subset** ([research](../research/M6-SVELTEKIT.md)): a native router over a route manifest built with Kit's own route-tree code; layouts nest and stay mounted; universal loads run natively; server loads and prerendered endpoints become build-time data tables; per-route lazy initialisation and per-route-chunk code generation (whole-site builds are M7); the shadcn-svelte site's build-time generators (velite, the registry script) and markdown preprocessors (mdsx) run as explicit, hash-recorded build steps. The editor needs only layout and page composition, the hash router and `<svelte:head>`. Also: Svelte 5.54.0 and Vite 8.1.5 (the docs' pins) join the checked versions. Items:
   - `adapter-static` routes and layouts;
   - the `$app`/`$lib` modules the editor uses;
   - `import.meta.env.MODE`;
   - the translations virtual module;
   - `<svelte:head>`.
9. **Carried from M5:**
   - `Intl.PluralRules`/`DisplayNames`;
   - React's continuous lane (the React virtualized list);
   - console reports of unhandled rejections.
10. **Corpus and islands:**
    - `runic scan` over 20–50 open-source Svelte, React and Vue apps;
    - QuickJS islands with island and coverage reports;
    - model-assisted discovery generalised to library packs, as an explicit separate operation.

## Library modules (step 3)

Driven by shadcn-svelte's simplest components, compiled from their unmodified sources (Button with its `buttonVariants` in `<script module>`, Badge, Card's parts; fixture `shadcn-basics-svelte`, case `shadcn-basics`). What they need, and how it is built:

- **Resolution as the bundler resolves.** The collector records every import edge as Vite resolved it, aliases included (runic.json `alias`, as SvelteKit's `$lib`); type-only imports load nothing (`svelte/elements` has no runtime module). The TypeScript program resolves imports through those edges, a component file standing for its virtual module, so the checker follows re-export chains (`$lib/registry/ui/button/index.js` → `./button.svelte` → its module script) and `VariantProps<typeof buttonVariants>` types.
- **`<script module>`.** A component's virtual module holds its module script, then its instance script, then the template. The module script's statements go through the shared module lowering (`lowerModules`, `componentModule`), in module order with ordinary modules: constants are globals, functions shared, `tv()` definitions pack constants. Every collected component file gets a virtual module (a barrel imports components a program may never render); only reached components are lowered.
- **Barrels and namespace tags.** `ModuleResolver` (frontend/modules.ts) follows imports and re-exports syntactically: `export { default as Root } from`, `export { Root as Button }`, `export *`, `export * as N`, namespace imports. Adapters use it to find the component a tag names (`<Card.Root>`) before any TypeScript program exists. Values resolve through the checker's alias chain; pack bindings sit on any alias symbol along it, so `export { cn } from "cn"` keeps the pack. A namespace used as a value is rejected.
- **Packages:** `cn` 0.3.0, the registry's class helper, is a pack evaluated at build time like tailwind-merge.
- **Templates:** `<svelte:element>` over a finite set of tags (an `if` chain), nullable number and boolean attribute values (`aria-disabled`, `tabindex`), `bind:this` into a `$bindable` prop, rest props typed by svelte/elements.
- **Links.** Button with `href` renders an `<a>`. The runtime and the interpreter implement a link's activation (click, Enter) as the fragment navigation the HTML standard's "navigate" makes from a link (Chromium agrees: the same link again replaces the entry and fires `popstate` without `hashchange`). Scrolling to and focusing a fragment's target are not modelled, so frontends accept only finite sets of fragments that name no element and are not the top; `:target` is rejected (Blitz never matches it).

### Prop domains

The tailwind packs evaluate calls at build time over arguments with finite sets of values; 136 of the editor's 141 `cn` calls (and shadcn-svelte's wrappers alike) pass an open `class` prop, so they were rejected. The values are finite in the program: each site that instantiates a component passes literals, conditionals, literal-union values, pack calls over them, or a prop of its own component, whose sites are finite in turn. `frontend/domains.ts` (shared language layer) computes them:

- **Declarations and sites** come from the adapter: each declared prop (component, name, binding, fallback, whether the component writes it) and each instantiation site (the expression, text or presence it passes per prop). The root component has one site passing nothing.
- **Value sets.** `valueSet` (frontend/packs/choice.ts) is `valueChoice` without IR: literals and constants, both branches of a conditional (a superset where tests correlate), `&&`/`||`/`??`, arrays and object literals, pack calls (each pack's `values` runs the real package over the arguments' sets), inlined wrappers, literal-union and boolean types, and props of the enclosing component (their own domains, recursively; a cycle is open). An absent or `undefined` value takes the prop's fallback (Svelte's `$props()` default).
- **Domains.** A prop's values at site *k* are the set its expression there can take; its domain is the union over the sites. A prop the component assigns or binds (`bind:this={ref}`), or one a site passes an open value, has none and stays open: the E_PACK diagnostic names the site. A prop whose TypeScript type is not a value type (`class?: ClassValue`) gets the type of its values.
- **Per-site enumeration, so code does not explode.** Choosing over the union of all sites multiplies the props a call reads (variants × sizes × classes across the program). Instead, a component with several sites gets a hidden `$site` prop when a call first needs it, and each instantiation passes its site index (a constant). A call reading site-dependent props is enumerated once per site over that site's values, behind a test of the index: the combinations add up over the sites, and a site passing constants contributes one leaf. Shared subtrees and pure tests still collapse (`toExpr`). Button's class in the fixture (16 sites) is one chain of 16 tests over a few leaves each.
- **Exactness.** Every value a prop can hold comes from a site (the component never writes it), so the per-site sets are exact supersets of the runtime values; a value outside them can only arrive through an unsound cast and throws, as for literal unions.
- **Not yet:** values carried by spreads onto components (bits-ui's `{...props}` from child snippets; step 6), text mixed with expressions in attributes, numbers.

## Library code (steps 3 to 6)

What bits-ui's sources look like, taking Collapsible as the example (`bits/collapsible/collapsible.svelte.js` and `components/*.svelte`, 2.19):

- **State classes.** Each part of a component is a class:
  - its fields are `$state` or `$derived`, and some are `#private`;
  - a `static create` registers the instance in a context, or reads its root from one;
  - methods are bound with `.bind(this)`;
  - getters read other instances.
- **Options as boxes.** `boxWith(getter, setter?)` objects; `opts.open.current` reads and writes them.
- **The `props` bag.** A `$derived.by` object literal holding attribute values, listeners (`onclick: this.onclick`), a computed key (`[attrs.root]: ""`), a `style` object and a spread attachment (`...this.attachment`, keyed by a symbol).
- **Components.** They merge rest props with the state's bag (`mergeProps`), then spread the result onto an element or pass it to a `child` snippet.

Decisions:

- **svelte-toolbelt and runed are packs, not source.**
  - Their sources dispatch on runtime types. `mergeProps` checks `typeof` per key, and boxes are getter objects with symbol brands. Compiling them would mean modelling dynamic typing for code whose behaviour is small and documented.
  - A pack may also *port* a module: a typed TypeScript copy compiled with the program in place of the package's (runed's `ElementSize`, floating-ui's `autoUpdate`), for code the language covers but whose published form it does not (`frontend/packs.ts` `PackPort`).
  - The packs cover `boxWith`, `mergeProps`, `attachRef`, runed's `Context` and `watch`/`watch.pre`, and the helpers bits-ui calls (`afterTick`, `executeCallbacks`, `composeHandlers`). Each lowers to IR constructs below, validated against the real packages on vectors and fixtures.
- **bits-ui compiles from its published source.**
  - Its `dist` JavaScript is typed by combining two sources. The package's `.d.ts` files give public fields, methods and options. The language layer's existing inference for untyped JavaScript gives private fields and locals, specialising per call site where needed.
  - Where the two disagree, compilation fails with a diagnostic rather than guessing.
- **Classes are records with methods.**
  - A class instance is a record with one field per declared field, including `#private` ones, which are not visible outside the class.
  - `$state` fields are tracked like Svelte deep state. `$derived` fields are per-instance cached slots, as component-level derived values are since M4.
  - Methods and getters are functions taking the instance, dispatched statically, since the receiver's class is known. `.bind(this)` yields a closure.
  - Statics are module globals.
  - No inheritance until a reached source needs it.
- **Boxes are an IR type**, `box<T>`: a getter closure, plus a setter closure if writable. Reading `.current` calls the getter (cached as a derived value for writable boxes, as `boxWith` does), and writing calls the setter.
- **Attribute bags extend M5's `attrs` type.**
  - A bag maps attribute names to values (string, number, boolean, nullish), plus listeners, a style value, and attachments.
  - Keys must be compile-time strings. Computed keys from module constants (`createBitsAttrs`) are folded at build time.
  - Attachments are an IR value: an element callback returning a cleanup, run when the element mounts and before it unmounts, as `{@attach}` is.
  - `mergeProps` is a built-in over bags with svelte-toolbelt's rules: listeners compose, functions chain, `class` goes through clsx, `style` objects and strings merge, otherwise the last value wins, and `hidden`/`disabled` `false` are dropped.
  - A bag spreads onto an element as rest props do, or flows into a `child` snippet argument.
- **Context.** Svelte's `setContext`/`getContext` and runed's `Context` lower to one IR context mechanism, keyed by a compile-time identity (a module-level `Symbol` or `Context` instance).

## Animations

**Chromium's timeline under test** (Playwright 1.63, Chromium 153; scratch pages, 2026-10-04):

- Playwright's fake clock does not drive CSS animations. It replaces `Date`, timers, `requestAnimationFrame` and `performance.now()` in the page. The document timeline follows real frames: with the fake clock paused, a transition advanced 300 ms in 300 ms of real time, and `clock.runFor(500)` did not move it.
- `Emulation.setVirtualTimePolicy` does not map either. With virtual time paused the timeline still moved a frame, and an advance budget of 200 ms moved it by 400 ms. It would also compete with Playwright's clock.
- DevTools' `Animation.setPlaybackRate(0)` stops the document timeline. It applies to the page's later documents too and does not need the Animation domain enabled. Each animation can then be put at any time with `animation.currentTime`.
  - This includes transform and opacity animations that run on the compositor: screenshots show the sought frame.
  - `Animation.seekAnimations` is not used: it works on DevTools' clones of the animations.
- After a seek, Chromium delivers `animationstart`, `transitionrun` and `transitionstart`, the `finished` promises (before the end events) and `animationend`/`transitionend` at the next rendering frame, not during the seek.

**Sampling.** The browser harness stops the timeline. It seeks every animation in `document.getAnimations()` to the virtual time since the harness first saw it. That call also brings styles up to date, which starts the transitions and animations of a style change. It looks after the page loads, before and after every action, and, when the page's CSS is time-based, at every frame of a `wait`: each multiple of 16 ms of virtual time, after the timers due by then have run.

The native probe resolves styles at the same points: after each action, and at each frame of a `wait`. So an animation starts at the same virtual time on both sides and is sampled at the same times. A timeline that moves anyway is a harness error.

A case's `pixelRegions` compare each named element's box with the same 3/255 tolerance, because animated areas are too small for the whole-viewport gate. In case `animations`, shifting Chromium's animations by one frame (16 ms) fails the colour and transform regions (MAE up to 5.5 and 3.4). The infinite loaders move too little in one frame to be detected (0.3).

**Runtime.** `runic-runtime::timeline` gives every style resolution the runtime starts the same time, in seconds. Before this change it passed 0, which froze Stylo's animations at their start.
- Natively it is real time from the shell's first access to the document. That is where blitz-shell starts its own animation clock: `View::init` borrows the document, then `View::resume` starts the clock. So the shell's redraws, which continue while animations run, and the runtime's resolutions agree.
- In probes it is the virtual clock.

**CSS accepted** (collector, then the Stylo oracle):
- `@keyframes`;
- `animation*`, including `animation-fill-mode: forwards | both` (CSS slice 3a, case `animation-fill`, [results](../../conformance/results/animation-fill.md)). Upstream Stylo discarded a finished animation when its element was next restyled, so a hover after the end restored the unfilled value; the pinned Stylo fork keeps a finished CSS animation until it is cancelled (`display: none`, another `animation-name`, removal), so its fill stays through restyles, follows a later change of `animation-fill-mode`, and a delayed `both` shows its first keyframe before the start;
- `transition*`.

**Rejected** with located `E_CSS_PROPERTY`:
- `transition-behavior: allow-discrete`.
- Scroll-driven animations (`animation-timeline`, `animation-range*`, `scroll-timeline*`, `view-timeline*`, `timeline-scope`).

`@starting-style` remains an unsupported at-rule.

**Animation and transition events** (CSS slice 3b, [results](../../conformance/results/animation-events.md)): `animationstart`, `animationiteration`, `animationend`, `animationcancel`, `transitionrun`, `transitionstart`, `transitionend`, `transitioncancel`.

- **Chromium 153** (scratch pages, real time, 2026-10-14). Each frame's update samples every animation and compares its phase (before, active, after) and current iteration with the last frame's, as Blink's `CSSAnimations::AnimationEventDelegate` and `TransitionEventDelegate` do: a start when it enters the active or after phase (both start and end when it jumps from before to after), one `animationiteration` per frame however many iterations passed (`elapsedTime` the current iteration's boundary), `transitionrun` at the first sample, `transitionstart` when the delay is over. `elapsedTime`: a start `max(-delay, 0)` capped at the active duration, an end the active duration (a reversed transition's shortened duration), a cancellation an animation's current time (delay included) or a transition's active time, at the style update that cancels it. A cancellation (a style change, `display: none` on the element or an ancestor, removal, also before the start) is queued at that style update (a forced layout read included) and dispatched with the next frame's events, before them; an animation created and cancelled before any frame, or cancelled after its end, fires none. The frame's order: the `finished` promises' reactions, then the events (each listener a callback with its microtask checkpoint), then the animation frame callbacks, also those the reactions and listeners request; tasks the listeners queue run after the frame. Events are `AnimationEvent`/`TransitionEvent`, bubbling and cancelable, at the originating element of a pseudo-element (`pseudoElement` `::before`), and reach a removed element's own listeners. Order within a frame: transitions before animations, elements by address (creation order in the measured cases, not tree order), an element before its `::before` and `::after`, an element's animations in `animation-name` order, transitions ending together by property name; the `transitionrun`/`transitionstart` of transitions an element starts in one style change follow a hash table (measured: neither declaration nor property order).
- **Fork** ([BLITZ-GAPS](../BLITZ-GAPS.md#fixed-in-the-fork)). Stylo drops canceled CSS animations and finished transitions during the traversal, so the Blitz fork keeps a record of each animation (start, delay, duration, iterations, a paused local time), refreshed after every traversal, and `BaseDocument::take_animation_events(now)` samples them with Blink's rules, times compared in whole microseconds (Chromium's `AnimationTimeDelta`); the Stylo fork compares its own animation times in microseconds too, so a boundary that falls exactly on a frame is reached there. Animations under a `display: none` ancestor are cancelled, as in Chromium.
- **Runtime** (`runic-runtime` `animation_events`). A program that may listen to these events records the document's animations from the start (`App::ANIMATION_EVENTS`). A frame's animation step resolves styles, samples the events, settles the `finished` promises (a task) and dispatches the events through the element path. Natively a frame is the shell's redraw (`Document::update_rendering`, a fork hook): the animation step, then the animation frame callbacks requested before it (in apps a callback is still due on its 16 ms boundary, and the app then asks the window for the frame that runs it, so a callback loop runs at 62.5 per second), then rendering. The probe's virtual frames follow the same order (below).
- **Harness model.** Playwright's clock moves in whole milliseconds and runs `requestAnimationFrame` callbacks as timers, so a frame at *F* runs the timers due by *F* − 1, seeks the animations to *F* (the `finished` reactions run, clock *F* − 1), waits for one rendering frame of Chromium when the program may listen to animation events (a fresh `ResizeObserver`'s first notification, which follows the frame's animation events), then runs the timers due at *F* (the frame's callbacks, also those requested in the events) and seeks again. Inside the reactions and listeners the clock reads *F* − 1; Chromium real time reads a little after the frame's time. An animation is sampled at the virtual time it is created (Chromium real time: in the frame after the style update that creates it).
- **Frameworks.** Svelte 5 attaches these listeners to their elements (they are not among its delegated events); Vue through its per-element invoker. React 19.3 (measured): `onAnimationStart/Iteration/End` and `onTransitionRun/Start/Cancel/End` dispatch from the root's listeners at default priority (a capture handler before the target's own native listener, the bubble handlers after it, then native listeners on the root and the document; the state update renders in a scheduler task after the frame); `transitionrun`, `transitionstart` and `transitioncancel` get a plain `SyntheticEvent` (`propertyName`, `elapsedTime`, `pseudoElement` undefined; `nativeEvent` has them); there is no `onAnimationCancel`. The React adapter rejects these props until React's root dispatch is modelled. Svelte 5's `transition:`/`in:`/`out:` use `element.animate()` and dispatch `introstart`/`introend`/`outrostart`/`outroend`, not these events; bits-ui 2.19.2 listens to none of them (it awaits `getAnimations()`'s `finished`), and svelte-toolbelt's `mergeProps` composes `on<animation|transition>*` props passed through.
**`element.getAnimations()`** (implemented in step 7, part 4; [contract](../CONTRACT.md)). bits-ui's `AnimationsComplete` (2.19) calls `node.getAnimations()` after one or two animation frames, awaits each animation's `finished` through `Promise.all` and, on a rejection, waits again while any animation is `pending` or not `finished`.

- **Chromium** (153, measured on scratch pages, 2026-10-05). In real time: a new CSS animation is `pending` from its creation (also in the next `requestAnimationFrame` callback) until its first frame commits, before `animationstart`; `finished` resolves with the animation in the frame's update step, its reactions run before `animationend` and that frame's animation frame callbacks, then `playState` is `finished` and `getAnimations()` no longer lists it (no fill). With `animation-fill-mode: forwards` or `both` (measured 2026-10-14) `finished` resolves at the same point, and `getAnimations()` keeps listing the same object with `playState` `finished` while the fill keeps it in effect: through unrelated restyles, not after the fill changes to `none` (listed again when it changes back); `display: none` or another `animation-name` cancels it (`idle`, its resolved promise unchanged), and shown again the element starts a new animation. A cancellation (the style no longer names it, `display: none` on it or an ancestor, removal) rejects `finished` with a `DOMException` `AbortError` at the style update that cancels it, so after a forced layout read the rejection's reactions run before microtasks queued later; `playState` (which flushes style) is then `idle`. Transitions are listed before animations. Under the harness (timeline stopped, animations sought): setting `currentTime` makes an animation not `pending`, and a seek past the end settles `finished` within the seek's own script (a microtask), so bits-ui's chain completes before the harness continues.
- **IR.** A type `animation` (an opaque handle with identity) and the built-ins `element.getAnimations` → `array<animation>`, `animation.finished` → `promise<animation>`, `animation.playState` → `string`, `animation.pending` → `boolean`. All of them need the native style engine: the interpreter throws `RunicLayoutError`, and the differential reports such programs incomplete.
- **Runtime** (`runic-runtime` `animations`). When the program calls `getAnimations`, every style resolution the runtime makes is followed by matching the document's animations (the Blitz fork's `BaseDocument::animations_of`) to the ones it tracks: a CSS animation by element and keyframes name while Stylo keeps it, a transition by element, property and start time. A CSS animation finishes when Stylo reports it finished; the Stylo fork keeps it until it is cancelled, so the runtime keeps tracking it (and the app keeps its object), and `getAnimations()` lists it while the element's `animation-fill-mode` for it is `forwards` or `both`. One the app first takes after its end has its promise resolved at once. An animation Stylo no longer has ended: it finished if it is a transition that reached its end and was not replaced (or a CSS animation its rendered element still names that Stylo had not reported finished); otherwise it was cancelled. Elements that are not rendered (`display: none` on them or an ancestor) list none.
- **Timing.** A cancellation rejects `finished` at once: right after the built-in whose style resolution made it (generated code settles the cancellations after every layout built-in), or at the next frame. A finish settles at a frame's *animation step*: in probes at each 16 ms frame of a `wait` after the timers due before the frame and the style resolution (where the harness seeks), before the frame's animation frame callbacks (CSS slice 3b; before that change, after them), and in the rendering step after each action; natively at each redraw before its animation frame callbacks, rendering and paint (`Document::update_rendering`), so closed content is hidden in the frame its exit animation ends, as in Chromium. The step is a task with its microtask checkpoint. `pending` stays true until a step has seen the animation; `playState` reads `running` until the step takes a finish.
- **Not covered:** animations of pseudo-elements (`getAnimations` options are rejected); other Animation members (`E_MEMBER`); `animation.finished` read again after a cancellation (Chromium then returns a new promise; the runtime keeps the settled one and reports the read at run time).

**Gaps found** ([BLITZ-GAPS](../BLITZ-GAPS.md)):
- The text of flex and grid containers, including buttons (the UA sheet makes them `inline-flex`), keeps its first `color`, with or without a transition. A fork patch is proposed. The fixtures colour a block-level button.
- Stylo advances an animation by at most one iteration per resolution, so iterations shorter than a frame fall behind.
- Stylo eased cubic-bezier timing functions with an epsilon of 1/(200 × duration in seconds), up to about 2% off for 200 ms animations, and cancelled an animation without recascading its element, which kept the animated values (the runtime restyled such elements again). Both are fixed in the Stylo fork, with Chromium's epsilon (1e-7) and a recascade; the accordions' mid-animation frames pass and the runtime's restyle is gone ([fixed in the Stylo fork](../BLITZ-GAPS.md#fixed-in-the-stylo-fork)).
- Stylo keeps the animations of elements under a `display: none` ancestor running.
- `animation-fill-mode` forwards and both: fixed in the Stylo fork (finished animations kept until cancelled), accepted since CSS slice 3a (above).

**Open:**
- tw-animate-css's `enter`/`exit` keyframes animate `filter: blur(var(--tw-enter-blur, 0))`. `filter` is rejected because the CPU renderer draws no filters, so `animate-in` and `animate-out` stay rejected. The fix is either to prove the blur is always 0 (the same custom-property analysis as for fill modes) or to draw filters.
- Stylo's `steps()` easing ignores the before flag. `jump-start` steps during a backwards-filled delay may differ; this is not verified.

## Progress

| Step | Done | Open |
|---|---|---|
| Animations | Runtime timeline (real time natively, virtual in probes, styles resolved at every frame of a wait); `@keyframes`, `animation*`, `transition*` accepted; harness seeks Chromium's stopped timeline; `pixelRegions`; case `animations` in Svelte, React and Vue | Animation events (`getAnimations()` came in step 7; Stylo's easing epsilon is fixed in the Stylo fork), tw-animate-css `filter` in `enter`/`exit`, the anonymous-block colour patch ([Animations](#animations)) |
| 2. Packs | Pack mechanism (`frontend/packs.ts`, `E_DEPENDENCY`/`E_PACK_VERSION`/`E_PACK`, `meta.mappings`); `clsx` 2.1.1 as IR expressions (38 vectors, `conformance/packs/clsx.mjs`); `@lucide/svelte` 1.52.0 icon expansion; case `packs` in Svelte, React and Vue; `tailwind-merge` 3.7.0 (`twMerge`, `twJoin`) and `tailwind-variants` 3.3.1 (`tv` constants and their variant functions) evaluated at build time by the pinned packages over constant or finite arguments (`frontend/packs/choice.ts`), shadcn's `cn` inlined, 21 vectors (`conformance/packs/tailwind.mjs`), case `tailwind-packs` in Svelte, React and Vue | Class props passed through from the parent: solved in Svelte by prop domains (step 3); React and Vue adapters do not analyse sites yet. Svelte `<script module>`: done in step 3 |
| 3. Library modules | `<script module>` lowered as a module; every component file a virtual module with its module script; TypeScript resolution through the collected edges (`createProgram` resolver); `ModuleResolver` for barrels, `export *`, `export * as`, namespace imports and `<Ns.Name>` tags; pack re-exports (`export { cn } from "cn"`, alias-chain bindings); runic.json `alias` (`$lib`); type-only imports not collected; prop domains with per-site enumeration (`frontend/domains.ts`, `valueSet`, packs' `values`, the `$site` prop); `cn` 0.3.0 pack (13 vectors, `conformance/packs/cn.mjs`); `<svelte:element>` over finite tags; nullable number/boolean attributes; links (fragment navigation in runtime and interpreter, `popstate`/`hashchange`, replace on the same URL); `:target` rejected; case `shadcn-basics` (shadcn-svelte Button, Badge, Card vendored unmodified, `vendor.json`), tests `tests/modules.test.mjs` | Package `exports` resolution and untyped `dist` JavaScript (bits-ui, reached in step 4–6 work); `.svelte.ts` rune modules (not reached by these components; `$state` there is rejected); Separator (bits-ui); the same analysis for React and Vue; spreads onto components in prop domains (step 6); lucide icons under oklch colours are not drawn natively (Blitz fork patch pending, BLITZ-GAPS); transitions (`transition-all`) and Card.Header's `@container` are kept out of the fixture's Tailwind generation until animations land and container queries are supported; links to the top or to fragment targets (scrolling and focus) |
| 4. Classes | Stage A: plain classes as nominal records with methods (case `classes` in Svelte, React and Vue). Stage B: reactive class fields, `$state`, `$state.raw`, `$derived` and `$derived.by`, public and `#private`, in field initialisers and constructors, in component scripts and `.svelte.ts` modules (case `reactive-classes`, differential `reactive-class-svelte`). Inheritance and class unions: single inheritance in JavaScript's construction order, overrides, `super`, abstract classes, class references dispatched by `match-class`, `instanceof`, discriminant and `as` narrowing, reactive fields in base classes and subclasses (case `class-hierarchy` in Svelte, React and Vue; differential `class-hierarchy-*`) | Library base classes (`extends Error`, `MediaQuery`: packs); `Symbol` and computed keys, `in`; derived fields of component-script classes read in other components |
| 5. Svelte library features | Packages compiled from source (`frontend/sources.ts`: bits-ui 2.19.2; the collector takes their modules, top-level code of packages without `"sideEffects": false` checked inert; declarations lowered lazily on first use; `dist` JavaScript typed by virtual modules annotated from the sibling `.d.ts`, field types inferred from assignments; build-time constants such as `createBitsAttrs` folded by running the import-free module; `E_SOURCE_VERSION` for other versions). runed 0.35.1 pack (`Context` with a compile-time key, `watch`, `watch.pre`); IR contexts (`context.set/get`, render-tree parents); `$props.id()` (`uid.next`), `untrack` (`reactive.untrack-call`), svelte/events `on` (`beforematch` only), `$effect`/`$effect.pre` created while instances are created (constructors, `watch`); props whose `undefined` takes the default; snippets forwarded through rest props (`slot-provided`, slot `when`). Case `bits-collapsible` (Collapsible through shadcn-svelte's unmodified wrapper and demo, compiled from bits-ui's source); case and differential `toolbelt` (`toolbelt-svelte`). bits-ui's non-overlay parts (below): cases `bits-separator`, `bits-progress`, `bits-checkbox`, `bits-switch`, `bits-toggle`, `bits-tabs`, `bits-avatar`, `bits-toggle-group`, `bits-toggle-group-single`, `bits-accordion`, `bits-accordion-multiple`; differential `roving-svelte`, `options-hierarchy-svelte`; esm-env 1.2.2 pack; `SvelteMap` (whole-map reads, in derived values only); svelte's `setContext`/`getContext` with string keys; objects of getters; discriminated union props; merged options records along class hierarchies; object rest destructuring | `$effect.root`, `MediaQuery`, function bindings; SvelteMap reads per key; `svelte/events` other than `beforematch`; `hidden="until-found"` (Blitz has no find-in-page); other bits-ui components (below) |
| 6. Attribute bags | `attrs` entries for `maybe<boolean>`, `null` apart from `undefined`, callbacks under non-event names (type-erased natively, adapted by `attrs.get`), style objects, attachments (`{attach}`, run with the rendering instance's post effects, cleaned up after the render removing them); svelte-toolbelt 0.10.6 pack (`boxWith` boxes as records of getter/setter closures with a derived `current` rather than an IR type, `mergeProps` as `attrs.merge-props`, `attachRef`, `afterTick`, `onDestroyEffect`); bag shapes (`frontend/bags.ts`) through literals, `mergeProps`, fields, derived values, rest props and snippet arguments; spreads onto components (`attrs.without`, `attrs.has`/`attrs.get` for declared props, later entries winning); spreads onto elements with Svelte's boolean text (`spreadBooleanText`), `style` through `cssText`, bags in `child` snippet arguments; app classes' `Record<string, unknown>` derived fields as bags | `executeCallbacks` (two non-event functions under one key) and style strings meeting style objects in `mergeProps` (`RunicUnsupportedError`); style objects spread directly onto elements; `composeHandlers` and `executeCallbacks` imported by app code; `mergeProps` vectors against the real package beyond the two cases |
| 8. SvelteKit | Phase 1 ([M6-SVELTEKIT](M6-SVELTEKIT.md#status)): `"kit": true`, `svelte.config.js` read as literals, `app.html`, the manifest from Kit 2.70.1's own files (SHA-256 pinned), Kit's client router ported to the compiled language (hash and path routers, kept layout instances, universal loads with Kit's tracking, `error`/`redirect`/`+error.svelte`, `$app/state` `page`, `goto`, `beforeNavigate`/`afterNavigate`, scroll, focus reset, announcer, title); cases `kit-hash`, `kit-routes`, `kit-routes-missing`. Phase 2 machinery ([addendum](M6-SVELTEKIT.md#phase-2-addendum-proposed-2026-10-05-decided-and-implemented-2026-10-06)): `runic generate` (pinned tools, recorded input and output hashes, `E_GENERATED` in builds; `svelte.config.js`'s preprocessors run there only), server loads and prerendered endpoints as build-time tables with Kit's invalidation, `import.meta.glob`, component values and dynamic tags, JSON modules behind declaration files, `{@html}` of build-time fragments (IR `html` node), fragment links to elements, `position: sticky` rejected; the site's Toggle, Tabs and Separator markdown pages through its velite and mdsx configurations in fixture `kit-docs-svelte`, cases `kit-docs`, `kit-docs-narrow` | The site's own route family: the shared-chain blockers (overlays, mode-watcher, svelte-sonner, zod, icon packages, `extends MediaQuery`, `<slot>`, `innerText`, cookies, `IntersectionObserver`, `position: sticky`, …), accordion and toggle-group pages mixing types (`E_TYPE_UNION`), unverified previews; checked identities for the site's pins (M7 prerequisite); Kit 3 and the editor's items |
| 9. Carried from M5 | `Intl.PluralRules` (`select`, `resolvedOptions().pluralCategories`/`type`, cardinal and ordinal, every locale with plural data in Chromium's ICU data) and `Intl.DisplayNames` (`of` for regions, scripts, currencies and languages, `fallback`, `languageDisplay`, display locales en-US, en-GB, de-DE, fr-FR, ja-JP, en, de, fr, ja), runtime locales and conditional options where constructed at the use, `intl.plural-select`/`plural-categories`/`display-of`/`locale` built-ins, 56,904 Chromium vectors (`tests/vectors/intl-locales.mjs`), case `plural-names`/`plural-names-de` in Svelte, React and Vue; React's continuous lane for scroll events (`schedule.continuous`: updates render in a default task after the frame, a discrete update renders pending ones with it, tasks queued inside a frame wait for its end, the focus fixup is a task after the frame), the React virtualized list (`examples/virtual-list-react` in case `virtual-list`), case `scroll-lane`; unhandled promise rejections reported as Chromium's `Uncaught (in promise)` console lines from a report task after the checkpoint, Vue's `callWithAsyncErrorHandling` modelled, the harness's `Runtime.exceptionThrown`, cases `rejections`, `rejections-timer` ([research](../research/M6-CARRYOVER.md)) | Plural digit options, other display name types and styles, variants and extensions in tags; timers posted by React scroll listeners; window scroll and resize listeners in React; timers due at the same instant (Chromium runs them before the tasks they queue); the focus fixup against a React scroll render (not stable in Chromium) |

### bits-ui beyond Collapsible

Verified through shadcn-svelte's unmodified wrappers and demos, each with a case against Chromium with pixels and key presses (docs/CONTRACT.md lists what each covers): Separator, Progress, Checkbox and Label, Switch (geometry and pixels a known gap: Blitz centres flex buttons' content), Toggle, Tabs, Avatar (without Avatar.Image), ToggleGroup and Accordion (each type in its own program). Layout-free fixtures exercise the same shared-layer parts in the differential harness (`roving-svelte`, `options-hierarchy-svelte`). Meter and RadioGroup lower as well but have no case.

**One discriminant per program.** bits-ui's ToggleGroup and Accordion (and Slider) take `type: "single" | "multiple"` with `value: string | string[]` (`number | number[]`). Where every site of the component passes one literal for the discriminant (also through wrappers' rest props), the props take that member's types and the options class hierarchy's `opts` fields share one record (frontend/types.ts `mergeRecords`). A program using both types would need a value of either type, a union the value model does not have: it is rejected with `E_TYPE_UNION` naming the discriminant's values. Lifting this needs either an IR union of string and array (a shared-interface change to design standalone) or a component compiled once per discriminant value.

Decided 2026-10-05 ([M6-OVERLAYS](M6-OVERLAYS.md#decisions-after-step-1-2026-10-05)): programs mixing discriminants are compiled by specialising the component per member that reaches it; until that lands, mixing stays `E_TYPE_UNION`.

What each remaining part gives today (a minimal use of the part, 2026-10-05), in the order the north star needs them:

- **Overlays** (Tooltip, Popover, DropdownMenu, Select, Dialog: step 7): imperative mounts, `ResizeObserver`, top-level calls, the `esm-env` pack, union narrowing (bits-ui's `Portal`), the floating-ui packs (core's math native, dom's platform over the native layout, `autoUpdate` ported) `IntersectionObserver` and the host layer (listeners, capture phases, tabbable, `MutationObserver`, the focus scope, escape, dismissible and text selection layers) are done; the Popover compiles and builds, and fails at run time on a `StyleProperties | string` prop both of whose members reach it, which needs a decision (layer 2 or lazy props); Tooltip also needs the generic `TimeoutFn`, DropdownMenu and Dialog the scroll lock ([status](M6-OVERLAYS.md#status-branch-m6-overlays-2)).
- **Overlay enter and exit animations**: `getAnimations()` is implemented and verified with the Accordion's and Collapsible's content animations ([Animations](#animations)); the overlays' presence path waits for the overlays themselves (step 7).
- **Slider**: its `step` prop, `number | number[]`, is outside the value model (`E_TYPE_UNION`, also where no site passes it).
- **Scoped component styles** (ScrollArea's viewport `<style>`).
- **AspectRatio**: a style object value that is not a string (`E_ATTRS`, a number).
- **PinInput**: a callback prop typed `(...args: any[]) => void` given no value at a site.
- **Pagination**: an untyped value in its state module (`E_TYPE_UNSUPPORTED`).
- **Images** (Avatar.Image): `<img>` and `new Image()`; the native runtime loads no images.
- **`hidden="until-found"`** (Accordion's and Collapsible's `hiddenUntilFound`): Blitz has no find-in-page; reported unsupported.

Rendering gaps met on the way ([BLITZ-GAPS](../BLITZ-GAPS.md)): flex buttons' centred content (Switch; fixed in the Blitz fork 2026-10-05), `text-transform: capitalize` (toggle-group-spacing; laid out in the Blitz fork since 2026-10-12), glyph rasterisation (ToggleGroup at 420px; first described as glyph origins), web fonts that Chromium loads after the app mounted (layout read while mounting; the accordion fixtures mount on a first action), CSS `fill` on icons (toggle-demo; drawn since the Blitz fork serialises computed SVG properties, 2026-10-05).

## Reactive class fields (stage B)

Svelte compiles a `$state` class field to a private signal with an accessor pair, and a `$derived` field to a lazily computed, cached signal. bits-ui's state classes and the shadcn-svelte site's own classes depend on both. The plain-class lowering (stage A) stays; reactive fields add the following.

- **IR.** A class record's field can be marked reactive: `"reactive": "state"` (deep: plain objects and arrays assigned to it are proxied, as Svelte proxies them), `"raw"` (`$state.raw`: tracked by identity) or `"derived"` with a function of the instance (`$derived(expr)` and `$derived.by(fn)`). Plain fields stay untracked. Svelte does not proxy class instances, so a class instance assigned to a `$state` field is stored as it is.
- **Reads and writes.**
  - A read of a reactive field is a dependency of the running tracked computation (effect, derived value, render). This is the heap-slot read M4 tracks, now on the class record's slot.
  - A write of a `state` or `raw` field that changes the value (`raw`: not SameValue; `state`: also mutation of its proxied contents) marks the slot written and sets a program-wide *reactive heap* flag for the next flush.
- **Derived fields.** They have a per-object cache: the value, plus the cells, heap slots and other derived values the last computation read. They are recomputed when read after one of those changed, and keep their value when the result is SameValue, as component-level derived values do. They are computed on first read, never at construction.
- **Bindings.** A template binding is re-evaluated when a cell it reads is dirty, as today, or when the reactive heap flag is set and the binding may read a reactive field. Which bindings may read one is decided statically: the expression or the functions it calls read reactive fields, and a call through a function value counts as may. Re-evaluation writes the DOM only where a value changed. Svelte's updates are finer-grained, but the difference is not observable: template expressions must not have side effects, which `E_REACTIVITY` and the effects checks already enforce.
- **Effects** with tracked dependencies depend on the reactive slots and derived fields they read, exactly as they depend on cells.
- **Validation.** Writing a reactive field from a derived value or during render is rejected, as for cells (Svelte throws `state_unsafe_mutation`). Reading a plain, non-reactive field that is written after construction in a template stays `E_REACTIVITY`.
- **Implemented** (case `reactive-classes`; [IR](../IR.md#types-and-values)) as above, with these refinements, each checked against Svelte 5.57.1's runtime:
  - Writes and derived recomputations compare with `===`, Svelte's `equals`, not SameValue: `NaN` written over `NaN` notifies, `-0` written over `0` does not and the field keeps `0`. Component-level `$derived` values still use SameValue (an existing difference for `NaN` and `-0` results, left for a separate change).
  - Reading a reactive field of an instance that the running effect or derived value created is not a dependency (Svelte does not track the signals a reaction creates; heap objects carry a creation stamp).
  - A derived field is a function of the instance; `$derived` assigned in the constructor must not read the constructor's parameters or locals (its closure would capture them), and assigning a derived field (overriding, Svelte 5.25+) is rejected.
  - The reactive heap flag is set by reactive field writes and by writes through proxies (deep state a `$state` field holds), and taken at the start of each flush pass.
  - Validation: writing reactive state from a template expression or a derived value is rejected unless the code built the instance itself (a constructor writing its own fields); a derived field must not change values it did not create, since how often it is computed would show (Svelte recomputes a disconnected derived on every read when its value stayed the same, which pure computations cannot observe).
  - Derived fields appear as `null` in snapshots.
- **Inheritance**, needed by the editor's `extends MediaQuery` and `extends Error` and some shadcn-svelte classes, follows as its own step ([below](#inheritance-and-class-unions); implemented for classes compiled from source):
  - single inheritance, with fields of the base first and `super(…)` in the constructor;
  - dispatch stays static where the receiver's class is exact, and becomes a match over its classes where it is not;
  - library base classes (`MediaQuery`, `Error`) are packs.

## Inheritance and class unions

bits-ui builds component families on base classes (`SelectBaseRootState` with `SelectSingleRootState` and `SelectMultipleRootState`; Accordion, ToggleGroup, Toolbar, Slider, date and time segments), and passes instances typed as the base class or as a union of subclasses through contexts. The app layer extends library classes (`MediaQuery`, `Error`). IR records have no subtyping, so:

- **Closed world.** The compiler sees every class of the program, so the subclasses of a class are known. A reference whose static type is a class `C` that has subclasses, or a union of classes, gets an IR *class reference* type: `{"class": C}` for `C` or any subclass, `{"classes": [...]}` for a union. It holds the instance with its class tag. A class without subclasses keeps the plain record type, so existing programs are unchanged.
- **Layout.** A subclass record starts with its base's fields, in order (`super(…)` initialises them first, as JavaScript does). Base methods are lowered once per base, with `this` typed as the base's class reference. Private names are per declaring class.
- **Field access** through a class reference reads the field every member has (TypeScript guarantees it for the fields it allows). **Method calls** dispatch by the class tag to the most derived override among the known classes, with a match over the closed set of tags. `super.m(…)` is a static call. `instanceof` tests the tag.
- **Upcasts** wrap a record into a class reference. **Narrowing** (`instanceof`, discriminant checks TypeScript performs) unwraps it, and fails with a `TypeError` only where TypeScript's types were unsound.
- **Library base classes.** `Error` subclasses carry `name`, `message` and the class tag, so caught values can be tested with `instanceof`. A caught value of unknown type becomes a class reference over the program's error classes plus the built-in error records. `MediaQuery` (`svelte/reactivity`) is a pack class wrapping M5's media query lists.
- **Rejected:** mixins, `extends` of expressions, abstract members called through `super`, `Symbol.hasInstance`, and changing prototypes.
- **Implemented** (case `class-hierarchy` in Svelte, React and Vue; differential `class-hierarchy-*`; [IR](../IR.md#types-and-values)) for classes compiled from source, as above, with these decisions and refinements:
  - **IR.** The design's types, plus three expressions instead of method tables: `upcast`, `downcast` (the `TypeError` of unsound narrowing) and `match-class` (a branch per exact class, binding the instance as that record). Dispatch is a `match-class` the frontend writes over the receiver's concrete classes, each branch calling the override its class resolves to; a member every class resolves alike (a base method no subclass overrides, a field of the common prefix) is called or read directly. Methods stay ordinary functions, so the backend learns nothing about methods, and `instanceof` and field reads of a union whose classes each declare the field are the same construct. Records carry `extends` (validated prefix layout) and `abstract`. Natively every class reference is one generated enum with a variant per concrete class (upcasts wrap, matches are Rust `match`es); the interpreter's records already carry their class.
  - **Closed world.** The hierarchy is every class declaration of the program's sources; a hierarchy is laid out as a whole when one of its classes is first used, so a type maps to a record or a class reference consistently from the start. A union whose classes reduce to one root is that root's type (`A | B` with `B extends A` is `{"class": A}`). A subclass must be declared in the same module scope or component script as its base: a base method's dispatch may call any subclass's override, and module functions cannot call a component's.
  - **Construction.** Each concrete class has one constructor function running the chain in JavaScript's order: the statements before each `super(…)` and its arguments from the class up, then from the root down each class's parameter properties, field initialisers and statements after `super(…)`, into temporaries while they do not need the instance (stage A's early part, extended over the chain); base initialisers and constructor bodies are lowered again for each concrete subclass, with `this` typed as that exact class, so calls in them resolve statically. Where a base constructor needs the instance (calls a method, passes `this` on), the record is built there; subclasses that declare fields are then rejected, since JavaScript would run that code before their fields exist (a dispatched override would see them missing) and no IR value stands for a missing field. Subclasses without fields of their own are accepted (the override runs, as in JavaScript). Late fields (bits-ui's `this.contentPresence = new PresenceManager(…)`: assigned at the constructor's top level after the record is built, with nothing but other non-function fields reached through `this` before) are own fields of the class whose constructor builds the record; they are nullable in the record of that class and its subclasses, and every read through the hierarchy unwraps them.
  - **Members.** A field shadows prototype members of any class in the chain, as an own property does; other names resolve to the nearest class declaring them, a get/set pair as one accessor. `super.x` of a field is rejected (JavaScript reads the prototype, where fields are not). Redeclaring an inherited field is rejected; abstract properties are implemented by the subclasses' fields (each class of a union may then have the field at another index: a read dispatches, a write through the union is rejected). Private names a base also declares are qualified in the subclass record (`B#p`).
  - **Narrowing.** TypeScript's narrowed type at a read (identifiers, element accesses, property reads, `as` assertions) that names fewer classes than the IR value's type gives a `downcast`. An `as` assertion TypeScript cannot check (`as unknown as C`) throws the `TypeError` where JavaScript would continue with the wrong object; a sound program never fails one. Arrays, maps, sets and functions of a subclass type cannot be used as ones of the base type (no conversion keeps their identity; rejected).
  - **Not yet:** library base classes. `extends Error` needs caught values typed as a union of the program's error classes and the built-in error records; built-in errors are plain records today, so this changes every program with `catch`, and stays rejected (`E_CLASS`) until packs give `Error` and `MediaQuery` class records.

## Verification

- Every step adds conformance cases in Chromium. Library steps use small fixtures that import the real packages: one bits-ui primitive per fixture, then the editor's wrappers.
- Packs pass their vector suites against the pinned packages.
- The editor's screens are compared with Chromium against its mock bridge (`import.meta.env.MODE`), screen by screen. The bridge itself is M7.
- Each Blitz patch has the case that shows its gap (`blitz-*` cases). A paint-only difference the whole-viewport pixel gate cannot see is checked by screenshot inspection and stated in the case.

## Work mode

- **Standalone:**
  - the design of steps 3 to 6, which change the IR and language layer every adapter shares;
  - SvelteKit;
  - the QuickJS bridge.
- **Subagents** (worktrees, one at a time per shared build):
  - each pack;
  - the Blitz CSS patches;
  - the Stylo oracle;
  - the carried M5 items;
  - the overlay host APIs once step 6 fixes the shapes.
- **Corpus scan:** one agent per app plus an aggregator. As a workflow only with the user's opt-in; otherwise sequential subagents.
