// Mapping pack for @tabler/icons-svelte 3.40.0 (docs/design/M6-LIBRARIES.md#mapping-packs-d9).
//
// The package's components are legacy-mode Svelte (`export let`, `$$props`,
// `<slot />`), which the Svelte adapter does not lower from source. Deep icon
// imports (`@tabler/icons-svelte/icons/<name>`, the default export of
// dist/icons/<name>.svelte) are components: an instance expands to the
// inline SVG that dist/Icon.svelte renders for the icon's `type` (outline or
// filled), read from the icon file's own `iconNode`:
//
//   <svg {...defaultAttributes[type]} {...$$restProps} width={size}
//        height={size} class="tabler-icon tabler-icon-<name> {class ?? ''}"
//        {...type === 'filled' ? { fill: color } : { 'stroke-width': stroke, stroke: color }}>
//     {icon nodes}
//   </svg>
//
// - `size` (default 24) sets width and height;
// - `color` (default currentColor) sets stroke (outline) or fill (filled);
// - `stroke` (default 2) is the stroke width of outline icons (filled icons
//   ignore it); it is not the stroke paint;
// - the class is the template string above: a trailing space without one;
// - the other attributes are the rest props, replacing defaults of their
//   name in place and following them otherwise.
// Values of size, color and stroke must not be nullable (undefined picks
// the default, null removes the attribute). Rest attributes are limited to
// the inline SVG allow-list on <svg> (docs/CONTRACT.md): id, role, aria-*,
// data-* and paint attributes; those Icon.svelte overrides (width, height,
// stroke-width or fill as the icon type sets them) are rejected rather than
// dropped. The pack also rejects the props that select the icon (`type`,
// `name`, `iconNode`), spreads, children, listeners and bare attributes
// (E_PACK). Icon.svelte and defaultAttributes.js must be the published files
// (`pinnedCheck`), since the pack implements them.
import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Expr, Node, Type } from '../ir.ts';
import type { Pack, PackageRef, PackAttr, PackComponent } from '../packs.ts';
import { pinnedCheck } from './pinned.ts';

const ID = '@tabler/icons-svelte@3.40.0';

/** The files whose behaviour the pack implements. */
const PINNED = {
  'dist/Icon.svelte': '359ff416f5cfbfd61290584a76e7fc005e4e8667a0091ce2b4a23a1586fea31d',
  'dist/defaultAttributes.js': '3356fbaa7993d2ad3c593f2ce0bbfeb8db8bbc3b44dcd2f0b1c7c7b0126997d8',
};

/** dist/defaultAttributes.js, in its key order. */
export const DEFAULT_ATTRIBUTES: Record<'outline' | 'filled', [string, string][]> = {
  outline: [
    ['xmlns', 'http://www.w3.org/2000/svg'],
    ['width', '24'],
    ['height', '24'],
    ['viewBox', '0 0 24 24'],
    ['fill', 'none'],
    ['stroke', 'currentColor'],
    ['stroke-width', '2'],
    ['stroke-linecap', 'round'],
    ['stroke-linejoin', 'round'],
  ],
  filled: [
    ['xmlns', 'http://www.w3.org/2000/svg'],
    ['width', '24'],
    ['height', '24'],
    ['viewBox', '0 0 24 24'],
    ['fill', 'currentColor'],
    ['stroke', 'none'],
  ],
};

interface IconData {
  type: 'outline' | 'filled';
  name: string;
  node: [string, Record<string, string>][];
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

/** Icon.svelte's props the pack covers (`stroke` is the stroke width). */
const DECLARED = ['color', 'size', 'stroke', 'class'];

/** Props that select the icon (the icon file passes them; a site would replace them). */
const UNCOVERED = ['type', 'name', 'iconNode', 'children'];

/** Rest props the <svg> may carry (runic-ir's inline SVG allow-list). */
const allowed = (name: string): boolean =>
  name === 'id' || name === 'role' || /^(aria|data)-[a-z0-9-]+$/.test(name) || PAINT.has(name);

/** The attributes Icon.svelte sets after the rest props, by icon type. */
const OVERRIDDEN: Record<IconData['type'], string[]> = {
  outline: ['width', 'height', 'stroke-width'],
  filled: ['width', 'height', 'fill'],
};

/** The icon file's own data: its type, name and nodes, in the shape every icon of the package has. */
function readIcon(pkg: PackageRef, name: string): IconData | string {
  const file = path.join(pkg.dir, 'dist', 'icons', `${name}.svelte`);
  if (!existsSync(file)) return `${ID} has no icon ${name}`;
  const problem = pinnedCheck(pkg, PINNED);
  if (problem) return `${ID} pack: ${problem}`;
  const m =
    /^<script>import Icon from '\.\.\/Icon\.svelte';\nconst iconNode = (\[.*\]);\n<\/script>\n<Icon type="(outline|filled)" name="([a-z0-9-]+)" \{\.\.\.\$\$props\} iconNode=\{iconNode\}>\n {2}<slot\/>\n<\/Icon>\n?$/.exec(
      readFileSync(file, 'utf8'),
    );
  let node: unknown;
  try {
    node = m ? JSON.parse(m[1]) : undefined;
  } catch {
    node = undefined;
  }
  const shape =
    Array.isArray(node) &&
    node.every(
      n =>
        Array.isArray(n) &&
        n.length === 2 &&
        typeof n[0] === 'string' &&
        n[1] &&
        typeof n[1] === 'object' &&
        Object.values(n[1]).every(v => typeof v === 'string'),
    );
  if (!m || !shape) return `${ID} pack: icons/${name}.svelte has an unexpected shape`;
  return { type: m[2] as IconData['type'], name: m[3], node: node as IconData['node'] };
}

function icon(data: IconData): PackComponent {
  return {
    kind: 'component',
    expand(attrs, { lower, b, at, fail }) {
      const own = (a: PackAttr, what: string): never => fail('E_PACK', `${ID} pack: ${what}`, a.at);
      const props = new Map<string, PackAttr>();
      const rest: PackAttr[] = [];
      for (const a of attrs) {
        if ('spread' in a.value) own(a, 'spread attributes on icons are not covered');
        if (props.has(a.name) || rest.some(r => r.name === a.name))
          own(a, `${a.name} is given twice`);
        if ('present' in a.value) own(a, `the bare attribute ${a.name} is not covered`);
        if (DECLARED.includes(a.name)) props.set(a.name, a);
        else if (UNCOVERED.includes(a.name)) own(a, `the ${a.name} prop is not covered`);
        else if (/^on/.test(a.name)) own(a, 'listeners on icons are not covered');
        else if (OVERRIDDEN[data.type].includes(a.name))
          own(
            a,
            `Icon.svelte replaces ${a.name} on ${data.type} icons (${a.name === 'fill' ? 'give color' : a.name === 'stroke-width' ? 'give stroke' : 'give size'})`,
          );
        else if (allowed(a.name)) rest.push(a);
        else
          own(
            a,
            `${a.name} is outside the inline SVG allow-list (id, role, aria-*, data-* and paint attributes)`,
          );
      }
      /** The value of a prop: an expression and its IR type. */
      const value = (a: PackAttr): { v: Expr; t: Type } => {
        if ('text' in a.value) return { v: { op: 'lit', value: a.value.text }, t: 'string' };
        const v = lower.expr((a.value as { expr: ts.Expression }).expr, b);
        return { v, t: lower.irType(v, b) };
      };
      /** A string or number prop, as its attribute text. */
      const text = (name: string, fallback: string): Expr => {
        const a = props.get(name);
        if (!a) return { op: 'lit', value: fallback };
        const { v, t } = value(a);
        if (t === 'string') return v;
        if (t === 'number') return { op: 'to-string', arg: v };
        return own(
          a,
          `${name} takes a string or a number here (undefined picks the default, null removes the attribute)`,
        );
      };
      const size = text('size', '24');
      const color = text('color', 'currentColor');
      // class={`tabler-icon tabler-icon-${name} ${$$props.class ?? ''}`}
      const base = `tabler-icon tabler-icon-${data.name} `;
      let klass: Expr = { op: 'lit', value: base };
      const cls = props.get('class');
      if (cls) {
        const { v, t } = value(cls);
        if (t === 'string')
          klass =
            v.op === 'lit'
              ? { op: 'lit', value: base + v.value }
              : { op: 'concat', left: klass, right: v };
        else if (JSON.stringify(t) === '{"maybe":"string"}') {
          const local = b.local('$tablerClass', t);
          const read: Expr = { op: 'local', local };
          klass = {
            op: 'concat',
            left: klass,
            right: {
              op: 'with',
              local,
              value: v,
              body: {
                op: 'cond',
                test: { op: 'builtin', name: 'maybe.is-nullish', args: [read], type: 'boolean' },
                then: { op: 'lit', value: '' },
                else: { op: 'unwrap', value: read },
              },
            } as Expr,
          };
        } else own(cls, 'class takes a string or a nullable string here');
      }
      const out: { name: string; value: Expr }[] = DEFAULT_ATTRIBUTES[data.type].map(
        ([name, v]) => ({ name, value: { op: 'lit', value: v } }),
      );
      const set = (name: string, v: Expr) => {
        const i = out.findIndex(o => o.name === name);
        if (i >= 0) out[i] = { name, value: v };
        else out.push({ name, value: v });
      };
      // The rest props in source order (the class prop is one of them).
      for (const a of attrs) {
        if (a === cls) {
          set('class', klass);
          continue;
        }
        if (!rest.includes(a)) continue;
        const { v, t } = value(a);
        if (t === 'string' || JSON.stringify(t) === '{"maybe":"string"}') set(a.name, v);
        else if (t === 'number' || t === 'boolean') set(a.name, { op: 'to-string', arg: v });
        else own(a, `${a.name} takes a string, a nullable string, a number or a boolean`);
      }
      set('width', size);
      set('height', size);
      set('class', klass);
      if (data.type === 'filled') set('fill', color);
      else {
        set('stroke-width', text('stroke', '2'));
        set('stroke', color);
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

export const tablerIconsSveltePack: Pack = {
  name: '@tabler/icons-svelte',
  version: '3.40.0',
  module: import.meta.url,
  export(pkg, imported) {
    const m = /^\.\/icons\/([a-z0-9-]+)$/.exec(pkg.subpath);
    if (!m)
      return `${ID} pack covers icon imports (@tabler/icons-svelte/icons/<name>), not ${pkg.subpath}`;
    if (imported !== 'default') return `${ID} pack: icon modules have a default export only`;
    const data = readIcon(pkg, m[1]);
    return typeof data === 'string' ? data : icon(data);
  },
};
