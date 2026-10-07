# Approach review (2026-10-07)

Is the approach right for the goal of as much working behaviour as possible? This review takes stock after the first three and a half days of M6 (2026-10-04 to 2026-10-07, branch `m6`, commit `9add179`), from the evidence in the repository and the [gap register](../GAPS.md). It recommends what to keep, what to change, and which decisions need the user.

## The approach as it stands

[ARCHITECTURE](../ARCHITECTURE.md) fixes the approach in sixteen decisions. Four of them carry the weight here:
- **The pipeline (D1–D6).** Framework adapters and a shared language layer lower source code to a typed IR. Rust generated from the IR runs on a native runtime over Blitz.
- **No JavaScript engine by default (D7).** Islands are an opt-in crutch that never touches the DOM.
- **A static type for every value (D16).** What cannot be typed is rejected.
- **Verification against the real thing.** Conformance runs each fixture in Chromium and natively and compares semantics, geometry and pixels; a differential test compares the generated code with a reference interpreter.

Library code compiles from source: bits-ui since M6, through the same language layer, with packs for small utilities.

## Evidence

**What works.**
- **Size.** 147 conformance cases with 465 runs pass all gates with pixels. The only exceptions are recorded known gaps (two semantics, one glyph-rasterisation pixel gap).
- **Differential.** The test covers 169 fixtures with no mismatch.
- **bits-ui behaviour.** Thirteen bits-ui components run from bits-ui's published source through shadcn-svelte's unmodified wrappers. Their behaviour matches Chromium step by step, including floating-ui positioning, focus scopes, presence animations, typeahead and fuzzy filtering.
- **Forks.** The Blitz, Stylo, Taffy and renderer forks fixed the layout and paint gaps the cases found.
- **Silent bugs caught.** The verification catches silent errors. During the Command case it exposed that a library function had been lowered for one of the two keys it is called with (a call through a declaration file was missed). It also exposed an unsound `??` rule before it was committed.

**What it costs.**
- **M6 so far** is 209 commits. They added about 35,000 lines to the TypeScript frontend (now 43,600) and about 31,000 to the Rust crates (now 53,200).
- **The cost per component is not falling.**
  - The last cases needed 1,200 (DropdownMenu), 1,650 (Select) and 1,820 (Command) lines of compiler and runtime change, on top of the groundwork commits each had.
  - Sheet (zero) and Tooltip (about 200) show that siblings of a covered component are cheap. A component with a new mechanism is not.
  - A typical new component took two to four hours of work, most of it in a cycle of lowering, meeting the next blocker, and generalising just enough.
- **North-star coverage is about 8%.** 34 of the 374 previews on the shadcn-svelte component pages have a case; 25 of 59 component wrappers are vendored.
  - The site shell, React (shadcn/ui) and Vue (shadcn-vue) have not started.
  - React and Vue stopped at M5's surface: React has four hooks and no context; Vue has no `reactive` or provide/inject. Radix UI and reka-ui need most of what is missing.

**Where the effort goes.** Three sources of evidence agree:
- the Command case, change by change;
- the survey behind the gap register (419 distinct frontend rejections, 165 runtime and backend ones);
- the earlier cases.

They point to three cost drivers.

1. **Typing untyped library code (D16).** About half of Command's compiler changes made bits-ui's JavaScript typeable:
   - parameters typed from calls, recursive functions typed from their outside calls;
   - contexts typed from their sets, dictionaries from their uses, fields from their assignments;
   - nullable receivers and keys;
   - props forwarded through bindings.

   `frontend/package-modules.ts` has grown to 2,300 lines of such rules, and each is named after the bits-ui call site that needed it. The rules are local inferences from the evidence they find. When one misses evidence, the result can be wrong code rather than a diagnostic (the `setState` case). Every new library brings its own patterns, so this cost does not amortise.
2. **Breadth of the platform surface.** Elements (50 tags), events, DOM APIs and framework APIs were added one case at a time. Much of this is mechanical: an inert element or a simple event is cheap once someone does it. It is also the most common blocker for real pages. In the survey, `img`, `table`, `kbd`, `form` (in React and Vue), `submit` and `sticky` top the list.
3. **Unmodelled runtime mechanisms.** A few gaps are structural:
   - Comment anchors: without them, script that moves nodes blocks later framework inserts.
   - Unions: no per-member compilation.
   - Images.
   - Form submission.

   Each is a bounded project that unblocks a class of components.

The verification pillars are not a cost driver; they are why the results can be trusted. Blitz is not the main cost either: one small fork commit per case on average, and most cases need none.

## Assessment

**Keep.**
- **Verification against Chromium.** It is the project's strongest asset, and it is what makes "never approximate" enforceable.
- **The IR boundary, the Rust runtime on Blitz, and the forks.** They work and are not where the time goes.
- **Honest diagnostics.** The register shows the value of every rejection carrying a reason.
- **Svelte first.** The north star's full application is Svelte.

**Not converging.** The combination of D16 (static types only) with compiling arbitrary library code from source. Typing is a whole-program inference problem. Covering it rule by rule for each library keeps the per-component cost flat and accumulates rules whose completeness is hard to assure. At the current rate the Svelte component pages alone need well over a hundred more hours: 34 components at two to four hours each, plus the previews of covered components, which are cheaper but not free. The React and Vue libraries (Radix, reka-ui) are each comparable to bits-ui, and their adapters lack basic APIs.

**Wrong unit of progress.** Cases are the specification, but "one demo per component" is not the goal. Progress toward the goal is measured in previews and pages that work: 34 of 374 today. Breadth work (elements, events, framework APIs) raises that number faster per hour than a new hard component. The gap register now makes breadth plannable.

## Options

| Option | What changes | Coverage gain | Cost | Conflicts |
|---|---|---|---|---|
| **A. Continue as is** | Nothing | Steady, flat per component | Highest per unit of coverage; rules accumulate | — |
| **B. A dynamic value tier** | The IR gains a dynamic JS value type (as the interpreter's `Val` already is) with operations whose semantics are runic-js's. Typed code stays static; untyped code (package JavaScript, `any`) compiles to dynamic operations; values crossing into typed slots are checked at run time (a mismatch throws, it is not approximated) | Removes most of driver 1 (V2, L4, much of V1): library code compiles without per-pattern rules; static types become an optimisation | A large fixed investment: a dynamic object model (ordered properties, prototypes for built-in methods, functions, classes), new IR operations, codegen, interpreter support, boundary checks | Amends D16 (static types remain where known). Keeps D7: no JS engine |
| **C. JS engine for libraries** | Islands may touch the DOM through bindings to the runtime (QuickJS or Boa); library code (or the frameworks' own runtimes) runs in the engine against the native DOM | Highest and fastest for library code; most of driver 1 and part of driver 2 | DOM bindings for the APIs the libraries and framework runtimes use (Svelte 5 creates DOM from template strings, so run-time HTML parsing too); two execution models to keep consistent; engine semantics differ from V8 in places; startup and size grow | Reverses D7 and the "no JavaScript engine" goal, which is a reason the project exists |
| **D. Compile the frameworks' compiled output** | Lower Svelte's compiled JavaScript (and a pack for `svelte/internal`) instead of source | Removes adapter work for framework features | Still JavaScript to a typed IR: does not address driver 1 | — |
| **E. Narrow the target** | Svelte only, or own components instead of bits-ui/Radix/reka-ui | Fast for the narrowed target | Low | Abandons the shadcn north star as defined |

The options are not exclusive. B and C both attack driver 1; neither addresses driver 2 or 3, which need the breadth work either way.

## Recommendation

1. **Keep the architecture and the verification.** The core is sound.
2. **Spike option B before committing to it.** The spike should:
   - define a minimal dynamic tier for package modules only: property get and set, calls, arithmetic, and the boundary check;
   - make one blocked bits-ui part compile with no new inference rule (Pagination or PinInput, both blocked by untyped values);
   - pass its conformance case;
   - measure the generated code's size and speed.

   If it works, amend D16 so static types are an optimisation, and retire the per-pattern rules as they become unnecessary. If it does not, record why, and choose between A and C knowingly.
3. **Make the inference fail closed in the meantime.** A rule that cannot see all its evidence (unresolved calls, unknown sites) must leave the type open and reject, never decide. The `setState` fix did this for one rule; the others need the same audit.
4. **Do breadth in bulk, driven by the register.** Add inert elements, simple events, the missing Svelte imports and directives, and the React and Vue APIs in sweeps, each with a conformance case per group. These are mechanical with a machine-checkable oracle, the shape [WORKING](../WORKING.md) assigns to workflows (which need the user's opt-in).
5. **Do the structural runtime mechanisms as projects:** comment anchors, per-member compilation (V1), images, form submission.
6. **Measure progress in previews and pages**, from the corpus scan and the page previews, not in cases.

## Decisions for the user

1. **Is "no JavaScript engine by default" still a hard requirement**, now that the goal is as much working behaviour as possible? If yes, option C is out and B is the main lever. If no, C deserves its own spike.
2. **Approve the option-B spike** (it would amend D16 if adopted).
3. **Order of the north star:** depth on the Svelte site first (the current plan), or breadth across Svelte, React and Vue sooner.
4. **Workflows for breadth sweeps:** whether to run them (multi-agent, token-heavy) when they are ready.
