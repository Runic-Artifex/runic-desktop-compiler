// `runic scan <project-dir>`: a feature census of a project's sources against
// the roadmap. It does not lower anything; it reports which constructs occur,
// how often and where, and the milestone that plans each one, so the next
// work can be prioritised by what real applications use.
import ts from 'typescript';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseSvelte } from 'svelte/compiler';

/** Feature → planned milestone (see docs/ROADMAP.md). "M1" = supported subset today. */
export const FEATURES = {
  // Language (M2)
  'js:class': 'M2',
  'js:async-function': 'M4',
  'js:await': 'M4',
  'js:for-loop': 'M2',
  'js:while-loop': 'M2',
  'js:switch': 'M2',
  'js:try-catch': 'M2',
  'js:throw': 'M2',
  'js:closure': 'M2',
  'js:object-literal': 'M2',
  'js:array-literal': 'M2',
  'js:destructuring': 'M2',
  'js:spread': 'M2',
  'js:template-literal': 'M2',
  'js:optional-chaining': 'M2',
  'js:nullish-coalescing': 'M2',
  'js:regex': 'M2',
  'js:let-mutation': 'M2',
  'js:generator': 'M6',
  'js:typeof': 'M2',
  'js:instanceof': 'M2',
  'js:delete': 'M2',
  'js:new': 'M2',
  'js:arrow-function': 'M1',
  'js:ternary': 'M1',
  'js:enum': 'M2',
  'js:interface-or-type': 'M1',
  // Built-ins (M2 unless noted)
  'api:Math': 'M1',
  'api:JSON': 'M2',
  'api:Array': 'M2',
  'api:Object': 'M2',
  'api:String': 'M2',
  'api:Number': 'M2',
  'api:Map': 'M2',
  'api:Set': 'M2',
  'api:WeakMap': 'M2',
  'api:Promise': 'M4',
  'api:Date': 'M5',
  'api:Intl': 'M5',
  'api:RegExp': 'M2',
  'api:Symbol': 'M6',
  'api:Proxy': 'M6',
  'api:structuredClone': 'M2',
  'api:crypto': 'M5',
  // Host services
  'host:setTimeout': 'M4',
  'host:setInterval': 'M4',
  'host:requestAnimationFrame': 'M4',
  'host:queueMicrotask': 'M4',
  'host:fetch': 'M5',
  'host:localStorage': 'M4',
  'host:sessionStorage': 'M5',
  'host:console': 'M5',
  'host:window': 'M5',
  'host:document': 'M5',
  'host:navigator': 'M5',
  'host:location': 'M5',
  'host:history': 'M5',
  'host:matchMedia': 'M5',
  'host:ResizeObserver': 'M5',
  'host:IntersectionObserver': 'M5',
  'host:MutationObserver': 'M6',
  'host:getBoundingClientRect': 'M5',
  'host:scrollTo': 'M5',
  'host:focus()': 'M3',
  'host:clipboard': 'M5',
  'host:AbortController': 'M4',
  'host:addEventListener': 'M5',
  'host:CustomEvent': 'M5',
  'host:URL': 'M5',
  'host:Blob': 'M6',
  // Svelte 5
  'svelte:$state': 'M1',
  'svelte:$state.raw': 'M2',
  'svelte:$state.snapshot': 'M2',
  'svelte:$derived': 'M1',
  'svelte:$derived.by': 'M1',
  'svelte:$effect': 'M4',
  'svelte:$effect.pre': 'M4',
  'svelte:$props': 'M3',
  'svelte:$bindable': 'M3',
  'svelte:$inspect': 'M5',
  'svelte:$host': 'M9',
  'svelte:lifecycle': 'M4',
  'svelte:context': 'M3',
  'svelte:store': 'M4',
  'svelte:transition': 'M5',
  'svelte:if': 'M1',
  'svelte:each': 'M3',
  'svelte:each-keyed': 'M3',
  'svelte:await': 'M4',
  'svelte:key': 'M3',
  'svelte:snippet': 'M3',
  'svelte:render': 'M3',
  'svelte:html': 'M6',
  'svelte:const': 'M2',
  'svelte:component': 'M3',
  'svelte:element': 'M3',
  'svelte:window': 'M5',
  'svelte:document': 'M5',
  'svelte:body': 'M5',
  'svelte:head': 'M6',
  'svelte:boundary': 'M4',
  'svelte:slot': 'M3',
  'svelte:bind:value': 'M1',
  'svelte:bind:checked': 'M5',
  'svelte:bind:group': 'M5',
  'svelte:bind:this': 'M3',
  'svelte:bind:other': 'M5',
  'svelte:bind:component-prop': 'M3',
  'svelte:on:legacy': 'M3',
  'svelte:event:click': 'M1',
  'svelte:event:input': 'M1',
  'svelte:event:keyboard': 'M5',
  'svelte:event:pointer': 'M5',
  'svelte:event:focus': 'M5',
  'svelte:event:scroll': 'M5',
  'svelte:event:submit': 'M5',
  'svelte:event:change': 'M5',
  'svelte:event:other': 'M5',
  'svelte:class-directive': 'M3',
  'svelte:style-directive': 'M3',
  'svelte:style-attr': 'M3',
  'svelte:action': 'M5',
  'svelte:spread': 'M3',
  'svelte:dynamic-attr': 'M1',
  'svelte:scoped-style': 'M6',
  'svelte:module-script': 'M3',
  // Meta-frameworks and packages
  'kit:$app': 'M6',
  'kit:route-file': 'M6',
  'import:package': 'M6',
  'import:svelte-component': 'M3',
  'import:css': 'M1',
  'import:asset': 'M5',
};

const SKIP = new Set([
  'node_modules',
  '.svelte-kit',
  'build',
  'dist',
  '.git',
  'test',
  'tests',
  '__tests__',
]);

async function* files(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (
      /\.(svelte|ts|js|tsx|jsx|mjs)$/.test(e.name) &&
      !/\.(test|spec|d)\.[jt]sx?$/.test(e.name)
    )
      yield p;
  }
}

// Null-prototype tables: identifiers such as `constructor` must not match.
const table = entries => Object.assign(Object.create(null), entries);
const GLOBALS = table({
  Math: 'api:Math',
  JSON: 'api:JSON',
  Array: 'api:Array',
  Object: 'api:Object',
  String: 'api:String',
  Number: 'api:Number',
  Map: 'api:Map',
  Set: 'api:Set',
  WeakMap: 'api:WeakMap',
  Promise: 'api:Promise',
  Date: 'api:Date',
  Intl: 'api:Intl',
  RegExp: 'api:RegExp',
  Symbol: 'api:Symbol',
  Proxy: 'api:Proxy',
  structuredClone: 'api:structuredClone',
  crypto: 'api:crypto',
  setTimeout: 'host:setTimeout',
  setInterval: 'host:setInterval',
  clearTimeout: 'host:setTimeout',
  clearInterval: 'host:setInterval',
  requestAnimationFrame: 'host:requestAnimationFrame',
  cancelAnimationFrame: 'host:requestAnimationFrame',
  queueMicrotask: 'host:queueMicrotask',
  fetch: 'host:fetch',
  localStorage: 'host:localStorage',
  sessionStorage: 'host:sessionStorage',
  console: 'host:console',
  window: 'host:window',
  document: 'host:document',
  navigator: 'host:navigator',
  location: 'host:location',
  history: 'host:history',
  matchMedia: 'host:matchMedia',
  ResizeObserver: 'host:ResizeObserver',
  IntersectionObserver: 'host:IntersectionObserver',
  MutationObserver: 'host:MutationObserver',
  AbortController: 'host:AbortController',
  CustomEvent: 'host:CustomEvent',
  URL: 'host:URL',
  Blob: 'host:Blob',
});
const MEMBERS = table({
  getBoundingClientRect: 'host:getBoundingClientRect',
  scrollTo: 'host:scrollTo',
  scrollIntoView: 'host:scrollTo',
  focus: 'host:focus()',
  addEventListener: 'host:addEventListener',
  clipboard: 'host:clipboard',
  matchMedia: 'host:matchMedia',
  setTimeout: 'host:setTimeout',
  setInterval: 'host:setInterval',
});
const RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);
const SVELTE_IMPORTS = table({
  onMount: 'svelte:lifecycle',
  onDestroy: 'svelte:lifecycle',
  beforeUpdate: 'svelte:lifecycle',
  afterUpdate: 'svelte:lifecycle',
  tick: 'svelte:lifecycle',
  setContext: 'svelte:context',
  getContext: 'svelte:context',
  hasContext: 'svelte:context',
  createContext: 'svelte:context',
});

class Census {
  constructor(root) {
    this.root = root;
    this.counts = new Map();
    this.packages = new Map();
    this.files = 0;
    this.lines = 0;
    this.errors = [];
    this.generated = [];
  }
  add(feature, file, line) {
    if (!(feature in FEATURES))
      feature = feature.startsWith('svelte:event:') ? 'svelte:event:other' : feature;
    const entry = this.counts.get(feature) ?? { count: 0, where: new Set() };
    entry.count++;
    if (entry.where.size < 5) entry.where.add(`${path.relative(this.root, file)}:${line}`);
    this.counts.set(feature, entry);
  }

  script(text, file, lineOffset = 0, kind = ts.ScriptKind.TS) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const line = n => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1 + lineOffset;
    const add = (f, n) => this.add(f, file, line(n));
    let depth = 0;
    const visit = n => {
      if (ts.isImportDeclaration(n)) {
        const spec = n.moduleSpecifier.text;
        if (spec.endsWith('.css')) add('import:css', n);
        else if (/\.(svg|png|jpe?g|woff2?|json)$/.test(spec)) add('import:asset', n);
        else if (spec.endsWith('.svelte')) add('import:svelte-component', n);
        else if (spec.startsWith('$app/')) add('kit:$app', n);
        else if (spec === 'svelte' || spec.startsWith('svelte/')) {
          for (const el of n.importClause?.namedBindings?.elements ?? []) {
            const name = (el.propertyName ?? el.name).text;
            if (SVELTE_IMPORTS[name]) add(SVELTE_IMPORTS[name], n);
          }
          if (spec === 'svelte/store') add('svelte:store', n);
          if (spec.startsWith('svelte/transition') || spec.startsWith('svelte/animate'))
            add('svelte:transition', n);
        } else if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('$lib')) {
          const pkg = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : spec.split('/')[0];
          this.packages.set(pkg, (this.packages.get(pkg) ?? 0) + 1);
          add('import:package', n);
        }
      }
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) add('js:class', n);
      if (
        ts.isFunctionDeclaration(n) ||
        ts.isArrowFunction(n) ||
        ts.isFunctionExpression(n) ||
        ts.isMethodDeclaration(n)
      ) {
        if (n.modifiers?.some(m => m.kind === ts.SyntaxKind.AsyncKeyword))
          add('js:async-function', n);
        if (n.asteriskToken) add('js:generator', n);
        if (ts.isArrowFunction(n)) add('js:arrow-function', n);
        if (depth > 0) add('js:closure', n);
      }
      if (ts.isAwaitExpression(n)) add('js:await', n);
      if (ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n))
        add('js:for-loop', n);
      if (ts.isWhileStatement(n) || ts.isDoStatement(n)) add('js:while-loop', n);
      if (ts.isSwitchStatement(n)) add('js:switch', n);
      if (ts.isTryStatement(n)) add('js:try-catch', n);
      if (ts.isThrowStatement(n)) add('js:throw', n);
      if (ts.isObjectLiteralExpression(n)) add('js:object-literal', n);
      if (ts.isArrayLiteralExpression(n)) add('js:array-literal', n);
      if (ts.isObjectBindingPattern(n) || ts.isArrayBindingPattern(n)) add('js:destructuring', n);
      if (ts.isSpreadElement(n) || ts.isSpreadAssignment(n)) add('js:spread', n);
      if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n))
        add('js:template-literal', n);
      if (n.questionDotToken) add('js:optional-chaining', n);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)
        add('js:nullish-coalescing', n);
      if (ts.isRegularExpressionLiteral(n)) add('js:regex', n);
      if (ts.isConditionalExpression(n)) add('js:ternary', n);
      if (ts.isTypeOfExpression(n)) add('js:typeof', n);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword)
        add('js:instanceof', n);
      if (ts.isDeleteExpression(n)) add('js:delete', n);
      if (ts.isNewExpression(n)) add('js:new', n);
      if (ts.isEnumDeclaration(n)) add('js:enum', n);
      if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n))
        add('js:interface-or-type', n);
      if (ts.isVariableDeclarationList(n) && n.flags & ts.NodeFlags.Let) add('js:let-mutation', n);
      if (ts.isCallExpression(n)) {
        const callee = n.expression.getText(sf);
        if (RUNES.has(callee)) add('svelte:' + callee, n);
      }
      if (
        (ts.isIdentifier(n) && GLOBALS[n.text] && !ts.isPropertyAccessExpression(n.parent)) ||
        (ts.isIdentifier(n) &&
          GLOBALS[n.text] &&
          ts.isPropertyAccessExpression(n.parent) &&
          n.parent.expression === n)
      ) {
        if (!(
          ts.isImportSpecifier(n.parent) ||
          (ts.isPropertyAssignment(n.parent) && n.parent.name === n)
        ))
          add(GLOBALS[n.text], n);
      }
      if (ts.isPropertyAccessExpression(n) && MEMBERS[n.name.text]) add(MEMBERS[n.name.text], n);
      const fn = ts.isFunctionLike(n);
      if (fn) depth++;
      ts.forEachChild(n, visit);
      if (fn) depth--;
    };
    visit(sf);
  }

  svelteTemplate(node, file, source) {
    const line = n => (n.start !== undefined ? source.slice(0, n.start).split('\n').length : 0);
    const add = (f, n) => this.add(f, file, line(n));
    const walk = n => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      switch (n.type) {
        case 'IfBlock':
          add('svelte:if', n);
          break;
        case 'EachBlock':
          add(n.key ? 'svelte:each-keyed' : 'svelte:each', n);
          break;
        case 'AwaitBlock':
          add('svelte:await', n);
          break;
        case 'KeyBlock':
          add('svelte:key', n);
          break;
        case 'SnippetBlock':
          add('svelte:snippet', n);
          break;
        case 'RenderTag':
          add('svelte:render', n);
          break;
        case 'HtmlTag':
          add('svelte:html', n);
          break;
        case 'ConstTag':
          add('svelte:const', n);
          break;
        case 'Component':
          add('svelte:component', n);
          break;
        case 'SvelteElement':
          add('svelte:element', n);
          break;
        case 'SvelteComponent':
          add('svelte:component', n);
          break;
        case 'SvelteWindow':
          add('svelte:window', n);
          break;
        case 'SvelteDocument':
          add('svelte:document', n);
          break;
        case 'SvelteBody':
          add('svelte:body', n);
          break;
        case 'SvelteHead':
          add('svelte:head', n);
          break;
        case 'SvelteBoundary':
          add('svelte:boundary', n);
          break;
        case 'SlotElement':
          add('svelte:slot', n);
          break;
        case 'BindDirective': {
          const parentIsComponent = false;
          add(
            ['value', 'checked', 'group', 'this'].includes(n.name)
              ? 'svelte:bind:' + n.name
              : parentIsComponent
                ? 'svelte:bind:component-prop'
                : 'svelte:bind:other',
            n,
          );
          break;
        }
        case 'OnDirective':
          add('svelte:on:legacy', n);
          break;
        case 'ClassDirective':
          add('svelte:class-directive', n);
          break;
        case 'StyleDirective':
          add('svelte:style-directive', n);
          break;
        case 'UseDirective':
          add('svelte:action', n);
          break;
        case 'TransitionDirective':
        case 'AnimateDirective':
          add('svelte:transition', n);
          break;
        case 'SpreadAttribute':
          add('svelte:spread', n);
          break;
        case 'Attribute': {
          if (/^on[a-z]+$/.test(n.name)) {
            const ev = n.name.slice(2);
            const group =
              ev === 'click'
                ? 'click'
                : ev === 'input'
                  ? 'input'
                  : /^key/.test(ev)
                    ? 'keyboard'
                    : /^(pointer|mouse|touch|drag|wheel)/.test(ev)
                      ? 'pointer'
                      : /^(focus|blur)/.test(ev)
                        ? 'focus'
                        : ev === 'scroll'
                          ? 'scroll'
                          : ev === 'submit'
                            ? 'submit'
                            : ev === 'change'
                              ? 'change'
                              : ev;
            add('svelte:event:' + group, n);
          } else if (n.name === 'style') add('svelte:style-attr', n);
          else if (
            Array.isArray(n.value)
              ? n.value.some(v => v.type === 'ExpressionTag')
              : n.value?.type === 'ExpressionTag'
          )
            add('svelte:dynamic-attr', n);
          break;
        }
      }
      for (const [k, v] of Object.entries(n))
        if (k !== 'parent' && v && typeof v === 'object') walk(v);
    };
    walk(node);
  }

  async file(file) {
    const text = await readFile(file, 'utf8');
    const rel0 = path.relative(this.root, file);
    // Generated Runic bridge clients are replaced natively (ARCHITECTURE D13),
    // so their constructs are not compilation work; count them separately.
    if (/^\s*\/\/ <auto-generated \/>/.test(text)) {
      this.generated.push(rel0);
      return;
    }
    this.files++;
    this.lines += text.split('\n').length;
    const rel = path.relative(this.root, file);
    if (/\/routes\/.*\+(page|layout)(\.server)?\.(svelte|ts|js)$/.test('/' + rel))
      this.add('kit:route-file', file, 1);
    try {
      if (file.endsWith('.svelte')) {
        const ast = parseSvelte(text, { modern: true });
        for (const s of [ast.instance, ast.module].filter(Boolean)) {
          if (s === ast.module) this.add('svelte:module-script', file, 1);
          const body = text.slice(s.content.start, s.content.end);
          const offset = text.slice(0, s.content.start).split('\n').length - 1;
          this.script(body, file, offset);
        }
        if (ast.css)
          this.add('svelte:scoped-style', file, text.slice(0, ast.css.start).split('\n').length);
        this.svelteTemplate(ast.fragment, file, text);
      } else {
        const kind = file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        this.script(text, file, 0, kind);
      }
    } catch (e) {
      this.errors.push({ file: rel, message: e.message.split('\n')[0] });
    }
  }

  report() {
    const features = [...this.counts.entries()]
      .map(([feature, { count, where }]) => ({
        feature,
        milestone: FEATURES[feature] ?? '?',
        count,
        where: [...where],
      }))
      .sort((a, b) => a.milestone.localeCompare(b.milestone) || b.count - a.count);
    const byMilestone = {};
    for (const f of features) {
      byMilestone[f.milestone] ??= { features: 0, occurrences: 0 };
      byMilestone[f.milestone].features++;
      byMilestone[f.milestone].occurrences += f.count;
    }
    return {
      schema: 1,
      root: this.root,
      files: this.files,
      lines: this.lines,
      byMilestone,
      packages: Object.fromEntries([...this.packages.entries()].sort((a, b) => b[1] - a[1])),
      features,
      generatedExcluded: this.generated,
      parseErrors: this.errors,
    };
  }
}

export async function scan(root) {
  const census = new Census(path.resolve(root));
  const src = path.join(census.root, 'src');
  const base = await readdir(src).then(
    () => src,
    () => census.root,
  );
  for await (const f of files(base)) await census.file(f);
  return census.report();
}

export function formatScan(r) {
  const lines = [`${r.files} files, ${r.lines} lines in ${r.root}`, ''];
  for (const [m, s] of Object.entries(r.byMilestone).sort())
    lines.push(
      `${m.padEnd(4)} ${String(s.features).padStart(3)} features ${String(s.occurrences).padStart(6)} occurrences`,
    );
  lines.push('', 'Features (milestone, count, first locations):');
  for (const f of r.features)
    lines.push(
      `  ${f.milestone.padEnd(4)} ${f.feature.padEnd(32)} ${String(f.count).padStart(5)}  ${f.where.slice(0, 2).join(', ')}`,
    );
  lines.push(
    '',
    'Packages: ' +
      Object.entries(r.packages)
        .map(([p, n]) => `${p} (${n})`)
        .join(', '),
  );
  if (r.generatedExcluded.length)
    lines.push(
      '',
      `Excluded ${r.generatedExcluded.length} generated bridge files (D13): ${r.generatedExcluded.join(', ')}`,
    );
  if (r.parseErrors.length)
    lines.push('', 'Parse errors: ' + r.parseErrors.map(e => `${e.file}: ${e.message}`).join('; '));
  return lines.join('\n');
}
