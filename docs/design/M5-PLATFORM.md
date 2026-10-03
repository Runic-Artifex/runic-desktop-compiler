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

The props a parent passes are known at each call site, so the rest of them is too. The IR represents them as a per-instance *attribute bag*:

- A component may declare `rest: true`: props a call site passes that the component does not declare are collected into the bag. Each entry is an attribute (`string`, `Maybe<string>` or `boolean`, coerced as the framework coerces attributes) or a listener (`on<event>` with a function value).
- An element with `"spread": true` applies the instance's bag after its own attributes. The framework's precedence holds (later wins, `class` merges where the framework merges it).
- Natively the bag is a list of `(name, value)` with a runtime attribute value type, so one generated component serves call sites passing different props. Listener entries register with the runtime by event name.
- Rest props read by name in script (`restProps.id`) are rejected in the first step; forwarding is the dominant use.

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
