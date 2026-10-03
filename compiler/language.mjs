import ts from 'typescript';
import { literal } from './ir.mjs';
import { Diagnostic, location, hash } from './collect.mjs';
import { helperPattern, matchHelper, mappedExpression } from './mappings.mjs';
const operators = new Map([
  [ts.SyntaxKind.PlusToken, 'add'],
  [ts.SyntaxKind.MinusToken, 'sub'],
  [ts.SyntaxKind.AsteriskToken, 'mul'],
  [ts.SyntaxKind.EqualsEqualsEqualsToken, 'eq'],
  [ts.SyntaxKind.ExclamationEqualsEqualsToken, 'ne'],
  [ts.SyntaxKind.LessThanToken, 'lt'],
  [ts.SyntaxKind.LessThanEqualsToken, 'le'],
  [ts.SyntaxKind.GreaterThanToken, 'gt'],
  [ts.SyntaxKind.GreaterThanEqualsToken, 'ge'],
  [ts.SyntaxKind.AmpersandAmpersandToken, 'and'],
  [ts.SyntaxKind.BarBarToken, 'or'],
]);
export const unwrap = n => (ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n);
export function componentScriptFile(graph, component) {
  let file = component + '.ts',
    suffix = 0;
  while (graph.modules.has(file)) file = component + '.runic-' + ++suffix + '.ts';
  return file;
}
export function globalMathReference(ast, checker, mathSymbol) {
  const named = (n, name) => ts.isIdentifier(n ?? {}) && n.text === name;
  const declares = statements =>
    statements.some(s =>
      ts.isVariableStatement(s)
        ? s.declarationList.declarations.some(d => named(d.name, 'Math'))
        : ts.isFunctionDeclaration(s)
          ? named(s.name, 'Math')
          : ts.isImportDeclaration(s)
            ? named(s.importClause?.name, 'Math') ||
              named(s.importClause?.namedBindings?.name, 'Math') ||
              s.importClause?.namedBindings?.elements?.some(b => named(b.name, 'Math'))
            : false,
    );
  const setupShadow = declares(ast.statements);
  return (n, scope) => {
    if (n.text !== 'Math' || scope.has('Math')) return false;
    if (n.getSourceFile() === ast) return checker.getSymbolAtLocation(n) === mathSymbol;
    // Template expressions are parsed independently of the TS setup program.
    // Their lexical bindings include the whole setup and enclosing inline
    // function, including declarations later in a block and self names.
    if (setupShadow) return false;
    for (let p = n.parent; p && !ts.isSourceFile(p); p = p.parent)
      if (ts.isFunctionExpression(p) || ts.isArrowFunction(p) || ts.isFunctionDeclaration(p)) {
        if (
          named(p.name, 'Math') ||
          p.parameters.some(a => named(a.name, 'Math')) ||
          (ts.isBlock(p.body) && declares(p.body.statements))
        )
          return false;
      }
    return true;
  };
}
export function createExpressionLowerer({
  root,
  checker,
  mathSymbol,
  isMath = n => checker.getSymbolAtLocation(n) === mathSymbol,
  binding,
  accepted,
  ir,
  err,
  read,
  sourceOf = n => location(n, root),
}) {
  function pure(node, env) {
    const special = read?.(unwrap(node), env, pure);
    if (special) return special;
    const n = unwrap(node),
      source = sourceOf(n);
    const make = (op, type, fields) => ({ op, type, effect: 'pure', ...fields, source });
    const want = (e, type) => {
      if (e.type !== type)
        err(n, 'E_TYPE', `Expected ${type}, got ${e.type}; coercion is unsupported`);
      return e;
    };
    if (ts.isNumericLiteral(n)) {
      const v = Number(n.text);
      if (!Number.isInteger(v) || Math.abs(v) > 1e6)
        err(n, 'E_NUMBER', 'Only finite integer literals |x| <= 1000000 are accepted');
      return literal(v, source);
    }
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
      return literal(n.text, source);
    if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword)
      return literal(n.kind === ts.SyntaxKind.TrueKeyword, source);
    if (ts.isIdentifier(n)) {
      const b = binding(n, env);
      if (b?.kind === 'value') return b.value;
      err(n, 'E_EXPRESSION', `Unresolved or non-pure value ${n.text}`);
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'length') {
      const arg = pure(n.expression, env);
      if (arg.type === 'string') return make('utf16-length', 'number', { arg });
    }
    if (ts.isPrefixUnaryExpression(n)) {
      const arg = pure(n.operand, env);
      if (n.operator === ts.SyntaxKind.ExclamationToken)
        return make('not', 'boolean', { arg: want(arg, 'boolean') });
      if (n.operator === ts.SyntaxKind.MinusToken) {
        if (arg.op === 'literal' && arg.value === 0)
          err(n, 'E_NUMBER', 'Negative zero is unsupported');
        return make('neg', 'number', { arg: want(arg, 'number') });
      }
    }
    if (ts.isBinaryExpression(n)) {
      const op = operators.get(n.operatorToken.kind);
      if (!op) err(n, 'E_OPERATOR', `Unsupported operator ${n.operatorToken.getText()}`);
      const left = pure(n.left, env),
        right = pure(n.right, env);
      if (left.type !== right.type)
        err(n, 'E_TYPE', 'Mixed operand types and coercion are unsupported');
      if (['add', 'sub', 'mul', 'lt', 'le', 'gt', 'ge'].includes(op)) want(left, 'number');
      if (['and', 'or'].includes(op)) want(left, 'boolean');
      return make(op, ['add', 'sub', 'mul'].includes(op) ? 'number' : 'boolean', { left, right });
    }
    if (ts.isConditionalExpression(n)) {
      const test = want(pure(n.condition, env), 'boolean'),
        yes = pure(n.whenTrue, env),
        no = pure(n.whenFalse, env);
      if (yes.type !== no.type) err(n, 'E_TYPE', 'Conditional branches must have the same type');
      return make('select', yes.type, { test, yes, no });
    }
    if (ts.isCallExpression(n)) {
      if (n.typeArguments?.length)
        err(n, 'E_TYPESCRIPT', 'Type arguments do not establish runtime invariants');
      if (
        ts.isPropertyAccessExpression(n.expression) &&
        ts.isIdentifier(n.expression.expression) &&
        isMath(n.expression.expression, env) &&
        ['min', 'max'].includes(n.expression.name.text)
      ) {
        if (n.arguments.length !== 2)
          err(n, 'E_ARITY', 'Math.min/max require exactly two arguments');
        return make(n.expression.name.text, 'number', {
          args: n.arguments.map(a => want(pure(a, env), 'number')),
        });
      }
      if (ts.isIdentifier(n.expression)) {
        const b = binding(n.expression, env);
        if (b?.kind === 'function') {
          const pattern = helperPattern(b.fn, checker, mathSymbol);
          if (!pattern)
            err(
              n,
              'E_HELPER',
              'Helper is outside the bounded pure-expression grammar; effects, captured values and unsupported calls cannot be mapped',
            );
          const matching = accepted.filter(rule => matchHelper(b.fn, rule, checker, mathSymbol));
          if (!matching.length) {
            const error = new Diagnostic(
              'E_MAPPING',
              'No accepted mapping for this helper implementation; run discover explicitly',
              source,
            );
            error.discovery = {
              helper: b.fn.getText(),
              pattern,
              parameters: b.fn.parameters.length,
              source: location(b.fn, root),
              resolvedDependencies: ['typescript:lib.es5.Math'],
              context: {
                argumentSyntax: n.arguments.map(a => a.getText()),
                states: ir.states.map(s => ({ type: s.type, initial: s.initial })),
              },
            };
            throw error;
          }
          const args = n.arguments.map(a => want(pure(a, env), 'number'));
          const applicable = [];
          let preconditionFailure;
          for (const rule of matching) {
            try {
              applicable.push({ rule, expression: mappedExpression(rule, args, source) });
            } catch (e) {
              if (e.code === 'E_MAPPING_PRECONDITION') preconditionFailure = e;
              else throw e;
            }
          }
          if (!applicable.length) throw preconditionFailure;
          const alternatives = new Set(
            applicable.map(a =>
              hash({ value: a.expression.value, requirements: a.expression.requirements }),
            ),
          );
          if (alternatives.size > 1)
            err(
              n,
              'E_MAPPING_AMBIGUOUS',
              'Overlapping applicable rules have different lowerings or applicability obligations',
            );
          const { rule: matched, expression } = applicable[0];
          if (!ir.mappings.some(r => r.sha256 === matched.sha256))
            ir.mappings.push({ id: matched.id, version: matched.version, sha256: matched.sha256 });
          return expression;
        }
      }
      err(
        n,
        'E_CALL',
        'Unsupported call; calls require a pinned adapter or validated pure mapping',
      );
    }
    err(n, 'E_EXPRESSION', `Unsupported expression ${ts.SyntaxKind[n.kind]}`);
  }
  return pure;
}

export function languageProgram(sources, options = {}, virtual = new Map()) {
  // Every collected application file is loaded as an ES module, including
  // files with no import/export marker. Do not let TS treat those as globals.
  const settings = {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    moduleDetection: ts.ModuleDetectionKind.Force,
    ...options,
  };
  const host = ts.createCompilerHost(settings),
    baseRead = host.readFile,
    baseExists = host.fileExists;
  host.readFile = f => virtual.get(f) ?? baseRead(f);
  host.fileExists = f => virtual.has(f) || baseExists(f);
  const program = ts.createProgram(sources, settings, host);
  return { program, checker: program.getTypeChecker() };
}
