// Checks on selects and radio buttons shared by the React and Vue adapters
// (docs/IR.md "Selects", "Radio buttons"). The IR applies a radio button's
// `checked` to that button only, while the DOM unchecks the rest of its
// group when one is checked, so a program must not set two buttons of a
// group checked at once: the adapters accept named groups whose `checked`
// values provably exclude each other.
import { Diagnostic } from '../compiler/collect.mjs';
import type { Component, Expr, Node, Source } from './ir.ts';

type Element = Node & { kind: 'element' };

/** An element's attribute value expression. */
const attr = (n: Element, name: string): Expr | undefined =>
  (n.attrs ?? []).find(a => a.name === name)?.value;

const literal = (e: Expr | undefined): string | undefined =>
  e?.op === 'lit' && typeof e.value === 'string' ? e.value : undefined;

export const isRadio = (n: Element): boolean =>
  n.tag === 'input' && literal(attr(n, 'type')) === 'radio';

/**
 * A select's children are options, directly or through lists and
 * conditionals of options: text and components inside a select are
 * unsupported (the browser renders no text there).
 */
export function checkSelectChildren(select: Element, what: string): void {
  const visit = (nodes: Node[]) => {
    for (const n of nodes)
      switch (n.kind) {
        case 'element':
          if (n.tag !== 'option')
            throw new Diagnostic(
              'E_TEMPLATE',
              `<${n.tag}> inside <select> is unsupported (options only)`,
              n.source ?? select.source,
            );
          break;
        case 'if':
          visit([...n.then, ...(n.else ?? [])]);
          break;
        case 'each':
          visit([...n.body, ...(n.else ?? [])]);
          break;
        case 'text':
          throw new Diagnostic(
            'E_TEMPLATE',
            `Text inside <select> is unsupported (${what})`,
            n.source ?? select.source,
          );
        default:
          throw new Diagnostic(
            'E_TEMPLATE',
            'Options of a select must be written in its own template (components and slots inside <select> are unsupported)',
            n.source ?? select.source,
          );
      }
  };
  visit(select.children ?? []);
}

/** `source` keys removed: expressions compared by structure. */
const shape = (e: unknown): string => JSON.stringify(e, (k, v) => (k === 'source' ? undefined : v));

/**
 * Named radio groups: every button of a group (the same literal `name`) is
 * in one component that has at most one instance at a time, outside lists
 * and slot content, and is checked when one expression equals its own
 * string literal (`x === 'a'`, `v-model` with a literal value), the
 * expression the same for the whole group and the literals distinct. Then
 * at most one button of a group is checked at any time, as in the DOM.
 * Buttons without a name have no group.
 */
export function checkRadioGroups(components: Component[], root: number): void {
  // Components that may have more than one live instance: rendered by more
  // than one component node (both branches of a conditional count), in a
  // list or slot content, or below such a component. Each visit of a
  // component walks its subtree again (recursive components are rejected).
  const count = new Map<number, number>();
  const multi = new Set<number>();
  const instance = (k: number, repeated: boolean, path: number[]) => {
    if (path.includes(k)) return;
    count.set(k, (count.get(k) ?? 0) + 1);
    if (repeated || count.get(k)! > 1) multi.add(k);
    const walk = (nodes: Node[], rep: boolean) => {
      for (const n of nodes)
        switch (n.kind) {
          case 'element':
            walk(n.children ?? [], rep);
            break;
          case 'if':
            walk([...n.then, ...(n.else ?? [])], rep);
            break;
          case 'each':
            walk([...n.body, ...(n.else ?? [])], true);
            break;
          case 'slot':
            walk(n.fallback ?? [], rep);
            break;
          case 'component':
            for (const s of n.slots ?? []) walk(s.body, true);
            instance(n.component, rep, [...path, k]);
            break;
        }
    };
    walk(components[k].template, repeated);
  };
  instance(root, false, []);
  type Button = { component: number; node: Element; listed: boolean };
  const groups = new Map<string, Button[]>();
  const fail = (message: string, source: Source | undefined): never => {
    throw new Diagnostic('E_TEMPLATE', message, source);
  };
  components.forEach((c, k) => {
    const walk = (nodes: Node[], listed: boolean) => {
      for (const n of nodes)
        switch (n.kind) {
          case 'element': {
            if (isRadio(n)) {
              const name = attr(n, 'name');
              if (name !== undefined && literal(name) === undefined)
                fail('Radio buttons need a literal name (or none)', n.source);
              const g = literal(name);
              if (g !== undefined && g !== '')
                groups.set(g, [...(groups.get(g) ?? []), { component: k, node: n, listed }]);
            }
            walk(n.children ?? [], listed);
            break;
          }
          case 'if':
            walk([...n.then, ...(n.else ?? [])], listed);
            break;
          case 'each':
            walk([...n.body, ...(n.else ?? [])], true);
            break;
          case 'slot':
            walk(n.fallback ?? [], listed);
            break;
          case 'component':
            for (const s of n.slots ?? []) walk(s.body, true);
            break;
        }
    };
    walk(c.template, false);
  });
  for (const [name, buttons] of groups) {
    const first = buttons[0];
    let subject: string | undefined;
    const values = new Set<string>();
    for (const b of buttons) {
      const at = b.node.source;
      if (b.listed)
        fail(
          `Radio buttons of group "${name}" in a list or slot content are unsupported (two of them could be checked at once, which the DOM does not allow)`,
          at,
        );
      if (b.component !== first.component)
        fail(
          `The radio buttons of group "${name}" must be in one component (${components[first.component].name})`,
          at,
        );
      if (multi.has(b.component))
        fail(
          `Radio buttons of group "${name}" in ${components[b.component].name}, which may have more than one instance: its instances would share the group`,
          at,
        );
      const checked = (b.node.props ?? []).find(p => p.name === 'checked')?.value;
      const parts =
        checked?.op === 'eq'
          ? literal(checked.right) !== undefined
            ? { subject: checked.left, value: literal(checked.right)! }
            : literal(checked.left) !== undefined
              ? { subject: checked.right, value: literal(checked.left)! }
              : undefined
          : undefined;
      if (!parts)
        fail(
          `A radio button of group "${name}" must be checked by comparing a value with its own string literal (checked={size === 's'}, v-model with a literal value): two buttons of a group checked at once are unsupported`,
          at,
        );
      const s = shape(parts!.subject);
      if (subject !== undefined && s !== subject)
        fail(`The radio buttons of group "${name}" must compare the same value`, at);
      subject = s;
      if (values.has(parts!.value))
        fail(`Two radio buttons of group "${name}" have the value "${parts!.value}"`, at);
      values.add(parts!.value);
    }
  }
}
