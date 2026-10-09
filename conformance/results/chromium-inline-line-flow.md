# Chromium parity: private line-flow consumers

Parley's borrowed, crate-private `LineFlow` now routes committed-line glyph
placement, cluster point/visual-offset lookup and first/last-line selection
traversal, alongside the existing content and box views. Four new regression
tests compare those consumers with independent legacy formulas. Style grouping,
f32/f64 accumulation, glyphless content and out-of-flow widths keep their
separate policies. Vertical geometry, newline indicators, middle-line selection
and terminal caret fallback remain consumer decisions. No public API, text,
shaping boundary, caret stop, CSS binding or used-edge advance is added.

This is a foundation checkpoint: **zero Chromium repairs and zero regressions**.
Across 35 direct matrices and 4,820 states, result files, raw native states,
whole native screenshots and browser reference bytes are unchanged. Three before
matrices are fresh (498 states); 32 use explicitly retained historical baselines.
The fresh affinity capture had a verified docs-only diff. The independent audit
checks exact bytes and recorded gates; it does not recompute direct PNG MAEs.
Absolute strict parity remains failed: 761 geometry and 3,391 strict pixel states.
The 75-state zero-edge subset retains 75 geometry/fragment, 69 rectangle-hit and
49 strict pixel passes. Explicit point coverage is absent in that subset.

All six compiled regression commands completed: 61 runs, 569 states, 508 actions
and 1,138 PNGs, including hover in both optimization modes, CPU/selected GPU
tables, forms/focus and controls. The independent audit passes raw semantics,
geometry and independently decoded whole/authored-region PNG metrics at the
unchanged compiled tolerances. Both audits authenticate their exact source and
evidence inventories; dependency suites with known failures remain unpassed.
The initial runner stopped after the first successful hover job because expected
case counts were mistaken for an exit-code list. A source-guarded resume ran only
the missing five jobs. The completed first journal entry and orchestration
failure were retained; the aggregate journal was appended.

Compiler/workspace checks pass 344/143 tests. Parley std passes 204 with its four
historical cluster-position failures; Blitz DOM passes 76 with its two historical
hover/scroll failures. These dependency suites remain unpassed. Blitz paint/HTML
pass 13/3; Parley libm and formatting checks pass. The 152-file Parley test mirror
was prepared before signing and authenticated against the final signed source.
It was removed after both audits consumed it. The compiled manifest retains
historical hashes for its 154 disposable file references; those files are no
longer present. Source proof and test logs remain.
The separate historical placeholder reduction was not rerun by this checkpoint.
System-font/default-feature parity, OS keyboard/pointer/IME delivery and the
unavailable named `/code-review` stage remain incomplete. Independent source
review was completed.

Tested heads are compiler `c820f87`, Parley `3b16e99` and Blitz `4a6f257`; the other
four pinned forks are unchanged. The subsequent record commit is docs-only.
Only the six Parley lock source entries change after normalization; the unrelated
lock edge changed by Cargo was restored. The font-weight harness now uses the
canonical Parley checkout, with identical font bytes at both signed revisions.
One maintained development checkout per repo is retained, excluding Cargo caches
and Parley's bare reference repository; no per-agent checkout was created.

Next, freeze logical scheduling and structural placements for signed edges,
including pending normalized space around out-of-flow boxes. Implement width
and quota breakers, intrinsic sizing and rollback/replay together, then route all
effective paint/editing coordinates through the private views. Breaker/intrinsic
and effective consumer wiring must pass one acceptance checkpoint together; an
advance-only intermediate implementation is not supported. Keep CSS and
margin/border ownership in Blitz and generic layout units in Parley. Reuse the
existing wrap/min-content/forced-break browser drivers; add instrumented overflow
recovery, opposing nonzero edges, rollback, custom-box replay and bidi identity
proofs. This next design is planning only.

The [JSON record](chromium-inline-line-flow.json) contains source pins, exact
gate totals, failed test identities and hashes of the retained local evidence.
See the [ADR](../../docs/ARCHITECTURE.md#chromium-parity-private-line-flow-consumers-2026-10-09)
and [targeted plan](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership).
