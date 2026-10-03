# Phase 8 Modular application and local delivery

Status: planned, 2026-10-03. Depends on verified [Phase 6](PHASE6.md) and [Phase 7](PHASE7.md) capabilities; see the [execution plan](PHASES5-8.md).

## Application and scope

Build equivalent React, Vue and Svelte settings applications as a practical consumer of the preceding work. Split a readonly summary/header and a small stateful panel into local components, share ordinary constants and an existing mapped bounded helper, and keep one unconditional text editor in the root. Use supported buttons for choices, a finite mode and a conditional panel whose state resets after a committed removal. Keep the complete text-length/finite-state projection within the existing 4,096-state budget by choosing small domains.

This is a vertical integration and usability phase. It introduces no additional framework, editor, persistence, form submission, list, network service or native permission. Local Linux/Nix distribution artifacts use the existing package boundary and do not imply cross-platform installation support.

## Work and acceptance

1. Add three ordinary multi-file applications with the same supported user behavior. Build/analyze them through the public CLI, without fixture-name special cases or hand-authored Rust. Verify failed analysis/build preserves the previous usable output.
2. Use the Phase 5 campaign to check the full current regression corpus, original-runtime semantics/geometry at both widths, editor traces, lifecycle cases, additional framework versions and both native binding modes. Freeze final source before final evidence capture.
3. Capture representative browser/native visuals using the established calibration and unchanged tolerances. Keep fresh captures distinct from historical pixel receipts; missing capture capability remains an explicit incomplete stage.
4. Produce complete local packages for all three applications, audit embedded assets/runtime closure and launch them in the existing isolated imported-store workflow without Node, a browser or the development shell. Record actual package/binary identities and the host/display prerequisites.
5. Document concise build, run, verify and package commands, the accepted component subset, common source-located diagnostics and a repeatable version-update checklist. Save `PHASE8-EVIDENCE.md` and update the documentation index with actual results.

The deliverable is a usable example and reproducible local distribution, not a release publication. Performance work requires separate measurement and is not an acceptance promise. Browser/internal native events and isolated launches do not close inherited OS keyboard, platform IME or Wayland resize gates.
