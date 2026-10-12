# Images: `new Image()` and bits-ui's Avatar — 2026-10-12

Steps 4 and 5 of the [image design](../../docs/design/M6-IMAGES.md) for the `new Image()` host object and the Avatar cases: bits-ui 2.19.2's Avatar compiled from its published source through shadcn-svelte's unmodified avatar wrappers. Avatar.Image renders `<img {...mergedProps} {src} />`, and its root state decides between image and fallback with `new Image()`, `onload` and `onerror`. Both receive the `src` literal the app passes, through the wrappers' props and bits-ui's `boxWith` getters.

Case `bits-avatar` (fixture `bits-avatar-svelte`, Chromium 153.0.8010.12, CPU renderer, viewports 800x600 and 420x600, the mount and nine actions: 10 compared states per viewport). `runic.images.json` comes from a real `runic images` run: `https://github.com/shadcn.png?size=40` (JPEG, 1,355 bytes) and `https://github.com/evilrabbit.png?size=40` (PNG, 710 bytes), both 40x40, and `https://github.com/runic-artifex-no-such-user-404.png?size=40`, pinned as HTTP 404.

The case covers:

- load success after the default `delayMs` of 0 (`wait 0`);
- the pinned 404 showing its fallback (`data-status` error), with a badge;
- a group of two small avatars with a count;
- a root with `delayMs` 500, still loading after `wait 300` and loaded after `wait 250`;
- a source switched at run time from the 404 to an image (`swap`, then `wait 0`);
- sizes changed from the app (`small`, `large`);
- the group count changed (`more`);
- a hover.

The roots' `onLoadingStatusChange` callbacks write a visible trace.

| Run | Semantics | Geometry | Pixels |
|---|---|---|---|
| `node conformance/run.mjs bits-avatar images --pixels` | 14/14 | 14/14 | 13/14, 1 known gap |
| `node conformance/run.mjs bits-avatar images --pixels --no-opt` | 14/14 | 14/14 | 13/14, 1 known gap |
| `node conformance/run.mjs blend bits-avatar --pixels`, with and without `--no-opt` (Blitz `8acde914`; per viewport the 10 `bits-avatar` states and the 1 `blend` state) | 11/11 | 11/11 | 11/11 |

Each row's 14 states are the `bits-avatar` case's 10 and the `images` case's 4 at one viewport, both viewports giving the same counts. The DOM, focus and geometry of every state match exactly, including each avatar's `data-status`, the visible fallback or image, and the trace: `switch error` at the mount (the 404 settles before the first state), `delayed loaded` after `wait 250` (not after `wait 300`), `switch loading` after `swap` and `switch loaded` after the following `wait 0`. Both modes give identical pixel numbers. The `images` case is unchanged: the same region numbers as in [images-svelte](images-svelte.md).

## Pixels

Mean error of the `#avatars` region (/255) per state. The gate is 3/255. The first two columns are this record's original run, from before Blitz drew `mix-blend-mode` at all (it drew it as `normal`). The last two were measured at Blitz `8acde914`, which blends as Chromium does ([blend-svelte](blend-svelte.md)); `bits-avatar` with and without `--no-opt` gives identical numbers.

| State | 800x600 before | 420x600 before | 800x600 blended | 420x600 blended |
|---|---|---|---|---|
| mount (fallbacks: images not loaded yet) | 0.586 | 1.16 | 0.602 | 1.191 |
| wait 0 (images shown) | 1.662 | 3.289 | 0.797 | 1.577 |
| wait 300 | 1.662 | 3.289 | 0.797 | 1.577 |
| wait 250 (the delayed image shown) | 2.379 | 4.709 | 0.809 | 1.601 |
| small | 2.256 | 4.466 | 0.748 | 1.481 |
| swap | 2.256 | 4.466 | 0.748 | 1.481 |
| wait 0 (the switched image shown) | 2.856 | 5.653 | 0.642 | 1.271 |
| more | 2.866 | 5.673 | 0.653 | 1.292 |
| large | 2.483 | 4.916 | 0.589 | 1.167 |
| hover | 2.483 | 4.916 | 0.589 | 1.167 |

Before blending, whole-viewport mean error ranged over 0.075–0.237/255 at 800 px and 0.143–0.452/255 at 420 px. At 420 px the region failed the gate once images showed, and the case recorded this as a known gap. With blending, whole-viewport mean error is 0.076–0.116/255 at 800 px and 0.144–0.221/255 at 420 px. Every state passes, and the known gap is removed.

The cause was shadcn-svelte's avatar ring. `after:absolute after:inset-0 after:border after:border-border after:mix-blend-darken` draws a light border, and `mix-blend-mode: darken` removes it over the image in Chromium. Before `8acde914`, Blitz paint ignored `mix-blend-mode`, so the native ring stayed visible over every image. Crops of the 420 px shots before the fix, measured with `magick compare -metric MAE`:

| Crop | Mean error |
|---|---|
| The first avatar, 44x44, after `wait 0` | 5.13/255 |
| The whole `#cn` avatar after the switch | 6.57/255 |
| A 14x14 crop inside `#cn`'s image, away from the ring | 1.35/255 (resampling of the 40x40 image, the [scaled image row](../../docs/gaps/PLATFORM.md#images-and-fonts-p7)) |

The remaining region error is the resampling of the scaled images.

## Ordering against Chromium

Measured with a probe page of 11 scenarios in Chromium 153.0.8010.12, under a real clock and under Playwright's installed clock (the harness's). The probe was not committed.

These orders match the runtime:

- one outcome per `src` set;
- a second set abandons the first outcome, also when the second URL is cached;
- `load` comes after the setting task and its microtasks;
- listeners run in registration order, the handler at the position of its first assignment;
- an empty `src` gives `error` (the `src` reads back as the page URL);
- `crossOrigin` reflects as `anonymous` for `foo`, and an invalid `referrerPolicy` as `""`;
- under the installed clock, loads and errors come before 0 ms timers.

These orders differ:

- **`<img>` before an image object.** For cached URLs Chromium dispatches in request order (`img load, img2 load, Image2 load` when the `<img>` got the URL first). The runtime runs image-object outcomes before the `<img>` events of the same round.
- **Uncached loads.** They finish in network order in Chromium: in this run the `<img>` first in both request orders, in an earlier run varying.
- **Real clock.** Chromium runs a 0 ms timer before uncached loads and before a cached `<img>`'s load. The runtime runs every finished load first.

The [gap row](../../docs/gaps/PLATFORM.md#images-and-fonts-p7) records these differences. `complete`, `naturalWidth`, `naturalHeight` and `decode()` are rejected. Chromium reports a cached image as `complete` with its natural width synchronously, and an uncached one as not complete with width 0.

## Differential

`node conformance/differential.mjs bits-avatar-svelte images-svelte` reports both fixtures incomplete:

- `bits-avatar-svelte`: the interpreter loads no images, and the program sets the `src` of an image object.
- `images-svelte`: `<img>` listens for `load`.

There are 0 failures ([T1 row](../../docs/gaps/VERIFICATION.md#reference-interpreter-t1)).
