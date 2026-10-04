# M5 design: events, forms, layout APIs and host services

Status: design for M5 ([roadmap](../ROADMAP.md#m5-events-forms-layout-apis-services)). The work order follows the north-star census (`conformance/results/scan-translations-editor.txt`) and the editor's component library (shadcn-svelte on bits-ui), whose patterns appear hundreds of times.

## Goals

- Component templates as the editor's UI library writes them: rest props forwarded with spread attributes, `class` and `style` directives, component refs.
- The DOM event model: event objects with `preventDefault`/`stopPropagation`, focus and pointer events, window and document listeners.
- Form controls beyond text inputs and checkboxes: `textarea`, `select`, radio buttons.
- Layout and measurement: element geometry, scrolling, media queries.
- Host services: the document element (theming), clipboard, history and location, console, `Date`/`Intl` subsets, `RegExp`, `Math.random`.
- The focus model: Chromium's sequential navigation starting point (case `reorder-navigation`).

## Rest props and spread attributes

Census: `{...restProps}` 154, `{...props}` 12. The pattern:

```svelte
let { ref = $bindable(null), class: className, children, ...restProps }: ButtonProps = $props();
<button bind:this={ref} class={cn(base, className)} {...restProps}>{@render children?.()}</button>
```

The props a parent passes are known at each call site, so the rest of them is too. The editor types them with `svelte/elements` attribute types (`HTMLButtonAttributes`: hundreds of optional members), so the rest is not a record. The IR represents it as an *attribute bag*:

- **Type `attrs`.** An ordered list of `(name, value)` entries; a value is an attribute (`string`, `maybe<string>`: absent removes, `boolean`: presence) or a listener (an `on<event>` entry holding a function taking the event or nothing). Natively `js::Attrs`; identity is irrelevant, bags compare by entries.
- **Expression `attrs {items}`.** Builds a bag from items in source order, each `{name, value}` or `{spread}` (another bag); a later entry of the same name wins. The adapter applies its framework's attribute coercion when it builds an entry (numbers stringified, `false` removing or `"false"` as the framework does for that name), so bags carry final attribute values.
- **Rest props.** The rest binding of a component is a prop cell of type `attrs` marked `rest`. At each call site, the passed props the child does not declare form the bag (an `attrs` expression). The frontend knows every call site (whole-program compilation), so it knows the names a bag may hold; spreading a bag onto a component whose declared props it may contain is rejected, because the IR does not route bag entries into typed props.
- **Element spread.** An element with `spread: Expr` (type `attrs`) takes all its attributes and listeners from that bag. The adapter folds the element's own attributes into it in source order. When the bag changes, the runtime removes attributes it no longer holds and updates listener registrations.
- Rest props read by name in script (`restProps.id`) are rejected in this step; forwarding is the dominant use.

## Events

Handlers in the editor's component library receive event objects as values (`onclick={(e) => …}` passed through rest props, `e.preventDefault()` in forms and menus), so M5 makes the event a value instead of a per-kind payload.

**IR.**
- `event` is an opaque type; `{ "op": "event" }` is the event a handler is running for (closures capture it like any value).
- Built-ins read it:
  - `event.type`;
  - keyboard: `key`, `code`, `ctrlKey`/`shiftKey`/`altKey`/`metaKey`, `repeat`;
  - pointer and mouse: `clientX`/`clientY`, `button`/`buttons`;
  - wheel: `deltaX`/`deltaY`;
  - the target control: `value`, `checked`;
  - `target`/`currentTarget` as `element` handles, `defaultPrevented`.
- `event.preventDefault()`, `event.stopPropagation()` and `event.stopImmediatePropagation()` set its flags.
- `payload` stays as a shorthand for the old per-kind values.

**Kinds.**
- The existing `click`, `input`, `change` and `keydown`.
- `keyup`, `dblclick`, `contextmenu`, `focus`/`blur` (not bubbling) and `focusin`/`focusout`.
- `pointerdown`/`up`/`move`/`enter`/`leave`, `mousedown`/`up`/`move`/`enter`/`leave`.
- `wheel` and `scroll`.

The runtime takes them from Blitz's event stream; probes and the browser harness gain the matching actions (double click, hover, wheel, key up).

**Dispatch.**
- Listeners run in DOM order: target first, then bubbling. `stopPropagation` ends the walk after the current element's listener.
- After dispatch the runtime skips the default actions of a cancelled event:
  - a checkbox toggle (reverted, as Chromium reverts it);
  - button activation by Enter/Space;
  - text insertion by `keydown`;
  - focus moving on `mousedown` (the menu and popover pattern).
- Window and document listeners (`<svelte:window>`, `<svelte:document>`, `window.addEventListener`) see an event after the root (bubbling) and before default actions.

## Forms

`textarea` (value, selection, `bind:value`), `select` with `option` (value, `bind:value`, `change`), radio groups (`bind:group`). The runtime implements the controls' default actions where Blitz lacks them; conformance compares live values and selections as for text inputs.

## Layout, measurement and media

- `element.getBoundingClientRect()`, `offsetWidth/Height`, `scrollTop/Left` reads and `scrollTo`/`scrollIntoView`: the IR element type gains these as built-ins. They read Blitz's layout after the last flush (layout is resolved before handlers run).
- `ResizeObserver` callbacks run after layout, before paint, like Chromium.
- `matchMedia(query).matches` and its `change` event, with `prefers-color-scheme` from the platform and the probe's emulated value.
- Inline styles: `style` attributes and `style:` directives serialise through Stylo, so the attribute holds the browser's CSSOM serialisation (the M3 style deviation).

## Host services

A capability interface in `runic-runtime` (one module per service, each with a probe implementation):

| Service | Surface |
|---|---|
| Document element | `document.documentElement` `dataset`, `classList`, `style.setProperty`, `lang`, `dir` (theming) |
| Clipboard | `navigator.clipboard.writeText/readText` |
| History | `history.pushState/replaceState`, `location.hash`/`pathname`, `popstate`/`hashchange` |
| Console | `console.log/warn/error` to stderr |
| Time and text | `Date` (construction, getters in UTC and local time, `toISOString`), `Intl.DateTimeFormat`/`NumberFormat` subsets, `localeCompare` with ICU root collation |
| Randomness | `Math.random`, `crypto.randomUUID` (seeded in probes) |
| Patterns | `RegExp` with JavaScript semantics |

**The capability interface.** Every service follows the shape `localStorage` set in M4:
- **IR.** Built-ins in the service's own namespace (`clipboard.*`, `history.*`, `console.*`, `date.*`, `intl.*`, `random.*`). Frontends lower the browser API to them in the shared language layer: the APIs are the same in every framework.
- **Runtime.** One `runic-runtime` module per service. Production uses the platform: the system clock, time zone and locale, the OS clipboard, OS randomness, and an in-process history whose initial location is the app's start URL. JavaScript value semantics that need no platform (`Date` arithmetic and formatting, `Intl` formatting given a locale and time zone, collation) live in `runic-js`, so the interpreter and generated code share them.
- **Probe mode.** Each module has a probe mode seeded from the case manifest, as `storage` is. The interpreter models the probe mode, and the browser harness sets up the same environment in Chromium.
- **Manifest keys.**

  | Key | Default | Meaning |
  |---|---|---|
  | `timezone` | `"UTC"` | IANA zone; Chromium gets it through Playwright's `timezoneId` |
  | `locale` | `"en-US"` | the default locale; Playwright's `locale` |
  | `url` | `"/"` | the initial path, query and hash |
  | `clipboard` | `""` | the initial clipboard text |
  | `seed` | `1` | the random seed |

  The clock stays as it is: the fake clock starts at `CLOCK_ORIGIN` for cases with `wait`.
- **Randomness in Chromium.** Chromium's `Math.random` cannot be seeded. The harness replaces it, and `crypto.randomUUID`, with the generator the probe uses (an init script, the same kind of emulation as the fake clock). Only the case environment changes; the app runs unchanged.
- **Snapshots.** Effects outside the DOM are part of each step's snapshot under `host`, compared like the DOM:
  - console lines (`level`, text);
  - clipboard text;
  - `location.href` relative to the origin;
  - `history.length`.
- **Builds stay deterministic.** Clock, zone, locale, clipboard and randomness are runtime inputs, never build inputs.
- **Unsupported shapes are rejected.** Values, options and locales without verified parity are rejected with a located diagnostic. Examples: console arguments other than primitives, `Intl` options outside the verified subset, locales without vectors. Each supported formatting surface is pinned by vectors generated in Chromium or Node, like the RegExp vectors.

## Work order

1. Event objects, event kinds and default-action cancellation; window and document listeners.
2. Rest props and spread attributes (listeners included), `class:`/`style:` directives, component refs (`bind:this` on components through `$bindable` refs).
3. `textarea`, `select`, radio buttons.
4. Document element, `matchMedia`, layout reads and scrolling.
5. Services: console, clipboard, history, `Date`/`Intl`, `RegExp`, randomness.
6. Focus model and the remaining M3 known gap.
7. Examples: 7GUIs Circle Drawer and Cells; a virtualized 10,000-row list.

Steps 3 and 5 split into independent subagent tasks per control family and service once steps 1 and 2 fix the IR shape.

## Notes from step 1

Facts checked against Chromium 153 with Playwright before they were encoded (interpreter and runtime alike):

- **Pointer sequences.** A move sends the pointer boundary events (`pointerout`, `pointerleave` innermost first, `pointerover`, `pointerenter` outermost first), then the mouse boundary events in the same shape, then `pointermove` and `mousemove`. A move to the same position still sends the move events. Blitz interleaves pointer and mouse boundary events, so the runtime buffers them and replays Chromium's order. Elements removed from the document get no boundary events.
- **Disabled controls** receive pointer events and `mousemove`, but no `mousedown`, `mouseup`, `click`, `dblclick` or `contextmenu`, on the control or its ancestors.
- **A cancelled `pointerdown`** suppresses `mousedown` and `mouseup` (not the click, not focus).
- **The context menu** opens on press on Linux: `pointerdown`, `mousedown`, `contextmenu`, `pointerup`, `mouseup`. Windows opens it on release; the runtime switches by platform.
- **Double clicks** follow the click count. The runtime counts clicks itself (Blitz drops `dblclick` when the click is cancelled, which the runtime does for its own activation handling); probes give the count explicitly.
- **Keys.** Playwright presses modifiers as keys of their own (`Shift+a`: `Shift` down, `a` down and up with `shiftKey`, `Shift` up) and does not change the key (`a`, code `KeyA`). Enter activates a button after `keydown`, before `keyup`; Space activates buttons and checkboxes after `keyup`. A checkbox fires `click`, `input`, `change`.
- **Window and document listeners** run after the element path, each as a callback of its own, so a microtask checkpoint (and the framework's flush) precedes them. A target's listeners are taken when the event reaches it: a listener that an effect adds while the same click is still being dispatched runs for that click, as in browsers.

The interpreter has no layout: pointer events target the addressed element itself rather than the element hit at its centre, and carry zero coordinates. Differential tests therefore cover dispatch, not hit testing; browser conformance covers both.

Found on the way, for step 4: a text input placed inline (not as a block or flex item) gets a line box 4 px taller in Blitz than in Chromium.

### React and Vue (step 1)

Both adapters implement the event model; the shared cases `events` and `shortcuts` pass for all three frameworks.

- **React** (19.3.0). The root listener runs all element handlers of one native event in one call; microtasks and the synchronous render follow, then the document and window listeners. This is the IR's checkpoint order.
  - Enter and leave handlers are synthesized from out/over in the IR's order. One synthetic event serves the whole chain, so handlers that read `target`, cancel or stop propagation are rejected.
  - Continuous events (move, enter, leave) render in a later scheduler task. Their handlers are accepted only where that timing is unobservable: own state, rendered as text, no callbacks, timers or promises.
  - `onWheel` is rejected: React's passive root listener lets Chromium scroll before dispatching to the element under the pointer.
  - Function values are one object per invocation of the enclosing effect or handler (`hoistFunctionValues`), so effects can remove the listener they added.
  - Controlled values are restored after every event (`schedule.controlledRestore`).
- **Vue** (3.5.43). Modifiers follow `withModifiers`/`withKeys`; `.once`, `.capture` and `.passive` are rejected. A watcher's flush runs between element and document listeners, as Svelte's does.
  - Vue ignores a bubbling listener attached at or after the event's timestamp. Under the harness's paused clock (cases with `wait`), listeners attached at mount would be skipped, which no running page shows. Case `events-vue` therefore starts with a 1 ms wait.

### Selects and radio buttons in React and Vue (step 3)

Checked against React 19.3.0 and Vue 3.5.43 in Chromium 153 (react-dom `updateOptions`, `restoreControlledState`; runtime-dom `vModelSelect`, `vModelRadio`, `patchProp`):

- **React selects** (`value` with `onChange`). React applies the value at mount, at every commit of the select and after its `change` event: the option with that value, else the first enabled option (a value no option has does not show none, as in Svelte and Vue). The IR's `selectValue` property. A select whose `onChange` writes no state snaps back right after the change; its handler sees the picked value. Uncontrolled selects (no `value`) are supported; `defaultValue` (React marks the option `selected`) and `multiple` are rejected, as are controlled selects without `onChange` (React restores them after events without listeners, the IR after events with listeners), `preventDefault` in their `onChange` (the synthetic event reports itself prevented), text and components inside a select, and window or document `input` listeners in programs with controlled selects.
- **React radio buttons** (`checked` with `onChange`, which comes from the click). After the event React restores the target and every radio button of its group to their props. A named group must be provably exclusive: its buttons sit in one component with one instance, outside lists and slot content, and are checked by comparing one value with distinct string literals (`checked={size === 's'}`). The IR applies `checked` to one button, while the DOM unchecks the rest of the group when one is checked, so two checked at once cannot be modelled. A click handler that may cancel the click on a radio button and writes state is rejected (the browser re-checks the previous button after React's restore).
- **Vue selects.** `v-model` (vModelSelect: setSelected after the mount and every update, none for a value no option has) and `:value` (patchProp: the property where it differs at every re-render, and the `value` attribute) both apply at every re-render (`restore: "render"`); vModelSelect skips only the update where the model is the value it just assigned, which the control already shows. Option values bound with `:value` must be strings (v-model assigns `_value` itself).
- **Vue radio buttons.** `v-model` with a literal value (`value="s"` or `:value="'s'"`): checked where the model equals it, set when the model changes (the IR's per-element cache is equivalent while the group shows its model, which effects writing the model could break: rejected). `:checked` on radio buttons is rejected: Vue patches it only when it changes, so a click the state does not follow leaves the DOM out of step, and the IR does not uncheck the group when a script checks a button.
- **v-model and @change** on one select or radio button are separate native listeners in Vue, with a microtask checkpoint (and the flush) between them; the IR merges them into one handler. Supported where that flush is unobservable: no watchers or lifecycle hooks in the program, and, on radio buttons, `@change` does not write the model (Vue would set the buttons in both flushes).
- **Interpreter.** With `controlledRestore` the interpreter restores at the renders the runtime syncs at (updates, and after each dispatch that ran listeners), no longer at every render: between a picked option's `input` and `change` it kept the restored value, so `onChange` saw the old one.

### The virtualized list (step 7)

`examples/virtual-list-{svelte,vue}`: 10,000 rows of 24 px in a 288 px scroller; only the rows in view plus three above and below are rendered, positioned by the spacer's `padding-top` and recomputed from `scrollTop` and `clientHeight` in the list's `scroll` event. Rows select on click, "Jump to 5,000" sets `scrollTop`, and a filter shrinks the list. Facts checked against Chromium 153 (Svelte 5.57.1, Vue 3.5.43, React 19.3.0):

- **Scroll listeners.** Svelte's `onscroll` and Vue's `@scroll` are native listeners on the element; their framework flush runs in the microtask checkpoint after the listener, before the animation frame callbacks of the same rendering step (which see the new DOM). The event reaches the target only.
- **React's `onScroll`** is a listener on the element too, dispatched to the target only (React 17 and later), but `scroll` has continuous priority: the update renders in a scheduler task after the frame is painted (an animation frame callback of the same rendering step sees the old DOM), or with the next discrete update. It is accepted under the rule for continuous events: state it updates is rendered as text only (case `scroll-events`). The virtualized list derives its rows from that state, so React's version is rejected with a located diagnostic (`tests/react-events.test.mjs`); supporting it needs a model of React's continuous lane in the IR (render in a later task, merged into the next discrete update) or `flushSync`. Window `scroll` and `resize` listeners in React apps are rejected for the same reason, and `e.preventDefault()`/`e.defaultPrevented` in `onScroll` (React reports the non-cancelable event prevented).
- **Clamping.** Content that shrinks clamps the scroll position in layout; a layout read after the DOM update already sees the clamped value. The `scroll` event follows in the rendering step of the second frame after the change, also when a forced layout clamped it earlier. Blitz keeps the old offset, so the runtime clamps after every layout it runs and frames queue the events (`layout::resolve`, `Native::layout_frame`).
- **Probe frames.** The probe runs two frames after each action (rendering step, then layout), as the browser harness waits for two animation frames.
- **Pointer targets.** Before a pointer action Playwright calls `DOM.scrollIntoViewIfNeeded`, whose alignment is center-if-needed: no scroll for a fully visible target, the closest edge for a partly visible one, centred for a hidden one (measured on the list: at `scrollTop` 700 a fully visible row stays, a row cut at the top scrolls to 696, one cut at the bottom to 720, an overscan row below to 900). The probe does not model it and refuses pointer targets that are not fully visible in their scroll containers and the viewport; the cases click visible rows.
- **Measured** (release, this host, 2026-10-04): 14.48 MiB and 31 ms to the first frame for either example (`conformance/measure.mjs`, Xvfb, CPU renderer; 7GUIs CRUD: 14.45 MiB, 27 ms). Per scroll, timed by a release probe from the wheel event through the scroll event, the framework's update of the rows and layout (two frames, painting excluded), median over 3 runs: 0.24 ms for one row (Svelte; Vue 0.25), 0.30 ms for half a view (0.32), 0.44 ms for a jump of 50 rows that replaces every rendered row (0.45); p95 at most 0.52 ms.

## Progress

| Step | State |
|---|---|
| 1. Events, window and document listeners | Done for Svelte, React and Vue (cases `events`, `events-vue`, `shortcuts`) |
| 2. Rest props and spread, `class:`, `style:`, component refs | Done for Svelte (cases `rest-props`, `class-directives`, `style-directives`, `component-refs`), React (`rest-attrs-react`, `component-refs-react`, `style-objects`) and Vue (attribute fallthrough, `v-bind` spreads, `:class`, `:style`, template refs) |
| 3. Forms | `textarea` and `label` done for Svelte, React and Vue (cases `forms`, `forms-react`, `forms-vue`); `select` with its popup and radio buttons done for Svelte (cases `select`, `select-popup`, `radio`), React (`select-react`, `select-popup`, `radio-react`) and Vue (`select-vue`, `select-popup`, `radio`) |
| 4. Document element, `matchMedia`, layout reads, scrolling | Document element and `matchMedia` done for Svelte, React and Vue (case `theme`, crate `runic-css`); layout reads, scrolling and `scroll` events (case `measure`; scroll listeners in Svelte, Vue and React, scroll clamping when content shrinks: case `scroll-events`), media query lists with `change` events and the window `resize` event (case `media-events`) done. `ResizeObserver` moves to M6: the editor uses it only through its libraries (bits-ui, floating-ui) |
| 5. Services | Done: `RegExp` (`runic-js` over `regress`, case `patterns`); `Date` and `Intl` (cases `time`, `time-berlin`, `time-new-york`; `Intl.PluralRules`/`DisplayNames` still rejected); console, clipboard, history and location, randomness (cases `console`, `clipboard`, `hash-router`, `hash-router-start`, `randomness`; Svelte fixtures, the lowering is shared) |
| 6. Focus model | Focus events, `focus()`/`blur()`, `tabindex` and Tab order done for Svelte, React and Vue (case `focus`); blur and focusout when the focused element is removed or moved by a keyed diff, nested in the update (case `edit-blur`, all three frameworks; React DOM ignores events during its commit); focus fixup in the rendering step for disabled (and, natively, hidden) focused elements (case `focus-fixup`); the M3 gap (case `reorder-navigation`) to do |
| 7. Examples | 7GUIs Flight Booker, Circle Drawer and Cells done for Svelte, React and Vue (cases `7guis-flight`, `7guis-circles`, `7guis-cells`; notes below); virtualized 10,000-row list done for Svelte and Vue (case `virtual-list`); React rejected (scroll updates render after the frame, see below) |

## Notes from step 7 (7GUIs examples)

The examples follow the [7GUIs tasks](https://eugenkiss.github.io/7guis/tasks); each shared model file (`dates.ts`, `circles.ts`, `sheet.ts`) lists where an example differs and why. What they needed from the shared layers:

- **Pointer positions in cases.** Pointer actions (`click`, `dblclick`, `contextmenu`, `hover`, `wheel`) take an optional `position` (`{x, y}` from the top-left corner of the element's padding box, Playwright's option); the probe aims at the same point. The interpreter has no layout and ignores it. Circle Drawer clicks and hovers at canvas positions.
- **Single-line text inputs scroll back on blur.** Chromium scrolls the inner editor of a text input back to its start when it loses focus (before the `blur` listeners); text areas keep their scroll. Blitz kept the offset the caret last needed, so a value set later while the input was unfocused (a Cells cell whose value changed through a dependency after its long formula was edited) was drawn scrolled out of view, blank. The runtime now resets it on every focus loss (`controls::reset_scroll_on_blur`). The defect cost 0.1 to 0.2 mean pixel error, below the 3/255 tolerance: the pixel gate does not catch a few missing words, so screenshots of new cases deserve a look.
- **React continuous events and paint-only styles.** State that move, enter and leave handlers update may be rendered in inline style colours (`color`, `background-color`, the border colours, `outline-color`, `text-decoration-color`, `caret-color`) as well as in text: a colour changes no layout, hit testing or focus, so when React renders it is unobservable. Other inline style properties now count as non-text reads (the check ignored `style` objects before). Circle Drawer fills the hovered circle this way in all three frameworks.
- **Codegen:** `forEach` with a callback value (a closure capturing locals) did not compile (the adapter closure was called in place, leaving Rust nothing to infer its parameter types from).
- **Language layer:** `?.` on a value the IR has as never nullish but TypeScript sees as nullable through a cast (`(e.target as HTMLInputElement | null)?.blur()`) produced ill-typed IR; it now behaves like `.`.
- **Selects need their UA display.** The runtime draws a closed select as an `inline-grid` stacking its options; an author `display: block` stacks them as blocks (one row per option). Flight Booker keeps the select a flex item (blockified to `grid`). `<input type="range">` is not supported, so Circle Drawer adjusts the diameter with buttons.
- **Cells at full size.** 26 × 100 text inputs (2,600 controls) stay fast enough to keep the whole grid: release first frame 58–61 ms on Xvfb (median of 7; 7GUIs CRUD 26 ms, so about 33 ms for the grid), 14.4 MiB like the other examples; the debug probe mounts it in 0.35–0.4 s.

## Synchronous DOM access (steps 4 and 6)

Some host operations act on the document while a script runs, in Chromium:
- `getBoundingClientRect()`, `offsetWidth`, `scrollTop` force layout and read it;
- `scrollTo()` and `scrollIntoView()` scroll at once;
- `el.focus()` and `el.blur()` move focus and dispatch `blur`, `focusout`, `focus` and `focusin` before they return. Those listeners run nested, with no microtask checkpoint, since the script stack is not empty.

M3 queued focus requests until the callback returned, which is not observable while no focus listeners exist. With focus events it is.

**Design.**
- While the runtime runs app code (a task, a job, the mount), the generated context holds a handle to the document (`cx.host`), cleared afterwards.
- Layout reads resolve layout first, then read Blitz's boxes.
- Focus changes go through one runtime function used by every source: mousedown, Tab, label activation, script, a disabled or removed focused element. It returns the focus events in Chromium's order, as deliveries.
  - Script-initiated changes run those listeners nested, inside the built-in call.
  - User-initiated ones dispatch them as ordinary events.
- The interpreter has no layout. Programs that read layout are compared browser against native only: the differential harness reports them as not comparable rather than passing them. Focus events, which need no layout, are modelled in the interpreter too.

`scroll` events and `ResizeObserver` callbacks run in Chromium's rendering steps (scroll events before `requestAnimationFrame` callbacks, resize observations after layout). They need the frame model, which the probe gains with them.
