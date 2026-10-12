// Mapping pack for @lucide/svelte 1.52.0 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// Deep icon imports (`@lucide/svelte/icons/<name>`, default export) are
// components. An instance expands to the inline SVG that the package's
// dist/Icon.svelte renders for it, read from the icon's own node data:
//
//   <svg xmlns width height viewBox fill stroke stroke-width stroke-linecap
//        stroke-linejoin class [aria-hidden] ...rest>{icon nodes}</svg>
//
// following dist/utils/buildLucideIconNode.js and defaultAttributes.js:
// - `size` (default 24) sets width and height, `width`/`height` override it;
// - a truthy `color` replaces stroke="currentColor";
// - `strokeWidth` (default 2); with `absoluteStrokeWidth`,
//   Number(strokeWidth) * 24 / Number(width);
// - class: clsx of ['lucide', 'lucide-<name>', 'lucide-<alias>'…,
//   'lucide-icon', class] (mergeClasses, then Svelte's spread class);
// - aria-hidden="true" unless a rest prop is aria-*, role or title;
// - the other attributes follow in order, replacing defaults of their name.
// Values of size, width, height, color and strokeWidth must not be nullable
// (null and undefined pick different defaults there). Rest attributes are
// limited to the inline SVG allow-list on <svg> (docs/CONTRACT.md): id,
// role, aria-*, data-* and paint attributes. Spread attributes of known
// names (frontend/bags.ts) follow the same order (`expand`). Other props,
// spreads outside that shape, children, listeners and `nonScalingStroke`
// are rejected with E_PACK.
import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Expr, Node, Type } from '../ir.ts';
import type { Pack, PackAttr, PackComponent } from '../packs.ts';
import { ABSENT } from '../bags.ts';
import { classValue, clsxPack } from './clsx-2.1.1.ts';

const ID = '@lucide/svelte@1.52.0';

interface IconData {
  name: string;
  size: number;
  node: [string, Record<string, string>][];
  aliases: string[];
}

/** Paint attributes allowed on <svg> (runic-ir's inline SVG allow-list). */
const PAINT = new Set([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-opacity',
]);

/** Icon.svelte's props the pack covers. */
const DECLARED = [
  'color',
  'size',
  'width',
  'height',
  'strokeWidth',
  'absoluteStrokeWidth',
  'class',
];

/** Icon.svelte's props the pack does not cover. */
const UNCOVERED = ['nonScalingStroke', 'icon', 'iconNode', 'children'];

/** The <svg>'s attributes before the rest props (defaultAttributes.js, class, aria-hidden). */
const DEFAULTS = [
  'xmlns',
  'width',
  'height',
  'viewBox',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'class',
  'aria-hidden',
];

/** Rest props the <svg> may carry (runic-ir's inline SVG allow-list). */
const allowed = (name: string): boolean =>
  name === 'id' || name === 'role' || /^(aria|data)-[a-z0-9-]+$/.test(name) || PAINT.has(name);

/** The icon data of `icons/<name>`: through the alias re-export to the icon's .svelte file. */
function readIcon(dir: string, name: string): IconData | string {
  const icons = path.join(dir, 'dist', 'icons');
  const entry = path.join(icons, `${name}.js`);
  if (!existsSync(entry)) return `${ID} has no icon ${name}`;
  const target = /^export \{ default \} from "\.\/([a-z0-9-]+)\.svelte";$/m.exec(
    readFileSync(entry, 'utf8'),
  );
  if (!target) return `${ID} pack: icons/${name}.js is not an icon re-export`;
  const source = readFileSync(path.join(icons, `${target[1]}.svelte`), 'utf8');
  const literal = /^const iconData = (\{.*\});$/m.exec(source);
  let data: unknown;
  try {
    data = literal ? JSON.parse(literal[1]) : undefined;
  } catch {
    data = undefined;
  }
  const d = data as Partial<IconData> | undefined;
  const shape =
    d &&
    typeof d.name === 'string' &&
    d.size === 24 &&
    Array.isArray(d.node) &&
    d.node.every(
      n =>
        Array.isArray(n) &&
        n.length === 2 &&
        typeof n[0] === 'string' &&
        n[1] &&
        typeof n[1] === 'object' &&
        Object.values(n[1]).every(v => typeof v === 'string'),
    ) &&
    (d.aliases === undefined ||
      (Array.isArray(d.aliases) && d.aliases.every(a => typeof a === 'string'))) &&
    Object.keys(d).every(k => ['name', 'size', 'node', 'aliases'].includes(k));
  if (!shape) return `${ID} pack: the icon data of ${target[1]}.svelte has an unexpected shape`;
  return { ...(d as IconData), aliases: d!.aliases ?? [] };
}

/** mergeClasses: non-empty, trimmed-non-empty, first occurrences, joined and trimmed. */
const mergeClasses = (...classes: string[]): string =>
  classes
    .filter((c, i, all) => Boolean(c) && c.trim() !== '' && all.indexOf(c) === i)
    .join(' ')
    .trim();

function icon(data: IconData): PackComponent {
  return {
    kind: 'component',
    expand(attrs, { lower, b, at, fail, bags }) {
      const own = (a: PackAttr, what: string): never => fail('E_PACK', `${ID} pack: ${what}`, a.at);
      const props = new Map<string, PackAttr>();
      const rest: PackAttr[] = [];
      const spreads: PackAttr[] = [];
      for (const a of attrs) {
        if ('spread' in a.value) {
          spreads.push(a);
          continue;
        }
        if (props.has(a.name) || rest.some(r => r.name === a.name))
          own(a, `${a.name} is given twice`);
        if ('present' in a.value) own(a, `the bare attribute ${a.name} is not covered`);
        if (DECLARED.includes(a.name)) props.set(a.name, a);
        else if (UNCOVERED.includes(a.name)) own(a, `the ${a.name} prop is not covered`);
        else if (/^on/.test(a.name)) own(a, 'listeners on icons are not covered');
        else if (allowed(a.name)) rest.push(a);
        else
          own(
            a,
            `${a.name} is outside the inline SVG allow-list (id, role, aria-*, data-* and paint attributes)`,
          );
      }
      // Spreads (shadcn-svelte's Spinner: `{...restProps}` and
      // `{...(color != null ? { color } : {})}`): their names must be known.
      // Icon.svelte collects the names it does not declare in its rest
      // props, which follow its defaults in the <svg>'s attributes; so an
      // allow-listed name a spread may hold is an attribute whose value is
      // the last entry of the name in source order (an entry holding
      // undefined removes it). A declared prop a spread may hold only as
      // undefined keeps its default, where no attribute gives it; a name
      // outside the allow-list held only as null or undefined sets nothing.
      // Anything else is rejected.
      const reached = new Map<PackAttr, string[]>();
      const a11y = rest.some(a => a.name.startsWith('aria-') || a.name === 'role');
      for (const s of spreads) {
        const e = (s.value as { spread: ts.Expression }).spread;
        const shape = bags.shape(e);
        if (shape.open) own(s, `spread attributes on icons need known names`);
        const keys: string[] = [];
        for (const k of shape.keys) {
          const vs = bags.values(e, k);
          const held = vs?.filter(v => v !== ABSENT);
          if (held && !held.length) continue;
          if (!a11y && (k.startsWith('aria-') || k === 'role' || k === 'title'))
            own(
              s,
              `this spread may hold ${k}, which decides whether the icon is hidden from assistive technology (give role or an aria-* attribute explicitly)`,
            );
          if (DECLARED.includes(k) || UNCOVERED.includes(k)) {
            if (!held || held.some(v => v !== undefined) || props.has(k))
              own(s, `the ${k} prop from a spread is not covered`);
            continue;
          }
          if (/^on/.test(k)) own(s, 'listeners on icons are not covered');
          if (allowed(k)) {
            keys.push(k);
            continue;
          }
          if (!held || held.some(v => v !== undefined && v !== null) || DEFAULTS.includes(k))
            own(
              s,
              `this spread may hold ${k}, which is outside the inline SVG allow-list (id, role, aria-*, data-* and paint attributes)`,
            );
        }
        reached.set(s, keys);
      }
      /** The value of a prop: a string or number expression and its type. */
      const value = (a: PackAttr): { v: Expr; t: Type } => {
        if ('text' in a.value) return { v: { op: 'lit', value: a.value.text }, t: 'string' };
        const e = (a.value as { expr: ts.Expression }).expr;
        const v = lower.expr(e, b);
        return { v, t: lower.irType(v, b) };
      };
      const text = (a: PackAttr): Expr => {
        const { v, t } = value(a);
        if (t === 'string') return v;
        if (t === 'number') return { op: 'to-string', arg: v };
        return own(
          a,
          `${a.name} takes a string or a number here (nullable values pick different defaults)`,
        );
      };
      const given = (name: string) => props.get(name);
      // width = height = size = 24 unless given (Icon.svelte's prop defaults).
      const dimension = (name: 'width' | 'height'): Expr => {
        const a = given(name) ?? given('size');
        return a ? text(a) : { op: 'lit', value: '24' };
      };
      const width = dimension('width');
      const height = dimension('height');
      let stroke: Expr = { op: 'lit', value: 'currentColor' };
      const color = given('color');
      if (color) {
        const { v, t } = value(color);
        if (t !== 'string' && t !== 'number')
          own(color, 'color takes a string here (nullable values pick different defaults)');
        stroke = {
          op: 'cond',
          test: { op: 'to-boolean', arg: v },
          then: t === 'string' ? v : { op: 'to-string', arg: v },
          else: stroke,
        };
      }
      const sw = given('strokeWidth');
      const plain: Expr = sw ? text(sw) : { op: 'lit', value: '2' };
      let strokeWidth = plain;
      const absolute = given('absoluteStrokeWidth');
      if (absolute) {
        // Number(strokeWidth) * Number(icon.size) / Number(params.width).
        const num = (a: PackAttr | undefined, fallback: number): Expr => {
          if (!a) return { op: 'lit', value: fallback };
          const { v, t } = value(a);
          if (t === 'number') return v;
          if (t === 'string') return { op: 'to-number', arg: v };
          return own(a, `${a.name} takes a string or a number here`);
        };
        const scaled: Expr = {
          op: 'to-string',
          arg: {
            op: 'div',
            left: { op: 'mul', left: num(sw, 2), right: { op: 'lit', value: data.size } },
            right: num(given('width') ?? given('size'), 24),
          },
        };
        const { v, t } = value(absolute);
        if (t !== 'boolean') own(absolute, 'absoluteStrokeWidth takes a boolean');
        strokeWidth =
          v.op === 'lit'
            ? v.value
              ? scaled
              : plain
            : { op: 'cond', test: v, then: scaled, else: plain };
      }
      const base = mergeClasses(
        'lucide',
        `lucide-${data.name}`,
        ...data.aliases.filter(a => a.trim() !== '').map(a => `lucide-${a}`),
        'lucide-icon',
      );
      const cls = given('class');
      let klass: Expr = { op: 'lit', value: base };
      if (cls) {
        const part =
          'text' in cls.value
            ? ({ op: 'lit', value: cls.value.text } as Expr)
            : classValue((cls.value as { expr: ts.Expression }).expr, b, lower);
        // clsx([...base.split(' '), class]): a space before a non-empty part.
        klass =
          part.op === 'lit'
            ? { op: 'lit', value: part.value === '' ? base : `${base} ${part.value}` }
            : {
                op: 'concat',
                left: { op: 'lit', value: base },
                right: (() => {
                  const local = b.local('$lucideClass', 'string');
                  const read: Expr = { op: 'local', local };
                  return {
                    op: 'with',
                    local,
                    value: part,
                    body: {
                      op: 'cond',
                      test: { op: 'eq', left: read, right: { op: 'lit', value: '' } },
                      then: { op: 'lit', value: '' },
                      else: { op: 'concat', left: { op: 'lit', value: ' ' }, right: read },
                    },
                  } as Expr;
                })(),
              };
      }
      const out: { name: string; value: Expr }[] = [
        { name: 'xmlns', value: { op: 'lit', value: 'http://www.w3.org/2000/svg' } },
        { name: 'width', value: width },
        { name: 'height', value: height },
        { name: 'viewBox', value: { op: 'lit', value: `0 0 ${data.size} ${data.size}` } },
        { name: 'fill', value: { op: 'lit', value: 'none' } },
        { name: 'stroke', value: stroke },
        { name: 'stroke-width', value: strokeWidth },
        { name: 'stroke-linecap', value: { op: 'lit', value: 'round' } },
        { name: 'stroke-linejoin', value: { op: 'lit', value: 'round' } },
        { name: 'class', value: klass },
      ];
      if (!a11y) out.push({ name: 'aria-hidden', value: { op: 'lit', value: 'true' } });
      /** An attribute value as a nullable string. */
      const nullable = (v: Expr): Expr => {
        const t = lower.irType(v, b);
        return t === 'string' ? { op: 'some', value: v } : v;
      };
      // The rest props in source order: explicit attributes and the names
      // spreads may hold, a later entry of a name replacing an earlier one.
      for (const a of attrs) {
        const keys = reached.get(a);
        if (keys) {
          const e = (a.value as { spread: ts.Expression }).spread;
          for (const k of keys) {
            const name: Expr = { op: 'lit', value: k };
            const i = out.findIndex(o => o.name === k);
            const earlier: Expr =
              i >= 0 ? nullable(out[i].value) : { op: 'undefined', type: { maybe: 'string' } };
            const v: Expr = {
              op: 'cond',
              test: {
                op: 'builtin',
                name: 'attrs.has',
                args: [bags.value(e), name],
                type: 'boolean',
              },
              then: {
                op: 'builtin',
                name: 'attrs.get',
                args: [bags.value(e), name],
                type: { maybe: 'string' },
              },
              else: earlier,
            };
            if (i >= 0) out[i] = { name: k, value: v };
            else out.push({ name: k, value: v });
          }
          continue;
        }
        if (!rest.includes(a)) continue;
        let v: Expr;
        if ('text' in a.value) v = { op: 'lit', value: a.value.text };
        else {
          const x = value(a);
          if (x.t === 'string' || JSON.stringify(x.t) === '{"maybe":"string"}') v = x.v;
          else if (x.t === 'number' || x.t === 'boolean') v = { op: 'to-string', arg: x.v };
          else v = own(a, `${a.name} takes a string, a nullable string, a number or a boolean`);
        }
        const i = out.findIndex(o => o.name === a.name);
        if (i >= 0) out[i] = { name: a.name, value: v };
        else out.push({ name: a.name, value: v });
      }
      const children: Node[] = data.node.map(([tag, attributes]) => ({
        kind: 'element',
        tag,
        attrs: Object.entries(attributes).map(([name, v]) => ({
          name,
          value: { op: 'lit', value: v },
        })),
        source: at,
      }));
      return { kind: 'element', tag: 'svg', attrs: out, children, source: at };
    },
  };
}

export const lucideSveltePack: Pack = {
  name: '@lucide/svelte',
  version: '1.52.0',
  module: import.meta.url,
  // Class values follow clsx (Svelte's spread class).
  requires: [clsxPack],
  export(pkg, imported) {
    const m = /^\.\/icons\/([a-z0-9-]+)$/.exec(pkg.subpath);
    if (!m)
      return `${ID} pack covers icon imports (@lucide/svelte/icons/<name>), not ${pkg.subpath}`;
    if (imported !== 'default') return `${ID} pack: icon modules have a default export only`;
    const data = readIcon(pkg.dir, m[1]);
    return typeof data === 'string' ? data : icon(data);
  },
};
