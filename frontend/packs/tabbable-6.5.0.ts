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
 * Whether `e` is the feature test of a native ResizeObserver (bits-ui's
 * `typeof ResizeObserver === "function" &&
 * ResizeObserver.toString().includes("[native code]")`): true, as the
 * runtime's is.
 */
function nativeResizeObserver(e: ts.Expression): boolean {
  e = skipParens(e);
  const K = ts.SyntaxKind;
  if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== K.AmpersandAmpersandToken) return false;
  const typeOf = skipParens(e.left);
  const native = skipParens(e.right);
  return (
    ts.isBinaryExpression(typeOf) &&
    typeOf.operatorToken.kind === K.EqualsEqualsEqualsToken &&
    typeOf.left.getText() === 'typeof ResizeObserver' &&
    typeOf.right.getText().replace(/'/g, '"') === '"function"' &&
    native.getText().replace(/\s+/g, '').replace(/'/g, '"') ===
      'ResizeObserver.toString().includes("[nativecode]")'
  );
}

/**
 * The options of a call: an object literal, or the object literal a
 * function without parameters returns (bits-ui's `getTabbableOptions()`).
 */
function optionsLiteral(e: ts.Expression, lower: Lowerer): ts.ObjectLiteralExpression | undefined {
  const o = skipParens(e);
  if (ts.isObjectLiteralExpression(o)) return o;
  if (!ts.isCallExpression(o) || o.arguments.length || !ts.isIdentifier(o.expression))
    return undefined;
  const decl = lower.checker.getSymbolAtLocation(o.expression)?.valueDeclaration;
  const body =
    decl && ts.isFunctionDeclaration(decl) && !decl.parameters.length ? decl.body : undefined;
  const only = body?.statements.length === 1 ? body.statements[0] : undefined;
  const r = only && ts.isReturnStatement(only) && only.expression && skipParens(only.expression);
  return r && ts.isObjectLiteralExpression(r) ? r : undefined;
}

/**
 * The `includeContainer` option of `tabbable(container, options)` and
 * `focusable(…)`: the options other than it are tabbable's defaults,
 * `getShadowRoot` (the runtime's document has no shadow roots) or
 * `displayCheck: "full"` (the default; also through the feature test of
 * a native ResizeObserver).
 */
function includeContainer(
  node: ts.CallExpression,
  options: ts.Expression | undefined,
  b: FnBuilder,
  lower: Lowerer,
  allowContainer = true,
): Expr {
  let value: Expr = { op: 'lit', value: false };
  if (!options) return value;
  const o = optionsLiteral(options, lower);
  if (!o)
    return lower.fail(
      options,
      'E_PACK',
      `${LABEL}: options are an object literal (or a function returning one)`,
    );
  for (const p of o.properties) {
    const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
    if (!key || !ts.isPropertyAssignment(p))
      return lower.fail(p, 'E_PACK', `${LABEL}: options have static keys and values`);
    if (key === 'includeContainer' && allowContainer)
      value = lower.coerce(p.initializer, b, 'boolean');
    else if (key === 'displayCheck') {
      const v = skipParens(p.initializer);
      const full = (x: ts.Expression) =>
        ts.isStringLiteralLike(skipParens(x)) &&
        (skipParens(x) as ts.StringLiteral).text === 'full';
      if (!(
        full(v) ||
        (ts.isConditionalExpression(v) && nativeResizeObserver(v.condition) && full(v.whenTrue))
      ))
        return lower.fail(p, 'E_PACK', `${LABEL}: displayCheck is covered as "full" (the default)`);
    } else if (key === 'getShadowRoot') {
      // `true` (or a function) only changes the walk into shadow roots,
      // which the runtime's document does not have.
      const v = skipParens(p.initializer);
      if (v.kind !== ts.SyntaxKind.TrueKeyword && v.kind !== ts.SyntaxKind.FalseKeyword)
        return lower.fail(p, 'E_PACK', `${LABEL}: getShadowRoot is a boolean literal`);
    } else
      return lower.fail(
        p,
        'E_PACK',
        `${LABEL}: option ${key} is not covered (includeContainer, getShadowRoot and displayCheck are)`,
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
            const [el, options, ...rest] = n.arguments;
            if (!el || rest.length)
              return l.fail(n, 'E_PACK', `${LABEL}: ${imported} takes an element and options`);
            // (Options checked as tabbable's defaults: no includeContainer.)
            includeContainer(n, options, b, l, false);
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
