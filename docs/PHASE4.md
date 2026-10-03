# Phase 4 Shared local modules

Continue from the Phase 3 adapters by allowing Vue and Svelte applications to share ordinary local JavaScript and TypeScript modules. React already consumes local constants and mapped helpers. This phase exercises a common source-language boundary with two additional consumers, while retaining generated Rust applications, schema 3 and the existing native binding layer.

## Scope and ownership

The shared language layer owns acyclic module initialization, named imports and exports, scalar const evaluation and pure numeric helper identity. Framework adapters still own component setup, reactive reads, handlers and templates. Module constants are evaluated once before component setup. Helpers require existing independently validated, pinned mappings; normal builds never call a model or execute application JavaScript during analysis.

Admit local `.js` and `.ts` files with named imports, aliases, named exports and explicit named re-exports. Accept immutable scalar declarations with supported pure initializers and plain numeric helper declarations or const function expressions. Reject cycles, mutable globals, initialization effects, dynamic/CommonJS imports, external packages, default/namespace/star exports, typed signatures and captured helper dependencies. Svelte rune modules, child components and general framework lifecycle remain separate capabilities. Named module bindings follow [ES module scope](https://www.typescriptlang.org/docs/handbook/2/modules.html); accepting this subset does not claim general module compatibility.

## Milestones

1. Add a graph-backed shared module analyzer using collected original sources and the existing expression/mapping validators. Preserve declaration locations and lexical resolution of the global Math object.
2. Integrate it into Vue and Svelte without changing their setup capture, immediate-write or derived-read semantics. Keep existing React behavior stable.
3. Add equivalent multi-file React, Vue and Svelte consumers with identical helper/constant source. Exercise imports, aliases and a barrel through original framework runtimes, including the two admitted Vue and Svelte versions.
4. Verify negative cases for cycles, effects, mutation, missing exports, lexical shadowing, unsupported helper bodies and mapping applicability. Test module identity changes and original diagnostics rather than only mirroring implementation.
5. Build both native binding modes, check all finite transitions against original-runtime output and preserve older receipts. Record results separately in the Phase 4 evidence report and publish the accepted contract only after verification.

## Limits and follow-on work

This phase does not close inherited OS keyboard, platform IME or Wayland resize gates. It adds no performance promise and starts no Rust compiler rewrite. Broader composition can follow once this module boundary is exercised; introducing component props/state lifetimes or keyed lists needs a separate observable-behavior contract.
