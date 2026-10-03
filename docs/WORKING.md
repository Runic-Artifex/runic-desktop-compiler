# How work is executed

This document is for whoever drives a milestone: a person or the main agent session. [ROADMAP.md](ROADMAP.md) assigns a mode to each milestone; this file defines the modes and the rules they share.

## Modes

| Mode | Use for | Do not use for |
|---|---|---|
| **Standalone** (main session) | Design decisions and ADRs, the IR schema, runtime core, scheduler, cross-cutting refactors, integration, final verification of a milestone | Large mechanical fan-out that buries the design context |
| **Subagent** (one delegated task, usually in a git worktree) | Bounded tasks with a frozen interface and objective acceptance: research spikes, one adapter against frozen IR and shared cases, one host-service crate, code review, broad code search | Anything that changes a shared interface; the subagent reports back and the main session decides |
| **Workflow** (orchestrated multi-agent run) | Wide fan-out with an objective oracle plus independent verification: built-in families against test262/Node, corpus scans, mapping-pack authoring, ordering-case mining, end-of-milestone adversarial review | Design work. Never start one without the user's explicit opt-in for that run. Default size stays under 10 agents |

Rules of thumb:

- If the work defines an interface, do it standalone.
- If the work implements against a frozen interface, use a subagent.
- If the work repeats the same check or implementation across many independent items with a machine-checkable oracle, use a workflow.

## Milestone procedure

1. **Plan.** Read the milestone, current `CONTRACT.md` and code. Write conformance cases for the driving examples first; they are the specification.
2. **Design checkpoint.** New IR constructs or public interfaces get a short ADR section in `ARCHITECTURE.md`. Schema changes that affect every frontend are reviewed by the user before implementation.
3. **Implement** in the assigned mode. Keep commits small and focused on main or a short-lived branch. Run focused tests while iterating.
4. **Verify.** Run `npm test`, `cargo test --workspace` (from M1 on) and full conformance for the affected cases. Run `/code-review` on the milestone diff.
5. **Record.**
   - **`CONTRACT.md`:** update the implemented surface in place; git history replaces the old copied contract versions.
   - **Conformance summary:** commit a short summary under `conformance/results/`.
   - **Tag:** create `m<N>`.
   - **Report:** give the user a short report covering what works, the case counts, the remaining gaps and the next task.

## Resource rules for parallel work

- **Cargo builds.** A full Blitz build is slow (`CARGO_BUILD_JOBS=2`) and `target/` is about 4 GB. Worktrees must not create their own `target/`. Until `RUNIC_TARGET_DIR` and the shared build lock land in M1, subagents in worktrees do JS/Nix/docs work only, and native builds run in the main tree, one at a time.
- **Disk space.** Before browser, native or package matrices, check space with `df -h` on the project filesystem (it shares `/tmp`). Start with conservative concurrency.
- **Cleanup.** Stop task-owned servers and windows. Remove disposable outputs under `artifacts/` and `.cache/` when their consumers finish. Keep logs that explain failures.
- **Environment.** Always use the locked environment: `nix develop . -c <cmd>`, or `direnv exec . <cmd>` after the user has allowed `.envrc`.

## Delegation checklist

A subagent or workflow prompt must state:

- the goal and the frozen interfaces it may not change;
- the files it may touch;
- the acceptance commands to run;
- the resource limits above;
- what to report back: findings, the diff summary, and the commands run with their results.

Results are not trusted until the main session has reviewed the diff and re-run the acceptance commands.
