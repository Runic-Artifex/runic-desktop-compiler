# Gaps: packages, packs and library code

Part of the [gap register](../GAPS.md). Locations as of commit `9add179` (2026-10-07). Clusters: **L1** packages without a pack or source entry, **L2** bits-ui parts, **L3** pack exclusions, **L4** untyped package code.

## Packages without a pack or source entry (L1)

A package import is `E_DEPENDENCY` unless a mapping pack covers it or it is compiled from source (`frontend/sources.ts`: bits-ui 2.19.2 only). Exact versions only (`E_SOURCE_VERSION`, `E_PACK_VERSION`).

| Package | Imports in the shadcn-svelte site (scan) | Needed by | Notes |
|---|---|---|---|
| `@tabler/icons-svelte` | 119 | site icons | Icon pack like lucide's |
| `layerchart`, `d3-scale`, `d3-shape` | 100, 75, 47 | charts | Large; SVG text and gradients (P1) |
| `@internationalized/date` | 63 | calendar, date pickers | Planned M6 pack |
| `@tanstack/svelte-table` | 26 | data table | |
| `svelte-sonner` | 21 | toasts, site shell | |
| `shadcn-svelte` (workspace) | 16 | site | |
| `mode-watcher` | 14 | site shell | cookies/localStorage, media queries |
| `zod` | 10 | forms | probes `eval`; compile its jitless path |
| `vaul-svelte`, `formsnap`, `paneforge`, `sveltekit-superforms` | 9, 8, 6, 5 | drawer, forms, resizable | |
| `@hugeicons/*`, `@dnd-kit*`, `embla*`, `chrono-node`, `little-date`, `package-manager-detector`, `lodash`, `qrcode`, `@shadcn-svelte/parity` | 7, 8, 3, 2, 2, 3, … | various | `shiki` is generation-only |
| bits-ui 2.19.5 (the editor's version) | — | Translations Editor | Add the version |
| Site pins not matched by packs: `@lucide/svelte` 1.27.0, runed 0.37.1, tailwind-variants 3.3.0, tailwind-merge 3.6.0 | — | the site as pinned | Checked identities and vectors (M7 prerequisite) |
| React: Radix UI, lucide-react, class-variance-authority, `react-hook-form`, … | — | shadcn/ui examples (M7) | Nothing started |
| Vue: reka-ui, lucide-vue-next, `@vueuse/core`, … | — | shadcn-vue examples (M7) | Nothing started |

## bits-ui parts (L2)

bits-ui compiles from source; parts with a conformance case are in [CONTRACT](../CONTRACT.md#packages). Parts without one, with the first blocker found:

| Part | Blocker | Source |
|---|---|---|
| Slider | `number \| number[]` value union (V1) | design/M6-LIBRARIES |
| ScrollArea | scoped component style | design/M6-LIBRARIES |
| AspectRatio | `E_ATTRS` | design/M6-LIBRARIES |
| PinInput (input-otp) | Since 2026-10-12 the `onComplete` callback is typed (by its `noop` default); next `pattern: ReadableBox<any>` in its state's options (V2, frontend). Beyond that it needs the runtime: the text control's selection (`selectionStart`/`End`/`Direction`, `setSelectionRange`), the document's `selectionchange` event (also dispatched by script), a `<style>` element the state creates and fills with `sheet.insertRule` (`::selection`, `:autofill` rules), `DOMContext.getDocument()`/`getElementById`, and `input.dispatchEvent(new Event("input"))` | bits-ui pin-input.svelte.js |
| Pagination | `E_TYPE_UNSUPPORTED` without dynamic values; with the opt-in it passes case `bits-pagination` | design/M6-DYNAMIC-VALUES |
| Avatar.Image | images (P7) | CONTRACT |
| Meter, RadioGroup | lower; no case yet | design/M6-LIBRARIES |
| Menubar | the shadcn-svelte census examples lower (2026-10-12); no native case yet | conformance/results/shadcn-svelte-census.md |
| AlertDialog, HoverCard, ContextMenu, NavigationMenu, Calendar, RangeCalendar, DateField, Combobox, Toolbar, LinkPreview | not attempted | — |
| Multiple Select, ToggleGroup/Accordion mixing types in one program | V1 | CONTRACT |
| Command: clearing the search, queries without matches | P3 (comment anchors) | CONTRACT |
| Popover open/close animations | not sampled by the case | CONTRACT |

## Pack exclusions (L3)

| Pack | Not covered | Location |
|---|---|---|
| tailwind-merge 3.7.0 | `extendTailwindMerge`, `createTailwindMerge`, `getDefaultConfig` ("a native port would have to reproduce the whole default configuration") | packs/tailwind-merge-3.7.0.ts:73 |
| tailwind-variants 3.3.1 | `slots`, `compoundSlots`, `extend`, a second config, non-constant configs | packs/tailwind-variants-3.3.1.ts:68-92 |
| clsx 2.1.1 / cn | spreads, computed and repeated keys, non-scalar values, other exports | packs/clsx-2.1.1.ts:255-417 |
| choice (build-time evaluation of pack calls) | open strings without finite domains, string/boolean mixes, array spreads, object defaults and spreads | packs/choice.ts:358-557 |
| @lucide/svelte 1.52.0 | barrel imports, `nonScalingStroke`, `iconNode`, children, listeners; spreads of unknown names, of declared props with a value, of names outside the inline SVG allow-list with a value, and of `aria-*`/`role`/`title` where no `aria-*` or `role` is given explicitly | packs/lucide-svelte-1.52.0.ts |
| runed 0.35.1 | exports other than Context, watch, ElementSize, Previous (watchOnce, IsMounted, PersistedState, …); watch options beyond `lazy`; previous values of several sources | packs/runed-0.35.1.ts |
| svelte-toolbelt 0.10.6 | box members other than `current`, `executeCallbacks` of two functions under one key, boxes of handlers, other exports | packs/svelte-toolbelt-0.10.6.ts |
| @floating-ui/dom 1.7.4 | `autoPlacement`, `inline`, `detectOverflow`, platform overrides, virtual elements, derivable options, RTL scroll origins, `offsetParent` with the root as containing block, SVG children and inline boxes | packs/floating-ui-dom-1.7.4.ts; runtime floating.rs |
| tabbable 6.5.0 | SVG content, `hidden="until-found"`, radio groups across forms, elements inside replaced elements, `displayCheck` other than full | packs/tabbable-6.5.0.ts; runtime tabbable.rs |
| esm-env 1.2.2 | subpaths | packs/esm-env-1.2.2.ts |

## Untyped package code (L4)

Package JavaScript is typed by its declaration files and by inference from its own code (`frontend/package-modules.ts`). Each inference rule covers a pattern found in bits-ui; code outside the rules meets V2 (`E_TYPE_UNSUPPORTED`) or V1. Rules added so far: field types from assignments, parameters from calls (also recursive functions, from their outside calls), empty arrays from pushes, dictionary parameters, constants of `any` literals, runed contexts from their sets, collections from their `set`/`add` calls, nullish returns, option callbacks, local listeners. A call through a declaration file's class counts for its implementation (since 2026-10-07: before, such calls were silently missed, which lowered bits-ui's `setState` for one of its two keys).

| Not covered | Reason | What it would take |
|---|---|---|
| Patterns no rule recognises | Each rule is pattern-specific | More rules per library, or a dynamic tier (see [the approach review](../research/APPROACH-REVIEW.md)) |
| Assurance that a rule's evidence is complete | Rules decide from the calls and assignments they find; a missed site can give a wrong type silently (the `setState` case) | Rules must fail closed: unknown or unresolved sites make the type open |
