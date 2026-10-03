# Phase 1 Reliable compilation and reusable mapping discovery

Implementation results are recorded in [PHASE1-EVIDENCE.md](PHASE1-EVIDENCE.md). This document preserves the accepted plan; full OS keyboard and Wayland resize verification remain open.

This is the proposed next phase after the Phase 0 initial prototype. Its objective is to make compilation repeatable, extend the supported React subset enough for two more useful applications, and demonstrate a live model proposing a new rule that works unchanged on held-out source. Linux, Rust, Blitz, an engine-free generated application, and deterministic compilation with pinned accepted rules remain the architectural foundation.

Phase 0 established working native compilation and mouse input, 106 checked Rust transitions, and 212 browser/native comparisons passing semantics and geometry. It left one pixel comparison outside tolerance, keyboard input unverified, discovery exercised only through replay, and no meaningful measured optimization gain. The baseline and its limitations are recorded in [EVIDENCE.md](EVIDENCE.md) and [CONTRACT.md](CONTRACT.md).

There is also an architectural constraint to address: `compiler/mappings.mjs` currently accepts only the `pure-clamp` identity, matcher, and preconditions. Phase 1 must let the same restricted interpreter accept distinct rule families; otherwise a new mapping still requires adding its recognizer to compiler code.

## Milestone 1 Preserve the baseline and close native validation gaps

Preserve the Phase 0 source, locks, measurements, screenshots and discovery artifacts as a versioned baseline. New verification runs should write to separate run directories with source, compiler, mapping and toolchain hashes. Keep the existing evidence intact while introducing a report format that distinguishes passed, failed, unavailable and untested checks.

Investigate the thermostat 420×600 pixel discrepancy using difference images and separate checks for font decoding, scale, capture, layout and rasterization. Preserve the original references and 3/255 threshold. A demonstrated capture defect may justify correcting the capture path; raising the threshold to fit the failing fixture does not close the gate. Compare selected post-interaction screenshots as well as initial states.

Verify native Tab, Shift+Tab, Enter and Space through real delivered keyboard events, including focus order, visible focus, disabled controls and conditional mount/unmount. Separate an automation transport failure from a runtime input failure. Add resize checks in a running window and a Wayland input smoke test where the available desktop permits it; report X11 and Wayland results separately.

**Acceptance:** both existing fixtures retain their semantic results; all four original visual cases pass the unchanged comparator; native button keyboard behavior and resizing have retained evidence. Any unsupported desktop route has an explicit compatibility boundary and cannot be reported as verified. Internal event dispatch remains a separate test layer.

## Milestone 2 Make validation and compiler failures repeatable

Create a verification entry point that orchestrates analysis, locked builds, IR/backend checks, browser comparisons through the active environment's browser adapter, and package auditing. Use the T3 collaborative preview in this environment. Native desktop tests remain a distinct stage with explicit prerequisites. Missing prerequisites must produce an incomplete result, rather than a successful report with zero cases.

Strengthen validation of serialized IR and mapping envelopes: required fields, exact types, supported operations, expression shapes, identities, handler references, resource limits and source-located errors. Exercise malformed input, unknown dependencies, shadowed symbols, unsupported effects and partial build failures. Ensure failed builds and failed acceptance leave previous usable artifacts and registry entries intact.

Add deterministic generation checks in fresh output directories and metamorphic compiler tests: rename local identifiers, move supported helpers between modules, and vary component composition while preserving behavior. Keep code generation, validation and the browser oracle sufficiently separate to expose a shared mistake. Introduce formatting and module boundaries as these interfaces change, with focused tests for observable behavior.

**Acceptance:** a documented command produces an auditable summary with exact case counts and artifact hashes; partial runs cannot claim full success; source variants compile without name-based recognition; diagnostics retain useful locations and explanations. Existing fixtures remain regression tests throughout Phase 1.

## Milestone 3 Extend a small coherent React contract

Add these capabilities in order, proving each through a minimal frontend/IR/native experiment before incorporating it into the larger fixtures:

1. Arrow function components and supported local function bindings, with the same purity and hook restrictions as function declarations.
2. Direct replacement state updates, including mixed replacement and functional update queues. Preserve captured render values, source ordering and a single visible commit.
3. Finite string enum state established from literal alternatives and reachable transitions. Keep exact integer restrictions and the existing bounded exploration limit. A type annotation alone must not establish a domain.
4. A controlled select with static options and a typed change-event value projection. Probe Blitz's actual input behavior first. Validate payloads against the option domain and test mouse, keyboard, disabled state and focus. If the probe fails, keep the capability rejected and document the blocker before selecting a replacement scope.
5. Multiple local CSS imports with preserved browser cascade order, limited to the explicitly supported property/value contract. Add a fixture where reversing import order changes the result.

Describe these changes in compatibility contract v2 and migrate the IR schema deliberately. Continue rejecting programs that exceed the accepted state space. Do not bypass exhaustive numeric/domain validation merely to admit larger applications, or substitute sampled executions for the current invariant checks. State-space abstraction and unrestricted text input need a separate design phase.

**Acceptance:** each capability has positive, negative and boundary tests against original React behavior and the native backend. Mixed state queues, control values and stylesheet ordering agree. The generated application still executes no JavaScript. A failed capability probe blocks its compatibility claim rather than leading to a partial adapter.

## Milestone 4 Support more than one declarative mapping family

Introduce mapping schema v2 with a bounded pure-expression matcher and lowering language. Start with parameter references, integer literals, resolved min/max, integer arithmetic, comparisons and selections already representable by the IR. Define typed captures, applicability predicates, required capabilities and resource limits. Recognize purity and resolved symbol identity; reject unmatched statements, effects and calls. Candidate artifacts remain inert data interpreted by compiler-owned code.

Version the registry to hold multiple rules, preserve exact accepted bytes and validation evidence, and support reproducible migration of the Phase 0 clamp rule. Define deterministic rule selection and diagnose overlapping applicable rules with different lowerings. Acceptance should add or replace one explicitly identified version atomically, rather than overwrite the entire dictionary.

Generalize independent validation to compare the source implementation matched by a rule with its lowering. Keep compiler-owned generated inputs, negative matcher variants and boundary cases separate from model-proposed tests. Test applicability soundness as well as the rewrite: correct arithmetic applied to the wrong source is still a compiler bug. Preserve counterexamples and enforce validation time/input limits.

**Acceptance:** at least two structurally distinct helper families work through the same matcher/validator interpreter, without helper-specific compiler branches. Corrupted rules, incorrect lowerings, unsafe matches and ambiguous applications fail explicitly. The migrated clamp rule continues to compile both Phase 0 fixtures.

## Milestone 5 Run live discovery with frozen held-out applications

Create two independently structured applications using contract v2: a pricing configurator with discrete choices and derived totals, and a settings wizard with conditional sections and bounded progress. Freeze both source graphs before discovery. Use the first application to expose an unsupported pure helper outside the existing clamp family; bounded step or piecewise threshold helpers are initial candidates. Select the exact construct after the source is fixed and confirm it is rejected without the new rule.

Configure an available authorized live provider using existing authentication. Retain actual provider/model metadata, request identity where available, exact input/prompt/candidate hashes, and a bounded attempt history. Keep provider invocation evidence separate from candidate claims, and exclude credentials. Freeze the schema and validation corpus before the experiment. No held-out source enters the discovery bundle.

Have the provider propose a candidate using supported schema operations. Run independent validation, retain rejected attempts and counterexamples, and accept only a candidate that passes. Do not manually repair a candidate and describe it as an unchanged model result. Rebuild the discovery application with the pinned rule and no model call, then apply exactly the same bytes to the held-out application. Include an incompatible helper implementation and an invalid numeric precondition that must be rejected.

**Acceptance:** the retained live invocation produced the accepted candidate; validation passed independently; the unchanged rule works on frozen held-out source; negative examples fail; ordinary builds make no provider calls. If no authorized provider is available, other milestones continue, but the live discovery gate remains incomplete. Replay remains useful for regression testing and cannot satisfy this gate.

## Milestone 6 Measure deployment and optimization on representative work

Use both Phase 0 fixtures and the two new applications to measure executable size, complete runtime closure, compressed distribution, startup and update cost. Add input-to-visible-update measurements including painting/presentation where observable. Keep renderer presentation return distinct from compositor acknowledgment, and explain the measurement endpoint on each desktop route. Report warm runs and first-observed runs separately; claim a cold condition only when it was actually established.

Profile binary sections, selected Cargo features, runtime closure contributions and update work before choosing changes. Evaluate a small recorded set of candidates such as LTO settings, feature selection and binding work reduction. Compare the same source, toolchain and workload with optimization disabled/enabled, interleave repeated measurements, and retain distributions rather than a single best sample. Any desktop capability reduction is a separately labeled deployment profile.

Export complete packages for all four supported applications and verify launch from a clean environment outside the development shell. Exercise one fresh Linux/Nix installation or isolated environment using imported closures, an existing display server, and no development dependencies. Audit loaded libraries and embedded assets. Packaging only on the developer's already populated store is insufficient evidence for fresh installation.

**Acceptance:** complete dependency accounting and fresh-install results are available for every application; measurements identify the dominant costs; chosen changes pass semantic and visual regression gates. Keep an optimization only when repeated data supports its benefit. Neutral results are a valid outcome and should preserve the simpler configuration. Phase 1 does not promise a size or speedup percentage before measurement.

## Delivery and order of work

Begin with Milestone 1's baseline capture and native probes, then Milestone 2's reporting infrastructure. Implement Milestone 3 capabilities one at a time and Milestone 4's mapping interface with focused checks. Freeze the new applications and validation corpus before the live experiment in Milestone 5. Run the complete measurement/package matrix once changes are ready for Milestone 6, reusing the locked Nix environment and incremental caches.

Deliver compatibility contract v2, versioned IR/mapping schemas, migrated registry, four browser/native fixtures, retained live discovery evidence, a verification driver, complete Linux packages and a Phase 1 evidence report. Update the README to state each gate's actual status. Preserve the Phase 0 report as historical evidence.

Phase 1 is complete when the declared native/input/visual contract passes, two new applications compile through reusable analysis, the dictionary accepts and reuses a genuinely new live-proposed rule, and installation and measurements reproduce independently of the development shell. Any unresolved gate remains named and incomplete. Broader effects, asynchronous applications, unrestricted state domains and additional frontend frameworks can then be planned from this evidence.
