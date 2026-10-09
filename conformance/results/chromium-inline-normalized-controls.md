# Chromium parity: normalized span control sites

Parley now retains private normalized box anchors and an authored edge/box control
stream. Boxes recorded while collapsible whitespace is pending join that
sequence's anchors: retention shifts their normalized sites by one byte; discard
leaves them in place. Public box indices, shaping seams and bidi identity stay
unchanged. Thus `a [OOF]b` and `a[OOF] b` both yield `a b` and public box
index 1, but captured box sites 2 and 1. Edge ordinals and global box identities
merge by authored box counts, preserving equal-site nested/sibling order.

Two new tests and extended existing checks cover both OOF kinds, 18 whitespace
and UTF-8 histories, in-flow flushing, a mixed six-box pending group, owner-stack
membership, late tracking toggles, reset, automatic closing, clone and both
breakers' external replay. All 12 focused tests pass; these overlap the full std
suite. Existing text/source, shape/style/metric and positioned-item comparisons
remain intact. Captured sites describe immutable authored normalization; arbitrary
post-build public box index/kind mutation is outside this contract.

This captures metadata only: **zero Chromium repairs and zero regressions**.
No public API, used values, line fitting, intrinsic advance or physical placement
is added. Across 35 direct matrices and 4,820 states, result files, raw native
states and whole native/browser screenshots and reference bytes are unchanged.
All 35 baselines are retained outputs from the preceding accepted checkpoint;
none is a fresh before capture in this turn. The independent audit authenticates
exact bytes, authored configurations and recorded gates; it does not independently
recompute direct PNG MAEs. Strict parity remains failed: 761 geometry and 3,391
strict pixel states. The 75-state zero-edge subset retains 75 geometry/fragment,
69 rectangle-hit and 49 strict pixel passes; explicit point coverage is absent.

All six compiled commands pass: 61 runs, 569 states, 508 actions and 1,138 PNGs,
covering both hover optimization modes, CPU/selected GPU tables, forms/focus and
controls. Independent raw semantics/geometry and decoded whole/authored-region
PNG comparisons pass at unchanged tolerances. Both audits validate signed/resolved
source identity and their evidence inventories. Compiler/workspace suites pass
344/143 tests. Parley std passes 206 with its four historical cluster-position
failures; Blitz DOM passes 76 with its two historical hover/scroll failures.
Those dependency suites remain unpassed. Paint/HTML pass 13/3; libm and formatting
checks pass. The separate historical placeholder reduction was not rerun.
System-font/default-feature parity, OS input delivery and named `/code-review`
remain incomplete; independent source review found no blocker.

The 152-file Parley mirror was prepared before signing and its bytes authenticated
against the final signed source. An initial focused mirror had a detected source
drift; its proof/log remain, and the final mirror and focused check were recreated
before signing. After both audits consumed the final mirror, all source/harness
hashes were rechecked and it was removed. The compiled manifest retains 154
historical disposable references whose files are no longer present. Source proofs
and logs remain; canonical checkouts and the shared target are retained.

The initial wrapper audit caught an incorrect font-weight output namespace before
any direct or compiled captures. Its npm stage passed and workspace stage was
interrupted. Both failed generator versions, journals/logs and an authenticated
relocation map remain. The corrected font wrapper moves all three output references;
the other 34 wrappers move one complete output name. A fresh authoritative runner
ran all 49 stages; the initial attempt is excluded from final counts. Browser
references, cases, actions and tolerances were preserved.

Tested heads are compiler `3469b89`, Parley `5f982ec` and Blitz `4a6f257`;
the other four pinned forks are unchanged. The subsequent record commit is
docs/results-only and is not natively rebuilt. Only six Parley lock source entries
changed; all other normalized lock bytes are identical. One maintained development
checkout per repo remains, excluding Cargo caches and Parley's bare authority
repository. No per-agent checkout or duplicate Cargo target was created.

Next, implement activated signed ordinary-span flow, accepting width/quota breakers,
intrinsic traversal, rollback/replay and all effective paint/editing consumers
together. Retain explicit run-slice/box identities, whole atoms and typed interior
markers; captured normalization sites do not yet define physical placement.
Nonzero interior-control behavior remains an open design decision: explicit
shaping seams can split combining/flag graphemes. Keep CSS, direction and margin
ownership in Blitz, and generic layout units in Parley. Bind the existing ordinary
span, avoiding duplicate root margins in flex/grid. Target the retained 84 standards
states missing an 8px text margin and the 60 margin-hit losses. Reuse existing
browser drivers and add internal overflow/cache/replay proofs. Quirks and further
percentage/calc/auto policy remain separate. This next scope is planning only.

The [JSON record](chromium-inline-normalized-controls.json) contains source pins,
gate totals, failed test identities and retained evidence hashes. See the
[ADR](../../docs/ARCHITECTURE.md#chromium-parity-normalized-span-control-sites-2026-10-09)
and [targeted plan](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership).
