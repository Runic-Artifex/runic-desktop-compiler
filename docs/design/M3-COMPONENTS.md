# M3 design: components, instances and lists

Status: implemented in M3 ([roadmap](../ROADMAP.md#m3-components-and-lists)); the IR is specified in [IR.md](../IR.md). It extends IR schema 4 additively, like M2. Where the implementation departed from the first draft, this note was updated; see [Outcome](#outcome).

## Goals

- Component instances with their own state, created and destroyed with the template region that contains them, so state resets on remount as in every framework.
- Props, including callbacks and two-way bindings (Svelte `bind:` / `$bindable`, Vue `v-model` on components).
- Keyed and unkeyed lists with stable identity: moving an item moves its DOM and keeps its component state, focus and input values.
- Children, slots and snippets as parameterised template content owned by the parent.
- Element refs for focus.
- Svelte deep-state ownership (replacing the M2 deviation).

The interpreter remains the semantic authority (D8); codegen must match it on the differential test, and both are checked against the frameworks by conformance.

## Instances

Every component in `components` may now be instantiated any number of times. The root component has exactly one instance, created at startup.

- **State.** Each instance owns one value per cell. IR functions with `component: k` run *in an instance* of `k`: cell reads and writes refer to that instance. Closures created there capture their instance, so a callback passed to a child still writes the parent's cells.
- **Snapshots** (React render reads) are per instance and, as in M2, equal the committed state outside handlers.
- **Lifetime.** An instance is created when its `component` node is mounted (in tree order, parent first) and destroyed with that node: when an `if` branch switches, a list item disappears or an ancestor is destroyed. Creation evaluates the props, then the cell initialisers in order. Destruction drops its state; cleanup callbacks arrive with effects in M4.
- **Identity.** An instance is identified by its parent instance, its `component` node, and the list keys on the path between them. Re-rendering with the same identity keeps the instance.

## Props

A prop is a cell of the child marked with `"prop": "<name>"`. Its `init` is the default, used when the parent does not pass the prop.

```jsonc
// child cell
{ "name": "count", "type": "number", "init": { "op": "lit", "value": 0 }, "prop": "count", "tracking": "identity" }
// parent template
{ "kind": "component", "component": 1,
  "props": [ { "name": "count", "value": Expr, "bind"?: Expr } ],
  "slots"?: [ Slot ] }
```

- When the parent's prop expression changes value (SameValue), the child's prop cell is set and becomes dirty. Reference-typed prop cells are tracked `deep`: a mutation through a shared object also updates the child, matching Svelte/Vue proxies and React re-rendering the child with its parent. (React does not re-render on a mutation without a state update; that over-approximation is recorded as a deviation.)
- `bind` is a function value `fn(T) -> void`, built by the frontend as a closure that assigns the parent's place. A write to a bound prop cell sets the child's value and then calls `bind` with the new value. An unbound prop can be written locally (Svelte's temporary override) until the parent passes a new value.
- Callbacks are ordinary function-typed props.

The validator checks that each passed prop exists, that types match, and that `bind` has type `fn(T) -> void`.

## Lists

```jsonc
{ "kind": "each", "items": Expr,            // an array
  "item": 3, "index"?: 4,                   // template locals receiving the element and its index
  "key"?: Expr,                             // evaluated with `item`/`index` bound; any type with SameValueZero keys
  "body": [Node], "else"?: [Node] }
```

Components gain `templateLocals: [Local]`. Template expressions inside an `each` body may read the locals of the enclosing `each` nodes with `{ "op": "local" }`.

- **Keyed:** blocks are matched by key. A matched block keeps its DOM nodes and component instances; its locals are updated, and the nodes move into the new order. Unmatched old blocks are destroyed; new keys are mounted. Duplicate keys throw a `RunicKeyError` (Svelte throws; React and Vue only warn, a recorded deviation).
- **Which blocks move** is observable: Chromium blurs a focused element whose node is moved. `each.reorder` names the framework's keyed diff, ported exactly in runic-runtime's `reorder` module: `lis` (Vue's `patchKeyedChildren`), `forward` (React's `reconcileChildrenArray`) and `stash` (Svelte 5's `reconcile`). React DOM refocuses the previously focused element after each commit (`restoreFocus`).
- **Unkeyed:** blocks are matched by index, so item values update in place (Svelte, Vue and React without keys behave this way).
- `else` renders when the array is empty (Svelte `{:else}`).
- Bindings inside a block re-evaluate when a cell they read is dirty, or when the block's locals were reassigned or the `items` expression was re-evaluated (an item object may have been mutated in place).

## Listeners with context

Handlers gain `params: [Local]`; their local index space is params, then locals. A listener passes arguments evaluated in its template scope:

```jsonc
"listeners": [ { "event": "click", "handler": 2, "args": [ { "op": "local", "local": 3 } ] } ]
```

Arguments are evaluated when the event is dispatched, from the block's current locals; this matches closures over the current item in all three frameworks, because rendering is synchronous after every handler.

## Slots, children and snippets

A slot is parent-owned template content that a child renders, possibly with arguments:

```jsonc
// on the component node in the parent
"slots": [ { "name": "default", "params": [5], "body": [Node] } ]   // params are parent template locals
// in the child template
{ "kind": "slot", "name": "default", "args": [Expr], "fallback"?: [Node] }
```

The slot body evaluates in the parent instance (its cells and template locals), with `params` bound to the child's `args`. React `children` and render props, Vue default/named/scoped slots and Svelte `children`/snippets (`{@render}`) all lower to this.

## Refs

A cell of type `{"maybe": "element"}` can be bound to an element: `{ "kind": "element", …, "ref": cell }`. It is set at mount and set to `null` on removal (as `bind:this`, Vue template refs and `useRef`). `element.focus()` and `element.blur()` are the element built-ins, applied by the runtime after the update; measurement APIs arrive with layout in M5. The `element` type is opaque: it can be compared, stored and passed, not inspected. DOM element types come from `frontend/dom.d.ts`.

## Svelte deep-state ownership

Svelte `$state` proxies plain objects and arrays. A proxy has its own identity but wraps the raw object; properties are read from the raw object until the proxy has read them once. Native code models proxies as *wrappers* (`JsRef::proxy`): a new identity sharing the raw value's storage.

- Storing a raw object or array into proxied state (a `set` of a `proxied` cell, an `assign` into a proxy, or an item inserted into a proxied array) stores a proxy of it; nested plain objects and arrays are proxied in place. Values read from state are proxies already and keep their identity.
- Consequences match Svelte: `items.push(x); items.includes(x)` is false; storing the same raw object twice gives two distinct proxies; a raw write right after storing (`items.push(x); x.name = …`) is visible, because both share storage.
- Only mutations through proxies make `proxied` cells dirty (Svelte's raw writes are not reactive).
- `Map`, `Set` and class instances are never proxied (Svelte requires `SvelteMap`/`SvelteSet`, M6); Vue keeps `deep` tracking.
- Not modelled: Svelte's lazy per-property snapshot. A raw write in a *later* handler stays visible natively, while Svelte hides it for properties its proxy has already read (recorded deviation).

The ownership rule is the `proxied` tracking mode, which only the Svelte adapter selects.

## Native implementation

- **Store.** Generated code keeps a slab of instance states per component (`Cells{k}` plus snapshot). Component functions and handlers take the instance id; closures capture it.
- **Scopes.** Each template scope struct stores its instance id and, inside lists, its block's template locals (shared with its listeners).
- **Listeners** are runtime-owned closures keyed by node; removal frees them.
- **Dispatch.** Run the listener, compare every live instance's cells with their state before the handler (plus the mutation epoch) to get dirty bits, then update the tree from the root. Parent updates set child prop cells and their dirty bits before updating the child.
- **Reconciliation** for keyed lists reuses blocks by key and moves their nodes with `insert_before`; it creates no virtual DOM.

## Snapshot format

Probe and interpreter snapshots keep `cells` for the root instance and add `instances`: every other live instance in tree order as `{ "component": name, "cells": [...] }`. The differential test compares both.

## Examples and cases

- **7GUIs CRUD** (filter, list selection, create/update/delete), written with a clickable list instead of a `<select>` listbox (select is M5).
- **TodoMVC in memory:** add, toggle, edit, delete, filters and "clear completed". This needs checkboxes and the Enter key, so M3 adds controlled checkboxes (`checked` prop, `change` event) and `keydown` listeners whose payload is `event.key`, the minimum of the M5 event model.
- Conformance cases for list moves with preserved focus and input values, conditional remount resetting child state, two-way binding and callbacks.

## Work order

1. IR, validator and interpreter for instances, props, lists, listener arguments and the snapshot format.
2. Codegen and runtime, checked by the differential test on hand-written programs and the Svelte adapter.
3. Svelte adapter (`$props`, `$bindable`, child components, `{#each}`, snippets), then the examples and cases.
4. React and Vue adapters in parallel subagents on the same cases.
5. Slots/children, refs, ownership, checkboxes and keydown.
6. React regions spike: compare React Compiler's reactive scopes with our dependency guards on the examples (report only).

## Outcome

Implemented as designed, with these changes and findings:

- **Module objects** became program `globals` (module constants evaluated once), since component cells cannot be shared between components.
- **Events:** `change` (checkboxes, boolean payload) and `keydown` (payload `event.key`, bubbling, before default actions) joined `click` and `input`; checkboxes have a live `checked` property. The runtime owns checkbox activation (Blitz's default action touched removed checkboxes).
- **Differential test:** it now picks targets from the live DOM (`nth` actions) and compares child instances; before M3 it only reached the root template.
- **Codegen** builds `runic-codegen` per working tree (`.cache/codegen-target`), so parallel worktrees cannot swap each other's backend.
- **Deviations** (recorded in the M3 results):
  - *Update granularity.* Svelte runs all text and attribute updates of a block together, Vue and React re-render components; a value read without reactivity (a `Map` in `$state`, a plain `let`) therefore refreshes there when a neighbour changes, but natively only when its own dependencies change. Planned with the M4 reactivity work, which needs shared dependency analysis in the interpreter and codegen.
  - *Navigation after a move-induced blur* continues from the moved element natively, from Chromium's detach position in the browser (case `reorder-navigation`, known gap, M5 focus model).
  - Svelte's lazy proxy snapshots (above); duplicate keys throw where React and Vue warn.
