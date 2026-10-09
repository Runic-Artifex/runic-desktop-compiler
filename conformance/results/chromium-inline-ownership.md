# Chromium parity: ordinary span ownership

Standards-mode ordinary inline fragments now retain whole shaping-atom ownership.
An owner starting inside an atom can have a real zero-width continuation at its
logical end. This closes all 21 remaining intent and 60 alignment-history
geometry/fragment failures. The zero-advance stage keeps CSS in Blitz and generic
ownership in Parley, with no IR, backend or renderer change.

| Oracle | Geometry / fragments before → after | Hits | Strict pixels |
|---|---|---|---|
| Caller intent, 150 states | 129 → 150 | 126 → 147 | 46 → 51 |
| Alignment history, 132 states | 72 → 132 | 51 → 111 | 52 → 72 |
| New span edges, 306 states | 66 → 141 | 81 → 159 | 52 → 64 |

Across 33 matrices and 4,628 exact before/after pairs, geometry/fragments repair
156 states and hits repair 159, without regressions in those gates. Strict pixels
repair 39 states and regress in two new edge states. All 4,628 native whole PNGs
are byte-identical: corrected bounds change the measured crops. `margin_zero`
and `margin_auto`, DPR 1.25, step 0 become strict failures; six owner-local losses
across steps 0–2 rise from MAE 2.821 to 3.519. They remain failures. The completed
audit has `finalValid=false`; its zero-regression gate is not passed.
Hit counts use the retained rectangle-relative probes. The separate 252 explicit
point states retain 237 passes without repairs; neither gate verifies OS delivery.

The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-ordinary-span-ownership-2026-10-09-isolated)
defines the additive builder option and line query. Parley retains normalized
UTF-8 ranges and opening/closing all-box ordinals. Pending closes follow only
whitespace already pending at capture. The private query shares positioned-atom
traversal, follows alignment/justification and each atom's whitespace policy,
includes descendant in-flow boxes and excludes out-of-flow width. Empty geometry
still requires independent empty participation. Rebreaking and saved replay use
committed line items. Defaults, sources, shaping and the positioned-item enum
remain. Blitz uses owned bounds for standards CSSOM, with no legacy fallback on
an absent line. Quirks keeps its earlier policy.

All 46 final commands ran against five clean signed sources. Root and independent
audits agree on measured denominators, exact input/reference hashes and finite
pixel thresholds. All 9,256 raw before/after states validate; required captures
exist and 101 null local metrics have empty clipped unions. MAE remains 3/255,
direct geometry 0.125 CSS px and compiled geometry 2 CSS px. Audits do not
independently recompute PNG MAEs. All 389 compiled table/form/control states pass
semantics, geometry and strict pixels, including selected GPU tables.

| Verification | Result |
|---|---|
| Compiler / Rust workspace | 297 / 122 passed, zero failures |
| Blitz DOM | 76 passed; two existing failures |
| Blitz paint / HTML | 13 / 3 passed |
| Parley std / engine | 181 passed with four existing failures / 39 passed |
| Stylo / Parley libm | 16 passed / check passed |

The existing failures remain hover invalidation, scroll bubbling and four
fontless cluster-position alignment tests. The exact-source Parley mirror has
145 files. Focused ownership, normalization and Blitz tests pass 14/5/3. A real
empty-range defect and two invalid shaping-fixture assumptions were corrected;
failed focused logs and their source proofs are retained. Independent static
review fingerprints match the signed code. System-font/default-feature tests,
OS keyboard/pointer/IME delivery and unavailable named `/code-review` remain
incomplete.

The [JSON record](chromium-inline-ownership.json) contains source identities,
remaining failures and hashed evidence/observation manifests. All ten older
records, 1,839 evidence references and 282,305 observation references are intact.
Canonical captures are retained; 4,836 byte-identical candidate PNGs were removed
after their audits, with replacement hashes recorded. One existing isolated
worktree per repository is retained, original checkouts are unchanged, and no
merge, push or milestone tag was performed.

Next is [nonzero edge flow](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership):
shared offsets, signed advances, intrinsic sizing, wrap affinity and replay,
CSS percentages/calc and style invalidation, then slice/clone paint and hits.
The 60 retained margin hit failures and 84 standards control-margin states are
specific targets; 48 quirks control states need separate policy. Full bidi
segmentation, grapheme/caret behavior, tabs and raster parity remain open.
