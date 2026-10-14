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

## Svelte delegation (2026-10-14, in progress)

`schedule.delegation` (Svelte's delegated kinds run from its delegation
roots; React programs `E_EVENT` where a listener script adds meets their
handlers of its kind; Vue reported at run time) and bubbling events
reaching the whole ancestor chain natively (`3389e92`).

| Check | Result |
|---|---|
| bits-dropdown-menu, script-dom-events, `--pixels` | every gate passed at both viewports |
| IR of every fixture (`analyze` at `7906771` and now; 6 expected rejections on both sides) | 91 identical (the React and Vue fixtures); 129 Svelte fixtures differ only by `schedule.delegation`; 8 differ by `target.listen` (bits-dropdown-menu, -popover, -select, -tooltip, floating, form-submit-element-listeners-svelte/-vue, form-submit-stops-vue) |
| Svelte cases re-screened with `--pixels` (176 cases with a Svelte fixture, in batches of 25 under 2 h: `.cache/sv25-00` … `-07`) | batch 00 (25 cases, 83 viewport runs): every gate passed; batches 01–07 pending |
| Full differential | pending |
| `npm test`, `cargo test --workspace` | 515/515, 186/186 |
