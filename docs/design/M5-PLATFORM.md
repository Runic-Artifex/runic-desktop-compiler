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

- **Event objects.** Handlers may read `event.target`/`currentTarget` (value, checked), `key`, modifier keys, pointer coordinates and `button`, and call `preventDefault()`/`stopPropagation()`. The IR event payload becomes a record per event kind; `preventDefault` affects the runtime's default action (activation, text input), `stopPropagation` ends bubbling.
- **Kinds:** `focus`/`blur` (no bubbling) and `focusin`/`focusout`, `dblclick`, `pointerdown/up/move/enter/leave` and the mouse equivalents, `wheel`, `scroll`, `input`/`change` on all controls, `submit`.
- **Window and document targets:** `<svelte:window>`, `<svelte:document>`, `window.addEventListener`/`removeEventListener` (Vue and React through effects) for `keydown` shortcuts, `resize` and `pointerdown` outside popovers.
- **Delivery:** the order of listeners per element and per phase follows the DOM (capture, target, bubble). Svelte's delegated events and React's root listener keep their observable ordering relative to native listeners on `window`.

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

1. Rest props and spread attributes, `class:`/`style:` directives, component refs (`bind:this` on components through `$bindable` refs).
2. Event objects and event kinds; window and document listeners.
3. `textarea`, `select`, radio buttons.
4. Document element, `matchMedia`, layout reads and scrolling.
5. Services: console, clipboard, history, `Date`/`Intl`, `RegExp`, randomness.
6. Focus model and the remaining M3 known gap.
7. Examples: 7GUIs Circle Drawer and Cells; a virtualized 10,000-row list.

Steps 3 and 5 split into independent subagent tasks per control family and service once steps 1 and 2 fix the IR shape.
