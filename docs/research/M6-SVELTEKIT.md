# M6 SvelteKit: the shadcn-svelte site and the Translations Editor

Status: research for M6 step 8 ([design](../design/M6-LIBRARIES.md#work-order)) and the M7 north star ([roadmap](../ROADMAP.md#m7-north-star-on-linux)), 2026-10-04. This report changes no code.

**Inputs** (read in place; nothing was installed or built there):
- **Docs site:** `.cache/corpus/shadcn-svelte/docs` at commit `3ef557c8` (2026-09-30). Lockfile pins: `@sveltejs/kit` 2.70.1, `svelte` 5.54.0, `vite` 8.1.5, `bits-ui` 2.19.2, `mdsx` 0.0.7, `velite` 0.3.1, `shiki` 3.20.0.
- **Translations Editor:** `runic-sdk/apps/translations-editor/Frontend`, on `@sveltejs/kit` 3.0.0 and `svelte` 5.57.1.
- **SvelteKit sources:** `runic-sdk/node_modules/.bun/@sveltejs+kit@3.0.0+…` and `@2.70.3+…`.

Paths below are relative to each app's root unless they start with a package name.

## Summary

- **The editor needs almost nothing from SvelteKit.**
  - Its tree is one `+layout.svelte` and one `+page.svelte`, with no load functions, no hooks and no `$app/*` import.
  - It uses `router: { type: "hash" }` and Runic's adapter (`adapter-static` in SPA mode, fallback `index.html`).
  - Its SvelteKit needs are composition (`children`), `<svelte:head>`, the `app.html` attributes, Kit 3's config location and the items already planned: the translations virtual module and `import.meta.env.MODE`.
- **The docs site is a full SvelteKit app.** It is not an SPA: it uses `adapter-cloudflare`, with SSR plus prerendering. Its tree has:
  - 18 page routes, 7 endpoints, 13 layouts (one `@` reset) and 5 route groups;
  - 6 dynamic parameters, 1 rest parameter and 1 matcher;
  - 11 universal loads, 5 server loads, 5 `entries()` generators;
  - about 275 prerendered page instances. 105 of them come from markdown.
- **Build-time machinery runs before Vite and inside the Svelte preprocessor.** The collector does neither today:
  - velite turns `content/` into `.velite/` (the `$content` alias);
  - `scripts/build-registry.ts` writes `src/__registry__/` (git-ignored);
  - `svelte.config.js` preprocessors turn `.md` into Svelte (mdsx, with shiki, prettier and the registry index) and inject example imports.
  
  Everything else (13 `import.meta.glob`, 6 template-literal `import()`, a `?raw` import) has a finite set of targets that is known at build time.
- **Nothing found needs a JS engine at runtime.**
  - Every dynamic `import()` and glob has static targets, so they become static tables of compiled modules.
  - There is no `eval` or `new Function` in the site's source. zod 4, a dependency, probes `new Function` for a JIT and falls back to its interpreter path. It needs a pack or the jitless path.
- **Two docs features have no native counterpart yet:**
  - `<iframe>` showing another route of the same app, used for block previews and the `/create` preview (3 live sites);
  - `document.cookie`, in 4 places plus the inline script in `app.html`.
- **Proposed model.** A compiled SvelteKit app is a native client router over a route manifest built at compile time:
  - layouts nest and persist across navigations as Kit's `root.svelte` does;
  - universal loads run natively as ordinary async code;
  - server loads and prerendered endpoints are evaluated at build time, once per `entries()` instance, into data tables that `fetch` and `data` read;
  - non-prerenderable server code is rejected.
- **Size.**
  - **Source:** 1,854 `.svelte` and 939 `.ts` files (104k lines) plus 105 markdown pages (15k lines), before libraries.
  - **Extrapolation:** from M5's binary sizes, roughly 40–200 MiB of app code.
  - **Proposal:** one program per site at runtime, provided module initialisation becomes lazy per route chunk. Code generation should be split into per-chunk Rust modules or crates. Today it writes a single `src/app.rs` (`crates/runic-codegen/src/emit.rs:67`). Conformance builds should be able to select a subset of routes.

## 1. Routing

### Configuration

| | Docs site | Editor |
|---|---|---|
| Kit version | 2.70.1; config in `svelte.config.js` | 3.0.0; config passed to `sveltekit({...})` in `vite.config.ts` (Kit 3 splits plugin options into Kit and vite-plugin-svelte config, `@sveltejs/kit/src/exports/vite/index.js:168`) |
| Adapter | `@sveltejs/adapter-cloudflare` (SSR worker plus prerendered pages) | `runicToolkitAdapter({ mode: "spa", desktop: false, fallback: "index.html" })` (`runic-sdk/packages/web/sveltekit/src/index.ts`): `adapter-static` with a fallback, plus a `runic-toolkit.sveltekit.json` manifest |
| Router | default `pathname` | `router: { type: "hash" }` |
| Prerender | per route (`export const prerender = true` in 15 files); `kit.prerender.handleMissingId`/`handleHttpError` only warn | none (SPA fallback) |
| `kit.alias` | `"$content/*": ".velite/*"`, plus the default `$lib` (1,749 files import `$lib/…`, 4,568 imports) | none; uses Node subpath imports `#lib`/`#lib/*` from `package.json` |
| `paths`, `trailingSlash`, `csr`/`ssr` | defaults (no `export const ssr/csr/trailingSlash` anywhere) | defaults |
| Preprocess and extensions | `preprocess: [mdsx(mdsxConfig), componentPreviews()]`, `extensions: [".svelte", ".md"]` | none |
| Hooks and matchers | no `hooks.*`; one matcher `src/params/view.ts` (`isBlock`, from the generated `__registry__/blocks.js`) | none; generated `hooks` are the defaults (`.svelte-kit/generated/client/app.js`) |
| `app.html` | inline cookie script setting `theme-*`/`layout-*` classes; 2 external scripts (analytics, EthicalAds); body attributes `data-sveltekit-preload-data="hover"` and a Tailwind class list including arbitrary properties (`[--header-height:…]`) | `<html class="dark" data-theme="runic">`, body `data-sveltekit-preload-data="false"`, 2 external bridge scripts (`/webui.js`, `/runic-cswebui.js`; M8, D13) |

### Route tree of the docs site (`src/routes`)

```
+layout.svelte  +error.svelte
(app)/  +layout.svelte +layout.ts +layout.server.ts
  (layout)/  +layout.svelte
    (root)/            +page.svelte +page.ts                      /            prerender
    blocks/            +layout.svelte +page.svelte +page.ts      /blocks      prerender
      [category]/      +page.svelte +page.ts +page.server.ts     5 entries    prerender
    charts/            +layout.svelte +page.ts (redirect)         /charts      not prerendered
      [t]/             +page.svelte +page.ts +page.server.ts     7 entries    prerender
    colors/            +layout.svelte +layout.ts +page.svelte                 prerender
    themes/            +layout.svelte +layout.ts +page.svelte                 prerender
    docs/              +layout.svelte +layout.server.ts                      prerender
      [...slug]/       +page.svelte +page.ts                     105 entries  prerender
      changelog/       +page.svelte +page.ts                                 prerender
    examples/          +layout.svelte +layout.ts +page.svelte +page.ts (redirect)  prerender
      authentication/ dashboard/ playground/ tasks/   +page.svelte           prerender
    (create)/          +layout@(app).svelte  (resets to (app), skipping (layout))
      create/          +layout.svelte +page.server.ts (redirect with url.search)  not prerendered
        [item]/        +page.svelte +page.ts                                 not prerendered
  preview/             +layout.svelte
    [item]/            +page.svelte +page.ts                                 not prerendered
(view)/  +layout.svelte
  view/[view=view]/    +page.svelte +page.ts                     148 entries  prerender
api/block/[block]/+server.ts (prerender)  rss.xml/+server.ts (prerender)
discord/ init/ og/ registry/ repro/  +server.ts  (dynamic: external redirects, JSON, OG image)
```

| Kind | Count |
|---|---:|
| Page routes (directories with `+page.*`) | 18 (16 with `+page.svelte`; `/charts` and `/create` only redirect) |
| `+page.ts` / `+page.server.ts` | 11 / 3 |
| Layouts | 13 (12 `+layout.svelte`, 1 `+layout@(app).svelte`) |
| `+layout.ts` / `+layout.server.ts` | 4 / 2 |
| `+server.ts` endpoints | 7 (2 prerendered) |
| `+error.svelte` | 1 (root) |
| Route groups | 5: `(app)`, `(layout)`, `(create)`, `(root)`, `(view)`. Also 3 parenthesised colocated folders that hold no routes: `(components)` ×2, `(data)` |
| Layout resets `@` | 1 |
| Dynamic parameters | 6: `[block]`, `[category]`, `[t]`, `[item]` ×2, `[view=view]` |
| Rest / optional parameters | 1 (`[...slug]`) / 0 |
| Matchers | 1 (`view`) |
| `entries()` generators | 5 (`docs/[...slug]`, `blocks/[category]` ×2 files, `charts/[t]` ×2 files, `view/[view=view]`) |
| Colocated non-route modules under `routes/` | 115 `.svelte`, ~37 `.ts` (route-local components and data) |

**Prerendered page instances:** 105 docs, 5 block categories, 7 chart types, 148 block views and about 12 static pages, about 275 in total. `/create/[item]` and `/preview/[item]` cover 66 example groups each (`src/lib/registry/examples/create/index.ts`) and are rendered on demand by the Cloudflare worker.

### How pages get content

| Load | Kind | Does | Build time or runtime in a native SPA |
|---|---|---|---|
| `(app)/+layout.server.ts` | server | reads cookies `sidebar_state` and `scn_user_config` | Build time. During prerendering there are no cookies, so the prerendered site always gets the defaults |
| `(app)/+layout.ts` | universal | `if (!browser) return data;` otherwise re-parses `document.cookie` | Runtime; needs a cookie host service |
| `docs/+layout.server.ts`, `colors`/`themes`/`examples` `+layout.ts`, `(root)/+page.ts` | page options only | `prerender = true` | Build-time options |
| `docs/[...slug]/+page.ts` | universal | `getDoc(slug)` (`src/lib/docs.ts`): lazy `import.meta.glob("/content/**/*.md")` gives the page component, `$content` gives the metadata (title, toc, links); component pages also `fetch('/api/block/<name>')` | Runtime: a static glob table plus build-time data for the fetch |
| `docs/changelog/+page.ts` | universal | glob of `content/changelog/**/*.md`, loads the 2 newest components | Runtime, static table |
| `blocks/+page.ts` | universal | 5 `fetch('/api/block/…')` | Runtime, build-time data |
| `blocks/[category]/+page.server.ts` | server | 6 globs over generated `__registry__/json/styles/nova/*.json`, returning names | Build time, per entry |
| `blocks/[category]/+page.ts` | universal | fetch per block; calendar components from a lazy glob; `error(404)` | Runtime |
| `charts/[t]/+page.server.ts` + `+page.ts` | server + universal | names from glob, then fetch per chart | Build time + runtime |
| `charts/+page.ts`, `examples/+page.ts` | universal | `redirect(302, …)` | Runtime |
| `create/+page.server.ts` | server, not prerendered | `redirect(303, '/create/preview-02' + url.search)` | Needs a server: reject (or see §4) |
| `create/[item]/+page.ts`, `preview/[item]/+page.ts` | universal | returns params / looks up an example, `error(404)` | Runtime |
| `view/[view=view]/+page.ts` | universal | template-literal `import()` of `lib/registry/blocks/${view}.svelte` or `…/${view}/+page.svelte` | Runtime, static table over the 148 blocks |
| `api/block/[block]/+server.ts` | endpoint, prerendered | imports generated registry JSON, rewrites imports, highlights every file with shiki, returns JSON | Build time; the output is a table keyed by URL |
| `rss.xml/+server.ts` | endpoint, prerendered | XML from `$content` changelog | Build time (only a link target) |

Markdown pages are Svelte components produced by the preprocessor (§3), loaded through the glob. `+page.svelte` renders them as `<Markdown viewerData={…} />`.

## 2. `$app/*` and `@sveltejs/kit` APIs

### Docs site (runtime imports, `src/`)

| Module and API | Files | Uses and locations |
|---|---:|---|
| `$app/state` `page` | 17 | **`url`:**<ul><li>`pathname` 17 (nav components, `docs/[...slug]/+page.svelte` for neighbours and `{#key}`);</li><li>`search` 4 (create routes);</li><li>`searchParams` 3;</li><li>`origin` 2 (share URL in `design-system-provider-state.svelte.ts:353`);</li><li>`hash` 1.</li></ul>**Other fields:** `params` 4 (`action-menu.svelte`, `item-explorer.svelte`), `status` and `error` 1 each (`routes/+error.svelte`). No `navigating`, `updated`, `page.data`, `page.state` or `page.form` |
| `$app/navigation` `goto` | 5 files, 7 calls | `command-menu.svelte:272,298,323` (path plus `#anchor`); `action-menu.svelte:28`, `preview-switcher.svelte:30` and `item-explorer.svelte:48` (path plus `url.search`); `design-system-provider-state.svelte.ts:114` with `{ replaceState, noScroll, keepFocus }` |
| `$app/navigation` `beforeNavigate` | 1 | `ethical.svelte:5`, reading `navigation.from/to.route.id`, to reload ads |
| Not used | | `afterNavigate`, `onNavigate`, `preloadData`, `preloadCode`, `invalidate*`, `pushState`/`replaceState` (shallow routing), `$app/forms`, `$app/paths`, `$app/stores`, `$env/*`, hooks |
| `$app/environment` | 7 | `browser` in 6: `(app)/+layout.ts`, `ethical.svelte`, `use-is-mac.svelte.ts`, `design-system-provider.svelte`, `menu-color-picker.svelte`, `registry/examples/combobox-responsive.svelte`. `dev` in 2: `tailwind-indicator.svelte`, `ethical.svelte` |
| `$app/types` | 1 | type-only (`site-footer.svelte`) |
| `@sveltejs/kit` `error` | 5 | `lib/docs.ts:91` and 3 universal loads (`blocks/[category]`, `preview/[item]`, `view/[view]`), plus `init/+server.ts` |
| `@sveltejs/kit` `redirect` | 7 | universal: `charts/+page.ts`, `examples/+page.ts`. Server: `create/+page.server.ts`, `discord`, `og`, `registry`, `repro` endpoints |
| `@sveltejs/kit` `json` | 2 | endpoints only |
| `./$types` | 13 imports | type-only (`PageLoad`, `PageServerLoad`, `EntryGenerator`, `PageProps`); generated by `svelte-kit sync`. Most pages type `data` implicitly (`let { data } = $props()`) |
| Link attributes | | `data-sveltekit-preload-data="hover"` on `<body>` and in `item-explorer.svelte:58`; 254 literal internal `href="/…"`, 201 `href="#…"` anchors, 16 `target="_blank"` |

### Editor

It uses **no** `$app/*` or `@sveltejs/kit` runtime import. Its other SvelteKit-related needs:
- `<svelte:head>` with `<title>` and a `<meta>` (`src/routes/+page.svelte:1791`);
- `<svelte:window onbeforeunload>`;
- `onMount` in the root layout;
- `import.meta.env.MODE` (3 sites, `src/lib/editor-bridge.ts`);
- `virtual:runic-translations/editor` (3 imports).

Kit 3 deprecates `$app/environment` in favour of `$app/env` (`runtime/app/environment/index.js`). Both must resolve if either app moves.

## 3. Build-time machinery in the docs site

| Machinery | Produces | Consumed by | Can the compiler produce it? |
|---|---|---|---|
| **velite** (`velite.config.js`, `pnpm build:content`) | `.velite/index.js` plus JSON: 9 collections of `{title, description, date?, path, navLabel?, links?, component, toc, slug, slugFull}` from front matter; `s.toc()` from headings. Git-ignored | `$content/index.js` in `lib/docs.ts`, `navigation.ts`, `components-list.svelte`, `rss.xml` | Yes, by running velite 0.3.1 (deterministic Node). It is a CLI step, not a Vite plugin |
| **Registry build** (`scripts/build-registry.ts`) | `src/__registry__/index.js` (name to files), `blocks.ts`, `json/styles/<style>/<item>.json`, `static/registry/**`, `static/schema*`. Git-ignored | mdsx config, the matcher, `view` entries, server globs, `api/block` | Yes, as a pinned script. Not a Vite plugin |
| **Icon stubs** (`scripts/build-icons.ts`) | `src/lib/registry/icons/__<lib>__/*.ts`: 783 one-line re-exports over 5 icon libraries | `icon-loader.ts` (template `import()`) | Already committed |
| **mdsx preprocessor** (`mdsx.config.js`) | `.md` to Svelte. remark-gfm, remark-code-import, rehype-slug and rehype-pretty-code with **shiki** (github-dark/light, 7 languages, JS regex engine). Code blocks become static `<span>` markup with `--shiki-*` variables. `rehypeComponentExample` inserts each preview's source, read from disk, formatted with prettier and highlighted. Elements map to 21 blueprint components (`src/lib/components/mdsx/`; the blueprint uses `<slot>`) | 105 pages, 92 with a `<script>` (498 imports of `$lib/components/…`) | Only by running the app's `svelte.config.js` preprocessors. The collector's Svelte plugin is `configFile: false` (`compiler/adapters/tooling.mjs:129`). The preprocessors import the generated `__registry__/index.js` |
| **`componentPreviews()` preprocessor** (`svelte.config.js`) | Injects `import X from "$lib/registry/examples/<name>.svelte"` and `component={X}` for each `<ComponentPreview name>` | 403 previews (391 distinct) on component pages | As above |
| `import.meta.glob` | 13 calls: `content/**/*.md` ×3, registry JSON ×7 (server), `blocks/calendar-*.svelte`, `examples/create/*/*.svelte` (527 files) | loads, the preview page | Vite expands them at collection. The set is finite and known at build time |
| Template-literal `import()` | 6: icon stubs, block views ×2, `style-${style}.css?raw` (server), registry JSON (server), shiki themes/languages (server) | | Vite turns them into globs: finite |
| `?raw` / `@sveltejs/enhanced-img` | 1 `?raw` (server); 2 `<enhanced:img>` | | `?raw` is a string; enhanced-img is an image pipeline (Vite plugin) |
| Fonts | `@fontsource-variable/*` imported from `app.css` (2) and `styles-registry.css` (26 families) | | WOFF2 through the collector (contract) |
| Static assets | `static/`: 2,460 files, 25 MB; `<img>` ×70 in 47 files (block screenshots, avatars) | | Images are outside the contract (WOFF2 only) |
| Environment | none (`$env`, `import.meta.env` unused; `process.env.CI` only in `vite.config.ts`) | | |
| `build:llms` | per-page `.md` files after the build | `docs-copy-page.svelte:37` `fetch(pageUrl + ".md")` | A generated static file |

**Conclusion.** All of it is deterministic Node tooling. It can be produced by running the real tools, but in two places the collector does not reach today:
- **Before Vite:** the velite and registry scripts.
- **Inside the Svelte preprocessor:** mdsx and the preview injection.

Suggested contract:
- **Generated inputs.** The compiler does not run package scripts. Generated inputs (`.velite/`, `src/__registry__/`) must exist, produced by the app's own `sync`, and the build records their hashes. A missing input is a located `E_GENERATED` diagnostic naming the script.
- **Corpus preparation.** The corpus needs a preparation step: install plus `pnpm sync`, in a copy and not in the read-only checkout.
- **Preprocessors.** Opt in to the app's preprocessors in `runic.json`. The collector imports `svelte.config.js` (Kit 2), or extracts the `sveltekit({...})` options (Kit 3), and uses only `preprocess`, `extensions` and `kit.alias`/`router`. Other keys (adapter, prerender handlers) are build-only and ignored with a note.
- **Kit 3 config.** `vite.config.ts` cannot be imported without running the app's Vite config. Read the literal `router.type` from the `sveltekit()` call's AST and reject non-literal options.

## 4. Proposed static SPA subset

### What a compiled SvelteKit app is

1. **Route manifest, built at compile time.**
   - **Source.** Use the app's own Kit to build the manifest. `create_manifest_data` (`@sveltejs/kit/src/core/sync/create_manifest_data/index.js`) plus `parse_route_id`/`exec` (`src/utils/routing.js`) give route IDs, layout chains (groups, `@` resets), error boundaries, parameter patterns, matchers and Kit's sort order.
   - **Pinning.** These are internal files rather than package exports, so pin them by version and SHA-256 as packs do.
   - **Matchers** (`src/params/*.ts`) compile as ordinary functions.
2. **Composition.**
   - A generated root component reproduces Kit's `root.svelte`: the layout chain is nested through `children` snippets, and each level gets `data`, `params` and `form` (always null).
   - **Persistence.** On navigation, a level whose component is unchanged keeps its instance and receives new props. So `/docs/a` → `/docs/b` keeps every layout and the page instance (the docs rely on `$derived` from `data` and on `{#key page.url.pathname}`).
   - The live-region announcer (`#svelte-announcer`) mounts as Kit's does, so the DOM matches in conformance.
3. **Loads.**
   - **Universal** `+page.ts`/`+layout.ts` loads run natively as ordinary async functions, with `browser = true`, `dev = false`, `building = false`. The `load` event provides `params`, `url`, `route`, `data`, `parent()`, `fetch` and `depends`, as far as used.
   - **Re-running.** As in Kit, a load re-runs only when what it read changed (params, url parts, parent, server data). Kit tracks those reads, so the native version must too. The docs layouts' loads read only `data` and run once.
   - **Server loads** (`+page.server.ts`/`+layout.server.ts`) and **prerendered endpoints** are evaluated at build time, by Kit in Node or by the compiler's interpreter, once for each `entries()` instance and each crawled URL. The results become typed constant tables keyed by route and parameters (`data`) or by URL (`fetch`). This matches what a static Kit build ships as `__data.json` and prerendered files.
   - **Unserialisable values.** Values that cannot be serialised (components) never cross that boundary in either app. Kit forbids them too.
4. **`fetch` inside loads** resolves same-origin URLs against the build-time table (`/api/block/*`). Other URLs are rejected. This is a narrower `fetch` than M8's local-resource fetch: response, `.json()` and `.text()`, typed by the load's declared or inferred result type. The `HighlightedBlock` interface is in `api/block/[block]/+server.ts`.
5. **Data typing.**
   - `data` in a page is the merge of its layouts' data and its own load result, as Kit's generated `$types` describe it.
   - The language layer must compute that type itself: run `svelte-kit sync` in the prepared copy, or infer it from the load functions. Most pages leave `$props()` untyped.
6. **Static module tables.**
   - `import.meta.glob` and analysable `import()` calls become tables of compiled modules.
   - `import()` returns a promise that settles after the target's module subgraph initialises. Module initialisation becomes lazy per chunk, at Kit's node granularity, instead of today's "initialise once at startup".
7. **`$app/state`.** `page` is a reactive record with `url` (a URL value: `pathname`, `search`, `searchParams`, `hash`, `origin`), `params`, `route.id`, `status`, `error` and `data`, written by the router.
   - **Origin.** `origin` needs a defined value natively, for example the site URL from `runic.json`. The site only uses it to build share links.
8. **Errors.** `error()` and `redirect()` from loads are router outcomes: redirects re-navigate, and errors render the nearest `+error.svelte`. An unknown path is a 404 through the root error page.

### Support first

**(a) The editor (M6 step 8).**
- Collection:
  - Kit 3 config detection, reading `router.type`;
  - the `#lib` subpath imports;
  - the virtual translations module;
  - `import.meta.env.MODE`.
- Rendering:
  - root layout plus a single page with `children`;
  - `app.html` `<html>`/`<body>` attributes;
  - `<svelte:head>`: `<title>` to `document.title` (the window title follows with M8 packaging); other head elements are inert natively and must be declared as such in the contract, not silently dropped.
- Routing: the hash router reading the runtime's location. The empty fragment maps to `/`, as Kit's hash mode does.
- Out of scope: bridge scripts in `app.html`, recognised as the D13 bridge in M8 and rejected until then.

**(b) The docs site (M6 to M7), in order:**
1. **Collection.**
   - Manifest and composition over the prerendered routes: `/`, `/docs/**`, `/blocks/**`, `/charts/**`, `/colors`, `/themes`, `/examples/**`.
   - The `$lib` and `$content` aliases.
   - The generated-input and preprocessor contract from §3.
2. **Router and APIs.**
   - Universal loads, build-time server loads and endpoints, the `fetch` table.
   - `$app/state`: `page` with `url`, `params`, `status` and `error`.
   - `goto` with `replaceState`/`noScroll`/`keepFocus`; `beforeNavigate` with `from`/`to.route.id` and `cancel`.
   - `error`/`redirect`.
3. **Markdown pages.**
   - Each page compiles as a component; it is static markup plus blueprint components.
   - The highlighted code is static markup at build time. Its `--shiki-*` styles go through the Stylo oracle.
4. **`{@html}`** in 4 places:
   - 3 code viewers insert shiki HTML from the build-time table;
   - `active-theme.svelte` inserts a `<style>` built from the constant `THEMES` table.
   
   Both have finite value sets known at build time. Lower them as constants where possible. Otherwise use a runtime HTML-fragment insertion through Blitz's own parser: `blitz-html`/`html5ever` are already in `Cargo.lock`, and no JS is needed. Use an element and attribute allow-list and check every possible stylesheet at build time.
5. **Host services:**
   - `document.cookie`, a persistent jar stored like `localStorage`;
   - runed's `PersistedState`, which uses `localStorage` and the `storage` event, now rejected;
   - opening external links (`target="_blank"`, links to non-page resources such as `/rss.xml`, the endpoint redirects) in the OS browser, or rejecting them.

### Reject (located diagnostics)

- **Server code that cannot be prerendered:**
  - `+page.server.ts`/`+layout.server.ts` on routes that are not prerendered: `/create`'s redirect, so the `/create` and `/preview` design-system section is out until it is decided;
  - non-prerendered `+server.ts` (`init`, `og`, `discord`, `registry`, `repro`);
  - form actions and `$app/forms`;
  - Kit 3 remote functions.
- **Hooks and other Kit features:**
  - `hooks.client`/`hooks.server`/`reroute`/`transport`;
  - service workers;
  - `$env/*` (until used);
  - snapshots;
  - shallow routing (`pushState`/`replaceState` from `$app/navigation`, `page.state`);
  - `invalidate`/`invalidateAll`;
  - `$app/stores` (legacy).
- **Preloading.** `preloadData`/`preloadCode` calls are rejected. The `data-sveltekit-preload-data` attribute is accepted only as a timing hint, with a contract note: loads are pure in both apps, and the table is in-process.
- **`app.html` scripts.** Inline and external scripts in `app.html` are rejected. The docs' inline cookie script reproduces `(app)/+layout.ts`'s theme classes before hydration, so it must be modelled or rejected, not dropped. Analytics and ads scripts are network behaviour.
- **`<iframe>`**, until M7 decides. The 3 live uses are:
  - `component-preview.svelte:45` (`type="block"`, only `content/components/sidebar.md`);
  - `block-viewer-iframe.svelte` (all `/blocks` pages);
  - `(create)/components/preview.svelte`.
  
  Natively, an iframe is a second instance of the same app, at another route with its own viewport width (the point of the block viewer is responsive breakpoints), rendered into a sub-surface. That is the M8 embedder interface turned inward, and is worth designing together with it.
- **Network `fetch`:** `github-link.svelte` fetches `ungh.cc` for star counts.

### Conflicts with "no JS engine at runtime"

**None in the site's or the editor's own code:**
- no `eval` or `new Function`;
- every `import()` and glob has finite targets known at build time;
- `{@html}` content is HTML and CSS, not script, and has a finite set of values.

**Library-level:**
- **zod 4** (`lib/blocks.ts`, `colors.ts`, `user-config.svelte.ts`, `registry/config.ts`, 2 example schema files) probes and uses `new Function` (`zod/v4/core/util.js:149`, `compile.js`) with an interpreter fallback (`jitless`). It needs a pack, or compiling the fallback path with `allowsEval` folded to false.
- **The `/create` design system** encodes presets at runtime with shadcn-svelte's `decodePreset`/`encodePreset`. That is ordinary code, no conflict, but a dependency to compile.
- **Code shown as text is not code.** Shiki and prettier run only at build time; at runtime, highlighted code is markup.

### Size and splitting

| Part | Files | Lines |
|---|---:|---:|
| `src/lib/registry/ui` (59 components) | 357 `.svelte`, 63 `.ts` | 11,078 |
| `src/lib/registry/examples` (top level, 404; 391 previewed) | 404 | 12,426 |
| `src/lib/registry/examples/create` (66 groups) | 527 | 30,050 |
| `src/lib/registry/blocks` (148 blocks) | 257 `.svelte` | 18,907 |
| `src/lib/components`, `features` | 148 `.svelte`, 9 `.ts` | 8,739 |
| `src/routes` | 145 `.svelte`, 45 `.ts` | 11,164 |
| `content/` | 105 `.md` | 15,319 |
| **All of `src/`** | 1,854 `.svelte`, 939 `.ts` | 104,096 |

**Libraries on top** (scan: `conformance/results/scan-shadcn-svelte.txt`):
- bits-ui (222 imports);
- 5 icon libraries (lucide 764 imports, tabler 119, hugeicons, phosphor, remixicon);
- layerchart and d3 (charts, 100 + 122 imports);
- `@tanstack/svelte-table`, svelte-sonner, vaul-svelte, paneforge, embla, formsnap/superforms/zod, dnd-kit, chrono-node, qrcode.

**Pin mismatches.** The docs pin Svelte 5.54.0 and Vite 8.1.5, which are not checked identities (`E_FRONTEND_VERSION`). bits-ui 2.19.2 differs from the editor's 2.19.5.

**Estimate from M5's binaries** (`conformance/results/m5-measure.json`):
- **Base:** 14.32 MiB for 7GUIs Counter (15 lines).
- **Larger apps:** Cells, 371 lines, is 14.44 MiB; Circle Drawer, 212 lines, 14.49 MiB; TodoMVC, 104 lines, 14.51 MiB. That is 0.3–1.8 KiB per source line.
- **Extrapolation:** roughly 40–200 MiB for the site's ~120k lines, before libraries and the highlighted-code markup (data rather than code). This is crude: Tailwind class strings dominate many template lines and cost data, not code.

**Judgement:**
- **Runtime:** one binary for the whole site is reasonable once module initialisation is lazy per route chunk. Untouched code is never paged in, and startup initialises only the start route.
- **Build:** the generated program cannot stay one `src/app.rs`.
  - Emit one Rust module, or crate, per route chunk and shared library chunk, so rustc parallelises and caches.
  - Measure rustc time on the editor-sized closure before committing to the whole site.
- **Conformance:** add route selection (`--routes /docs/components/**`) so a binary can hold the routes under test plus their layouts, while the release build holds all of them.

## 5. History and navigation

**Hash or path.** Both are needed:
- the editor uses `hash`; Kit's hash mode reads the route from `location.hash` (`client.js:1852,1859`) and ignores in-page anchors;
- the docs use `pathname` and depend on in-page anchors (201 `href="#…"`, TOC, `goto('/blocks/x#name')`).

Natively, a path router has no server to fall back to, which is harmless: a reload restarts the document at the current entry, which the runtime already does. The router chooses the field by the app's `router.type`.

**What the M5 runtime already gives** (CONTRACT "Host services", `crates/runic-runtime/src/history.rs`):
- in-process session history from a start URL;
- `pushState`/`replaceState` with a null state;
- `back`/`forward`/`go`, `length`;
- `pathname`/`search`/`hash` and `location.hash` assignment;
- `popstate`/`hashchange` as tasks;
- reload at the current entry.

**What a native Kit router needs in addition.** Kit's client router itself is not compiled: it relies on `history.state` indices and on scroll positions in `sessionStorage` (`client.js:101–160`, `session-storage.js`). The native router is runtime code and needs:
1. **Entry identity and per-entry data** (the navigation index, the scroll position) from the history module, instead of JS-visible `history.state`. Then save the scroll position on leaving an entry and restore it on traversal (Kit sets `scrollRestoration = "manual"`).
2. **Link interception** as the default action of `<a href>` clicks:
   - same-origin links in the app's routing mode navigate through the router;
   - `target="_blank"`, `rel="external"`, `download`, `data-sveltekit-reload` and links to non-page resources are external, so they open in the OS or are rejected;
   - modifier clicks follow Kit's `get_link_info` rules.
3. **After navigation:**
   - scroll to the top, or to the `#id` anchor (`scrollIntoView` exists since M5);
   - with `noScroll`, keep the scroll position;
   - reset focus to `<body>` (Kit's `reset_focus`) unless `keepFocus`;
   - update the announcer and `document.title`.
4. **The `beforeNavigate` lifecycle** (cancellable; `from`/`to` with `route.id`) for link, `goto` and `popstate` navigations. Its `beforeunload` variant is the window close, which the editor also listens to (`onbeforeunload`).
5. **Start URL:** `/` for a path-routed app, or `/#/` for a hash-routed one. Probes seed it per case, as `hash-router-start` does.

Kit's preloading, `invalidate`, shallow routing and snapshots are not needed by either app (§4).
