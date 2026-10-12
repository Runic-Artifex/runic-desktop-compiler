# Gap register

Everything the compiler, runtime and verification do not cover yet, with the reason and what covering it would take. It is the list to implement from: the goal is as much working behaviour as possible, and every gap here is behaviour an app cannot have today.

[CONTRACT.md](CONTRACT.md) says what *is* implemented; this register says what is not. [BLITZ-GAPS.md](BLITZ-GAPS.md) keeps the rendering details of the Blitz, Stylo and Taffy gaps, which the register summarises. The register was built on 2026-10-07 (commit `9add179`) from a survey of every diagnostic in the frontend (419 distinct rejections), every unsupported path in the runtime, backend and interpreter (165), and every gap the documents and conformance data record.

**Keeping it current.** A change that adds a rejection or an unsupported report adds a row; a change that covers one removes it (and the contract gains it). Rows name the diagnostic code and the main source location, so `rg` finds the code.

The [targeted Chromium parity plan](research/CHROMIUM-PARITY.md) turns the renderer
subset of this register into ordered work with module owners and verification
gates. The [consolidation checkpoint](../conformance/results/chromium-consolidation.md)
integrated the reviewed table/parity forks through exact Git pins and the four
hover over/out events. The later [bounded forms checkpoint](../conformance/results/form-submit.md)
adds canceled physical/implicit submit and no-argument requests with independent
evidence. Complete CSS tables, remaining renderer/platform failures, reset,
validation and uncanceled submission defaults remain open. The historical
[table worktree experiment](research/BLITZ-TABLES.md) and
[implementation record](../conformance/results/chromium-parity.md) retain their
own failures and acceptance gates. The [font/inline continuation](../conformance/results/chromium-font-inline.md)
records the settled-text repair, remaining focus/nested-inline paint, and font
instance coverage. The [focus continuation](../conformance/results/chromium-control-focus.md)
closes compiled table focus/selection paint and disabled traversal while retaining
UA control geometry, DPR 2 text and other renderer gaps. The
[control-box continuation](../conformance/results/chromium-control-boxes.md)
repairs UA sizing, textarea baselines/overflow, document-mode struts and fontless
selection positions, while retaining span bounds, input centering, native theme
paint and shared DPR metrics as separately owned work.
The [text-metric continuation](../conformance/results/chromium-text-metrics.md)
repairs logical font metric scaling and single-line inner-editor geometry, and
shares signed offsets with pointer selection. Its new oracles retain fractional-DPR
box, glyph-placement, selected-text click and RTL alignment failures. This remains
historical isolated implementation evidence; the consolidation record defines the current bounded integrated surface.
The [line-width continuation](../conformance/results/chromium-line-widths.md)
closes the retained fractional-DPR control-box geometry gap with an opt-in Stylo
policy. Text, input-height and pointer geometry pass 432/432, 504/504 and 264/264;
pixel and pointer-state residuals remain independently open. Its owner-specific
policies are now pinned by the consolidation checkpoint; this does not lift the
compiler sticky/fill or ordinary-inline `getClientRects()` guards.

## Detail

| File | Content |
|---|---|
| [gaps/LANGUAGE.md](gaps/LANGUAGE.md) | Value model and types, language constructs, classes, async, modules |
| [gaps/FRAMEWORKS.md](gaps/FRAMEWORKS.md) | Svelte, SvelteKit, React, Vue features |
| [gaps/PLATFORM.md](gaps/PLATFORM.md) | Elements, events and forms, script DOM, CSS and rendering, host services, Intl, images and fonts |
| [gaps/LIBRARIES.md](gaps/LIBRARIES.md) | Packages without a pack, bits-ui parts, pack exclusions, untyped package code |
| [gaps/VERIFICATION.md](gaps/VERIFICATION.md) | Interpreter-only gaps, test infrastructure, product milestones, diagnostics quality |

## Clusters

A cluster is one implementation effort that removes many rows. Ranked by what they block in the north star (the shadcn-svelte site and component pages, then shadcn/ui React and shadcn-vue examples, then the Translations Editor). "Blocks" is a judgement from the survey, not a measurement; the corpus scan (M6 step 10) is to replace it with counts.

| # | Cluster | Blocks | Why it is open | What it would take | Detail |
|---|---|---|---|---|---|
| P1 | **Elements**: 80 shared IR/Svelte tags (with `img`) and 73 React/Vue tags; all three include `form`, `fieldset`, `legend` (without `disabled`) and ten table tags; no `details`, `dialog`, `q`, `progress`, …; React/Vue still lack `a`, `dl`, `dt`, `dd`, `figure`, `figcaption`; SVG shapes only | Every docs page and most examples | Uncovered element behavior remains rejected | Inert elements with group conformance; interactive elements with their behavior | [PLATFORM](gaps/PLATFORM.md#elements-p1) |
| L1 | **Packages**: only bits-ui and svelte-sonner (source) and twelve packs | All React and Vue examples (Radix, reka-ui, lucide-react/-vue, cva, vueuse); the site shell (mode-watcher, vaul-svelte, paneforge, zod, layerchart; svelte-sonner compiles from source but stops at untyped code, V2) | Each package is compiled from source or packed individually | Source compilation per package, which meets V1/V2/L4 | [LIBRARIES](gaps/LIBRARIES.md#packages-without-a-pack-or-source-entry-l1) |
| V2 | **Untyped values**: `any`/`unknown` that no rule types | Most library code; demo data | D16 requires a static type for every value; package code is typed by pattern-specific rules (L4) | More rules per library, or a dynamic value tier ([review](research/APPROACH-REVIEW.md)); the tier's spike (opt-in `dynamicValues`, [design and results](design/M6-DYNAMIC-VALUES.md)) compiles bits-ui's Pagination with no new rule; adopted as an opt-in (D16 amended); open: its own gaps and React/Vue | [LANGUAGE](gaps/LANGUAGE.md#value-model-and-types-v1-v2), [dynamic values](gaps/LANGUAGE.md#dynamic-values-opt-in-spike) |
| V1 | **Unions** reached by several members | Slider (single and multiple in one program), multiple Select, mixed Accordion/ToggleGroup programs, `string \| number` props; unions whose members reach different slots of one instance (the 10 context-menu examples' `HTMLElement \| Measurable`, the date pickers' `string \| number`). (Unions reached by several classes only are covered since 2026-10-12, which moved the calendars past bits-ui's `DateValue \| DateValue[]`.) | No sum type in the IR; specialisation per member not started, and it separates sites, not slots | Per-member compilation (decided 2026-10-05) or IR unions; per-slot narrowing for the slot cases | [LANGUAGE](gaps/LANGUAGE.md#value-model-and-types-v1-v2) |
| F3, F4 | **React and Vue surfaces**: React has four hooks (no context, memo, forwardRef, custom hooks); Vue lacks `reactive`, provide/inject, `v-show`, `v-html`, styles, `Transition` | The shadcn/ui and shadcn-vue halves of the north star | Svelte leads (D14); React and Vue stopped at M5 | Per API; Radix and reka-ui need most of them | [FRAMEWORKS](gaps/FRAMEWORKS.md#react-f3) |
| F1 | **Svelte**: `use:`, transitions, stores, `{#await}`, `<svelte:boundary>`, scoped styles, more bindings, snippets with parameters | Site components (actions, transitions), the editor (scoped styles) | Added as cases needed them | Per feature | [FRAMEWORKS](gaps/FRAMEWORKS.md#svelte-f1) |
| P4 | **CSS and rendering**: `position: sticky`, `:target`, fill modes, Stylo-dropped declarations | Site header, sidebar and table of contents (sticky); in the census hosts, the site stylesheet's `scroll-fade-*` utilities (scroll-driven animations) where an element can match them: the seven scroll-fade examples and the three that render the AttachmentGroup (`scroll-fade-x`). Rules no element can match are left out (D17) | Remaining engine gaps and compiler/runtime guards; pinning sticky/fill repairs does not lift acceptance | Per guarded surface and retained failure | [PLATFORM](gaps/PLATFORM.md#css-and-rendering-p4), [BLITZ-GAPS](BLITZ-GAPS.md) |
| P7 | **Images and system fonts** | Avatars, cards, the site's assets; any `system-ui` text | Only embedded fonts. Images load from the pinned table (M6 steps 2–5) for Svelte's `<img>` (spreads included) and `new Image()` (bits-ui's Avatar) | React and Vue `<img>`, `srcset`/`loading`, image-object `complete`/natural sizes/`decode()`, ordering against `<img>` events ([design](design/M6-IMAGES.md)) | [PLATFORM](gaps/PLATFORM.md#images-and-fonts-p7) |
| P2 | **Events and forms**: canceled physical/implicit submit and no-argument requests are bounded; reset, FormData/serialization, constraint validity/UI, uncanceled navigation/dialog defaults, React native-element/synthetic-submit combinations, broader submit interfaces and input types, drag/touch/clipboard/animation events remain open | Forms examples (with zod/formsnap), the editor's forms | Each remaining event/default needs an explicit model and independent acceptance | Shared form decisions and staged event selection, framework scheduling preserved; per remaining event/default | [PLATFORM](gaps/PLATFORM.md#events-and-forms-p2) |
| P3 | **Script DOM**: no comment anchors, so script reordering blocks later framework inserts; selector subset; few node APIs | Command (clear, no matches), libraries that move or create nodes | The runtime places blocks without anchors | Comment anchors (Blitz has `create_comment_node`), then general DOM mutation; Stylo's selector matching | [PLATFORM](gaps/PLATFORM.md#script-dom-p3) |
| F2 | **SvelteKit**: mdsvex, most `$app` APIs, server code, iframes | The whole site beyond the generated docs pages | Static SPA subset by design (M6) | M7 | [FRAMEWORKS](gaps/FRAMEWORKS.md#sveltekit-f2) |
| P6 | **Intl**: five verified locales, few options | The Translations Editor (arbitrary language tags, DisplayNames, PluralRules) | Only Chromium-verified data | Vectors per locale | [PLATFORM](gaps/PLATFORM.md#intl-p6) |
| V3–V6 | **Classes, constructs, async, modules**: rest parameters, logical assignment, `in`, generators, getters in literals, nested `await`, `export default`, enums | Scattered; rest parameters and nested `await` are common | Lowered as needed | Mostly mechanical | [LANGUAGE](gaps/LANGUAGE.md) |
| P5 | **Host services**: fetch, location, cookies, storage events, console objects | Site shell (cookies, mode-watcher), the editor (bridge) | Explicit capabilities; no origin | M7/M8 | [PLATFORM](gaps/PLATFORM.md#host-services-p5) |
| T1 | **Interpreter**: no layout, style or mutable DOM, so every bits-ui fixture is incomplete in the differential | Verification depth, not apps | The interpreter is independent of Blitz | Interpreter models of the APIs | [VERIFICATION](gaps/VERIFICATION.md#reference-interpreter-t1) |

## Deliberate policy (not gaps)

These are decisions, listed so that they are not mistaken for missing work. Changing one is an architecture decision ([ARCHITECTURE](ARCHITECTURE.md#decisions)); [the approach review](research/APPROACH-REVIEW.md) discusses D7 and D16.

- No JavaScript engine by default; islands are opt-in and never touch the DOM (D7). Islands are not implemented yet.
- Every value has a static type (D16); untyped values are rejected.
- Exact package versions with hashes; no patched copies (`E_DEPENDENCY`, `E_PACK_VERSION`).
- Builds never run app configs or generation steps; generation is a separate recorded command.
- `E_REACTIVITY`/`E_READONLY` where the frameworks' update granularity would show, instead of modelling it.
- No run-time HTML parsing; no server code at run time.
- Behaviour is never approximated: a model that would differ from Chromium is a rejection or a run-time report.
