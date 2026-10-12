# Blending (2026-10-12)

`mix-blend-mode` and `background-blend-mode` with Blitz fork commit `8acde914`
(*Paint mix-blend-mode and background-blend-mode as Chromium does*) and the
runtime's `E_BLEND` guard. Case `blend` (fixture `blend-svelte`, no Tailwind),
Chromium 153.0.8010.12, viewports 800x700 and 420x1100, one state: 71 pixel
regions, one per blended box.

## Chromium behaviour measured and matched

Measured with an uncommitted probe page in Chromium 153: backdrop
`rgb(40, 120, 200)` and source `rgb(220, 90, 60)`, unless stated otherwise.

| Behaviour (Chromium 153) | Blitz before | Now |
|---|---|---|
| The 16 values other than `normal`. multiply 35,43,47; screen 225,168,213; overlay 69,85,171; darken 40,90,60; lighten 220,120,200; color-dodge 255,185,255; color-burn 6,0,21; hard-light 196,85,94; soft-light 84,101,177; difference 180,30,140; exclusion 190,124,166; hue 199,69,39; saturation 40,120,200; color 199,69,39; luminosity 61,141,221; plus-lighter 255,210,255. Neither Chromium nor Stylo parses `plus-darker` | drawn as `normal` | a layer in peniko's `Mix` mode; plus-lighter is `Compose::PlusLighter` |
| Isolation: these ancestors isolate a blended descendant, which then blends only with what they paint. `isolation: isolate`, opacity, transform, z-index, `position: fixed`, `will-change: transform`, filter, `contain: paint` | — | Blitz's stacking contexts with a blended descendant get an isolation layer. `will-change` and `contain` are not Blitz stacking contexts: reported (`E_BLEND`) |
| These ancestors do not isolate. Overflow `hidden`/`auto`/`clip`, rounded overflow, `clip`, a scrolled scroller. Content clipped by `overflow: hidden` (green over half) multiplied gives 0,90,0 | — | the clip layers are closed around the blend layer and drawn again inside it |
| On the root element (`html`) `mix-blend-mode` is ignored. A blended `body`, or blended content under it, blends with the canvas background | — | the root's blend is skipped; the runtime paints the canvas white under the document as before |
| opacity 0.5 with multiply gives 38,82,124. An overflowing child of a blended element is blended with it. A multiply inside a screen-blended element blends only within its group: 225,168,213 | — | the blend layer is outermost (opacity, filter, clip-path and mask inside) and the size of the viewport |
| A `::after` with darken gives 40,90,60 | — | as any element |
| `background-blend-mode: multiply` over a background colour gives 34,42,47. Without a colour, a layer does not blend with what is behind the element. `plus-lighter` is not accepted | drawn as `normal` | each image layer is a blend layer inside an isolation layer around the element's backgrounds |

## Results

| Run | Semantics | Geometry | Pixels |
|---|---|---|---|
| `node conformance/run.mjs blend --pixels` at Blitz `5a047829` (before) | 2/2 | 2/2 | 0/2: 69 of 71 regions above 3/255 |
| `node conformance/run.mjs blend bits-avatar --pixels` | 22/22 | 22/22 | 22/22 |
| `node conformance/run.mjs blend bits-avatar --pixels --no-opt` | 22/22 | 22/22 | 22/22 (identical numbers) |
| `node conformance/run.mjs blend --pixels --renderer gpu` (lavapipe/llvmpipe) | 2/2 | 2/2 | 2/2 |

Region mean error (/255) by group, the range over its regions. Before the
fix the numbers are the same at 420x1100 except where noted. After it, the
numbers are from the CPU and GPU renderers, the larger of the two viewports:

| Group | Before | CPU | GPU |
|---|---|---|---|
| over a solid colour (16) | 21.0–123.7 | 0–0.333 | 0–0.667 |
| translucent over a gradient (16) | 7.8–74.6 (3.8–63.2 at 420) | 0.424–1.024 | 0.196–0.735 |
| over an image (16) | 18.4–75.7 | 0.080–0.256 | 0.059–0.453 |
| opacity, nested (3) | 41.0–74.1 | 0.333–0.667 | 0–0.667 |
| isolating ancestors (4) | 5.6–6.3 | 0–0.549 | 0.198–0.648 |
| none, overflow, rounded overflow, hoisted child (4) | 23.6–41.1 | 0–0.478 | 0–1.038 |
| text (2) | 10.3–41.0 | 0.409–0.599 | 0.487–0.802 |
| avatar rings (3) | 0.76–5.44 | 0.242–0.734 | 0.226–0.968 |
| `background-blend-mode` (7) | 43.0–105.3 | 0.163–0.574 | 0.108–0.341 |

Before the fix, whole-viewport error was 10.4/255 at 800x700 and 12.7/255 at
420x1100. Now it is 0.139 and 0.168 on the CPU, and 0.208 and 0.249 on the
GPU.

Unit tests: blitz-paint 7 render with vello_cpu and compare with Chromium
153's pixels within 1/255:

- every mode;
- isolating and non-isolating ancestors;
- a hoisted child blended through its clip;
- opacity and nesting;
- a pseudo-element;
- root and body;
- `background-blend-mode`.

Disabling the clip suspension fails two of them (220,90,60, drawn as
`normal`). runic-runtime 3 (`effects::tests`) cover `E_BLEND`.

## Reported, not drawn

`E_BLEND` stops a probe, and an app reports each element once. It covers a
blended element that is:

- a non-atomic inline box: Blitz draws its text and backgrounds with its
  line's text, so the blend layer never wraps them. The fixture's first text
  draft, a blended `<span>`, measured 10.3/255 drawn unblended, so the fixture
  blends a block.
- SVG content inside an `<svg>`: usvg receives no `mix-blend-mode`.
- also backdrop-filtered.
- below an ancestor that only Chromium makes a stacking context:
  `will-change` naming a stacking property, `contain`
  paint/layout/strict/content, `container-type` size/inline-size,
  `backdrop-filter`, `perspective` or `transform-style: preserve-3d`.

[PLATFORM](../../docs/gaps/PLATFORM.md#css-and-rendering-p4),
[BLITZ-GAPS](../../docs/BLITZ-GAPS.md).

## Regressions

With `--pixels`, all on the CPU renderer:

| Run | Runs | Result |
|---|---|---|
| `hover-events hover-targets` | 12 | passed |
| `tables-interactive` | 6 | passed |
| `forms forms-react forms-vue measure scroll-events focus focus-fixup` | 22 | passed |
| `blitz-buttons blitz-button-baseline blitz-control-line-height blitz-inline-baselines` | 7 | passed |
| `fieldset images bits-dialog bits-toggle-group` | 8 | passed with the two existing known gaps |

The two known gaps are `fieldset` at both viewports and `bits-toggle-group` at
420px. Their region numbers are unchanged: fieldset up to 5.822 and 6.529,
toggle-group `bound` 3.856. `images` is also unchanged: `sized` 0.886–0.893,
`cover` 0.767–0.792.
