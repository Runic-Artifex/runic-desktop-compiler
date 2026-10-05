// Mapping pack for tabbable 6.5.0 (docs/design/M6-OVERLAYS.md): bits-ui's
// focus scope asks it for the tabbable and focusable elements of a
// container. The package walks the DOM and filters by focusability,
// visibility (getClientRects and computed styles), inertness, disabled
// fieldsets, radio groups and tabindex; the native runtime ports it over its
// own document (runic_runtime::tabbable, compared with the package in
// Chromium), behind the `focus.*` built-ins.
import ts from 'typescript';
import type { Pack } from '../packs.ts';
import type { Expr } from '../ir.ts';
import { skipParens, type FnBuilder, type Lowerer } from '../language.ts';

const LABEL = 'tabbable@6.5.0 pack';

/**
 * The `includeContainer` option of `tabbable(container, options)` and
 * `focusable(…)`: the options other than it are tabbable's defaults, or
 * `getShadowRoot` (the runtime's document has no shadow roots).
 */
function includeContainer(
  node: ts.CallExpression,
  options: ts.Expression | undefined,
  b: FnBuilder,
  lower: Lowerer,
): Expr {
  let value: Expr = { op: 'lit', value: false };
  if (!options) return value;
  const o = skipParens(options);
  if (!ts.isObjectLiteralExpression(o))
    return lower.fail(options, 'E_PACK', `${LABEL}: options are an object literal`);
  for (const p of o.properties) {
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    if (!key || !ts.isPropertyAssignment(p))
      return lower.fail(p, 'E_PACK', `${LABEL}: options have static keys and values`);
    if (key === 'includeContainer') value = lower.coerce(p.initializer, b, 'boolean');
    else if (key === 'getShadowRoot') {
      // `true` (or a function) only changes the walk into shadow roots,
      // which the runtime's document does not have.
      const v = skipParens(p.initializer);
      if (v.kind !== ts.SyntaxKind.TrueKeyword && v.kind !== ts.SyntaxKind.FalseKeyword)
        return lower.fail(p, 'E_PACK', `${LABEL}: getShadowRoot is a boolean literal`);
    } else
      return lower.fail(
        p,
        'E_PACK',
        `${LABEL}: option ${key} is not covered (includeContainer and getShadowRoot are)`,
      );
  }
  void node;
  return value;
}

export const tabbablePack: Pack = {
  name: 'tabbable',
  version: '6.5.0',
  module: import.meta.url,
  export(pkg, imported) {
    if (pkg.subpath !== '.') return `${LABEL} covers the main module, not ${pkg.subpath}`;
    switch (imported) {
      case 'tabbable':
      case 'focusable':
        return {
          kind: 'function',
          call: (n, b, l) => {
            const [container, options, ...rest] = n.arguments;
            if (!container || rest.length)
              return l.fail(n, 'E_PACK', `${LABEL}: ${imported} takes a container and options`);
            return {
              op: 'builtin',
              name: imported === 'tabbable' ? 'focus.tabbables' : 'focus.focusables',
              args: [l.coerce(container, b, 'element'), includeContainer(n, options, b, l)],
              type: { array: 'element' },
            };
          },
        };
      case 'isTabbable':
      case 'isFocusable':
        return {
          kind: 'function',
          call: (n, b, l) => {
            const [el, options] = n.arguments;
            if (!el || n.arguments.length > 1 || options)
              return l.fail(n, 'E_PACK', `${LABEL}: ${imported} takes an element (no options)`);
            return {
              op: 'builtin',
              name: imported === 'isTabbable' ? 'focus.is-tabbable' : 'focus.is-focusable',
              args: [l.coerce(el, b, 'element')],
              type: 'boolean',
            };
          },
        };
    }
    return `${LABEL} covers tabbable, focusable, isTabbable and isFocusable, not ${imported}`;
  },
};
