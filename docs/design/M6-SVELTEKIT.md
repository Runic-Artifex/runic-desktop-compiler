# M6–M7: SvelteKit

Decisions for compiling SvelteKit apps: the Translations Editor (Kit 3.0.0, hash router, one layout and one page) and the shadcn-svelte documentation site (Kit 2.70, path router, 18 page routes, 13 layouts, about 275 prerendered pages). The evidence and the full feature inventory are in the [research](../research/M6-SVELTEKIT.md).

## Decisions

- **Kit's own code builds the route manifest.**
  - The compiler calls the app's pinned Kit to build the route tree. It uses `create_manifest_data` and the routing utilities to get route ids, layout chains (groups, `@` resets), error boundaries, parameter patterns, matchers and Kit's sort order.
  - These are internal files rather than package exports, so they are pinned by version and SHA-256, as packs are.
  - Param matchers compile as ordinary functions.
- **The native router is the runtime's.**
  - It sits over the M5 in-process history, in hash or path mode as the app configures it.
  - It adds:
    - an id per history entry (scroll positions);
    - link-click default actions;
    - scroll to the top or to the fragment after navigation;
    - focus reset and the title update after navigation;
    - Kit's live-region announcer;
    - `beforeNavigate` with cancellation.
- **Composition keeps instances.**
  - A generated root component nests the layout chain through `children` snippets, passing `data`, `params` and `form` (always `null`) to each level.
  - On navigation, a level whose component is unchanged keeps its instance and gets new props, as in Kit.
- **Universal loads run natively.**
  - `+page.ts`/`+layout.ts` loads are ordinary async functions, with `browser = true`.
  - They re-run only when what they read changed: params, url parts, `parent()`, server data. The router tracks those reads as Kit does.
- **Server code runs at build time, in Kit.**
  - Server loads and prerendered `+server.ts` endpoints are evaluated by the app's own Kit in Node, once per `entries()` instance and per crawled URL. The output is what a static Kit build would ship.
  - The results become typed constant tables (`data` by route and params, `fetch` by URL), read through `data` and through a same-origin `fetch` inside loads.
  - Server code that cannot be prerendered is rejected.
  - Building them is an explicit, hash-recorded step, like the site's other generators (below). It is never a model call, and never a runtime network request.
- **Build-time generators are explicit inputs.**
  - The site's velite content collection, its registry generator and its markdown preprocessors (mdsx, with shiki) run as declared steps of the build, from `runic.json`, with their outputs hash-recorded.
  - A missing or stale output is a diagnostic.
  - The app's `vite.config` and `svelte.config` are still never run as a whole.
- **`{@html}`.** Values with a finite set of compile-time strings (the site's shiki output and theme `<style>`) lower to their markup at build time. Any other `{@html}` is rejected. Native HTML parsing at runtime (Blitz's parser is already linked) is a later option, with an allow-list.
- **`<iframe>`** of the same app (the site's block viewer) is a second instance of the app, at another route and its own viewport size, rendered into a sub-surface. It is designed with the M8 embedder interface and rejected until then.
- **Size.**
  - Whole-site builds need per-route module initialisation, lazy like Kit's nodes, and code generation split by route chunk instead of one `app.rs`. That is M7 work.
  - Conformance builds may select a subset of routes.

## Phasing

1. **M6, the editor's subset:**
   - Kit 3 config detection (`router.type` in `vite.config`);
   - `#lib` imports;
   - root layout and single page;
   - the hash router;
   - `<svelte:head>` `<title>` to `document.title` (other head elements rejected until they have a native meaning);
   - `app.html` `<html>`/`<body>` attributes.
   
   The bridge scripts in its `app.html` are M8 and rejected until then.
2. **M6, one route family of the site** (exit criterion: "the shadcn-svelte site's component examples render from source"):
   - `/docs/components/[name]` with its layouts;
   - universal loads;
   - build-time server data;
   - markdown pages through the explicit generator steps;
   - `$app/state` `page`;
   - `goto`.
3. **M7, the whole site:**
   - per-route initialisation and chunked code generation;
   - the remaining routes (`/blocks` waits for iframes, `/create` for its server code);
   - cookies and `PersistedState`;
   - external links opened in the OS browser.

### Status

Phase 1's core landed on Kit **2.70.1** (the site's pin) rather than 3.0.0: Kit 3's optional TypeScript ^6 peer conflicts with the pinned TypeScript 5.9.3, so 3.0.0 and its `vite.config` router configuration wait for that upgrade. Done ([contract](../CONTRACT.md#sveltekit), cases `kit-hash`, `kit-routes`, `kit-routes-missing`):

- `runic.json` `"kit": true`; `svelte.config.js` read as literals; `app.html` attributes and container; `$lib` and `kit.alias`.
- The manifest from the app's Kit, its files pinned by SHA-256.
- The hash and path routers, nested layouts with kept instances, universal loads with Kit's tracking, `error()`/`redirect()`/`+error.svelte`/404 with `handleError`, `$app/state` `page`, `goto`, `beforeNavigate`/`afterNavigate`, scroll, focus reset, the announcer and the title.

Refinement of "the native router is the runtime's": the router is Kit's own client (`client.js` of 2.70.1) ported to the compiled language and generated per app (route table, loads, data merges, error-page variants, the composition tree), so it follows Kit's ordering, tracking and error routing line by line. The runtime adds only generic host primitives (history entry state, `document.title`, focus reset and starting point, origin-less URL resolution, a host reply task, element attributes and parents), keeping the backend free of framework knowledge (D10).

Open: Kit 3 and the editor's `#lib` imports and bridge scripts; `page.data`/`page.state`, shallow routing, `invalidate`, `navigating`; render errors routed to `+error.svelte`; reload scroll restoration.

Phase 2's machinery landed on 2026-10-06 (branch `m6-kit-2`, [contract](../CONTRACT.md#sveltekit), [implemented](#implemented-2026-10-06)): `runic generate` with pinned, recorded steps, server data and prerendered endpoints as build-time tables, markdown pages through the site's velite and mdsx configurations and its previews preprocessor, `import.meta.glob`, component values and dynamic tags, `{@html}` of build-time fragments. Cases `kit-docs` (800px) and `kit-docs-narrow` (420px) run the site's markdown pages for Toggle, Tabs and Separator in a Kit fixture with a layout of its own (fixture `kit-docs-svelte`) against its own Kit build. The site's own `/docs/components/[name]` route family still renders no page: its layouts, page component and markdown wrappers need the [blocker inventory](#blocker-inventory-why-no-page-renders-yet) lifted first.

## Phase 2 addendum (proposed 2026-10-05, decided and implemented 2026-10-06)

Scope: `/docs/components/[name]` of the shadcn-svelte site at the pinned commit, which is the URL family `/docs/components/*` of the route `(app)/(layout)/docs/[...slug]`. Its layout chain is `+layout.svelte` → `(app)/+layout.svelte` (with `+layout.ts` and `+layout.server.ts`) → `(app)/(layout)/+layout.svelte` → `docs/+layout.svelte` (with `+layout.server.ts`, `prerender` only). The page's `+page.ts` calls `getDoc(slug)` (`src/lib/docs.ts`: a lazy `import.meta.glob("/content/**/*.md")` and the velite metadata) and, for component pages, `fetch('/api/block/<name>')`. That endpoint is prerendered by Kit's crawl, not by `entries()`: its URLs are the ones the docs pages' loads fetch while they are prerendered.

### Build-time steps: pinned, run and recorded

- **Declared, not discovered.** `runic.json` gains `"generate"`, an ordered list of steps. Each step has a name, a command, its inputs (globs in the app), its outputs (directories) and its tool identity:
  - a package tool (`velite@0.3.1`, `mdsx@0.0.7`): name, exact version and the SHA-256 of the package files it loads, checked as packs and Kit's files are (a patched copy is rejected);
  - an app script (`scripts/build-registry.ts`, run by the app's pinned `tsx`): the script and its imports are hashed as inputs.
  
  The site needs three steps, in order: the registry script (`src/__registry__/`), velite with `velite-update-json.ts` (`.velite/`), then mdsx over `content/**/*.md` (preprocessed Svelte per page).
- **Run by an explicit command, checked by builds.** `runic generate <project>` runs the steps in the locked shell with Node 24, `TZ=UTC`, a fixed `SOURCE_DATE_EPOCH` and the app's installed dependencies, in a prepared copy, never in the corpus checkout. It writes a generation record: per step, the tool identity, the hashes of the inputs and the hashes of the outputs. `runic build` never runs a step. It recomputes the input hashes, and reports a missing record or output, or a stale one (inputs or tool changed), as `E_GENERATED` at the step in `runic.json`. Generation runs app code and may run model-free Node tooling only; builds stay deterministic, offline and free of app scripts. Conformance runs `generate` once per prepared app, as it runs `npm ci`.
- **Preparation.** The site is a pnpm workspace whose registry script imports workspace packages (`shadcn-svelte`, `@shadcn-svelte/parity`) that its root `postinstall` builds. Preparation therefore copies the monorepo at the pinned commit, installs its lockfile with pnpm 10.32.1 (its `packageManager`; the flake has no pnpm today), and builds the workspace CLI packages. It is a prepare step of the corpus (`conformance/corpus/`), not of builds.

### Where the outputs enter the IR

- **velite** output (`.velite/index.js` and its JSON) is an ordinary local module behind the `$content` alias (`kit.alias`, already read as a literal): its exports become module constants, typed by velite's generated declarations.
- **The registry index** (`src/__registry__/index.js`) is an ordinary module of constants. It reaches the program only through mdsx's code-block insertion (at generation) and the `view` matcher (outside this route family).
- **Markdown pages.** Each `.md` file's preprocessed Svelte is collected as a component module at the `.md` path, so `import.meta.glob("/content/**/*.md")` and `getDoc` see it as Kit does. The highlighted code is static markup in that source.
- **`import.meta.glob`** with a literal pattern becomes a constant table from path to a lazy loader. Calling a loader returns a promise of the module namespace, settled after the module initialised. While modules initialise with the program (a known deviation of phase 1), it settles in the next microtask, as an already-evaluated dynamic import does in Chromium.
- **Server data.** `+layout.server.ts`/`+page.server.ts` loads and prerendered `+server.ts` endpoints are evaluated at generation, as Kit's prerender evaluates them: in Node, through the compiler's own Vite (the app's aliases, no app config), once per `entries()` instance and per crawled URL, with no cookies and no request headers. The results are hash-recorded JSON. They become constant tables in the program: server data keyed by route id and params, which the router passes as `data` to the universal load, and endpoint responses keyed by path, which the load event's `fetch` reads.
  - The endpoint URLs of a crawl are those the universal loads fetch for the page entries. Generation obtains them by running the page entries' universal loads in Node with a recording `fetch`; a load whose fetch URLs cannot be collected that way (a fetch depending on browser state) is rejected.
  - `fetch(url)` in a load is a table lookup returning a response record with `ok`, `status`, `json()` and `text()`. `json()` is typed by the declared type the result is assigned to (`const item: HighlightedBlock = await res.json()`) and checked against every table entry at build time.
- **`{@html}`** of strings that come only from those tables (the code viewers' shiki markup) is parsed at build time into static fragments, one per distinct string, selected at run time by the string. Each fragment's elements and classes go through the existing template and Stylo checks. This needs an IR template hole for a fragment chosen from a constant table: a schema change, reviewed before it is implemented.

### What gets rejected

- A generated input without a step, or a step without a record (`E_GENERATED`); `preprocess` and `extensions` in `svelte.config.js` that no step covers (`E_KIT_CONFIG`, as in phase 1).
- Server loads and endpoints on routes that are not prerendered, and endpoints no crawl reaches (`E_KIT_SERVER`, as in phase 1).
- `fetch` in loads of URLs outside the table: located `E_KIT_FETCH` where the URL is constant, `RunicUnsupportedError` at run time otherwise. Network `fetch` elsewhere (`github-link.svelte`) stays rejected.
- `import.meta.glob` with non-literal patterns or options other than `eager` and `import`, and template-literal `import()` with targets outside the app.
- `{@html}` of any other value.

### Decisions (2026-10-06)

Both were reserved (they change how build-time tools may run); the coordinator chose:

- **Previews preprocessor: option 1.** `svelte.config.js` is imported only inside `runic generate` (`compiler/generate-preprocess.mjs`), with its SHA-256 recorded as an input of the step; `runic build` reads it as literals and never imports it. The rule that the app's configs are never run still holds for builds; generation is the one explicit, recorded exception.
- **Versions: option 2 for M6.** The fixture builds the site's unmodified sources against the compiler's checked versions in both the native app and the reference Kit build, and `vendor.json` declares the substitution. **M7 prerequisite:** option 1, checked identities (version environments and pack vectors) for the site's pins (Svelte 5.54.0, `@lucide/svelte` 1.27.0, runed 0.37.1, tailwind-variants 3.3.0, tailwind-merge 3.6.0), before M7 claims the site.
- **`{@html}`: approved without HTML parsing at run time.** Every string that can reach a `{@html}` comes from build-time strings, is parsed at build time, and the runtime only selects among the parsed fragments; anything else stays rejected with a location (or, for a dynamic value outside the strings, reported at run time).

The options as they were proposed:

1. **The `componentPreviews` preprocessor lives inside `svelte.config.js`.** mdsx's own configuration is the separate `mdsx.config.js`, which a step can run. But every component page also needs `componentPreviews()`, a function defined inline in `svelte.config.js` (it injects the example imports and `component={…}` into each `<ComponentPreview>`). Running it changes the rule that the app's `svelte.config.js` is never run as a whole. Options:
   1. Import `svelte.config.js` inside `runic generate` only, and run its `preprocess` list over the `.md` files. This runs the whole config module (it imports `@sveltejs/adapter-cloudflare`, `magic-string`, `mdsx` and `mdsx.config.js`), but not in builds. Recommended: generation already runs app code (the registry script), and the record hashes the config.
   2. Extract the `componentPreviews` function declaration from the config's AST and run only it. This still runs app code, but less of the config, and it is fragile against upstream edits.
   3. Leave `componentPreviews` out. Every component page then fails at its first `<ComponentPreview>` (`E_GENERATED`), so no page renders.
2. **Dependency versions.** The site's lockfile pins versions the compiler has not checked: Svelte 5.54.0 (the checked ones are 5.57.1 and 5.49.2), `@lucide/svelte` 1.27.0 (pack 1.52.0), runed 0.37.1 (pack 0.35.1), tailwind-variants 3.3.0 (pack 3.3.1) and tailwind-merge 3.6.0 (pack 3.7.0). Options:
   1. Add each as a checked identity, with its version environment in conformance and its pack vectors.
   2. Build the site's unmodified sources against the compiler's checked versions, in both the native app and the reference Kit build, with the substitution declared in the case. This is how the `bits-*` fixtures use shadcn-svelte's files.
   
   Recommended: option 2 for M6 conformance, option 1 before M7 claims the site.

### Implemented (2026-10-06)

As proposed, with these refinements:

- **Steps** (`compiler/generate.mjs`): a step is a command (`node <app script>` or a bin of one of its pinned tools, with `outputs`) or a `preprocess` glob; its tools are pinned by version and the SHA-256 of their package files (`compiler/generate-pins.mjs`, written by `generate-pins-update.mjs`; their dependencies are pinned by the repository's lockfile). The record holds each step's declaration hash and every input and output file's hash; builds report the first difference. Steps run with `TZ=UTC`, `LC_ALL=C` and `SOURCE_DATE_EPOCH=0`. The generator tools are devDependencies of this repository at the site's lockfile versions; the fixture needs no pnpm or corpus preparation (its registry step is a script of its own in the site's output format), so the flake is unchanged. The real site will need the corpus preparation described above.
- **Server phase** (`compiler/adapters/kit-server.mjs`): prerendered routes per entry; server loads with tracked reads, keyed natively by what they read (the union over entries); universal loads run for their fetches (also with `ssr = false`, where Kit's own crawl runs none: endpoints may list `entries()`); a fetched endpoint must be `prerender = true`. Vite's dependency cache lives outside the app (Tailwind would scan it). Server data is JSON only.
- **Native tables** (`compiler/adapters/kit-generate.mjs`, `frontend/adapters/kit/client.ts`): a server node's data is a lookup returning new objects (as each parsed response is), invalidated by Kit's `load_route` rules; `load_data` and `fetch` are host round trips once the app has started and immediate during the first navigation (server rendering inlines them). `await res.json()` parses the body into the type the program declares at the `await` (JSON.parse's checks, at run time).
- **`import.meta.glob`**: the call is replaced, in the module the frontend lowers, by a function appended to the module that builds Vite's table from the matched modules' exports named by the module type argument; a loader resolves through Vite's preload helper and Rollup's inlined dynamic import (two chained microtask steps), as the reference bundle does.
- **Component values** (not in the proposal, needed by `getDoc` and the previews preprocessor's `component={…}`): a class record per program, a module constant per component; dynamic tags become an `if` chain over the component values whose required props the tag passes (frontend/adapters/svelte-dynamic.ts).
- **`{@html}`**: candidates are a constant's own fragment, or every string of the app's build-time tables; the IR gains the additive `html` node and `Program.fragments` ([IR](../IR.md#template)), built natively from a static table.
- **Found on the way:** JSON modules behind declaration files (velite's index), module constants destructuring a record (mdsx), undeclared props not evaluated, `dl`/`dt`/`dd`/`figure`/`figcaption`, underscores in attribute names (`__src__`), links to fragments naming an element followed as Chromium follows them (Kit leaves same-page hash links to the browser), `position: sticky` rejected ([gaps](../BLITZ-GAPS.md)), and codegen fixes (typed `undefined`/`null`, truthiness of functions, `JSON.parse` into a record).
- **Not modelled:** server rendering and hydration (the fixture is an SPA, `ssr = false`; hydrated elements get `$props.id()` ids `s1`, `s2`, … where the native app's are `c1`, `c2`, …), `entries` in universal modules (`E_KIT_LOAD`), globs in component scripts and without a type argument (the site's `getDoc` casts an untyped glob: `E_GLOB` until untyped loaders are typed through their casts).

The site's own pages, as of 2026-10-06 (all fail at the shared chain below; the fixture shows the markdown side of the pages marked):

| Page | In the fixture | Its own blockers besides the shared chain |
|---|---|---|
| toggle | all 5 previews (toggle-sizes newly verified) | none |
| tabs | all 5 previews (tabs-icons newly verified) | none |
| separator | all 4 previews (separator-menu, separator-list newly verified) | none |
| accordion | no | its previews mix Accordion types `single` and `multiple` in one program (`E_TYPE_UNION` until components are specialised per discriminant) |
| button, badge, card, progress, checkbox, label, switch, toggle-group, collapsible | no | previews not yet verified (table above); toggle-group mixes types like accordion |
| avatar | no | every preview uses `Avatar.Image` (`<img>`) |

### Blocker inventory: why no page renders yet

A static import closure of the layout chain, the page component and the markdown wrappers (`ComponentPreview`, `ComponentSource`, `InstallTabs`, `PMAddComp`, `PMInstall`, `Steps`, `Step`, `Callout`, the mdsx blueprint) has 265 site modules. Each item below is in that closure, so it blocks every page of the family. Locations are relative to `docs/src`.

- **Overlays** (bits-ui step 7, in progress elsewhere):
  - Tooltip: `routes/(app)/+layout.svelte` and `(layout)/+layout.svelte` (`Tooltip.Provider`), and `copy-button.svelte`, which `mdsx/pre.svelte` puts on every code block;
  - Dialog and Command: `command-menu/command-menu.svelte`, in the site header;
  - DropdownMenu and Popover: `docs-copy-page.svelte`, `docs-toc.svelte` (dropdown variant) and `mobile-nav.svelte`;
  - Sheet: `registry/ui/sidebar/sidebar.svelte`, on its mobile branch;
  - Select: `component-code-viewer/component-code-viewer-code-title.svelte`.
- **Packages without a pack or source entry:**
  - `mode-watcher` 1.1.0: `(app)/+layout.svelte`, `mode-switcher.svelte`, `ui/sonner`;
  - `svelte-sonner` 1.2.1: the `Toaster` in `(app)/+layout.svelte`;
  - `zod` 4.4.3: `user-config.svelte.ts`, `registry/config.ts`, `colors.ts`;
  - `@tabler/icons-svelte` and `@hugeicons/svelte`: the copy buttons, the table of contents, the icon placeholders;
  - `package-manager-detector`;
  - the workspace packages `shadcn-svelte` and `@shadcn-svelte/parity`.
- **Language and Svelte features:**
  - `class IsMobile extends MediaQuery` (`registry/hooks/is-mobile.svelte.ts`): library base classes are rejected;
  - `MediaQuery` in `component-source.svelte`;
  - `<slot>` in `mdsx/blueprint.svelte`;
  - `{@html}` in `component-code-viewer-code.svelte` (supported since 2026-10-06 for the endpoint's strings);
  - `<svelte:head>` meta tags in `metadata.svelte`;
  - `position: sticky` (the header, the sidebar, the table of contents; rejected since 2026-10-06, a Blitz gap).
- **DOM and host APIs:**
  - `innerText` (`mdsx/pre.svelte`, `component-code-viewer-code.svelte`);
  - `IntersectionObserver` (`docs-toc.svelte`);
  - `document.createRange` and `getSelection`, and `checkVisibility` (`component-code-viewer-code.svelte`);
  - `document.cookie` (`(app)/+layout.ts`, `user-config.svelte.ts`);
  - runed's `PersistedState` (`design-system-provider-state.svelte.ts`);
  - network `fetch` (`github-link.svelte`).
- **Kit** (the machinery landed 2026-10-06; what the site still needs from it):
  - `entries` in `docs/[...slug]/+page.ts` (only server modules may export it natively);
  - `import.meta.glob` without a type argument, cast later (`lib/docs.ts`: `resolver as unknown as DocResolver`);
  - the registry step (`scripts/build-registry.ts` through tsx, after building the workspace packages: the corpus preparation above);
  - `api/block` imports `shadcn-svelte`'s schema and zod (fine at generation, Node runs them).

Every page also renders all of its own previews (`<ComponentPreview name>`). For the 14 pages the phase was meant to cover, the previews already verified by the `bits-*` cases are a minority:

| Page | Previews | Verified by a case | Not yet verified |
|---|---:|---|---|
| button | 14 | none | all 14 (`button-demo` … `button-as-link`, including `button-loading` with a spinner and `button-group-demo`) |
| badge | 6 | none | all 6 (`badge-spinner`, `badge-link`, …) |
| card | 5 | none | all 5 (`card-image` uses `<img>`) |
| separator | 4 | demo, vertical | menu, list |
| progress | 3 | demo | label, controlled |
| checkbox | 7 | demo | invalid, basic, description, disabled, group, table |
| label | 2 | demo | `field-demo` |
| switch | 6 | demo | description, choice-card, disabled, invalid, sizes |
| toggle | 5 | demo, outline, with-text, disabled | sizes |
| tabs | 5 | demo, line, vertical, disabled | icons |
| avatar | 9 | none | all 9 (every avatar demo uses `Avatar.Image`, rejected; `avatar-dropdown` is an overlay) |
| toggle-group | 7 | demo, outline, spacing (without its `capitalize` labels), vertical | sizes, disabled, font-weight-selector |
| accordion | 6 | demo, multiple, disabled, borders | basic, card |
| collapsible | 4 | demo | basic, settings, file-tree |

Status per page today: all 63 component pages fail at the shared chain above. The 14 pages above also need their unverified previews checked; the other 49 add their own parts (overlays, forms, charts, data tables, images).

**Proposed order.**
1. Decide the two open questions.
2. Land the overlays (Tooltip first: it is in both app layouts and on every code block).
3. Implement the phase 2 machinery above (generation steps and record, glob tables, server data and the `fetch` table, `.md` modules, the `{@html}` table form). Verify it with a Kit fixture that runs the site's real generators over the covered pages' markdown, compared with its own Kit build in Chromium.
4. Lift the shared-chain blockers in order of reach:
   - the packages (mode-watcher, svelte-sonner, zod's jitless path, tabler and hugeicons icons, the workspace packages);
   - `extends MediaQuery`;
   - `<slot>` in the blueprint;
   - `innerText`;
   - cookies;
   - `IntersectionObserver`;
   - selection ranges;
   - head meta tags.
5. Build the real site with route selection (`/docs/components/**` and its layouts) and record the per-page status.

## Versions

Kit versions join the checked identities like the frameworks: 2.70.x for the site, 3.0.0 for the editor. Svelte 5.54.0 and Vite 8.1.5, the site's pins, need their own version environments in conformance (as `conformance/svelte-5.49.2` is), and those must run in the campaign, not just exist.
