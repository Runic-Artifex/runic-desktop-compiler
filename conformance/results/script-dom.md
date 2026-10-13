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
