# Clean rebuild verification (2026-10-12)

The shared cargo target (`target/`, 68.1 GB of accumulated builds) was deleted and everything rebuilt from nothing at compiler `3c328e1`: schema 5 (top-level assets, the image table), the census batches and the [fixed inline edges](chromium-inline-edges.md), with all rendering forks resolved from their Runic-Artifex GitHub repositories (Blitz `c8ecc95`, Parley `13cfb74`, Stylo `568059d`, Vello `a8efce5`, anyrender `22b336b`, Taffy `e7be3d5`). The rebuild found one bug: the build lock assumed `target/` exists, so every native build failed on a fresh clone (fixed in `3c328e1`).

| Stage | Result |
|---|---|
| Workspace tests | 152 passed, 0 failed (full rebuild in 147 s) |
| `npm test` | 359 passed, 0 failed |
| Direct matrices | 36 matrices and the 2 cache drivers, 5,396 states: all 7,344 native and browser JSON outputs byte-identical to the accepted inline-edge run, no gate changes, exit codes as recorded |
| Compiled commands | 6 of 6 pass (hover with and without optimisation, tables on CPU and GPU, forms/focus, control regressions), 61 runs as recorded |
| Differential | **Incomplete**: 127 ok, 44 incomplete, 0 FAIL across 171 fixtures, then the native probe of `table-react` panicked in Blitz's debug-only layout check and the run stopped ([gap](../../docs/gaps/VERIFICATION.md#test-infrastructure-t2)). The same panic occurs at the previous pins. Completed later at compiler `bb091df` (Blitz `ef6e873`, which fixes the stale table layout child; the harness now records a probe failure and goes on): all 189 fixtures ran, 142 ok, 47 incomplete, 0 FAIL, with `kit-docs-svelte` incomplete for its missing generated inputs and, once generated, incomplete because it reads layout as before. |

Pixel outputs were compared through the gates recorded in the JSON results; the PNG files were not kept. Disk: 161 GB free before deleting the target, 225 GB after the rebuild and verification (the new target holds 4.6 GB).
