# Images: Svelte `<img>` — 2026-10-12

Steps 4 and 5 of the [image design](../../docs/design/M6-IMAGES.md) for `<img>` in Svelte: the runtime's pinned net provider, `load`/`error` dispatch and the adapter's `src` value check. `new Image()`, Avatar, React and Vue are open ([gaps](../../docs/gaps/PLATFORM.md#images-and-fonts-p7)).

Case `images` (fixture `images-svelte`, Chromium 153.0.8010.12, CPU renderer, viewports 800x600 and 420x600, the mount and three clicks: 8 compared states per mode). The fixture loads three files of `public/` and two remote URLs pinned by a real `runic images` run: a GitHub avatar (PNG, 3,144 bytes) and a missing file on raw.githubusercontent.com pinned as HTTP 404 (`avatars.githubusercontent.com` answers unknown ids and paths with a 200 identicon, so it has no 404 to pin). In Chromium the harness routes each pinned URL to its pinned bytes or status; any other remote request fails the run.

| Run | Semantics | Geometry | Pixels |
|---|---|---|---|
| `node conformance/run.mjs images --pixels` | 8/8 | 8/8 | 8/8 |
| `node conformance/run.mjs images --pixels --no-opt` | 8/8 | 8/8 | 8/8 |

The DOM, focus and geometry of every state match exactly, including the visible event log (`load local, click, load avatar, click, error missing, click, load local`) and the status line written by `onload`/`onerror` of the pinned avatar and the pinned 404. Both modes give identical pixel numbers. Whole-viewport mean error: 0.236–0.305/255 at 800 px and 0.401–0.531/255 at 420 px. Region mean errors, constant over the steps:

| Region | 800x600 | 420x600 |
|---|---|---|
| `#sized` (64x48 PNG drawn at 96x72 by its `width`/`height` attributes) | 0.893 | 0.886 |
| `#intrinsic` (the same PNG at its own size, `decoding="async"`) | 0 | 0 |
| `#avatar` (40x40 pinned remote PNG) | 0 | 0 |
| `#cover` (120x60 PNG, `object-fit: cover`, full width x 90 px) | 0.767 | 0.792 |
| `#switch` (the image whose `src` the button cycles; absent at step 2, hidden after its 404) | 0 | 0 |

Scaled images stay within the 3/255 gate but are not exact; the difference is recorded as its own [gap row](../../docs/gaps/PLATFORM.md#images-and-fonts-p7) (image filtering). The differential (`node conformance/differential.mjs images-svelte`) reports the fixture incomplete: the interpreter loads no images, so it has no `load`/`error` to deliver ([T1 row](../../docs/gaps/VERIFICATION.md#reference-interpreter-t1)). A listener-free variant (two `<img>`, one `src` toggled by a click among `public/` files, not committed) compared complete: 20 traces x 25 actions, 520 steps, 0 failures.
