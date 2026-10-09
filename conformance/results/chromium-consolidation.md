# Canonical parity and hover integration — 2026-10-09

The compiler and local renderer forks now have one working checkout each. The signed renderer revisions are unchanged from the prior parity checkpoint; the compiler adds completed mouse hover events, exact locked Git sources and complete differential trace accounting. This is a bounded integration checkpoint, not whole Chromium parity.

Tested compiler revision: `4d9413301006878a9ae02dceaacc65f4133e13d9`. See the [machine-readable record](chromium-consolidation.json) for all signed sources and proof hashes.

| Check | Result |
|---|---|
| Compiler suites | 316 passed, no failures or skips |
| Rust workspace | 128 passed, no failures, ignores or filters |
| Compiled hover, optimized and unoptimized | 180 browser/native states passed |
| Retained tables, controls and focus | 389 browser/native states passed |
| Required compiled screenshots | 1,138 present and hashed |
| Hover differential, both modes | 120 complete traces, 3,120 states, 3,000 original actions and resolved endpoints |
| Fresh direct table and authored-edge matrices | 104 pairs with unchanged raw JSON and whole PNG bytes |

The root independently rehashed 111 evidence files and 2,787 observations, regenerated the seeded physical hover actions, and verified complete endpoint replay. Differential endpoint selection comes from the real native pre-action hit. It checks event semantics and compiler behavior; independent browser/native and direct probes still own hit correctness.

Direct strict failures remain visible with their original exit 1: tables pass 77/77 geometry and 74/77 strict pixels; authored-edge drivers pass 3/27 geometry and 0/27 strict pixels. All 35 earlier fork matrices retain their source revisions and historical results (4,820 pairs); only two were freshly captured here. The six prior dependency-suite failures, default/system-font parity, OS input/IME and the unavailable named `/code-review` stage remain unpassed or incomplete. Recorded PNG error measurements were audited, not independently recomputed.

The lock retains all 468 package identities, versions, registry checksums and normalized dependency edges. Thirty fork packages now use exact local Git revisions. The resolved Cargo checkouts and authoritative signed repository heads were verified before and after each acceptance job.

Six redundant worktrees were removed after both audits passed; their branches and rollback references remain. Opus's original unfinished submission work is preserved in signed archival commit `844bc27fa8d2c72302b6b86614140f871ce8173c`. All 18 unique generated fixture files were archived and hash-verified. Cleanup removed 367 confirmed ELF build outputs (34,497,605,120 bytes) and the obsolete codegen cache (6,033,591,264 bytes), preserving 2,929 conformance source/IR/lock/asset/evidence files, active caches and the shared target.

The initial missing-development-dependency run and the earlier differential target mismatch are retained. Acceptance followed a full offline dependency installation and the structural endpoint replay fix; no physical actions, expected states, tolerances or cases were rewritten.

Form submission and reset are **not** verified by the retained control/focus cases. Next is an end-to-end canceled-submission implementation shared across activation, implicit Enter and `requestSubmit()`. The next renderer effort remains ordinary-inline authored edges and common used positions for layout, paint, hits and editing. Existing compiler sticky/fill and runtime inline-fragment guards stay until their own integration evidence supports lifting them.
