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

## Progress

| Step | State |
|---|---|
| 1. Events, window and document listeners | Done for Svelte, React and Vue (cases `events`, `events-vue`, `shortcuts`) |
| 2. Rest props and spread, `class:`, component refs | Done for Svelte (cases `rest-props`, `class-directives`, `component-refs`). `style:` waits for step 4's CSSOM work (now available). React and Vue: to do |
| 3. Forms | Done for Svelte: `textarea` and `label` (case `forms`), `select` with its popup (cases `select`, `select-popup`), radio buttons (case `radio`). React and Vue: to do |
| 4. Document element, `matchMedia` | Done (case `theme`, crate `runic-css`); layout reads, scrolling, `ResizeObserver` and media change events to do |
| 5–7 | To do |

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
