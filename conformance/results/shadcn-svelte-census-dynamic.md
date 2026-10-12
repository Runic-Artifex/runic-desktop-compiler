# shadcn-svelte example census with dynamic values (2026-10-12)

The [example census](shadcn-svelte-census.md) rerun with every host setting `runic.json` `"dynamicValues": true` (`node conformance/triage.mjs --dynamic-values --jobs 4`, compiler `206a5da`, the same corpus and hosts), to measure how far the opt-in dynamic value tier ([design](../../docs/design/M6-DYNAMIC-VALUES.md)) covers the census's untyped-value blockers.

**168 lowered, 236 rejected**, 0 harness errors, 0 internal errors; without the opt-in, 260 lowered. Two examples gain (pagination-demo, pagination-simple) and 94 that lower without it are lost: the opt-in types values as `dyn` that the typed path's rules already type, and then rejects what it cannot do with them. It does not yet act as a fallback for the values the typed path rejects only.

| Lost | First diagnostic with the opt-in | Location |
|---|---|---|
| 33 | E_UNRESOLVED `win is not a supported binding here` | `bits-ui/dist/internal/floating-svelte/floating-utils.svelte.js:10` |
| 32 | E_MEMBER `Unsupported property current on this value` | `bits-ui/dist/internal/roving-focus-group.js:14` |
| 19 | E_UNRESOLVED `doc is not a supported binding here` | `bits-ui/dist/bits/utilities/focus-scope/focus-scope.svelte.js:134` |
| 11 | E_TYPE_UNION `string \| number \| string[] \| null \| undefined` | `ui/textarea/textarea.svelte:7` |
| 10 | E_MEMBER `Element dataset is unsupported (…)` | `bits-ui/dist/bits/select/select.svelte.js:130` |
| 10 | E_MEMBER `Unsupported element access` | `bits-ui/dist/bits/tooltip/tooltip.svelte.js:73` |

(Counts are per cluster over all examples, including ones rejected without the opt-in.) The opt-in also produces IR the backend validator rejects in 6 checkbox examples (`E_IR: Initialiser type differs from cell name`, `bits-ui/dist/bits/checkbox/components/checkbox.svelte:18`): a frontend defect, not a rejection. The untyped blockers it was measured for move on: pin-input to an untyped `#regexPattern` field, svelte-sonner to an unsupported type `T`.
