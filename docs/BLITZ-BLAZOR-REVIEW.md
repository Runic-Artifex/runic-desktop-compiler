# Blitz and Blazor initiative review

Read-only review recorded on 2026-10-02 to inform this compiler's next phase. The reviewed initiative is archived at `/mnt/SecondHDD/Runic-Next/Blitz-Blazor-Initiative/`. It remains a reference; this review does not restart it or import its SDK dependencies. Current decisions are in [ARCHITECTURE.md](ARCHITECTURE.md), with proposed work in [PHASE2.md](PHASE2.md).

## Architecture and achieved behavior

The initiative kept the Blazor component runtime, translated its render batches through a custom C# renderer and retained C# DOM, sent incremental mutations across the RBM2 C ABI to Rust/Blitz, and returned native events through managed callbacks. It coordinated asynchronous rendering, handler lifetimes and native acknowledgements across that seam. See the archived [project overview](/mnt/SecondHDD/Runic-Next/Blitz-Blazor-Initiative/sdk-checkout/experiments/runic-next-blitz/README.md) and [retained renderer](/mnt/SecondHDD/Runic-Next/Blitz-Blazor-Initiative/sdk-checkout/experiments/runic-next-blitz/Runic.Next.Blitz/Internal/RetainedDomRenderer.cs:374).

The recorded consumers established useful behavior including text editing, forms, clipboard, file operations, multiple windows and selected Windows NativeAOT deployments. The [Windows checklist](/mnt/SecondHDD/Runic-Next/Blitz-Blazor-Initiative/sdk-checkout/experiments/runic-next-blitz/WINDOWS-DELIVERY-TODOS.md:3) records eight fully verified milestones and one accepted limitation; its OS-pointer result remains 15/17, with pen cancellation/recovery unresolved. Wider Blazor/Bootstrap parity remained incomplete. These are retained historical results, not checks rerun by this review.

The archive contains 137 numbered Blitz patches plus other native overlays. Its [patch catalog](/mnt/SecondHDD/Runic-Next/Blitz-Blazor-Initiative/sdk-checkout/experiments/runic-next-blitz/patches/README.md) covers composition/editing, live control properties, focus, select controls, layout, CSS, accessibility and pointer behavior. That reflects both a framework bridge and a broad browser-behavior target; it is not a measure of the cost attributable to Blazor alone.

## What applies to this compiler

Rust for generated application logic and native bindings removes the need for this project's own managed/native framework bridge. The benefit is a smaller integration surface and direct use of Blitz types/APIs. A performance or size advantage still requires a matched application, feature set, platform and toolchain comparison; the archived Notes executable and our small fixtures are not such a comparison.

Rust does not remove editing, CSS, focus, composition or desktop compatibility work. Reuse the archive's concrete failure cases and native knowledge where those capabilities become relevant.

| Archive material | Intended use |
|---|---|
| Editing and composition probes | Build cases for selection replacement, preedit/commit, focus changes and controlled updates |
| Live control and identity work | Investigate stable native property updates without resetting editor state |
| Scroll, hit-testing and accessibility fixes | Consult when an actual consumer exposes the same gap |
| Queue and presentation tests | Keep mutation acknowledgement, framebuffer/presentation return and OS delivery distinct |
| Native platform/package checks | Reuse relevant scenarios when adding a supported platform or deployment profile |
| C# renderer, RBM2 bridge and SDK application infrastructure | Architectural background; not a prerequisite for the chosen generated-Rust application model |

Scenario reuse does not transfer framework semantics automatically. React, Svelte, Vue and other adapters must derive their expected event/update behavior from their own reference runtimes, particularly during composition and controlled updates.

## Patch applicability and provenance

The archive patches target Blitz `7931e6794d5d0e791660cc3474536047c01239ed`; this compiler pins `89e5e615aea649a1a9630c526956aa3d90a3afa7`. The local current checkout was shallow and lacked the archive base, so the review did not establish commit ancestry.

Read-only applicability checks found `0011-bulk-sibling-edits` applied cleanly, while selected input, composition, focus and other native patches conflicted with current source structure. A conflict can reflect changed or already addressed implementation; it does not prove that a fix is still missing. Current source contains text-editor and composition/input plumbing, which needs probing before adopting a workaround.

For reuse, reproduce a gap on the current pin, inspect the specific archived fix and current implementation, adapt the smallest necessary change, retain source/license provenance and validate the affected behavior. Do not copy the entire patch stack or revive its parity backlog as this project's roadmap. Preserve the archive and original receipts unchanged.

## Consequence for the next phase

Keep the shared compiler and Rust native bindings as the main architecture. Use the archive to guide a narrow native-editing probe and future focused fixes. Prove a second frontend through the same backend and design typed text validation before expanding the compiler's accepted input domain. The review supplied implementation leads, not a certification that the current native editing surface already works.
