# Chromium parity: private authored inline edges

Parley now records private authored ordinary-span opening and closing events
under the existing tracking opt-in. Normalized UTF-8 endpoints, style identity
and all-box ordinals retain nested and sibling authored order. Pending whitespace
changes text anchors independently of box order. Transparent modification scopes,
automatic closing, final enable/disable, both builder outputs, cloning and reuse
preserve that contract. Ten new focused tests pass.

The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-ordered-inline-span-edges-2026-10-09-isolated)
defines this private seam. No used horizontal advances, new public API, shaping
boundary, IR/backend change or rendering consumer change is implemented here.
Breaking, alignment, saved replay and Blitz consumers retain their behavior.

The new [flow-affinity oracle](../inline-flow-affinity.mjs) has 18 cases and 165
states at DPR 1, 1.25 and 2. All listed gates measure all 165 states.

| New oracle gate | Baseline | Final |
|---|---:|---:|
| Geometry | 9 | 9 |
| Client fragments | 6 | 6 |
| Rectangle-relative hits | 60 | 60 |
| Explicit point hits | 51 | 51 |
| Strict viewport/container/local pixels | 0 | 0 |

All 47 serial verification commands completed against five clean signed source
heads. Across 34 direct matrices and 4,793 exact pairs (4,628 retained plus 165
new), every result JSON and native whole PNG is unchanged. Root and independent
audits agree per eligible gate: zero repairs and zero regressions. The completed
audit and zero-regression gate pass. Absolute parity does not: geometry retains
737 failures and strict pixels retain 3,364 failures. The earlier ownership
checkpoint's two tighter-crop regressions remain failures in their historical
record and in this baseline.

All 9,586 raw before/after states validate; required observations/crops exist and
130 null local measurements have empty clipped unions. They remain unmeasured.
Direct geometry remains 0.125 CSS px, line widths 0.02 CSS px and strict MAE 3/255;
compiled geometry remains 2 CSS px. Audits do not independently recompute PNG
MAEs. All 389 compiled table/form/control states pass semantics, geometry and
strict pixels, including selected GPU tables. Local table crops are required.

| Verification | Result |
|---|---|
| Compiler / Rust workspace | 297 / 122 passed, zero failures |
| Blitz DOM | 76 passed; two existing failures |
| Blitz paint / HTML | 13 / 3 passed |
| Parley std / engine | 191 passed with four existing failures / 39 passed |
| Stylo / Parley libm | 16 passed / check passed |

The six failures remain hover invalidation, scroll bubbling and four fontless
cluster-position alignment tests. Their suites remain unpassed. The exact-source
Parley mirror had 146 source files. An initial focused invocation failed before
compilation because its shared-target environment was missing; the corrected
ten-test run and both logs remain. A runner validation defect was corrected with
an authenticated resume preserving three completed stages. The generator's output
log hash was corrected after its final line was written; the original record and
correction proof are retained. The original baseline proof's shortcut score fields
checked absent aliases; corrected measurements use actual difference arrays and
finite MAEs, while the original source/hash proof remains intact.

The observation review rechecks 125 fingerprints. The negative-margin case moves
its owner 26.375px and restores it, while all steps remain two lines; it does not
drive wrap recovery. The min-content mutation leaves CCC's controlling width at
50.28125px; it does not certify intrinsic-cache invalidation. Max-content changes
14.25px and restores. Preserved newline closing decoration and `br` with an
intervening empty child produce distinct fragments; immediate `br`-close needs
its own reduction. Own direction affects asymmetric fragment placement, while
parent direction also affects alignment. The out-of-flow case covers one source
checkpoint, and trailing space-only/empty observations coincide. Oracle comments
were corrected after capture; parser-contextual tokens and the syntax tree are
identical to the tested source.

Next is the [edge-consumption and shared-offset interface](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership).
Both breakers and intrinsic measurement need signed start/end fitting, cursor
and active-owner rollback, plus paint/span/cluster/caret/selection agreement.
Keep existing glyphless-spacing, out-of-flow-width and accumulation policies
until the opted-in edge path has measured compatibility checks. Resolve CSS edges
and direction in Blitz; pass generic used advances to Parley. First add locked
browser reductions that change negative-margin wrapping and min-content width,
and an immediate `br`-close case. Percentage/calc/auto refresh, slice/clone
decoration, RTL/atomic behavior and control margins follow. T3 Chrome 152
exploration supplies candidates and is excluded from acceptance.

System-font/default-feature tests, OS keyboard/pointer/IME delivery and unavailable
named `/code-review` remain incomplete. Static source review verifies twelve
fingerprints against signed code; it does not establish those missing stages.
The [JSON record](chromium-inline-authored-edges.json) contains measured gates,
source identities and hashed evidence plus 96,935 canonical observation paths.
All eleven prior records, 2,042 evidence references and 375,782 observation
references remain intact. Tested heads are compiler `344959d`, Parley `10478f6`,
Blitz `f7d0a01`, Stylo `568059d` and Vello `a8efce5`. Later edits are comments and
documentation only. One existing isolated worktree per repository is retained;
original checkouts are unchanged. No merge, push or milestone tag was performed.
After its consumers finished, the exact-source test mirror and task-owned Nix
profile symlinks were removed. Canonical captures, evidence, shared build caches
and source trees are retained.
