# M6: images as pinned assets

Status: **approved 2026-10-12** by the user at the WORKING.md design checkpoint (the IR change affects every frontend), with the open points below taken as proposed. Decision it implements: [ROADMAP decisions log](../ROADMAP.md#decisions-log), 2026-10-12, "remote images become pinned build assets".

## Driving examples

The [example census](../../conformance/triage.mjs) stops 16 of the 404 shadcn-svelte component examples at `<img>` (`E_TEMPLATE`, gap cluster P7):

- 12 reach bits-ui's `Avatar.Image` (avatar-*, empty-avatar-*, message-*). Avatar.Image renders `<img {src}>`, and its state class decides between image and fallback with `new Image()`, `onload` and `onerror` (`node_modules/bits-ui/dist/bits/avatar/avatar.svelte.js`). Today `new Image()` lowers to a `RunicUnsupportedError` (`frontend/language.ts`, "the native runtime loads no images").
- 4 render `<img>` directly: aspect-ratio-*, card-image.
- 14 of the 16 use remote https sources (github.com avatars, avatar.vercel.sh, unsplash). The site itself has 70 `<img>` in 47 files ([M6-SVELTEKIT research](../research/M6-SVELTEKIT.md)).

## What exists

- **Blitz** (pinned `7be80352` when this was written) builds the `image` crate without any format features, so it decoded no raster image in this workspace; SVG decodes behind the runtime's `svg` feature. *Corrected in step 4:* runic-runtime now enables `image`'s `png`, `jpeg`, `webp` and `gif` decoders (the workspace `image` dependency, no new crates in the lock), and Blitz is pinned at `8da0f830` (step 3). It lays out `<img>` with intrinsic sizes (`blitz-dom/src/layout/mod.rs`) and paints `object-fit` (`blitz-paint/src/sizing.rs`). It loads `src` through the document's `NetProvider` (`blitz-dom/src/mutator.rs` `load_image`). It dispatches **no** `load` or `error` event for an image: a failed fetch only drops the pending entry (`document.rs` `load_resource`), and `DataUriNetProvider` returns silently on a decode failure (step 3's fork commit records both outcomes, `take_image_load_events`).
- **Assets** already flow end to end for fonts: the collector inlines CSS `url()` files (1 MiB cap, local only, `compiler/collect.mjs`). The IR carries `styles.assets` (`{path, sha256, bytes, mime}`; the validator accepts only `font/woff2`, up to 4 MiB). Codegen embeds them with `include_bytes!`, and the runtime serves them as data URLs.
- **The precedent for an explicit networked step** is `runic generate` (pinned tool versions and hashes, a committed record and a staleness check at build time) and `conformance/corpus/fetch.mjs` (exact commits).

## Design

1. **`runic images <app>`, an explicit operation, never part of a build.** It collects every image URL the program can reach (step 3) and fetches each one once. It writes the bytes to `<app>/images/<sha256>.<ext>` and a record, `<app>/runic.images.json`, with one entry per URL: `{ url, sha256, bytes, mime }`, or `{ url, status }` for a URL that failed. The record and files are committed with the app. Builds read only the record and the files, never the network. Missing, extra or altered entries fail the build with `E_ASSET` and the command that fixes them. A failed fetch is pinned as a failure, so the error path (Avatar's fallback) stays reproducible.
2. **Local images** (an imported asset, or a path under the app's static directory) take the same asset path without the fetch step.
3. **Which URLs.** A `src` (attribute, `new Image().src` or `.src =`) must have a finite set of string values known at build time. The language layer's existing value domains supply these: the same mechanism types bits-ui's discriminants and evaluates the tailwind packs. Each value must be pinned. An open value (an image URL from data the program computes) is rejected with `E_ASSET` at the source location. At run time, a `src` that is not in the table cannot occur. If it does, through a path the analysis missed, the runtime reports it as unsupported rather than firing a silent `error`.
4. **IR (schema change, all frontends).** Generalise `styles.assets` to a top-level `assets` list with a MIME allowlist (`font/woff2`, `image/png`, `image/jpeg`, `image/webp`, `image/gif` and `image/svg+xml` when the `svg` feature is selected) and a per-asset size limit (proposed: 4 MiB per image, 32 MiB per program). Add `images: [{ url, asset } | { url, status }]`, the table the runtime resolves `src` through. Migration from the current schema moves font assets unchanged. The validator checks hashes, MIME types, sizes and that each `images` entry names an asset.
5. **Runtime.** A `NetProvider` serves `runic-asset:` URLs and pinned URLs from the embedded bytes. No socket is ever opened.
   - **Fork patch (Blitz, one commit, offered upstream).** Dispatch `load` after a successful decode and `error` after a failed fetch or decode, as tasks after the current one, matching Chromium's ordering for cached images. The conformance cases measure that ordering.
   - **`new Image()`** becomes a host object, not an element in the document. Setting `src` resolves through the same table and schedules `load` or `error`. It supports `onload`/`onerror`/`addEventListener`, `complete`, `naturalWidth`/`naturalHeight` and `decode()`. `crossOrigin` and `referrerPolicy` are accepted and recorded; with no network they change nothing observable, and the docs say so.
6. **Adapters.** Add `img` to the Svelte, React and Vue tag sets, with `src`, `alt`, `width`, `height`, `decoding` and the event attributes. These stay rejected until measured:
   - `loading="lazy"`, which changes when `load` fires;
   - `srcset`/`sizes` with more than one candidate (DPR selection);
   - `<picture>`;
   - `crossorigin` affecting canvas reads (no canvas exists).

## Verification

The browser side must see the same bytes. In the conformance harness, Playwright routes every pinned URL to the pinned file or status, so Chromium is also offline. Cases:

- **Avatar:** load success, a pinned failure showing the fallback, and a `delayMs` fallback.
- **aspect-ratio:** `object-fit: cover` at two viewports.
- **card-image**.
- **A direct `<img>`** with `width`/`height` only, then intrinsic size only.

Each case checks geometry, the event trace and pixels. Image scaling filters likely differ from Chromium's; any such difference is recorded as its own pixel gap, never absorbed by tolerance. A builder unit test covers the record checks (stale, extra, altered, missing). The differential harness reports image loading as an interpreter stage it does not model (T1).

## Work order

1. IR, validator and migration, with font assets moved and nothing else changed. Full `npm test` and workspace tests. Done as schema 5 ([IR](../IR.md#program)): an `images` entry names its asset by index into `assets`, and `image/svg+xml` is accepted only in a program drawing inline SVG, the condition under which codegen selects the `svg` feature.
2. `runic images` plus the build-time record check. Collector paths for local and pinned remote images. Done ([CONTRACT](../CONTRACT.md#collection), `compiler/images.mjs`): a lowering result may carry `imageUrls` (`{ url, source }`, none yet); `lower()` pins them before validation; `runic-codegen emit --asset-root <app>` reads, rechecks and embeds the bytes and emits `App::IMAGES` (`runic_runtime::images::PinnedImage`, sorted by URL in byte order). Decisions taken here: without remote URLs `runic images` removes the record (apps without remote images carry none); a Content-Type of `application/octet-stream` or none is accepted, its common aliases (`image/jpg`, `image/pjpeg`, `image/x-png`) count as the canonical type, and any other type than the bytes' fails; root-relative URLs are percent-decoded and may not carry a query, fragment or empty, `.` or `..` segment; the record and the files in `images/` feed the source hash, while local static files enter only through the asset digests and the recomputed `irHash`; SHA-256 in `runic-codegen` is a small local implementation (no hash crate is in the workspace lock).
3. The Blitz load/error event patch, as a fork commit with its own probe.
4. Runtime `NetProvider` and the `new Image()` host object. Lowering in `language.ts`. Done for `<img>` (`crates/runic-runtime/src/images.rs`, [CONTRACT](../CONTRACT.md#collection)): `PinnedNetProvider` serves the table, `data:` URLs and nothing else (an unpinned URL is reported unsupported and never opens a socket); the document's base URL is `http://runic.invalid/`, and table URLs are matched after the same `Url` normalisation Blitz applies; `load` and `error` (IR event kinds, non-bubbling, `<img>` attributes only) are dispatched each as its own task in Blitz's order, at the start of each host-task round and at startup, dropping an event whose element's `src` changed since. The `new Image()` host object is done (IR type `image` and `image.*` built-ins, [IR](../IR.md#types-and-values); lowered in `frontend/language.ts`; [CONTRACT](../CONTRACT.md#collection)): `src`, `onload`/`onerror` and `load`/`error` listeners, `crossOrigin` and `referrerPolicy` recorded only; each outcome runs as a task after decoding, before the `<img>` events of the round, and a new `src` abandons the earlier one. `complete`, `naturalWidth`/`naturalHeight` and `decode()` are rejected, and the orders that differ from Chromium are [gap rows](../gaps/PLATFORM.md#images-and-fonts-p7).
5. Adapter tag and attribute support (Svelte first, D14), then the conformance cases above. React and Vue follow if the cost stays small. Done for Svelte's `<img>` (case `images`, fixture `images-svelte`, [results](../../conformance/results/images-svelte.md)); React and Vue are a [gap row](../gaps/PLATFORM.md#images-and-fonts-p7). The Avatar case is done (case `bits-avatar`, fixture `bits-avatar-svelte`, [results](../../conformance/results/bits-avatar-svelte.md)): `<img>` spreads with determined `src` values, `src` followed through props and `boxWith` getters, load success, a pinned 404, `delayMs`, a source switched at run time; its pixels at 420px are a known gap (`mix-blend-mode`).
6. Rerun the census. The 16 examples move to their next blocker; per the census assessment, message-* stop next at `bubble-content.svelte:15`.

## Review outcome

- Record location and names: `runic.images.json` and `images/`, as proposed. Conformance fixtures commit their own record and images the same way; no separate vendoring step.
- Size limits: 4 MiB per image, 32 MiB per program.
- A pinned failure records only the HTTP status. A network error without a status fails `runic images` instead of being pinned.
