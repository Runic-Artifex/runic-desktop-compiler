# shadcn-svelte example census with dynamic values (2026-10-12)

The [example census](shadcn-svelte-census.md) rerun with every host setting `runic.json` `"dynamicValues": true` (`node conformance/triage.mjs --dynamic-values --jobs 4`, the same corpus and hosts), and without it, from the compiler with the opt-in as a fallback (dynamic values only where the static rules reject a value; [design](../../docs/design/M6-DYNAMIC-VALUES.md)), to check that the opt-in loses no example.

**With the opt-in: 264 lowered, 140 rejected. Without it: 261 lowered, 143 rejected.** 0 harness errors, 0 internal errors and no `E_IR` in either run. The lowered set with the opt-in is a superset of the one without it, compared per example: it gains pagination-demo, pagination-icons-only and pagination-simple and loses none. Without the opt-in the census lowers the previous 260 examples and field-select, whose constant passed to Select's `items` no longer yields invalid IR. (The first measurement of the opt-in, from `206a5da`, lowered 168 against 260: it typed values `dyn` that the static rules already type.)

The largest remaining clusters with the opt-in:

| Examples | First diagnostic with the opt-in | Location |
|---|---|---|
| 16 | E_CLASS `CalendarDate is a library class` | `bits-ui/dist/internal/date-time/utils.js:20` |
| 10 | E_DEPENDENCY `No mapping pack for dependency vaul-svelte` | `ui/drawer/drawer.svelte:12` |
| 10 | E_CLASS `this inside a function that may run while the instance is built` | `bits-ui/dist/bits/menu/menu.svelte.js:1492` |
| 9 | E_CLASS `Field PinInputRootState.#regexPattern needs a type` | `bits-ui/dist/bits/pin-input/pin-input.svelte.js:42` |
| 7 | E_TYPE_UNSUPPORTED `Unsupported type T` | `svelte-sonner/dist/toast-state.svelte.js:290` |
| 6 | E_TYPE_UNION `The default of name ({"maybe":"dyn"}) is not a value of the prop's type ("string")` | `bits-ui/dist/bits/checkbox/components/checkbox.svelte:18` |

36 examples rejected in both runs stop at another diagnostic with the opt-in. For most, the untyped value they stopped at without it (a union in the floating layer, `#regexPattern`'s initialiser, Slider's props, native-select's value) is dynamic, and the next blocker is of another kind. Checkbox's `name` stays rejected at the same prop, now by its default: a gap of the fallback ([gap register](../../docs/gaps/LANGUAGE.md#dynamic-values-opt-in-spike)).
