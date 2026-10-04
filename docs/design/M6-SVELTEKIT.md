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

Open: Kit 3 and the editor's `#lib` imports and bridge scripts; build-time server data and endpoints; `page.data`/`page.state`, shallow routing, `invalidate`, `navigating`; render errors routed to `+error.svelte`; reload scroll restoration.

## Versions

Kit versions join the checked identities like the frameworks: 2.70.x for the site, 3.0.0 for the editor. Svelte 5.54.0 and Vite 8.1.5, the site's pins, need their own version environments in conformance (as `conformance/svelte-5.49.2` is), and those must run in the campaign, not just exist.
