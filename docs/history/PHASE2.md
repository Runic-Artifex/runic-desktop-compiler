# Phase 2 Framework independence and native editing

Implementation plan recorded on 2026-10-02 and subsequently authorized. Delivered capabilities and remaining verification gates are recorded in [PHASE2-EVIDENCE.md](PHASE2-EVIDENCE.md). The [architecture decisions](ARCHITECTURE.md) are agreed direction; the milestones and unresolved choices here are the implementation plan. The plan itself does not expand the implemented [compatibility contract](CONTRACT.md).

## Objective and starting point

Demonstrate that a second frontend can use the shared compiler/Rust backend, then support a small editable application through both frontends. Improve Rust native bindings and design validation for typed text input as part of that work.

Phase 1 supplies four React fixtures, a working Rust backend, a validated finite-state IR and a pinned mapping registry. It has passing compiler/browser/pixel and isolated installation results, while full OS keyboard and Wayland resize verification remain incomplete. Its findings are preserved in [the evidence report](PHASE1-EVIDENCE.md).

## Milestone 1 Establish frontend and backend boundaries

Separate source collection, frontend-specific recognition, shared expression/semantic analysis and Rust code generation behind small explicit interfaces. Move React imports, hooks, JSX/bootstrap assumptions and version applicability into a React adapter. Make frontend provenance generic in the IR while retaining actual package/toolchain identities and source hashes.

Define who owns input domains, update scheduling and required native capabilities. Version changed IR interfaces deliberately and preserve compatibility or migration for existing artifacts. Native generation consumes the semantic contract, not a React-specific object model.

**Completion:** all existing fixtures retain their behavior and relevant validation results; a minimal framework-independent IR fixture reaches Rust generation without requiring React imports or React-specific provenance fields. The interface is sufficient to begin the second frontend without duplicating the backend.

**First action:** map the current responsibilities in `collect.mjs`, `frontend.mjs`, `ir.mjs` and `codegen.mjs`, then extract the smallest useful boundary while keeping the current CLI usable.

## Milestone 2 Prove reuse with a second frontend

Choose one of Svelte or Vue for an initial narrow adapter, using parser/compiler access, supported source semantics and the ability to expose React assumptions as the criteria. Implementation selected Vue; the results report records the rationale and checked surface. Full Angular, Solid or simultaneous support for several frameworks is outside this milestone.

Build a small ordinary application with finite state, computed text, disabled controls and conditional content. Share behavioral scenarios with a React fixture, while retaining each framework's original source and browser runtime as its reference. Include reads around multiple state writes and captured values so the tests can reveal scheduling differences rather than only confirm final screenshots.

Reuse the language analysis, IR validator, Rust generator and native bindings. If a semantic difference needs a new operation, define it generally and validate it; do not select framework-specific behavior inside the renderer.

**Completion:** both frontends compile through one backend and pass their own supported semantic/native comparisons. Source/adapter versions and limits are recorded. No framework-specific backend implementation is introduced to make the new fixture pass.

## Milestone 3 Probe native editing on the current Blitz pin

Use a small Rust native consumer to establish editable-control behavior before exposing it as a compiler capability. Start with one controlled text input; assess textarea separately if the same validated surface supports it. Consult the [archive review](BLITZ-BLAZOR-REVIEW.md) for useful cases and existing native implementation ideas.

Check typing and deletion, selection replacement, live value updates, clear/reset, focus/blur, disabled/read-only behavior and Unicode. Include a composition sequence where an available input route permits it. Test preservation of caret/selection during updates and identity across unrelated changes. Determine expected event ordering from the chosen framework/browser reference.

Review relevant archived Rust fixes only after reproducing a concrete gap on our current pin. Record any selected patch's original source/license, current adaptation and focused checks. A clean patch application alone does not establish correct behavior.

**Completion:** the supported native surface and actual limitations are recorded, with internal event tests distinguished from OS-delivered input. A control that fails the probe remains outside the compiler's declared native contract until fixed.

Milestones 2 and 3 can be investigated independently after the boundary work. Integrate them through one owner for shared native/IR changes; this does not require simultaneous builds or desktop sessions.

## Milestone 4 Define typed input and compositional validation

Specify a typed text event payload and live value/property operations in the IR. Establish where payload validation occurs and how handlers observe values, queued writes and commits. Design a text domain separate from the current finite enum domain.

Define explicit length and Unicode restrictions. JavaScript string length counts UTF-16 code units; Rust byte counts, scalar counts and editor grapheme counts are different quantities. If character counts or string operations are admitted, their lowering must implement the selected JavaScript semantics. Include empty text, non-ASCII scalars, emoji, combining sequences and boundary lengths in the validation design.

Retain exhaustive exploration for the finite subset. Establish sound rules for the supported text operations and their interaction with finite controls; any abstraction must describe what it proves and what it rejects. Treat browser/native traces as conformance evidence, not as a replacement proof for all possible text values. This milestone defines a limited supported domain rather than unrestricted JavaScript strings or arbitrary event expressions.

**Completion:** the validation model is documented and implemented for the chosen input/operation subset; invalid payloads and unsupported operations fail explicitly; existing numeric and scheduling guarantees remain justified.

## Milestone 5 Compile an editable application through both frontends

Extend the frontend adapters to one controlled text field, a live preview, a clear button and conditional disabled state. Start with direct binding of an event value to text state. Add derived character count only if Milestone 4 establishes its exact semantics.

Use equivalent consumer requirements in React and the second framework. Preserve original application source for reference execution. Verify updates, event ordering, focus, caret/selection, control identity and rendering against each original runtime. Check native compilation and packaged execution without frontend tooling or a model provider.

**Completion:** both adapters lower the declared editable capability to shared IR/native operations and pass the relevant checks. The contract names any differences in supported source syntax and any unverified desktop routes.

## Milestone 6 Exercise incremental version maintenance

Make adapter and mapping applicability explicitly versioned. Run the same conformance cases on the current supported version and one deliberately selected additional version of at least one frontend. Keep dependency sets isolated and reproducible, using the project's locked environments and bounded caches.

Preserve mappings whose assumptions remain valid. Make any needed change in the adapter or mapping pack and explain a shared IR/backend change only if semantics require it. Do not infer compatibility from a version number or relabel the original tests as an upgrade test.

**Completion:** an actual additional-version result demonstrates reuse of the compiler/backend. If that version cannot be supported yet, record the specific semantic/tooling change and required adapter work, and leave its compatibility result incomplete. Compatibility claims cover only versions actually checked.

## Scope and delivery

Keep this phase focused on architecture reuse, typed text editing and incremental maintenance. Keyed lists, persistence/file pickers, general forms/select, multiple windows, broad CSS/Bootstrap parity and extensive asynchronous effects remain later capability work. A predominantly Rust compiler remains a future migration option after the interfaces are exercised.

Deliver frontend interfaces/adapters, any deliberately versioned IR changes, the shared Rust control bindings, the text-validation design, two frontend consumers, conformance/version tests, an updated implemented contract and a Phase 2 results report. Preserve historical Phase 0/1 evidence.

Full OS keyboard and Wayland resize results from Phase 1 remain open until actual delivered input/resize behavior is demonstrated. Other independent compiler work can continue. Editable-control verification must retain any input transport limitation; internal dispatch cannot certify the missing desktop route.

Run focused checks while changing a capability, then the affected regression and deployment checks once ready. Reuse source/toolchain-matching artifacts. Broader performance comparisons are warranted by a changed runtime or a concrete regression concern; this phase makes no advance promise of a speed or size improvement.

## Implementation choices and resolutions

| Choice | Phase 2 resolution |
|---|---|
| Svelte or Vue as the second frontend | Vue, using the official SFC compiler and cases that expose immediate ref reads |
| Initial input versus textarea surface | One controlled text input; textarea remains outside support |
| Text limits and supported operations | Scalar single-line text up to 256 UTF-16 units; copy/reset/render, empty checks and UTF-16 length; documented length projection |
| Exact scheduling/IR representation | React queued writes retain render snapshots; Vue ordered writes lower to explicit expressions over entry state and captured locals |
| Additional version used for maintenance proof | Vue/compiler-sfc 3.5.24 alongside 3.5.43, in an isolated locked environment |
| Rust compiler migration sequence | Deferred; the new boundaries have actual consumers, but a compiler rewrite remains outside this phase |
