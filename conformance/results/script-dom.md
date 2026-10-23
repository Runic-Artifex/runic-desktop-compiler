# Script DOM (M6, docs/design/M6-SCRIPT-DOM.md)

## Slice 1: the announcer (2026-10-13)

The document and the window as values, nodes script creates and the child
lists script owns, text and attribute writes, `style.cssText`, and the body's
content before the container in snapshots. Driving consumer: bits-ui
2.19.2's announcer (`internal/date-time/announcer.js`). Compiler on main
`1e742eb`; Blitz and the other forks unchanged. Chromium 153.0.8010.12, CPU
renderer.

| Check | Result |
|---|---|
| `node conformance/run.mjs script-dom-announcer --pixels` (fixture `script-dom-announcer-svelte`, 19 actions: announcements before and after the region exists, a polite announcement removed by its 500 ms timer, a second `getAnnouncer(document)` finding the region, lines script inserts and clears in a childless element) | semantics, geometry and pixels passed at 800x600 and 420x600; also with `--no-opt` |
| Snapshots | the browser and the native traces agree at every step on the region before the container (`preceding`), the status text read back through `document.querySelector(...).textContent`, the `<br>` of `innerText`, and the script host's lines |
| `node conformance/differential.mjs script-dom-announcer-svelte --traces 20` | complete: 520 steps, 0 failures (the interpreter models the script DOM of the case) |
| IR of the other conformance fixtures (`analyze` at the base commit and on the branch) | 235 of 235 byte-identical |
| `npm test` | 477 passed, 0 failed (5 new in `tests/script-dom.test.mjs`) |
| `node compiler/cargo.mjs test --offline --workspace` | 179 passed, 0 failed (new: `dom::tests::script_nodes_move_within_child_lists_script_owns`, `script_dom::tests`) |

Census (`node conformance/triage.mjs --jobs 4`, 404 examples): 280 lowered,
as at main `1e742eb`; none gained or lost. 22 rejected examples moved past
their first blocker: the 8 calendar examples, range-calendar-demo and the
date-picker basic, demo, dob, range and time examples from the announcer's
document parameter (announcer.js:49) to `instanceof` of an untyped value in
bits-ui's date-time utils (utils.js:115); the 6 carousel examples from the
document in embla's API type to an overloaded function value of that type
(context.ts:33); hover-card-demo and hover-card-sides from svelte-toolbelt's
`DOMContext.getDocument()` to `getSelection()` of the document
(link-preview.svelte.js:49).

## Slice 2: node breadth (2026-10-13)

Text, comment and fragment nodes, node kinds and data, node-level traversal
where script owns the child list, live lists read where used, the
ChildNode/ParentNode insertions, `removeChild`/`replaceChild`, `cloneNode`,
`classList` and `dataset`, `instanceof` of the node interfaces. Compiler on
main `e78a676` (Stylo 3a2013ca, Blitz c8760598).

| Check | Result |
|---|---|
| `node conformance/run.mjs script-dom-nodes --pixels` (fixture `script-dom-nodes-svelte`, 9 actions: a fragment of strings, a comment, an element and a text node appended and read back; nodeValue writes and before/after/prepend/replaceWith; replaceChild and removeChild; deep and shallow clones of a rendered element; classList and dataset on a script element and a rendered one; replaceChildren; then again) | semantics, geometry and pixels passed at 800x600 and 420x600 |
| Snapshots | browser and native agree at every step, including `class=""` left by removing the last token |
| `node conformance/differential.mjs script-dom-nodes-svelte script-dom-announcer-svelte --traces 20` | complete: 1040 steps, 0 failures (the interpreter now also models script attribute writes on rendered elements) |
| `npm test` | 480 passed, 0 failed (3 new) |
| `node compiler/cargo.mjs test --offline --workspace` | 180 passed, 0 failed (new: `script_dom::tests::class_lists_follow_the_dom_standard`) |
| IR of the other conformance fixtures (`analyze` at slice 1 and now) | 238 of 238 byte-identical |
| Cases whose programs use `instanceof Element`/`HTMLElement` (generated code changed): bits-accordion, -accordion-multiple, -checkbox, -checkbox-examples, -dialog, -dropdown-menu, -popover, -select, -sheet, -tabs, -toggle-group, -toggle-group-single, -tooltip, script-dom-announcer, script-dom-nodes, unions, `--pixels` | all gates passed (bits-toggle-group 420x700 with its declared glyph-coverage gap) |
| Census | 280 of 404 lowered, unchanged; no example changed its first blocker (the north-star blockers are past this slice) |

## Slice 3: events (2026-10-14)

Listener options at every node handle, events script creates and dispatches
(DOM standard dispatch), `CustomEvent` details at their types, init members,
template listeners of custom types (Svelte's `on<type>`), feature tests of
host objects, and the report of listeners script adds whose order with a
framework's delegated template listeners may differ. Compiler on main
`7906771`.

| Check | Result |
|---|---|
| `node conformance/run.mjs script-dom-events --pixels` (fixture `script-dom-events-svelte`, 13 actions: capture given twice, once with a named function, a passive listener's preventDefault on a checkbox and a cancelling one, a document `once` key listener and a window capture listener, CustomEvent with a typed detail bubbling to an `ontick` template listener and cancelled by an ancestor, a non-bubbling one, a MouseEvent with init members, an Event at a script node bubbling to the document, InvalidStateError of a re-entrant dispatch, removeEventListener by capture flag) | semantics, geometry and pixels passed at 800x600 and 420x600 |
| Snapshots | Chromium's and the native log agree at every step (Chromium's console intervention for the passive listener's preventDefault is a diagnostic, not an app line) |
| `node conformance/differential.mjs script-dom-events-svelte script-dom-nodes-svelte script-dom-announcer-svelte --traces 20` | complete: 1560 steps, 0 failures |
| IR of the other conformance fixtures (`analyze` at `7906771` and now) | 220 of 228 identical; 8 changed where element listeners script adds now lower to `target.listen` (bits-dropdown-menu, -popover, -select, -tooltip, floating, form-submit-element-listeners-svelte/-vue, form-submit-stops-vue) |
| Cases whose programs use listeners script adds, events script creates or dispatches (generated code changed): bits-command, -dialog, -popover, -select, -sheet, -tooltip, floating, form-submit-element-listeners, form-submit-stops, id-counter, overlay-host, script-dom-announcer, script-dom-nodes, script-dom-events, hover-events, hover-targets, `--pixels` | all gates passed |
| bits-dropdown-menu | reported unsupported at run time (both viewports): bits-ui's menu adds `pointermove` listeners with `addEventListener` to the sub-trigger and the content, whose items' Svelte `onpointermove` handlers Svelte runs from its delegation root, after them; the runtime runs them at the items, before them. The case passed before only because the order did not change its outcome; the delegation model (P2 row) would cover it |
| `npm test` | 515 passed, 0 failed (6 new in `tests/script-events.test.mjs`) |
| `node compiler/cargo.mjs test --offline --workspace` | 186 passed, 0 failed (new: `event::submission_tests::listening_by_type_and_target`, `script_events_dispatch_once_at_a_time`) |

## Svelte delegation and Vue's element listeners (2026-10-14)

`schedule.delegation` (Svelte's delegated kinds run from its delegation
roots), bubbling events reaching the whole ancestor chain natively, and
`schedule.elementListeners` (Vue's template listeners are native listeners of
their elements, registered when Vue creates them). React programs get
`E_EVENT` where a listener script adds meets their handlers of its kind, and
a run-time report for types known only at run time. The report now runs for
nested dispatches natively as well (`run_nested_inner`), as it already did
in the interpreter. Rebased onto main `15889dd`.

| Check | Result |
|---|---|
| `node conformance/run.mjs element-listeners-vue --pixels` (new fixture `element-listeners-vue`, 12 clicks: script listeners after the template's at the target and its ancestors, capture at the target before bubble, a microtask after its listener, stopPropagation in a script listener below a template one, stopImmediatePropagation in a template listener, nested `dispatchEvent` and `requestSubmit` reaching second template listeners from a later task) | every gate passed at both viewports |
| Native and interpreter reports on nested dispatches (React; new fixture `nested-order-react`) | both engines report `requestSubmit` (order check) and `dispatchEvent` of a native click (template listener on its path) with the same message; the probe stops (`.cache/tools/probe-report.mjs`); `tests/script-events.test.mjs` checks the interpreter and that generated code calls the check. The fixture is left out of the differential, which has no model of a run-time report |
| Svelte cases with `--pixels` (176 cases with a Svelte fixture, in batches of 25 under 2 h: `.cache/sv25-00` … `-07`) | 25+25+25+25+25+25+25+1 cases, 83+79+72+69+75+89+72 viewport runs plus form-submit: every gate passed apart from declared known gaps (capitalize and fieldset pixels, reorder-navigation semantics, bits-toggle-group 420x700, text-elements pixels) |
| Main's new cases (array-writes, equal-writes, deep-tracking, watch-declared, watch-instances, effect-self-react, unmount-updates, teardown-vue, animation-fill, animation-fill-api) and form-submit, `--pixels` | 27 runs, every gate passed |
| Vue and React cases whose programs add listeners or submit by script (form-submit, -listeners, -listeners-physical, -element-listeners, -stops, -requests, -priority, -capture, shortcuts, classes), after `elementListeners` | every gate passed (form-submit-element-listeners-vue and form-submit-stops-vue again pass natively) |
| Full differential (20 traces x 25 actions; 10 chunks, Vue and React fixtures rerun after `elementListeners`) | 240 fixtures: 186 complete, 54 incomplete, 0 failures, 98953 steps. Main `15889dd`: 234 fixtures, 181 complete, 53 incomplete, 0 failures. The incomplete fixtures are the known categories: layout reads, images, hidden pointer targets, focus events without a differential action, and the eight with no reason given on main too (blend, blitz-gradients, blitz-inline-baselines, media-preferences, portal, rest-react/-svelte/-vue). animation-fill-api-svelte, added to main after its run, reads layout (`getAnimations`). Before `elementListeners`, form-submit-stops-vue and form-submit-element-listeners-vue failed: the interpreter reported Vue's order on nested dispatches and native code never checked them |
| IR of every fixture (`analyze` at `15889dd` and on the branch; 11 expected rejections the same on both sides) | 98 identical; 132 Svelte fixtures differ only by `schedule.delegation`; 8 by `target.listen` (bits-dropdown-menu, -popover, -select, -tooltip, floating, form-submit-element-listeners-svelte/-vue, form-submit-stops-vue). With `elementListeners`: the 49 Vue fixtures differ from the step before only by that field, nothing else changed |
| `npm test`, `cargo test --workspace` | 520/520, 192/192 |
| Found, not fixed (gap row) | a capture listener at an ancestor that stops propagation keeps the ancestor's own bubbling listeners from running in Chromium. Both engines still run them (`Event::can_enter`). The same holds on main. The case leaves out its mode-capture-stop steps |

## Capture stops and Svelte's roots at the start of a mount (2026-10-14)

`runic_js::Event` ends a stopped dispatch at its invocation (node and
phase), as the DOM standard does, in every dispatch path of both engines;
Svelte's delegation roots listen from the start of the mount. Compiler at
the task's commit `60cf512` on `f5919bb` (rebased as the branch's first
commit).

| Check | Result |
|---|---|
| `node conformance/run.mjs capture-stop-svelte capture-stop-react element-listeners-vue --pixels` (new cases; the Vue case gets back its three capture-stop steps) | every gate passed at both viewports |
| Svelte cases with `--pixels` (169 cases with a Svelte fixture, 18 batches under 2 h) | 523 viewport runs: every gate passed apart from declared known gaps (capitalize, fieldset and text-elements pixels, reorder-navigation semantics, bits-toggle-group 420x700) |
| Full differential (20 traces x 25 actions, 9 chunks) | 242 fixtures: 188 complete, 0 failures, 100067 steps |

## React's root dispatch, and both tasks on main (2026-10-23)

`schedule.rootDispatch` (React 19 runs its handlers from listeners at the
container in both phases) with task 1, rebased onto main `6c154fc` (CSS
slice 3b part 1, keyed-list order, teardown). The differential found the
interpreter skipping a checkbox's native `change` event after the click
under the root dispatch (17 traces of `root-dispatch-react`); native code
and Chromium fire it for script listeners, and the interpreter now does too.

| Check | Result |
|---|---|
| `node conformance/run.mjs <every case with a React fixture> --fixture <its React fixtures> --pixels` (57 case and fixture pairs in 4 batches, among them root-dispatch-react, nested-order-react, capture-stop-react and the new list-order-react) | 110 viewport runs: every gate passed apart from the declared text-elements-react pixels gap |
| Svelte and Vue event and dispatch cases, `--pixels`: animation-events, array-methods, teardown-order, watch-list, capture-stop-svelte, element-listeners-vue, script-dom-events, bits-dropdown-menu, form-submit-element-listeners, form-submit-stops, and the Svelte and Vue fixtures of hover-events, shortcuts, form-submit and list-order | 39 viewport runs: every gate passed |
| Full differential (20 traces x 25 actions, 7 chunks of at most 40 fixtures) | 254 fixtures: 197 complete, 57 incomplete, 0 failures, 104775 steps. root-dispatch-react is complete; nested-order-react is incomplete (its traces end at a hidden pointer target); the other incomplete fixtures are the known categories (layout reads, among them main's animation-events fixtures, which the interpreter fires none of; images; hidden pointer targets; focus events without a differential action; and those with no reason given on main too) |
| `npm test` | 522 passed, 0 failed (new: the checkbox's native change event under the root dispatch, `tests/script-events.test.mjs`) |
| `node compiler/cargo.mjs test --offline --workspace` | 199 passed, 0 failed |
