# M6 libraries: what the Translations Editor reaches in its npm dependencies

Status: research for M6 ([roadmap](../ROADMAP.md#m6-libraries-css-pipeline-sveltekit-islands)), 2026-10-04. This report changes no code. It audits the component and utility libraries that the north-star app imports, to decide the M6 order of work and which packages to compile from source and which to cover with mapping packs (D9).

## Summary

- **The editor reaches about 0.6 MB of library source.** bits-ui 2.19.5 contributes 166 files (445 KB, 13,207 lines), which is 34 % of its 488 runtime files. Its dependencies add 59 files (150 KB), and the class utilities add 357 KB: tailwind-variants 140 KB, tailwind-merge 106 KB. 49 lucide icons add 79 KB. `@internationalized/date`, `dequal` and `lz-string` are not reached.
- **Nearly every editor component needs bits-ui.** 19 app components import shadcn wrappers, and `+page.svelte` mounts all of them. 17 of those 19 reach a bits-ui class. The other two reach `<script module>` and tailwind-variants. Because the compiler rejects a whole program, the editor's main screen needs the complete closure.
- **The biggest blockers are, in order:**
  1. npm module forms: package exports, `.svelte.js` rune modules, `<script module>`, barrels and `<A.B>` component tags (515 sites).
  2. Classes: 116 classes, 743 fields (250 of them `$state`/`$derived`) and 1,053 uses of `#private` names. All of bits-ui's state is classes.
  3. The **props-bag model**. bits-ui builds heterogeneous attribute records with computed keys, listeners and symbol-keyed attachments, merges them with `mergeProps`, and spreads them onto elements or hands them to `child` snippets.
  4. Svelte's context API.
  5. The overlay host APIs: portals, floating-ui positioning, focus scope, dismiss layer and animation-aware presence.
- **lucide icons draw only allow-listed SVG,** but in a form the contract rejects. The 49 icons use only `path`, `circle`, `line` and `rect` with geometry and `fill`. `Icon.svelte`, however, renders them through `<svelte:element>` and spreads inside `<svg>`. A small `@lucide/svelte` pack that expands the static icon data into the existing inline-SVG lowering is the cheapest route.
- **Use mapping packs for clsx, tailwind-merge and tailwind-variants.** The editor uses a narrow, regular API:
  - one `cn = twMerge(clsx(…))` helper with 131 calls;
  - 11 `tv()` definitions that use only `base`, `variants` and `defaultVariants`.

  Their sources rely on typed arrays, `arguments`, `for-in` and heterogeneous config unions, none of which the IR models.
- **Islands do not help with the hard part.** D7 islands never touch the DOM, and every bits-ui, svelte-toolbelt and runed module is DOM-bound or reactive, so they must be native. Only the pure string utilities (twMerge, tv, clsx) could be islands, as a stopgap.

## Method

- **Inputs.** The editor at `runic-sdk/apps/translations-editor/Frontend` was read in place, with nothing installed or built there. Packages were read from `runic-sdk/node_modules/.bun/*` through the editor's `node_modules` symlinks. Versions come from each package's `package.json`.
- **Import closure.** A throwaway walker followed static imports from `src/routes/+layout.svelte` and `src/routes/+page.svelte`:
  - It resolved `#lib/*` and package `exports` with the `svelte`, `browser`, `import` and `default` conditions.
  - It tree-shook at member level through barrels (`export * as`, `export {default as X}`), namespace imports and named namespace objects. A file that only uses `Select.Item` therefore reaches `select-item.svelte`, not the whole `Select` barrel.
  - It stopped at `svelte/*`, `virtual:*` and `@runic-artifex/*`, the bridge per D13.

  Per-wrapper closures repeat the walk from each `components/ui/<x>/` directory's reached files.
- **Feature counts** are syntactic occurrences:
  - script features from the TypeScript 5.9.3 AST, over `.js`/`.ts` files and `<script>` blocks;
  - template features from the Svelte 5.57.1 `parse(…, {modern: true})` AST.

  Template expressions are not scanned for script features.
- **Paths.** `bits-ui/…` means `bits-ui@2.19.5/…/dist/…`, and `src/…` is the editor's source. The walker and its outputs lived in `/tmp` and have been deleted. `node compiler/cli.mjs scan` was run on the editor for cross-checking (233 files, 14,165 lines; package imports: `#lib` 290, `@lucide/svelte` 75, `bits-ui` 74, `tailwind-variants` 12, `clsx` 1, `tailwind-merge` 1).

## 1. What the editor uses

### shadcn-svelte wrappers (`src/lib/components/ui/`, 29 directories, 190 files; 143 reached)

The editor's 19 app components (`src/lib/*.svelte`, `src/routes/+page.svelte`) import these wrappers directly. Some wrappers are reached only through other wrappers.

| Wrapper | App files | bits-ui primitives (members used) | Reached through |
|---|---:|---|---|
| badge | 12 | none (tailwind-variants, `<svelte:element>`) | |
| button | 11 | none (tailwind-variants) | dialog, sheet, sidebar, input-group |
| sidebar | 7 | `mergeProps` | |
| field | 6 | `Label.Root` (field-label) | |
| dropdown-menu | 6 | `DropdownMenu.{Root, Trigger, Content, Portal, Group, GroupHeading, Item, CheckboxItem, CheckboxGroup, RadioGroup, RadioItem, Separator, Sub, SubTrigger, SubContent}` | |
| input | 5 | none | sidebar, input-group |
| select | 4 | `Select.{Root, Trigger, Content, Portal, Viewport, Group, GroupHeading, Item, ScrollUpButton, ScrollDownButton}` | |
| collapsible | 4 | `Collapsible.{Root, Trigger, Content}` | |
| alert, spinner, textarea | 4 each | none | |
| dialog | 2 | `Dialog.{Root, Portal, Overlay, Content, Close, Title, Description}` | |
| card, kbd, empty | 2 each | none | |
| toggle-group | 1 | `ToggleGroup.{Root, Item}` | |
| popover | 1 | `Popover.{Root, Trigger, Content, Portal}` | |
| scroll-area | 1 | `ScrollArea.{Root, Viewport, Scrollbar, Thumb, Corner}` | |
| checkbox | 1 | `Checkbox.Root` | |
| separator, item, input-group | 1 each | `Separator.Root` (separator only) | |
| sheet | 0 | `Dialog.*` as `SheetPrimitive` | sidebar (mobile) |
| tooltip | 0 | `Tooltip.{Provider, Root, Trigger, Content, Portal, Arrow}` | sidebar-provider, sidebar-menu-button |
| toggle | 0 | `Toggle.Root` | toggle-group |
| label, skeleton | 0 | `Label.Root` / none | field / sidebar |
| alert-dialog, progress | 0 | not reached | unused |

App files per wrapper:

- **badge:** ArtifactPreviewPanel, EditorSettingsFooter, EditorSidebarHeader, InterchangeDialog, LocaleSwitcher, MessageComposer, MessageHeading, MessageList, MessageToolbar, ReviewWorkflow, ValidationPanel, +page.
- **button:** EditorToolbar, InlineMessageEditor, InterchangeDialog, MessageComposer, MessageHeading, MessageList, MessageToolbar, ReviewWorkflow, TranslationEditor, ValidationPanel, +page.
- **sidebar:** EditorSettingsFooter, EditorSidebarHeader, EditorToolbar, LocaleSwitcher, MessageList, WorkspacePanel, +page.
- **dropdown-menu:** EditorSettingsFooter, EditorSidebarHeader, InlineMessageEditor, MessageComposer, MessageList, MessageToolbar.
- **select:** InlineMessageEditor, MessageComposer, ReviewWorkflow, +page.
- **collapsible:** LocaleSwitcher, MessageComposer, MessageList, ReviewWorkflow.
- **dialog:** AppDialog, CommandPalette.
- **popover, separator:** MessageComposer.
- **scroll-area, item:** LocaleSwitcher.
- **toggle-group:** EditorModeSwitcher.
- **checkbox:** +page.

Template use in the app files:

- `Button` 77, `Field.Field`/`Field.Label` 53 each, `Badge` 33, `Input` 30;
- `Select.{Root, Trigger, Content, Group}` 18 each, `Select.Item` 22;
- `Alert.*` 16 each, `Spinner` 14, `DropdownMenu.Item` 12, `DropdownMenu.RadioItem` 10;
- `DropdownMenu.Root` 6, `Collapsible.Root` 4, `Dialog.Root` 2, `Popover.Root` 1, `Checkbox` 2, `ToggleGroup.Root` 1.

### lucide icons (`@lucide/svelte` 1.52.0, deep imports `@lucide/svelte/icons/<name>`)

50 import specifiers resolve to 49 icon components (`alert-circle` and `circle-alert` are the same). There are 94 `<…Icon>` uses.

| File | Icons |
|---|---|
| src/routes/+page.svelte | message-square-text, plus, trash-2 |
| EditorSettingsFooter | chevrons-up-down, info, languages, monitor, moon, palette, settings-2, sun |
| EditorSidebarHeader | alert-circle, chevrons-up-down, folder-open, languages, plus, refresh-cw |
| EditorToolbar | check, redo-2, save, undo-2 |
| InlineMessageEditor | arrow-left, arrow-right, grip-vertical, plus, trash-2, variable, x |
| LocaleSwitcher | chevron-down, settings-2 |
| MessageComposer | arrow-down, arrow-up, chevron-down, circle-plus, code-xml, settings-2, trash-2 |
| MessageHeading | copy, pencil, trash-2 |
| MessageList | check-check, chevron-down, list-checks, message-square-off, more-horizontal, plus |
| MessageToolbar | list-filter, search |
| ReviewWorkflow | book-open, check-circle-2, chevron-down, clipboard-list, list-checks, sparkles, triangle-alert |
| TranslationEditor | wand-sparkles |
| ValidationPanel | circle-alert, circle-check-big, triangle-alert |
| WorkspacePanel | alert-circle, wrench |
| ui/checkbox, ui/dropdown-menu-checkbox-item | check, minus |
| ui/dropdown-menu-radio-item, ui/select-item | check |
| ui/dropdown-menu-sub-trigger | chevron-right |
| ui/select-trigger, ui/select-scroll-down-button / -up-button | chevron-down / chevron-up |
| ui/dialog-content, ui/sheet-content | x |
| ui/sidebar-trigger | panel-left |
| ui/spinner | loader-2 |

## 2. bits-ui and its runtime dependencies

`bits-ui@2.19.5` declares these dependencies:

- `@floating-ui/core ^1.7.1`, `@floating-ui/dom ^1.7.1`, `esm-env ^1.1.2`, `runed ^0.35.1`, `svelte-toolbelt ^0.10.6`, `tabbable ^6.2.0`;
- peers `@internationalized/date ^3.8.1` and `svelte ^5.33.0`.

The table gives the installed versions and the reached part of each package.

| Package | Installed | Required by | Reached files | Bytes | Lines |
|---|---|---|---:|---:|---:|
| bits-ui | 2.19.5 | editor | 166 of 488 | 445,413 | 13,207 |
| svelte-toolbelt | 0.10.6 | bits-ui | 20 of 26 | 25,032 | 815 |
| runed | 0.35.1 | bits-ui, svelte-toolbelt | 18 of 82 | 16,051 | 479 |
| @floating-ui/core | 1.8.0 | bits-ui, @floating-ui/dom | 1 | 36,290 | 1,039 |
| @floating-ui/dom | 1.8.0 | bits-ui | 1 | 27,950 | 790 |
| @floating-ui/utils | 0.2.12 | core, dom | 2 | 10,253 | 303 |
| tabbable | 6.5.0 | bits-ui | 1 | 27,962 | 592 |
| style-to-object | 1.0.14 | svelte-toolbelt | 1 | 1,088 | 42 |
| inline-style-parser | 0.2.7 | style-to-object | 1 | 5,090 | 261 |
| esm-env | 1.2.2 | bits-ui, runed | 3 | 300 | 9 |
| clsx | 2.1.1 | editor, svelte-toolbelt | 1 | 388 | 1 |
| dequal 2.0.3, lz-string 1.5.0 | | runed | 0 | | |
| @internationalized/date | 3.12.4 (devDependency) | bits-ui peer | 0 | | |

`@internationalized/date` has 14 imports in bits-ui, all in the date and time components, which the editor does not use. The roadmap's `@internationalized/date` pack is therefore not needed for the editor. Svelte 5.57.1 is the contract's checked identity.

Most of the reached bits-ui code is in a few areas:

- **The largest files:** `menu/menu.svelte.js` (1,622 lines), `select/select.svelte.js` (1,376), `scroll-area/scroll-area.svelte.js` (798), `tooltip/tooltip.svelte.js` (697), `popover/popover.svelte.js` (405), `dialog/dialog.svelte.js` (362), `internal/safe-polygon.svelte.js` (316), `utilities/dismissible-layer/use-dismissable-layer.svelte.js` (306).
- **By area:** `bits/menu` 77 KB, `internal` 68 KB, `bits/select` 66 KB, `bits/scroll-area` 44 KB, `bits/tooltip` 32 KB, then popover, dialog and the floating, dismissible and focus-scope layers.

**Closure per wrapper** (bits-ui alone / bits-ui plus its dependencies). Shared code is counted in every row.

| Wrapper | bits-ui files, bytes | with dependencies |
|---|---|---|
| dropdown-menu | 69, 204,872 | 107, 349,253 |
| select | 64, 177,064 | 106, 322,294 |
| sidebar (sheet, tooltip) | 65, 163,870 | 103, 307,851 |
| tooltip | 55, 144,463 | 93, 288,444 |
| popover | 50, 130,195 | 87, 274,007 |
| dialog / sheet | 40, 84,542 | 68, 148,314 |
| scroll-area | 29, 58,419 | 59, 98,390 |
| checkbox | 14, 29,091 | 35, 60,669 |
| toggle-group | 20, 24,134 | 43, 56,080 |
| collapsible | 15, 23,172 | 37, 54,578 |
| toggle / separator / label, field | 8–9, 6.5–7.5 K | 22–23, ~33 K |
| alert, badge, button, card, empty, input, input-group, item, kbd, spinner, textarea | 0 | 0 |

Bits-ui uses these helper exports: svelte-toolbelt `boxWith` 73, `mergeProps` 56, `attachRef` 13, `onDestroyEffect` 10, `simpleBox` 8, `DOMContext` 7, `afterTick` 6, `executeCallbacks` 5; runed `watch` 22, `Context` 12, `IsMounted` 3, `ElementSize`, `Previous`, `useDebounce`; tabbable `isTabbable`, `tabbable`, `focusable`, `isFocusable`; floating-ui `computePosition`, `autoUpdate`, `offset`, `shift`, `limitShift`, `flip`, `size`, `arrow`, `hide`.

## 3. Unsupported features in the reached sources

The tables count features that CONTRACT.md v9 lists as rejected or outside M5, or that it does not mention. Each "App" column gives how many of the 19 app components reach a library or wrapper file with the feature. The order is by that reach, then by count. App-only constructs are listed separately at the end.

### Module and component forms (every screen)

| Feature | Count | App | Where (representative) |
|---|---:|---:|---|
| npm package imports (`bits-ui`, `@lucide/svelte/icons/*`, …) | 457 imports | 19 | scan `import:package` |
| `<script module>` (rejected) | 18 files (12 wrappers, 4 app, 2 bits-ui) | 19 | `ui/button/button.svelte:1` (`buttonVariants = tv(…)`), badge, alert, field, toggle, item, empty, sidebar-menu-button; `bits-ui/bits/utilities/portal/…` |
| `.svelte.js` / `.svelte.ts` rune modules | 13 bits-ui state modules plus helpers; `ui/sidebar/context.svelte.ts`, `hooks/is-mobile.svelte.ts` | 17 | `bits-ui/bits/dialog/dialog.svelte.js` |
| Namespaced component tags `<A.B>` | 515 (443 app, 71 ui) | 19 | `src/routes/+page.svelte:1803`; `<DialogPrimitive.Content>` |
| Barrels: `export * as Dialog from "./exports.js"`, default re-exports | every bits namespace; 49 lucide alias modules (`icons/trash-2.js`: `export { default } from "./trash.svelte"`) | 19 | `bits-ui/bits/dialog/index.js:1` |
| Untyped JS in `dist/` (types only in `.d.ts`; they omit computed keys and attachments) | 166 bits-ui files | 17 | `dialog.svelte.d.ts:52-61` vs `dialog.svelte.js:125-136` |

### Language features

| Feature | Count | App | Where (representative) |
|---|---:|---:|---|
| `class` (all bits-ui state is `class X { static create(opts) … }`) | 116 classes; 109 constructors; 327 methods | 17 | `bits-ui/bits/dialog/dialog.svelte.js:11-12`; `runed/utilities/context/context.js:2`; `src/lib/components/ui/sidebar/context.svelte.ts:23` |
| Class fields; `$state`/`$derived` class fields | 743; 250 | 17 | `dialog.svelte.js:125` `props = $derived.by(() => ({…}))` |
| `#private` names (uses) | 1,053 (998 bits-ui, 51 runed) | 17 | `runed/…/context.js:3-11` |
| `static` members | 83 (78 `static create`) | 16 | `bits-ui/bits/checkbox/checkbox.svelte.js:13` |
| Class getters/setters; `.bind(this)` | 28; 95 | 14 | `bits-ui/bits/select/select.svelte.js:904`; `dialog.svelte.js:107` |
| `extends` | 6 (4 bits-ui) | 17 | `src/lib/ui-text.ts:45` (`extends Error`), `hooks/is-mobile.svelte.ts:5` (`extends MediaQuery`) |
| Getters/setters on object literals ("boxes") | 35 (8 svelte-toolbelt, 8 bits-ui, 6 tailwind-variants, 4 ui) | 19 | `svelte-toolbelt/box/box-extras.svelte.js:4-24`; `ui/toggle-group/toggle-group.svelte:42-51` |
| `Symbol` (unique keys) | 8 (contexts, box brands, lucide context) | 19 | `box-extras.svelte.js:2-3`; `runed/…/context.js:11`; `ui/sidebar/context.svelte.ts:69` (`Symbol.for`) |
| Symbol-keyed attachments: `createAttachmentKey`, `...this.attachment` | 1 definition, 13 `attachRef`, 52 spreads | 16 | `svelte-toolbelt/utils/attach-ref.js:25-27` |
| Computed keys | 220 (64 bits-ui, 125 generated bridge) | 17 | `dialog.svelte.js:130` `[this.root.getBitsAttr("trigger")]: ""` |
| Dynamic property access `o[expr]` | 459 (152 app, 138 tailwind-variants, 56 floating-ui core, 41 bits-ui, 34 tailwind-merge) | 19 | `svelte-toolbelt/utils/merge-props.js:23-125` |
| Heterogeneous records merged at run time (`mergeProps`) | 56 imports; 52 × `mergeProps(restProps, …)` (rest props read in script, rejected) | 16 | `bits-ui/bits/dialog/components/dialog-trigger.svelte:27` |
| `Object.getOwnPropertySymbols`, `Object.defineProperty` | 1; 3 | 16 | `merge-props.js:104`; `box-extras.svelte.js:64` |
| `in` operator | 48 (25 app) | 19 | `attach-ref.js:33`; `lucide/utils/buildLucideIconNode.js:42` |
| `for-in`; `arguments`; rest parameters | 22; 6; 20 | 19 (through tw utilities) | `tailwind-variants/dist/index.js:95, 3289`; `clsx.mjs:1` |
| Logical assignment | 16 | 19 | `tailwind-variants/dist/chunk-SUL6UUW2.js:209` |
| `instanceof` | 31 | 14 | `@floating-ui/utils/…dom.mjs:25` |
| `WeakMap` | 3 | 13 | `bits-ui/internal/svelte-resize-observer.svelte.js:8`; `focus-scope/focus-scope-manager.js:6` |
| `Proxy` (wraps a `PointerEvent`) | 1 | 13 | `bits-ui/bits/utilities/dismissible-layer/use-dismissable-layer.svelte.js:277` |
| `Int32Array`/`Uint8Array` | 4 | tw only | `tailwind-variants/dist/index.js:273-275` |
| `any` (in `.svelte` TS) | 5 | — | `bits-ui/bits/select/components/select.svelte:52` |
| Generators, `yield`, `BigInt` in libraries | 0 | — | (`BigInt` only in `src/lib/review-model.ts:28`) |

### Svelte features

| Feature | Count | App | Where (representative) |
|---|---:|---:|---|
| Context API: `getContext`/`setContext`/`hasContext`/`createContext`/`getAllContexts` (rejected "other svelte imports") | runed `Context` used 26 × `new Context` in bits-ui; direct imports in 6 files | 17 | `runed/…/context.js:1`; `ui/sidebar/context.svelte.ts:69,78`; `ui/toggle-group/toggle-group.svelte:2`; `lucide/context.js:9`; `src/lib/ui-text.ts:15` |
| `$props.id()` | 40 | 16 | `bits-ui/bits/dialog/components/dialog-trigger.svelte:7` |
| Spread attributes `{...x}` | 287 (130 ui, 101 bits-ui, 51 lucide) | 19 | `dialog-trigger.svelte:33` `<button {...mergedProps}>` |
| `child` snippet delegation: `{@render child({ props })}` in bits-ui; `{#snippet child({props})}` passed as a prop | 10 snippet sites (5 ui, 5 app) | 9 | `dialog-trigger.svelte:30-36`; `ui/sidebar/sidebar-menu-button.svelte:83`; `src/lib/EditorSidebarHeader.svelte:55` |
| Other snippets passed as props (`popper`, `presence`, `focusScope`, `content`) | 17 | 13 | `bits-ui/bits/select/components/select-content.svelte:51` |
| `bind:ref` to component props; function bindings | 49; 1 | 19 | `ui/sidebar/sidebar.svelte:39` (`bind:open={() => …, (v) => …}`) |
| `untrack`; `svelte/events` `on` | 6; 12 | 16; 13 | `attach-ref.js:1`; `bits-ui/bits/collapsible/collapsible.svelte.js:5` |
| `$effect.root` (rejected) | 3 | 14 | `bits-ui/bits/utilities/is-using-keyboard/is-using-keyboard.svelte.js:16`; `runed/…/watch.svelte.js:36` |
| `$effect.pre`, `$effect` | 4, 37 | 14 | `runed/…/watch.svelte.js:8` |
| Imperative `mount`/`unmount` (portals) | 1 component, used by every Portal | 13 | `bits-ui/bits/utilities/portal/portal.svelte:2,13,56` |
| `SvelteMap`; `MediaQuery`; `createSubscriber` | 2; 1; 1 | 13; app; — | `bits-ui/bits/select/select.svelte.js:1`; `src/lib/hooks/is-mobile.svelte.ts:1`; `runed/…/element-size.svelte.js:3` |
| `$state.snapshot` | 3 | 7 | `bits-ui/bits/checkbox/checkbox.svelte.js:27` |
| `<svelte:element>` | 2 | 17 | `ui/badge/badge.svelte:40`; `lucide/Icon.svelte:32` |
| `{#key}`; component `<style>` | 1; 2 bits-ui (7 app) | 13; — | `bits-ui/…/portal/portal-consumer.svelte:7`; `bits-ui/…/select-viewport.svelte:1` |
| `{@attach}` in a template | 1 (app) | 1 | `src/lib/InlineMessageEditor.svelte:326`. Attachments reach elements mainly through spreads (above). |
| Legacy `on:`, actions, transitions, `{@html}`, stores | 0 | — | |

### DOM and host APIs (bits-ui, floating-ui, tabbable)

| API | Count | App | Where (representative) |
|---|---:|---:|---|
| `getComputedStyle` | 15 | 14 | `bits-ui/bits/select/select.svelte.js:1317`; `internal/body-scroll-lock.svelte.js:132`; `floating-ui.dom.mjs` |
| `.focus()`, `.contains`, `.closest`, `querySelector(All)` | 33, 28, 13, 18 | 13–14 | focus scope, menus, select |
| `requestAnimationFrame`/`cancelAnimationFrame` | 13 / 11 | 13 | `bits-ui/internal/presence-manager.svelte.js:37`; `bits-ui/bits/collapsible/collapsible.svelte.js:70` |
| `MutationObserver` | 2 | 13 | `bits-ui/bits/utilities/focus-scope/focus-scope.svelte.js:148`; `bits-ui/internal/animations-complete.js:76` |
| `Element.getAnimations`, `style.animationName` | 3, 3 | 13 | `animations-complete.js:25`; `collapsible.svelte.js:105` |
| `CustomEvent`/`dispatchEvent`, `new PointerEvent(e.type, e)` | 5 / 2, 4 | 13 | `bits-ui/bits/menu/menu.svelte.js:1058`; `use-dismissable-layer.svelte.js:268` |
| `document.body` and body style mutation (scroll lock), `document.documentElement` | 32, 17 | 13 | `bits-ui/bits/menu/menu.svelte.js:847`; `body-scroll-lock.svelte.js` |
| `ResizeObserver` | 4 | 11 | `bits-ui/internal/svelte-resize-observer.svelte.js:10`; `floating-ui.dom.mjs:628` (`autoUpdate`) |
| `IntersectionObserver` | 3 | 11 | `floating-ui.dom.mjs:589` |
| `visualViewport`, `devicePixelRatio`, `getClientRects`, `offsetParent`-style layout reads | 5, 1, 6, many | 11 | `floating-ui.dom.mjs:62` |
| `navigator.userAgent` | 3 | 14 | `bits-ui/internal/is.js:5` |
| `createTreeWalker`, `elementFromPoint` | 1, 2 | 6 (dropdown-menu) | `bits-ui/internal/focus.js:86`; `menu.svelte.js:404` |
| Pointer capture | 2 | 1 | `bits-ui/bits/scroll-area/scroll-area.svelte.js:595` |
| `getRootNode`, `shadowRoot`, `ownerDocument.defaultView` | 4, 4, 5 | 16 | `svelte-toolbelt/utils/dom.js:67`; `dom-context.svelte.js:8` |

### App-only constructs

These were found during the walk and are not library work:

- component `<style>` in 7 app files;
- `BigInt` (`review-model.ts:28`);
- `createContext` (`ui-text.ts:15`);
- `import.meta.env.MODE` (`editor-bridge.ts:90`), which selects `mock-bridge.ts`, the natural input for "non-bridge screens";
- the Vite virtual module `virtual:runic-translations/editor` (`+page.svelte:4`, `ui-text.ts`);
- `<svelte:head>` (`+page.svelte:1791`).

## 4. lucide icons and the inline-SVG allow-list

`@lucide/svelte` 1.52.0 exports `.`, `./context`, `./icons` and `./icons/*`. Each icon is a small `.svelte` file with a static JSON node list, for example `icons/x.svelte`: `const iconData = {"name":"x","size":24,"node":[["path",{"d":"M18 6 6 18"}],…]}; <Icon {...props} icon={iconData}/>`. Icons are rendered by `dist/Icon.svelte`.

**The drawing is within the allow-list.**

- Elements across the 49 icons: `path` 111, `circle` 22, `line` 6, `rect` 4.
- Child attributes: `d`, `cx`, `cy`, `r`, `x`, `y`, `width`, `height`, `rx`, `ry`, `x1`, `y1`, `x2`, `y2`, `fill`. These are geometry and paint attributes the contract allows.
- `<svg>` attributes from `utils/defaultAttributes.js` and `buildLucideIconNode.js`: `xmlns`, `width`, `height`, `viewBox`, `fill="none"`, `stroke="currentColor"`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `class` (`lucide-icon lucide lucide-<name> …`) and `aria-hidden="true"` when no a11y prop is present.
- Attributes the editor passes:
  - allowed: `class` (17), `data-icon` (22), `aria-hidden` (12), `aria-label`;
  - outside the list: `role="status"` and `name` from `ui/spinner/spinner.svelte:20`.

**The component form is rejected (`E_SVG`).**

- `Icon.svelte:30` spreads `<svg {...iconAttributes}>`.
- `Icon.svelte:32` renders children as `<svelte:element this={tag} {...attrs}/>` inside the `<svg>`.
- `Icon.svelte:37` renders a snippet inside the `<svg>`.
- `Icon.svelte:26` passes `class` as an array.
- `Icon.svelte:5` reads a `Symbol`-keyed context (`context.js:9`).
- Its helpers use `for-in` (`utils/hasA11yProp.js:15`), `'color' in params` and computed keys (`buildLucideIconNode.js:39-44`).
- Every deep import goes through a default re-export module.

**Recommendation.** Use a D9 pack keyed on `@lucide/svelte@1.52.0` `icons/*`:

- The adapter reads `iconData` (static JSON) and lowers an icon instance to the existing inline-SVG template, applying `Icon.svelte`'s prop rules: `size`/`width`/`height`, `color`→`stroke`, `strokeWidth`/`absoluteStrokeWidth`, `class` merge order and the `aria-hidden` rule.
- It is validated by rendering every used icon with every prop shape the editor uses in Chromium against the native build.
- The 49 icons are 61 KB of source.

Compiling `Icon.svelte` generically would need `<svelte:element>` with a constant-folded SVG tag, spreads on SVG elements, snippets inside `<svg>` and symbol context. That is more work for one component. Two items stay open:

- **Allow-list:** extend it with `role` (and `name`), or reject the spinner.
- **CSS:** `animate-spin` on the spinner (`spinner.svelte:20`) is an `animation`, which the contract rejects.

## 5. tailwind-variants, clsx and tailwind-merge

**Call sites.**

- **`cn`.** The only direct users of `clsx` 2.1.1 and `tailwind-merge` 3.7.0 are in `src/lib/utils.ts:1-6`: `export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)); }`.
  - There are 131 calls: 126 in wrappers and 5 in app code. Only 1 has all-literal arguments.
  - Argument shapes: 134 string literals, 126 pass-through `className` props, 13 variant-function results, 4 `a && "…"`, 3 conditionals. There are no object or array arguments.
- **`class` values passed to wrappers.** The app files pass 157 of them: 147 static strings, 7 calls (`cn`/`buttonVariants`) and 3 arrays.
- **`tv`.** tailwind-variants 3.3.1 has 11 `tv({...})` definitions: button, badge, alert, field, toggle, item, item-media, empty-media, input-group-addon, input-group-button and sidebar-menu-button. All except input-group-button sit in `<script module>`.
  - All use only `base`, `variants` and `defaultVariants`. None uses `compoundVariants`, `slots`, `extend`, responsive variants or `compoundSlots`.
  - There are 17 variant-function calls (13 in wrappers, 4 in app code). Their values come from literal-union props, as shorthands (`{ variant, size }`) or literals. Only one passes `class:` (`src/lib/MessageComposer.svelte:366`). The domains are finite: button has 6 variants × 8 sizes.
- **Indirect use.**
  - svelte-toolbelt's `mergeProps` calls `clsx` on `class` (`merge-props.js:47-58`).
  - tailwind-variants 3.3.1 does **not** import tailwind-merge. `dist/index.js` bundles its own copy of the merge algorithm (`// src/internal/merge/*`, lines 4–3066, including `default-config.ts` at 579), and `defaultConfig.twMerge` is `true` (`chunk-SUL6UUW2.js:4-6`). Class strings therefore pass through two merge implementations: tv's inside `buttonVariants(…)`, then tailwind-merge 3.7.0 inside `cn`.

**Source features.**

- `tailwind-merge/dist/bundle-mjs.mjs` (106 KB, 3,369 lines) has 34 dynamic accesses, `for-in`, rest parameters and `Symbol` (line 612). Its config tables are heterogeneous arrays of strings, validator functions and nested objects. These are unions the IR rejects.
- tailwind-variants adds `Int32Array`/`Uint8Array`, `arguments`, 16 `for-in` loops, getters on object literals and 138 dynamic accesses.

**Recommendation: mapping packs, not compilation from source.**

- **`clsx@2.1.1`:** a trivial native pack. Strings, falsy values, nested arrays and objects are all covered by the Svelte `class` semantics the runtime already implements.
- **`tailwind-merge@3.7.0` `twMerge` (default config):** a native Rust port of the class-group map and conflict resolution.
  - Validate it differentially in Node against the real package.
  - The corpus is every class string the editor can produce: static literals × the finite variant domains × the 147 static `class` arguments. Add generated Tailwind 4 class combinations as fuzz.
  - This one pack covers all 19 screens. It sits on the hot path of every class binding, so it must be native.
- **`tailwind-variants@3.3.1` `tv`:** a pack restricted to `{base, variants, defaultVariants}` plus `class`/`className`. Any other key is rejected with a diagnostic.
  - Its output goes through the twMerge pack. Validation must check that tv's bundled merge and tailwind-merge 3.7.0 agree on the corpus, or the pack must model both.
  - Because the domains are finite, the backend can also precompute the variant table at build time.

Compiling these libraries from source would need typed arrays, `arguments`, `for-in` over records and union-typed config before the editor gains anything. QuickJS islands would be valid for them (they are pure string functions), but only as a stopgap. They would put an engine on every class computation.

## 6. Recommended order of M6 work

Each step names what it unblocks. "App" counts the editor's 19 app components that need the step.

1. **Blitz fork.** Already decided as M6's first step; kept as is.
2. **Library module system (19).** This is the prerequisite for everything else.
   - Resolve package `exports` with the `svelte` condition.
   - Compile `.svelte.js`/`.svelte.ts` rune modules and untyped `dist/*.js` (types inferred, with `.d.ts` only as hints, since they are lossy for props bags).
   - Support `<script module>` (18 files, including Button), default, namespace and star re-exports, `export * as`, and namespaced component tags (515).
   - Pin by `package@version` in the build report.
   - The wrappers without bits-ui (button, badge, alert, card, empty, input, textarea, kbd, item, input-group, spinner) then need only step 3's packs.
3. **Packs, in parallel with step 2:** clsx, tailwind-merge and tailwind-variants (19), and lucide (14 app components, 94 icon sites). These are independent, deterministic and validated against Node. They also make the first screen without bits-ui possible as an intermediate milestone.
4. **Classes and object semantics (17).**
   - Classes with fields, `$state`/`$derived` fields, `#private` names, `static` and accessors, and `this` with `.bind`.
   - Object-literal accessors (boxes), `Symbol` as an opaque unique key, computed keys, `in`, `instanceof` on host classes, `WeakMap`, logical assignment and rest parameters.
   - Classes must keep identity and be reactive per field, as Svelte's class fields are.
5. **Svelte context and the component-library surface (17).**
   - Context: `getContext`, `setContext`, `hasContext`, `createContext`, `getAllContexts` with symbol keys.
   - `$props.id()`, `untrack`, `svelte/events` `on`, `$effect.root`, `$effect.pre`, `$state.snapshot`, `SvelteMap`, `MediaQuery`, `createSubscriber`.
   - Rest props passed into script functions (`mergeProps(restProps, …)`), function bindings, `bind:ref` and `<svelte:element>`.
6. **The props-bag model (16), the central design item.**
   - The IR needs a value type for attribute bags: string keys, some computed (`data-<bits>-trigger`), mapped to string, number, boolean, undefined, listener, class value or style value, plus symbol-keyed attachments.
   - It must support `mergeProps` semantics: composed handlers, `clsx` on `class`, style-object merging through style-to-object, and deleting `hidden` and `disabled`.
   - It must support spreads of bags onto elements with keyed attribute and listener diffing, as Svelte's `attribute_effect` does.
   - It must support `child` snippets that receive bags.
   - This could be native code for svelte-toolbelt's `mergeProps`/`boxWith`/`attachRef` (a pack), which is cheaper and more exact than inferring them, but the bag type is needed either way.
7. **Overlay host layer (13; dialog, dropdown-menu, select, popover, tooltip, sheet).**
   - **Portal.** Mount a component subtree under `body` with inherited contexts (`portal.svelte`).
   - **Positioning.** floating-ui `computePosition`/`autoUpdate`. Either compile `@floating-ui/core` (mostly arithmetic, 1,039 lines) over a native `platform` built on the runtime's layout reads, or write a validated pack for `@floating-ui/dom`. This step also needs `ResizeObserver` (carried over from M5), `IntersectionObserver` and `visualViewport`.
   - **Focus scope.** tabbable, `MutationObserver` and `createTreeWalker`.
   - **Dismissal.** Document listeners, a re-dispatched `PointerEvent` wrapped in a `Proxy` (a one-site helper suited to a pack) and `CustomEvent`.
   - **Scroll lock.** Body style and `getComputedStyle`.
   - **Presence.** `getAnimations` and `animationName`. Decide this together with the CSS pipeline. `tw-animate-css` classes appear in 30 wrapper files (`animate-in`/`animate-out` 11/10, `fade-*`, `zoom-*`, `slide-in-*`), and `animation`/`transition` are rejected today. If animations stay rejected, presence must see "no running animations", and the rejection must be explicit.
   - **Also:** `elementFromPoint` (dropdown submenu), pointer capture (scroll-area) and `navigator.userAgent`.
8. **App-only items.** Component styles (7 files), `BigInt`, SvelteKit routes, `<svelte:head>`, `import.meta.env.MODE`/mock bridge and the translations virtual module. These belong to the SvelteKit and CSS tracks of M6.

**What must be native, and what could be an island (D7: islands compute values and never touch the DOM).**

- **Native:** all of bits-ui, svelte-toolbelt and runed (reactive state, contexts, attachments and listeners). Also Portal, the focus, dismiss and presence layers, tabbable, the floating-ui DOM platform, lucide and the shadcn wrappers.
- **Possible islands (opt-in stopgaps, to be reported):**
  - `twMerge`, `tv` and `clsx`: pure string to string;
  - `@floating-ui/core`'s `computePosition` math, only if rects are measured natively and passed in, because its `platform` hooks read the DOM.

  Neither is a good default. The class utilities sit on every class binding, and positioning runs on every pointer move or resize while an overlay is open. The editor's island baseline should be zero.

## Open questions

1. Should `role` (and `name`) join the SVG allow-list, or should the spinner be rejected?
2. How should CSS animation (tw-animate-css) and bits-ui presence behave until M10?
3. Should svelte-toolbelt's `mergeProps`/`boxWith`/`attachRef` be packs or compiled from source once step 6's bag type exists? The source is small (25 KB) but sits on every bits-ui element.
4. tailwind-variants bundles its own merge algorithm. Does it agree with tailwind-merge 3.7.0 on the editor's corpus? This must be measured before one twMerge pack can serve both.
