# Gaps: framework features

Part of the [gap register](../GAPS.md). Locations as of commit `9add179` (2026-10-07). Clusters: **F1** Svelte, **F2** SvelteKit, **F3** React, **F4** Vue.

## Svelte (F1)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Element directives `use:` (actions), `transition:`, `in:`, `out:`, `animate:`, `{@attach}`, legacy `on:` | E_TEMPLATE | "planned for a later milestone" | Actions: functions of the element with update/destroy; transitions: the Web Animations model the runtime has for CSS | svelte.ts:5018; component directives svelte.ts:4508 |
| Imports `svelte/store`, `svelte/transition`, `svelte/motion`, `svelte/animate`, `svelte/easing`, `svelte/attachments`, `svelte/legacy` | E_CAPABILITY | "planned for M6" | Stores are small; transitions as above | svelte.ts:3396 |
| `svelte` exports other than onMount, onDestroy, tick, untrack, mount, unmount, getAllContexts, settled, and setContext/getContext/hasContext with string literal keys in modules (createEventDispatcher, flushSync, createRawSnippet, createContext, …) | E_CAPABILITY | "planned for a later milestone" | Mostly small | svelte.ts:3367,3373 (list :136) |
| `svelte/reactivity` other than SvelteMap (SvelteSet, SvelteURL, SvelteDate, MediaQuery, createSubscriber); SvelteMap initial entries, iteration, per-key reads | E_CAPABILITY / run time | Not done. The site's docs layout wraps every docs page in `Sidebar.Provider`, which reaches `MediaQuery` (registry `hooks/is-mobile.svelte.ts`); the census hosts leave it out | MediaQuery over M5 media query lists | svelte-reactivity.ts:45-348 |
| Runes `$inspect`, `$host`, `$effect.tracking`; async `$effect`; `$derived.by` with an async function; `experimental.async` | E_RUNE / E_EFFECT / E_CLASS | Changes the render model | — | svelte.ts:3472; classes.ts:1969 |
| Legacy features (`export let`, `$:`, `$$props`, `<slot>`, `on:`, a top-level `let`/`var` or export) in components without runes of packages compiled from source | E_SVELTE_LEGACY | The adapter lowers runes mode; package files compile in the mode Svelte infers, as the site's build, and a legacy-mode component lowers only where runes mode means the same | A pack per package (as `@tabler/icons-svelte`), or a legacy-mode adapter (`export let`, `$:`, `$$props`, slots) | svelte.ts (`reach`) |
| `setContext`/`getContext`/`hasContext` with a `Symbol` key (shadcn-svelte's carousel context.ts:30) | E_TYPE_UNSUPPORTED | Symbols are outside the value model | A module-level `Symbol(…)` as a compile-time context identity, as runed's `Context` is (design/M6-LIBRARIES "Context"); the carousel also needs embla-carousel-svelte and `use:` | types.ts |
| `{#await}` | E_TEMPLATE | "planned for M4" (stale) | Pending/then/catch blocks on promises | svelte.ts:3898 |
| `<svelte:boundary>`, `<svelte:body>`, `<svelte:fragment>`, `<svelte:component>`, `<svelte:options>`, `{@debug}`, `<slot>` (the mdsx blueprint) | E_TEMPLATE | "Unsupported template node" | Per node | svelte.ts:594,3901 |
| `<svelte:window>`/`<svelte:document>` bindings (`bind:innerWidth`, `bind:scrollY`) | E_TEMPLATE | — | Window metrics exist | svelte.ts:998 |
| `<svelte:head>` other than `<title>` | E_TEMPLATE | No native meaning | Declare inert | svelte.ts:1029 |
| Element bindings other than `value`/`checked`/`this`/radio `group` (`bind:clientWidth`, `bind:open`, `bind:files`, `bind:innerHTML`, function bindings `bind:x={get, set}`) | E_TEMPLATE | "planned for M5" (stale) | Per binding; ResizeObserver exists | svelte.ts:4927,4932 |
| `class={obj/array}` (clsx form); `style:x\|important`, `style:x` shorthand | E_TEMPLATE | "planned for M6" | Run-time clsx exists in the pack | svelte.ts:4865,4966,4972 |
| Template snippets with parameters (outside component children); a snippet rendering itself | E_TEMPLATE | — | Snippets as functions with parameters | svelte.ts:1211,3854 |
| `{@const}` destructuring or of values other than text/number/boolean/bags/component values | E_TEMPLATE | — | — | svelte.ts:3759,3773 |
| `{#each}` over objects, Maps/Sets, iterables, numbers; patterns other than object fields | E_TEMPLATE | "planned for later" | — | svelte.ts:4061-4080 |
| Recursive components (`svelte:self`, self-import) | E_COMPONENT | "planned for a later milestone" | Lazy instantiation | svelte.ts:669 |
| Scoped component styles | E_TEMPLATE | Lowering does not add Svelte's scoping class (editor: 7 uses) | Emit the hash class and the scoped CSS | svelte.ts:589 |
| Top-level component statements other than declarations, effects, onMount/onDestroy | E_STATEMENT | — | Run once at creation | svelte.ts:3293,3538 |
| Nested prop destructuring; snippet props with defaults; discriminated-union props whose types differ (see V1) | E_PROPS / E_TYPE_UNION | — | — | svelte.ts:3108-3127,3155 |
| A prop typed wider than the value model that its component assigns or binds other than as covered (text-input `bind:value`; `bind:` to child props of one nullable type, without a default or a passed value) | E_TYPE_UNION | Its values do not all come from its sites | Typing from the writes per kind | svelte.ts (`typeOfBinds`, `typeOfChildBinds`) |
| `svelte/events` `on()` with `passive: true` and a handler that reads the event; capture on elements; custom event types with options | E_EVENT | — | — | svelte.ts:1832-2069 |
| Generic components whose type parameters have no default | E_TEMPLATE | One instantiation per program | Per-instantiation components | svelte.ts:175 |
| Imperative `mount`: targets other than `<body>`, `anchor`/`events`/`intro`, snippets with parameters, outro options | E_MOUNT / run time | Owner updates would interleave | — | svelte.ts:2111-2249; codegen lib.rs:854 |
| `$effect.pre` inside `$effect.root`; cleanups seeing current rather than previous values of class fields and module state | run time | Order depends on sibling cleanups | — | codegen lib.rs:2259; CONTRACT |
| Component-level `$derived` compares with SameValue where Svelte uses `===` (NaN, −0) | deviation | "left for a separate change" | One-line comparator change | design/M6-LIBRARIES |
| Svelte lazy proxy snapshots: identity through cycles, raw writes in later handlers | known gap | Native proxies are eager and shared | Lazy proxies | case `ownership-cycles` |
| Spreads: a style object directly onto an element, `defaultValue` that is not a string or changes, `defaultChecked`, `value` on controls | run time | Live control state Blitz does not track | Per item | runtime dom.rs:1635-1723 |
| A value reaching a component prop through rest props with records of other fields than the prop's records (fields the prop lacks, or a constant widened to two different records), and record widening of values other than constants passed to props (a `$state`, a parameter, a class field) | E_PROPS | Records are nominal; a constant computed from literals takes the prop's records program-wide, other values keep theirs, and native `attrs.get` downcasts to the exact type | Widen the value at its site, or convert records structurally where a bag is read | svelte.ts `checkSpreadRecords`; types.ts `widenRecord` |
| Radio groups across components, in lists or multi-instance components, with non-literal names | E_TEMPLATE | Two could be checked at once | Run-time group tracking | controls.ts:122-186 |
| Snippets as bag values: `{@render bag.key()}` other than a snippet the rest props received (through a constant whose last entry that may hold the key is the rest props); a bag of the rest props passed to a snippet where a site passes both that snippet and one the rest props hold | E_TEMPLATE | Snippets the rest props receive are slots, not bag entries | Snippet values in bags | svelte.ts (`restEntryOf`, `render`) |
| Svelte 5.54.0 (the site's pin) and 5.49.2 are not in the automated campaign | — | Unchecked identity | Version environments (M7 prerequisite) | design/M6-SVELTEKIT |

## SvelteKit (F2)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| mdsvex/`.md` extensions and preprocessors unless generated; `svelte.config.js` options beyond the literal subset; Kit 3 (TypeScript ^6 peer) | E_KIT_CONFIG | The config is not run | Generation (exists for the docs pages) | kit.mjs:59-259 |
| `page.data`/`form`/`state`, `navigating`, `updated`, `onNavigate`, `invalidate*`, `preload*`, shallow routing, `$app/stores`, `$app/forms`, `$app/paths`, `$app/server`, `$env/*`, `$service-worker`, hooks, service workers, form actions, remote functions, snapshots | E_KIT_* | Rejected | Per API | CONTRACT; kit-app.mjs |
| Non-prerendered server code, `entries` in universal modules, globs without a type argument or in components, `catch` around `error()`/`redirect()`, `autofocus`, scripts in `app.html` (the site's cookie script) | E_KIT_* / E_GLOB | No server at run time | — | kit.mjs; kit-server.mjs; svelte.ts:1426 |
| `data-sveltekit-preload-*` other than off; document `click`/window `popstate`/`hashchange` listeners in Kit apps | E_KIT_* | The router owns them. The shadcn-svelte site's `app.html` sets `data-sveltekit-preload-data="hover"` on `<body>`, so the census's Kit hosts, which use it as written, stop at `E_KIT_PRELOAD` ([census](../../conformance/results/shadcn-svelte-census.md)) | Preloading: run a route's `load` on hover or tap ahead of navigation | svelte.ts:1008,1665,4746; kit.mjs:353 |
| Deviations: data identity after a parent merge, reload scroll restoration, render errors not routed to `+error.svelte`, eager route-module initialisation, no SSR/hydration (`$props.id` `s1` vs `c1`) | recorded | — | Per item; lazy per-route initialisation (M7) | CONTRACT |
| External links, `data-sveltekit-reload`, unknown paths, cross-origin redirects, redirect loops, default `handleError` | run time | Not modelled | Open external links in the OS browser (M7) | adapters/kit/client.ts:367-1120 |
| The site's `/docs/components/[name]` family, `/blocks` (iframes), `/create` (server code) | — | Blocked by the shared chain (packages, sticky, images) | M7 | design/M6-SVELTEKIT |

## React (F3)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Every React API except `useState`, `useRef`, `useEffect`, `useLayoutEffect`: `useMemo`, `useCallback`, `useContext`, `createContext`, `forwardRef`, `memo`, `useId`, `useReducer`, `Fragment`, … | E_CAPABILITY | Memo slots were planned for M4 and not done | Hooks as reactive-core constructs; context like Svelte's | react.ts:647 |
| Custom hooks; hooks under conditions or in nested functions | E_HOOK | "custom hooks are unsupported" | Inline hooks into the component | react.ts:558 |
| Library components, `<X.Y>`, Radix, lucide-react (no packs or sources) | E_COMPONENT / E_DEPENDENCY | — | Source compilation as for bits-ui | react.ts:2620; packs.ts:221 |
| Elements outside the allow-list, including `a`, `img`, `form`, `table` | E_JSX | — | See P1 | react.ts:2293 |
| Spreads other than rest props; several spreads; spreads on checkboxes/selects | E_JSX | "planned for later" | Bags (exist for Svelte) | react.ts:718,2321 |
| Lazy `useState` initialisers; destructuring in component bodies; body statements other than const/hooks/functions (`if`, early return, `let`, loops); components not returning JSX | E_STATE / E_COMPONENT | — | — | react.ts:1009-1151 |
| Callback refs, refs to components, shared refs, refs in lists or slots, render-time ref reads, refs holding objects | E_REF | "planned for a later milestone" | — | react.ts:1196-1265,1943-1950,2949 |
| Nested prop destructuring; object/array prop defaults; children/render-prop defaults | E_PROPS | — | — | react.ts:913-967 |
| Events outside the list (`onSubmit`, `onKeyPress`, `onInput`, touch, drag, animation/transition end, paste); capture handlers; `onWheel` | E_EVENT | Passive root listener for wheel | — | react.ts:1783,1789,2370 |
| Style strings, computed keys, spreads in style objects | E_JSX | — | — | react.ts:1805-1927 |
| `select multiple`, `defaultValue`, uncontrolled controls, controlled controls without `onChange` | E_JSX | "planned for later / M5" | — | react.ts:2376-2547 |
| Recursive components; region unmount order; continuous-lane cases (timers from scroll listeners, window scroll/resize listeners) | E_COMPONENT / E_EVENT | — | — | react.ts:802,3342-3846 |
| Prop domains (class through the parent) | — | The React adapter does not analyse sites | Port the Svelte site analysis | design/M6-LIBRARIES |
| Builds with `babel-plugin-react-compiler` | — | Render counts would differ | Detect and reject (planned, not implemented) | research/REACT-REGIONS |

## Vue (F4)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Vue APIs other than `ref`, `computed`, `shallowRef`, `useTemplateRef`, `useAttrs`, `onWatcherCleanup`, `nextTick` and the lifecycle set: `reactive`, `toRef(s)`, `provide`/`inject`, `h`, `defineComponent`, `unref`, `toValue`, `customRef`, `effectScope`, `onUpdated`, `watchPostEffect`, … | E_CAPABILITY | "planned for a later milestone" | Per API; reka-ui uses most of them | vue.ts:2732,2745 (list :189-204) |
| `v-show`, `v-html`, `v-text`, `v-once`, `v-memo`, custom directives; directive and `v-model` modifiers (`.trim`, `.number`, `.lazy`) | E_TEMPLATE | "planned for a later milestone" | `v-show` is cheap | vue.ts:4371,4614 |
| `<style>` blocks, plain `<script>`, generic SFCs, `defineOptions` beyond `inheritAttrs` | E_SFC / E_OPTIONS | "component styles are M6" | Scoped styles as for Svelte | vue.ts:489-531 |
| `Transition`, `Teleport`, `KeepAlive`, `<component :is>`, RouterLink, library components | E_TEMPLATE | — | — | vue.ts:4248 |
| `<template v-if>` / `v-else` fragments (several nodes or text under one condition) | E_TEMPLATE ("`<template>` is outside the supported elements") | Found in the M6 element sweep; conditions are on elements only | Lower the fragment as Svelte's `{#if}` blocks | vue.ts:4248 |
| Watchers: `deep`, `once`, `flush: post\|sync`, reactive-object sources, watch handles; `onUpdated`/`onBeforeUpdate` | E_EFFECT | "planned for a later milestone" | — | vue.ts:2407-2677,2802 |
| Runtime `defineProps`/`defineEmits`; `defineModel` options; rest props; dynamic slot names, `$slots`; `v-bind="obj"` other than `$attrs`; reading fallthrough attributes by name | E_PROPS / E_EMITS / E_MODEL / E_SLOTS / E_ATTRS | — | — | vue.ts:561-739,912,1358,3464-3501 |
| `v-for` over objects, ranges, maps; destructured items | E_TEMPLATE | "planned for later" | — | vue.ts:3514-3526 |
| Event options `.passive`/`.once`/`.capture`; dynamic event names; events outside the list | E_EVENT | — | — | vue.ts:4338-4357 |
| `v-model` on inputs other than text/checkbox/radio, true-value/false-value, arrays; uncontrolled checkboxes/radios | E_TEMPLATE | "planned for a later milestone" | — | vue.ts:4485-4629 |
| Template refs: function refs, refs in `v-for` or slots, refs read in render | E_REF | — | — | vue.ts:2065,2167-2188 |
| Entries other than `createApp(App).mount("#root")` (no plugins, `app.use`) | E_BOOTSTRAP | — | — | vue.ts:446-470 |
| A raw object captured before it was stored in a ref is tracked natively | deviation | Low priority | — | results/m4 |
| Prop domains | — | Not analysed | Port the Svelte analysis | design/M6-LIBRARIES |
