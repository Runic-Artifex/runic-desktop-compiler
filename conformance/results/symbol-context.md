# Symbol context keys (2026-10-13)

Svelte contexts keyed by module-level `Symbol(…)` constants, as
shadcn-svelte's carousel keys its context (`registry/ui/carousel/context.ts:30`,
`const EMBLA_CAROUSEL_CONTEXT = Symbol("EMBLA_CAROUSEL_CONTEXT")`). Case
`symbol-context` (fixture `symbol-context-svelte`), Chromium 153.0.8010.12,
CPU renderer.

## What is covered

A module constant `const K = Symbol("description")` or `Symbol()` (the global
`Symbol`, at the top level of a module or a `<script module>`) whose every
reference is the key argument of svelte's `setContext`, `getContext` or
`hasContext` is a context identity named at build time
(`symbol:<description>#<n>`, one per declaration); the symbol has no runtime
value. Other uses of the constant, `Symbol.for`, the well-known symbols and
`Symbol(…)` evaluated in functions are rejected where they stand
(`tests/symbol-context.test.mjs`).

The fixture nests providers (the nearest wins), keys two contexts with symbols
of one description (two contexts), reads `hasContext` outside every provider
and of a symbol nothing sets, and shares each provider's `$state` count
through an object of getters that its consumers bump and reset by clicks.

## Results

`node conformance/run.mjs symbol-context --pixels`: semantics, geometry and
pixels passed at 800x600 and 420x600 (10 steps; pixel MAE at most 0.31/255);
24 independent text expectations passed in Chromium and natively.

The first version of the fixture shared the provider's `$state` object
itself (the carousel's `carouselState`) and read it as
`const tone = getTone()`: Chromium updated the counts after each click, the
native app kept showing 0. The constant is identity-tracked, so native
templates did not re-read it when the proxy was mutated, while Svelte tracks
reads through the proxy. The validator then rejected such constants
(`E_REACTIVITY`, `shares_mutated_proxy`); the fixture shares getters, the
toggle group's verified pattern. Since the reactivity workstream's first
step, reads through a proxy are dependencies wherever it is held and the
guard is gone (case `alias-reads`, [results](reactivity.md)).

## Census

`node conformance/triage.mjs --jobs 4` against the calendar census of main
(`1d51294`, 280 of 404 lowered): 280 lowered, none gained or lost. The six
carousel examples move from `E_TYPE_UNSUPPORTED` "bigint and symbol values"
at context.ts:30 to context.ts:33, the context's `api: CarouselAPI |
undefined`: embla-carousel 8.6.0's `EmblaCarouselType` holds an engine with
`ownerDocument: Document`, not a value type (docs/gaps/LIBRARIES.md, `embla*`).
