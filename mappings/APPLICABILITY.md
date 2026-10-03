# Mapping applicability

The active packs are `pure-clamp@2` and `bounded-increase@1`. Their schema 2 matcher, purity/evaluation contract, constant arguments, numeric predicates and capabilities define applicability. Matching requires resolved standard-library Math identity through pinned TypeScript tooling. Names and filenames are insufficient.

These packs contain no React-specific scheduling rule or framework version range. An adapter lowers supported source behavior into explicit expressions; a numeric rule then applies where its checked matcher and preconditions hold. Framework package/version support is selected separately by [tooling adapters](../compiler/adapters/tooling.mjs).

Proofs live in [`proofs/`](proofs/), one per pinned candidate, and are referenced from `registry.lock.json`. A proof records the validator hash it was produced with; when `compiler/ir.mjs`, `compiler/mappings.mjs` or the validation corpus change, re-run `node compiler/cli.mjs accept mappings/accepted/<file>` on the unchanged candidate bytes to refresh it. Historical Phase 1/2 proofs are retained at the `baseline/phase4` tag. Normal builds are deterministic and perform no discovery. Future framework/API-specific packs need their own applicability assumptions and conformance cases.
