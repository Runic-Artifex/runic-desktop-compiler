# History

Phases 0–4 were implemented before the 2026-10-03 restructure. Their plans, evidence reports and superseded contracts are kept here unchanged, apart from file moves. Links from these documents to `evidence/`, `baselines/` or `scripts/` point to files that were removed from the working tree. Those files are available at the `baseline/phase4` tag.

To inspect or rerun historical verification:

```sh
git worktree add ../runic-phase4 baseline/phase4
cd ../runic-phase4   # follow that tree's README and docs/PHASE*-EVIDENCE.md
```

| Document | Content |
|---|---|
| [PHASE0-PROMPT.md](PHASE0-PROMPT.md), [PHASE0-EVIDENCE.md](PHASE0-EVIDENCE.md) | Original brief and prototype evidence |
| [PHASE1.md](PHASE1.md), [PHASE1-EVIDENCE.md](PHASE1-EVIDENCE.md), [CONTRACT-V2.md](CONTRACT-V2.md) | React subset, schema 2, mapping discovery |
| [PHASE2.md](PHASE2.md), [PHASE2-EVIDENCE.md](PHASE2-EVIDENCE.md), [CONTRACT-V3.md](CONTRACT-V3.md) | Vue adapter, typed text, schema 3 |
| [PHASE3.md](PHASE3.md), [PHASE3-EVIDENCE.md](PHASE3-EVIDENCE.md), [CONTRACT-V4.md](CONTRACT-V4.md) | Svelte 5 adapter; semantic findings on Svelte listeners |
| [PHASE4.md](PHASE4.md), [PHASE4-EVIDENCE.md](PHASE4-EVIDENCE.md) | Shared local modules (contract v5, still current) |
| [PHASES5-8.md](PHASES5-8.md), [PHASE5.md](PHASE5.md)…[PHASE8.md](PHASE8.md) | Superseded plan, replaced by [ROADMAP.md](../ROADMAP.md) |
| [ARCHITECTURE-PHASE4.md](ARCHITECTURE-PHASE4.md), [DOCS-INDEX-PHASE4.md](DOCS-INDEX-PHASE4.md) | Previous architecture and docs index |

Results the current work still relies on:

- the desktop-input gates that remain incomplete (OS keyboard, IME, Wayland resize);
- the Svelte delegated-listener probe in Phase 3;
- the Phase 1 finding that the optimised binding mode gave no consistent speed-up.
