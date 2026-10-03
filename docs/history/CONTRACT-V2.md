# Compatibility contract v2

This compiler accepts closed, synchronous button-driven applications through AST/symbol analysis and exhaustive reachable-state validation. Generated applications execute Rust and Blitz, with no JavaScript engine. Analysis establishes applicability; filenames and helper spellings do not. The Phase 0 contract is retained inside the frozen source archive.

## Source and components

`runic.json` selects one local module entry and a native window title. `index.html` contains an empty `div#root` and exactly that module script. React and react-dom/client identities are pinned to 19.3.0. The collector records original modules, resolved imports, CSS, assets and SHA-256 hashes before JSX transformation. Local imports are evaluated in dependency order; cyclic graphs are rejected. Limits are 256 modules and 1,048,576 UTF-16 code units per module. Namespace imports, re-exports, arbitrary dependencies, extra scripts/resources and top-level executable effects are rejected.

Function declarations, const-bound function expressions and arrow components are supported. A block component contains supported const render declarations, optional local handlers and one final JSX return. Stateless components may use an expression body. Components take no parameters or an explicit destructured props object, consuming every passed property. Composition follows resolved identity. Default/rest props, spreads, recursion, children props, async/generator functions, typed signatures, refs, effects, custom hooks and render-time side effects are rejected. Stateful composition is unconditional; conditional components must be stateless.

## State and expressions

`useState` initializes a literal number, boolean or string in an unconditional `[value, setter]` declaration. Aliased imports retain React identity. Object/array state and lazy initialization are unsupported. Strings are finite enums established by actual reachable alternatives: each value is at most 256 UTF-16 code units and a slot may reach at most 32 alternatives.

A handler contains only ordered setter calls. Direct replacements and pure single-parameter functional updaters may be mixed. Every handler sees its committed render snapshot; direct values and other captured bindings retain that snapshot. A functional updater reads the latest pending value of its target slot. Updates execute in source order and commit together once, before UI refresh. Intermediate pending values are still validated even if overwritten later. Disabled or unmounted buttons cannot dispatch. Event parameters, callback escape, asynchronous work, nested updates, scheduling and imperative DOM access are unsupported. StrictMode/concurrent/effect observations are outside this contract.

Every executed numeric literal/intermediate is an exact finite integer with absolute value at most 1,000,000; each pending numeric state is bounded by 64. There are at most 16 slots, 64 handlers and 4,096 reachable states. Negative-expression initializers remain unsupported. BFS starts at the initial state and checks every mounted/enabled handler, every intermediate update and every rendered expression. Exact per-slot domains and the transition hash are recomputed when serialized IR is validated. An annotation or proposed range is not a proof.

Supported pure operations are homogeneous integer addition/subtraction/multiplication, unary negation, comparisons, same-type strict equality, boolean negation/short-circuit operations, same-type selections and two-argument min/max on resolved standard-library `Math`. Evaluation preserves left-to-right arguments and short-circuit branches. Fractions, signed zero, non-finite numbers, coercion, division, remainder and overflow are rejected. Integer decimal text agrees with JavaScript within the enforced bounds; boolean children produce no React text. Strings are literals, enum state or selected supported strings, with no implicit coercion or arbitrary string computation.

Text contains Unicode scalar values; lone UTF-16 surrogates, unsupported C0 controls and DEL fail. JSX entities are decoded. Literal text is bounded by 65,536 UTF-16 code units per expression and 1,048,576 across validated expressions; the UI has at most 1,024 nodes, depth 64 and 32,768 expression nodes.

## UI, CSS and assets

Tags are main, article, section, div, span, p, h1, h2, button, strong, small, header and footer. Phrasing elements contain only text/inline elements. Bindings support text, static IDs, string class/title/aria-label/button-type attributes and boolean disabled. Handlers attach to buttons outside forms. Conditional UI uses boolean `condition && <stateless subtree>`; conditional text may use selections. Conditions physically mount/unmount subtrees; unrelated updates preserve DOM identity.

Controlled `select` and `option` remain rejected with `E_CONTROL_UNSUPPORTED`: a native probe on the pinned Blitz renders surrounding text/buttons but omits those controls. Finite choices use ordinary buttons. There is no form/input field, dynamic list/key reconciliation, fragment, portal, HTML injection, image, navigation or JavaScript animation adapter.

Multiple local CSS imports are accepted. Each original stylesheet is validated, then the collector embeds Vite's actual emitted entry stylesheet order and re-embeds its emitted font references. Multiple split CSS outputs are rejected. Generated `runic-text`/`runic-if` anchors use `display: contents`; structural selectors including nth/first/last/only-child, :empty and sibling combinators are rejected. Supported declarations are font-family, src, font-weight, box-sizing, margin, background, color, font-size, padding, max-width, border, border-radius, line-height, display, flex-wrap, gap and border-color. Only @font-face/@media are supported; `!important` fails. This property set does not imply complete browser CSS value/rasterization compatibility.

Only local application-owned WOFF2 assets, at most 1 MiB with explicit `format('woff2')`, are accepted. Remote/data/fragment resource URLs are rejected. Native builds require at least one bundled WOFF2 font, embedded as a data URI and decoded by Blitz; analysis alone may inspect fontless programs. There is no system-font fallback or networking. Output PNGs are verification artifacts.

## Native input and lifecycle

Winit owns the window/event loop. Blitz performs hit testing, DOM delivery, style and live layout; the compiler emits no fixed layout coordinates. The adapter applies button click batches and suppresses conflicting default click behavior. Pointer clicks focus enabled buttons; becoming disabled clears focus. An intrinsic button focus border provides visible feedback before application CSS, which may override it.

The implemented key adapter traverses mounted/enabled app buttons with Tab/Shift+Tab, activates Enter on keydown and Space on keyup if focus is unchanged, and guards repeat/cancellation. Internal UiEvent tests exercise this layer separately from OS delivery. Real X11/Wayland mouse input and live X11 resizing are verified. Only one real Tab delivery is established; full OS keyboard behavior and Wayland resizing remain incomplete because desktop automation timed out or the compositor ignored requested sizes. Accessibility is not a verified claim. Consult the current evidence report before treating implemented behavior as desktop-tested compatibility.

## IR and mappings

Schema 2 records typed slots/exact domains, stable UI identities, typed pure expressions, ordered replacement/update transitions, bindings, capabilities, source provenance and mapping hashes. It contains no executable React AST or JavaScript plugin. The validator rejects unknown fields, malformed metadata, wrong types/arity, invalid references/identities, unsupported effects and resource overflow, then recomputes closure/content hashes. Source locations accompany diagnostics where available.

Handwritten adapters are compiler-owned implementation code. Machine proposals use inert mapping schema 2: a pure function with 1–4 numeric parameters and a restricted matcher/lowering tree of parameters, integer literals, min/max, arithmetic, comparisons, boolean operations and selections. Trees are bounded by 63 nodes/depth 16. Preconditions declare the finite-integer domain, constant arguments and typed predicates. Required capabilities must exactly describe the lowering. Resolved Math identity, purity and shape are checked; captures, effects, shadowed Math, defaults/rest, async and unsupported calls fail.

Every matched call retains original argument evaluation and matcher evaluation for domain/equivalence checking, even if its lowering drops an argument. Exact application reachability enforces applicability on all executions. Registry selection is deterministic; overlapping applicable rules with different lowerings produce `E_MAPPING_AMBIGUOUS`.

Independent validation compares compiler-owned JavaScript generated from the checked matcher against separately interpreted IR lowering. The frozen corpus includes exhaustive small values, large boundaries, numeric negatives and structural negatives; proposed tests are supplemental. Cases outside the original intermediate-number contract are explicitly counted and excluded. This bounded differential evidence plus exact application closure is not general JavaScript equivalence.

`accept` reruns validation and atomically pins exact bytes, proof and one immutable rule version under a registry lock. Multiple rule IDs coexist; rejected or changed bytes cannot overwrite an accepted version. Builds verify candidate/proof hashes and the current validator hash. Stale proofs require explicit revalidation/acceptance. The Phase 0 clamp envelope migrates reproducibly to v2; replay/live/external provenance remains distinguishable. Live proposal generation is explicit and bounded; normal builds never call a model.

## Builds and optimization

Builds require the locked Nix environment and publish a staged output atomically under artifacts or .cache. Failed collection, generation, Cargo or packaging leaves an existing usable artifact intact. Analysis outputs are separate from built IR. Verification checks emitted source/runtime/lock inputs before reusing a binary.

Baseline binding mode evaluates every dynamic binding; dependency mode evaluates bindings affected by changed slots. Both compare values before DOM mutation and avoid remounts for unchanged conditions. Exhaustive transitions, DOM identity traces and frames agree across modes. Phase 1 measurements show no consistent time gain; the existing modes and default release profile are preserved, with no new performance claim.
