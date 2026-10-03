# Mapping applicability

The active packs are `pure-clamp@2` and `bounded-increase@1`. Their schema 2 matcher, purity/evaluation contract, constant arguments, numeric predicates and capabilities define applicability. Matching requires resolved standard-library Math identity through pinned TypeScript tooling. Names and filenames are insufficient.

These packs contain no React-specific scheduling rule or framework version range. An adapter lowers supported source behavior into explicit expressions; a numeric rule then applies where its checked matcher and preconditions hold. Framework package/version support is selected separately by [tooling adapters](../compiler/adapters/tooling.mjs).

Phase 2 preserves candidate hashes and reruns independent validation against the new IR validator. The registry points to [new proofs](../evidence/phase2/mappings/); [Phase 1 proofs](../evidence/phase1/mappings/) remain unchanged. Normal builds are deterministic and perform no discovery. Future framework/API-specific packs need their own applicability assumptions and conformance cases.
