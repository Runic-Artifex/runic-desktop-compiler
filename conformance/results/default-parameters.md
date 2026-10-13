# Parameters with defaults and instanceof over pack class unions (2026-10-13)

Two language gaps (docs/gaps/LANGUAGE.md): a function with a default
parameter called without that argument produced invalid IR (the omitted
argument was an `undefined` of the non-nullable parameter type), and
`instanceof` of a pack class over the `@internationalized/date` class union
in bits-ui's untyped date helpers was rejected. Defaulted parameters are now
`maybe<T>` for callers (function types, the parameter list) with the default
applied in the body as JavaScript applies it; `instanceof` of a source or
pack class whose operand TypeScript types `any` is decided by the operand's
IR type, and `instanceof Date` by the IR type. Compiler on main `81fa6d9`;
no backend change. Chromium 153.0.8010.12, CPU renderer.

| Check | Result |
|---|---|
| `node conformance/run.mjs default-parameters --pixels` (fixtures `default-parameters-svelte`, `default-parameters-react`; 7 actions: defaults left out, passed undefined and null, an arrow's default with an effect per call, a function value of a type taking fewer arguments, an array callback, methods, constructors and `super(…)`, a runed `watch` callback's default previous value; the date helpers' `instanceof` over `CalendarDate`, `CalendarDateTime`, `ZonedDateTime`, undefined and a `Date`) | semantics, geometry and pixels passed at 800x600 and 420x600 for both fixtures |
| `node conformance/differential.mjs default-parameters-svelte default-parameters-react` | complete: 1040 steps, 0 failures |
| IR of the other conformance fixtures (`analyze` at `81fa6d9` and on the branch, pack source paths normalised) | 220 of 238 byte-identical; 18 changed (below) |
| `node conformance/run.mjs <the 19 cases of the 18 changed fixtures> --pixels` | all passed at both viewports, but the known 420px pixel gap of `bits-toggle-group` ([BLITZ-GAPS](../../docs/BLITZ-GAPS.md)) |
| `node conformance/differential.mjs <the 18 changed fixtures>` | `bits-checkbox-examples`, `bits-checkbox`, `script-dom-announcer`, `symbol-context`: complete, 0 failures; the 14 others incomplete as before (they read layout: computed style, animations, `scrollIntoView`, `scrollX`) and verified by the conformance runs above |

The 18 changed fixtures are bits-ui's (accordion, accordion-multiple,
checkbox, checkbox-examples, dialog, dropdown-menu, pagination, popover,
select, sheet, tabs, toggle-group, toggle-group-single, tooltip), `id-counter`,
`kit-docs`, `script-dom-announcer` and `symbol-context`. Their changes are of
three kinds: a typed function with a default now takes `maybe<T>` (bits-ui's
`focus`, `focusFirst`, `CustomEventDispatcher`, the fixture's `getTone`), its
callers pass `some(…)` or undefined; an untyped package function specialised
for a nullable argument binds the parameter's name to a local holding the
argument or the default instead of assigning the parameter (`useId`,
`getDirectionalKeys`, `getNextKey`, `getPrevKey`, `getTopMostDismissableLayer`,
the floating layer's `create` functions); and a dead default of a parameter
every caller passes a non-nullable value is no longer lowered (`debounce`'s
`wait = 500`, `next`/`prev`/`forward`/`backward`).

Census (`node conformance/triage.mjs --jobs 4`, 404 examples): 280 lowered,
as at main; none gained or lost. The 8 calendar examples, range-calendar-demo
and the date-picker basic, demo, dob, range and time examples moved from
`instanceof` in bits-ui's date utils (utils.js:115) past the formatter's
options (formatter.js:94) and `instanceof Date` (utils.js:127) to
`dateObj.set({ day: i + 1 })` in the untyped `createMonth`
(calendar-helpers.svelte.js:52), a method dispatched over the class union
through a receiver TypeScript types `any` (docs/gaps/LANGUAGE.md).

## Package globals before the constants that reach them (fix)

An app module constant constructing `@internationalized/date` classes
(`const values: DateValue[] = [new CalendarDate(…), …]`) made the native app
panic at start-up (`RangeError: Array index 1 is out of range`): the port's
month-length tables, created when the constructor's code was first reached,
came after that constant among the program globals. Package globals are now
initialised before every global whose initialiser reaches them (directly or
through the functions it calls or creates), as JavaScript evaluates a
package before the modules importing it; other globals keep their order.
The case's Svelte fixture builds its date values as such a module constant.
