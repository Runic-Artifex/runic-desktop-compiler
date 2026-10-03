// Vue 3.5 <script setup> adapter on the shared language layer
// (docs/design/M2-VALUES.md, docs/design/M3-COMPONENTS.md). Framework
// semantics only:
// - ref → deep-tracked cell read/written through `.value`; computed → derived;
//   reads observe earlier writes immediately;
// - templates unwrap refs (typed through a synthetic template function);
// - interpolation follows toDisplayString; bindings follow Vue 3 attribute
//   coercion; inline handlers are statements with `$event`;
// - child SFCs → component instances (children first); `defineProps<T>()`
//   (destructured or as an object, optionally `withDefaults`) → prop cells;
//   `defineEmits<T>()` → function-typed `on<Event>` prop cells that default to
//   a no-op; `defineModel<T>()` → a prop cell written through `.value`, bound
//   by the parent's `v-model`; `v-for` → lists.
import ts from 'typescript';
import path from 'node:path';
import { Diagnostic, hash } from '../../compiler/collect.mjs';
import type {
  Cell,
  Component,
  Expr,
  Handler,
  Listener,
  Local,
  Node,
  Program,
  Stmt,
  Type,
} from '../ir.ts';
import { FnBuilder, Lowerer, isAssignmentOperator, skipParens, type Hooks } from '../language.ts';
import { createProgram, VUE } from '../program.ts';
import { sameType, TypeMapper } from '../types.ts';
import { lowerModules } from '../modules.ts';
import { arrayElement, maybeInner } from '../irtype.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VNode = any;

const TAGS = new Set([
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'button',
  'input',
  'main',
  'article',
  'section',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'li',
  'strong',
  'em',
  'small',
  'b',
  'i',
  'code',
  'pre',
  'br',
  'hr',
]);
const BOOLEAN_ATTRS = new Set([
  'disabled',
  'readonly',
  'hidden',
  'required',
  'checked',
  'autofocus',
  'multiple',
]);
const MACROS = new Set(['defineProps', 'withDefaults', 'defineEmits', 'defineModel']);
// compiler-core node types
const ELEMENT = 1;
const TEXT = 2;
const COMMENT = 3;
const INTERPOLATION = 5;
const ATTRIBUTE = 6;
const DIRECTIVE = 7;
// compiler-core element tag types
const PLAIN = 0;
const COMPONENT_TAG = 1;

interface Graph {
  root: string;
  entry: string;
  hash: string;
  css: string;
  assets: { path: string; sha256: string; bytes: number; mime: string }[];
  manifest: unknown;
  config: { title: string; renderer?: 'cpu' | 'gpu' };
  modules: Map<string, { code: string; imports: { specifier: string; resolved: string }[] }>;
  tooling: {
    packages: Record<string, string>;
    compiler: { parse: (src: string, opts: object) => { descriptor: VNode; errors: unknown[] } };
  };
}

type Source = { file: string; line: number; column: number };

function locate(text: string, offset: number, file: string): Source {
  const lines = text.slice(0, offset).split('\n');
  return { file, line: lines.length, column: lines.at(-1)!.length + 1 };
}

const camelize = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const hyphenate = (s: string) => s.replace(/\B([A-Z])/g, '-$1').toLowerCase();
/** The prop that carries a listener for `event` (`remove` → `onRemove`). */
const handlerKey = (event: string) => 'on' + capitalize(camelize(event));
/** Vue's method-handler test: a member path is called with the event arguments. */
const isSimplePath = (code: string) => /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(code.trim());
/** Vue's function-expression test (`fnExpRE`). */
const isFunctionExpression = (code: string) =>
  /^\s*(async\s*)?(\([^)]*?\)|[\w$_]+)\s*(:[^=]+)?=>|^\s*(async\s+)?function(?:\s+[\w$]+)?\s*\(/.test(
    code,
  );

/** Props, emits and models a component declares (from its script syntax). */
interface Macros {
  props?: {
    /** Type argument text of defineProps (resolves in the component's module). */
    typeText: string;
    names: string[];
    /** `const props = defineProps<T>()`: the variable. */
    variable?: string;
  };
  emits?: {
    typeText: string;
    variable?: string;
    events: { key: string; params: string; arity: number }[];
  };
  models: { prop: string; typeText: string; nullable: boolean }[];
  /** Top-level setup names the template can see (refs unwrapped). */
  topNames: string[];
}

/** An SFC and its virtual TypeScript module. */
interface Unit {
  file: string;
  rel: string;
  original: string;
  descriptor: VNode;
  index: number;
  virtual: string;
  synthetic: string;
  scriptLength: number;
  scriptStart: number;
  segments: { synth: number; orig: number; length: number }[];
  /** Synthetic [start, end) of each template expression (keyed by AST node). */
  starts: Map<object, [number, number]>;
  /** Child components by local name. */
  children: Map<string, string>;
  macros: Macros;
}

/** Members of a props/emits type: a type literal, intersection or local interface/alias. */
function typeMembers(
  sf: ts.SourceFile,
  node: ts.TypeNode,
  fail: (n: ts.Node, message: string) => never,
): ts.TypeElement[] {
  if (ts.isTypeLiteralNode(node)) return [...node.members];
  if (ts.isParenthesizedTypeNode(node)) return typeMembers(sf, node.type, fail);
  if (ts.isIntersectionTypeNode(node)) return node.types.flatMap(t => typeMembers(sf, t, fail));
  if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments)
    return namedMembers(sf, node.typeName.text, node, fail);
  return fail(
    node,
    'Declare the type as a type literal or a local interface/type alias (imported types are planned for later)',
  );
}

function namedMembers(
  sf: ts.SourceFile,
  name: string,
  at: ts.Node,
  fail: (n: ts.Node, message: string) => never,
): ts.TypeElement[] {
  for (const s of sf.statements) {
    if (ts.isInterfaceDeclaration(s) && s.name.text === name && !s.typeParameters) {
      const inherited = (s.heritageClauses ?? []).flatMap(h =>
        h.types.flatMap(t =>
          ts.isIdentifier(t.expression) && !t.typeArguments
            ? namedMembers(sf, t.expression.text, t, fail)
            : fail(t, 'Interfaces may extend only local interfaces'),
        ),
      );
      return [...inherited, ...s.members];
    }
    if (ts.isTypeAliasDeclaration(s) && s.name.text === name && !s.typeParameters)
      return typeMembers(sf, s.type, fail);
  }
  return fail(
    at,
    'Declare the type as a type literal or a local interface/type alias (imported types are planned for later)',
  );
}

function memberName(m: ts.TypeElement): string | undefined {
  const n = m.name;
  if (n && (ts.isIdentifier(n) || ts.isStringLiteral(n))) return n.text;
  return undefined;
}

export async function lowerVue(graph: Graph): Promise<{ ir: Program }> {
  const { root } = graph;
  const fail = (code: string, message: string, source?: Source): never => {
    throw new Diagnostic(code, message, source);
  };
  const rel = (f: string) => path.relative(root, f);

  // --- Bootstrap: createApp(App).mount('#root') ---
  const entry = ts.createSourceFile(
    graph.entry,
    graph.modules.get(graph.entry)!.code,
    ts.ScriptTarget.Latest,
    true,
  );
  let rootFile: string | undefined;
  const local = new Map<string, string>();
  let createName: string | undefined;
  let bootstrap: ts.Expression | undefined;
  for (const stmt of entry.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
      const edge = graph.modules.get(graph.entry)!.imports.find(i => i.specifier === spec);
      const clause = stmt.importClause;
      if (!clause) continue;
      if (spec === 'vue' && clause.namedBindings && ts.isNamedImports(clause.namedBindings))
        for (const b of clause.namedBindings.elements) {
          if ((b.propertyName ?? b.name).text !== 'createApp')
            fail('E_CAPABILITY', 'Vue entry only imports createApp');
          createName = b.name.text;
        }
      else if (edge?.resolved.endsWith('.vue') && clause.name)
        local.set(clause.name.text, edge.resolved);
      else fail('E_IMPORT', 'Entry requires a local default SFC import and Vue createApp');
    } else if (ts.isExpressionStatement(stmt) && !bootstrap) bootstrap = stmt.expression;
    else fail('E_BOOTSTRAP', 'Vue entry may only import its component/CSS and mount once');
  }
  const mount =
    bootstrap &&
    ts.isCallExpression(bootstrap) &&
    ts.isPropertyAccessExpression(bootstrap.expression)
      ? bootstrap.expression
      : undefined;
  const create = mount && ts.isCallExpression(mount.expression) ? mount.expression : undefined;
  if (
    create &&
    ts.isIdentifier(create.expression) &&
    create.expression.text === createName &&
    ts.isIdentifier(create.arguments[0])
  )
    rootFile = local.get(create.arguments[0].text);
  if (!rootFile || mount!.name.text !== 'mount')
    fail('E_BOOTSTRAP', 'Expected createApp(App).mount("#root")');

  // --- Components: parse and analyse each SFC (children first) ---
  const units = new Map<string, Unit>();
  const order: Unit[] = [];
  const parse = (file: string, from?: Source): Unit => {
    const original = graph.modules.get(file)?.code;
    if (original === undefined)
      return fail('E_IMPORT', `Component ${rel(file)} was not collected`, from);
    const fileRel = rel(file);
    const { descriptor, errors } = graph.tooling.compiler.parse(original, { filename: file });
    if (errors.length) fail('E_PARSE', String(errors[0]), { file: fileRel, line: 1, column: 1 });
    if (
      !descriptor.scriptSetup ||
      descriptor.script ||
      !descriptor.template ||
      descriptor.styles.length ||
      descriptor.customBlocks.length
    )
      fail(
        'E_SFC',
        'Use one template and <script setup> (component styles are M6; import CSS instead)',
        { file: fileRel, line: 1, column: 1 },
      );
    if (descriptor.scriptSetup.attrs?.generic)
      fail(
        'E_SFC',
        'Generic components are planned for a later milestone',
        locate(original, descriptor.scriptSetup.loc.start.offset, fileRel),
      );
    const script: string = descriptor.scriptSetup.content;
    const scriptStart: number = descriptor.scriptSetup.loc.start.offset;
    const sf = ts.createSourceFile(file + '.ts', script, ts.ScriptTarget.Latest, true);
    const at = (n: ts.Node) => locate(original, scriptStart + n.getStart(sf), fileRel);
    const synFail =
      (code: string) =>
      (n: ts.Node, message: string): never =>
        fail(code, message, at(n));
    const text = (n: ts.Node) => script.slice(n.getStart(sf), n.end);
    const macroOf = (e: ts.Expression | undefined) => {
      const c = e && skipParens(e);
      return c &&
        ts.isCallExpression(c) &&
        ts.isIdentifier(c.expression) &&
        MACROS.has(c.expression.text)
        ? { name: c.expression.text, call: c }
        : undefined;
    };
    const children = new Map<string, string>();
    const macros: Macros = { models: [], topNames: [] };
    const props = (call: ts.CallExpression, variable?: ts.BindingName) => {
      if (macros.props) fail('E_PROPS', 'defineProps may be called once', at(call));
      let define = call;
      if ((call.expression as ts.Identifier).text === 'withDefaults') {
        const inner = call.arguments[0] && macroOf(call.arguments[0]);
        if (inner?.name !== 'defineProps')
          fail('E_PROPS', 'withDefaults wraps defineProps<T>()', at(call));
        if (!variable) fail('E_PROPS', 'Assign withDefaults(...) to a variable', at(call));
        if (ts.isObjectBindingPattern(variable!))
          fail(
            'E_PROPS',
            'withDefaults with destructured props is invalid in Vue; use destructure defaults',
            at(call),
          );
        define = inner!.call;
      }
      const typeArg = define.typeArguments?.[0];
      if (!typeArg || define.arguments.length)
        fail(
          'E_PROPS',
          'Declare props with a type: defineProps<{ ... }>() (runtime declarations are unsupported)',
          at(define),
        );
      const names: string[] = [];
      for (const m of typeMembers(sf, typeArg!, synFail('E_PROPS'))) {
        const name = memberName(m);
        if (!name || !(ts.isPropertySignature(m) || ts.isMethodSignature(m)))
          fail('E_PROPS', 'Props must be named properties', at(m));
        names.push(name!);
      }
      macros.props = {
        typeText: text(typeArg!),
        names,
        ...(variable && ts.isIdentifier(variable) ? { variable: variable.text } : {}),
      };
    };
    const emits = (call: ts.CallExpression, variable?: ts.BindingName) => {
      if (macros.emits) fail('E_EMITS', 'defineEmits may be called once', at(call));
      const typeArg = call.typeArguments?.[0];
      if (!typeArg || call.arguments.length)
        fail(
          'E_EMITS',
          'Declare emits with a type: defineEmits<{ remove: [id: number] }>() (runtime declarations are unsupported)',
          at(call),
        );
      if (variable && !ts.isIdentifier(variable))
        fail(
          'E_EMITS',
          'Assign defineEmits to a variable: const emit = defineEmits<…>()',
          at(call),
        );
      const events: { key: string; params: string; arity: number }[] = [];
      const add = (event: string, params: string[], where: ts.Node) => {
        const key = handlerKey(event);
        if (events.some(e => e.key === key))
          fail(
            'E_EMITS',
            `Event ${event} is declared twice (overloads are unsupported)`,
            at(where),
          );
        events.push({ key, params: `(${params.join(', ')})`, arity: params.length });
      };
      for (const m of typeMembers(sf, typeArg!, synFail('E_EMITS'))) {
        if (ts.isCallSignatureDeclaration(m)) {
          const [first, ...rest] = m.parameters;
          const t = first?.type;
          const literals = t && ts.isUnionTypeNode(t) ? t.types : t ? [t] : [];
          const names = literals.map(l =>
            ts.isLiteralTypeNode(l) && ts.isStringLiteral(l.literal) ? l.literal.text : undefined,
          );
          if (!names.length || names.some(n => n === undefined))
            fail(
              'E_EMITS',
              "Emit signatures start with the event name: (e: 'remove', …): void",
              at(m),
            );
          for (const p of rest)
            if (!p.type || p.dotDotDotToken)
              fail(
                'E_EMITS',
                'Emit parameters need a type (rest parameters are unsupported)',
                at(p),
              );
          for (const n of names) add(n!, rest.map(text), m);
        } else if (
          ts.isPropertySignature(m) &&
          memberName(m) &&
          m.type &&
          ts.isTupleTypeNode(m.type)
        ) {
          const params = m.type.elements.map((el, i) => {
            if (ts.isNamedTupleMember(el)) {
              if (el.dotDotDotToken) fail('E_EMITS', 'Rest emit arguments are unsupported', at(el));
              return `${el.name.text}${el.questionToken ? '?' : ''}: ${text(el.type)}`;
            }
            if (ts.isRestTypeNode(el))
              return fail('E_EMITS', 'Rest emit arguments are unsupported', at(el));
            if (ts.isOptionalTypeNode(el)) return `a${i}?: ${text(el.type)}`;
            return `a${i}: ${text(el)}`;
          });
          add(memberName(m)!, params, m);
        } else
          fail(
            'E_EMITS',
            "Declare each event as `name: [arg: T]` or `(e: 'name', arg: T): void`",
            at(m),
          );
      }
      macros.emits = {
        typeText: text(typeArg!),
        ...(variable ? { variable: (variable as ts.Identifier).text } : {}),
        events,
      };
    };
    const model = (call: ts.CallExpression, variable: ts.BindingName) => {
      if (!ts.isIdentifier(variable))
        fail(
          'E_MODEL',
          'Assign defineModel to a variable: const model = defineModel<T>()',
          at(call),
        );
      const typeArg = call.typeArguments?.[0];
      if (!typeArg)
        fail('E_MODEL', 'defineModel needs a type argument: defineModel<string>()', at(call));
      let [nameArg, options] = call.arguments;
      if (nameArg && !ts.isStringLiteral(nameArg)) [nameArg, options] = [undefined!, nameArg];
      const prop = nameArg ? (nameArg as ts.StringLiteral).text : 'modelValue';
      if (macros.models.some(m => m.prop === prop))
        fail('E_MODEL', `Model ${prop} is declared twice`, at(call));
      let nullable = true;
      if (options) {
        if (!ts.isObjectLiteralExpression(options))
          fail('E_MODEL', 'defineModel options must be an object literal', at(options));
        for (const p of (options as ts.ObjectLiteralExpression).properties) {
          const key = p.name && ts.isIdentifier(p.name) ? p.name.text : undefined;
          if (!ts.isPropertyAssignment(p) || (key !== 'default' && key !== 'required'))
            fail(
              'E_MODEL',
              'defineModel supports the default and required options (get/set transformers and local are planned for later)',
              at(p),
            );
          if (
            key === 'default' ||
            (p as ts.PropertyAssignment).initializer.kind === ts.SyntaxKind.TrueKeyword
          )
            nullable = false;
        }
      }
      macros.models.push({ prop, typeText: text(typeArg!), nullable });
    };
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (!spec.endsWith('.vue')) continue;
        const edge = graph.modules.get(file)!.imports.find(i => i.specifier === spec);
        const name = stmt.importClause?.name?.text;
        if (!edge || !name || stmt.importClause?.namedBindings || stmt.importClause?.isTypeOnly)
          fail('E_IMPORT', 'Import components as `import Name from "./Name.vue"`', at(stmt));
        children.set(name!, edge!.resolved);
        continue;
      }
      if (ts.isExpressionStatement(stmt)) {
        const m = macroOf(stmt.expression);
        if (m?.name === 'defineProps' || m?.name === 'withDefaults') props(m.call);
        else if (m?.name === 'defineEmits') emits(m.call);
        else if (m) fail('E_MODEL', 'Assign defineModel to a variable', at(stmt));
        continue;
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) macros.topNames.push(stmt.name.text);
      if (!ts.isVariableStatement(stmt)) continue;
      for (const d of stmt.declarationList.declarations) {
        const m = macroOf(d.initializer);
        if (m?.name === 'defineProps' || m?.name === 'withDefaults') props(m.call, d.name);
        else if (m?.name === 'defineEmits') emits(m.call, d.name);
        else if (m?.name === 'defineModel') model(m.call, d.name);
        if (ts.isIdentifier(d.name)) macros.topNames.push(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) && m)
          for (const el of d.name.elements)
            if (ts.isIdentifier(el.name)) macros.topNames.push(el.name.text);
      }
    }
    return {
      file,
      rel: fileRel,
      original,
      descriptor,
      index: -1,
      virtual: file + '.__runic.ts',
      synthetic: '',
      scriptLength: script.length,
      scriptStart,
      segments: [],
      starts: new Map(),
      children,
      macros,
    };
  };
  const visit = (file: string, stack: string[], from?: Source) => {
    if (stack.includes(file))
      fail('E_COMPONENT', 'Recursive components are planned for a later milestone', from);
    if (units.has(file)) return;
    const u = parse(file, from);
    units.set(file, u);
    for (const [, child] of u.children)
      visit(child, [...stack, file], { file: u.rel, line: 1, column: 1 });
    u.index = order.length;
    order.push(u);
  };
  visit(rootFile!, []);
  /** The local name of the child component a template tag refers to. */
  const childName = (u: Unit, tag: string): string | undefined => {
    if (u.children.has(tag)) return tag;
    const pascal = capitalize(camelize(tag));
    return u.children.has(pascal) ? pascal : undefined;
  };
  const dir = (n: VNode, name: string): VNode | undefined =>
    n.props.find((p: VNode) => p.type === DIRECTIVE && p.name === name);

  // --- Virtual modules: script, then the template as typed statements ---
  for (const u of order) {
    const script = u.original.slice(u.scriptStart, u.scriptStart + u.scriptLength);
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const { macros } = u;
    const top = macros.topNames;
    let s =
      script +
      `\nfunction __runic_template(__u = { ${top.map(n => `${n}: __runic_unref(${n})`).join(', ')} }) {\n` +
      `const { ${top.join(', ')} } = __u;\n`;
    const extra = (macros.props?.names ?? []).filter(n => !top.includes(n));
    if (extra.length) {
      s += `const __runic_P = ${macros.props!.variable ?? `defineProps<${macros.props!.typeText}>()`};\n`;
      s += `const { ${extra.join(', ')} } = __runic_P;\n`;
    }
    if (macros.emits)
      s += `const $emit = ${macros.emits.variable ?? `defineEmits<${macros.emits.typeText}>()`};\n`;
    const copy = (orig: number, code: string) => {
      u.segments.push({ synth: s.length, orig, length: code.length });
      s += code;
    };
    /** Copy an expression node, recording its synthetic span. */
    const mark = (e: VNode) => {
      const start = s.length;
      copy(e.loc.start.offset, e.content);
      u.starts.set(e, [start, s.length]);
    };
    const inline = (e: VNode) => {
      s += '(';
      mark(e);
      s += ')';
    };
    /** A handler expression: method paths and functions as is, statements wrapped. */
    const handler = (e: VNode, params: string) => {
      const code: string = e.content;
      if (isSimplePath(code) || isFunctionExpression(code)) return inline(e);
      s += '(';
      const start = s.length;
      s += `(${params}) => { `;
      copy(e.loc.start.offset, code);
      s += ' }';
      u.starts.set(e, [start, s.length]);
      s += ')';
    };
    const walk = (n: VNode) => {
      if (n.type === INTERPOLATION) {
        inline(n.content);
        s += ';\n';
        return;
      }
      if (n.type !== ELEMENT) return;
      const vFor = dir(n, 'for');
      if (vFor) {
        const r = vFor.forParseResult;
        if (!r?.source || !r.value)
          fail('E_TEMPLATE', 'Unsupported v-for expression (use `item in items`)', loc(vFor));
        s += 'for (const ';
        mark(r.value);
        s += ' of (';
        mark(r.source);
        s += ')) {\n';
        if (r.key) {
          s += 'const ';
          mark(r.key);
          s += ': number = 0;\n';
        }
      }
      const name = n.tagType === COMPONENT_TAG ? childName(u, n.tag) : undefined;
      if (name) {
        const child = units.get(u.children.get(name)!)!;
        // Props are checked against the child's props type (typing inline callbacks).
        s += `((__p: __RunicProps_${name}) => 0)({\n`;
        for (const p of n.props) {
          if (p.type !== DIRECTIVE || !p.exp || (p.arg && !p.arg.isStatic)) continue;
          if (p.name === 'bind' && p.arg && p.arg.content !== 'key') {
            s += `${JSON.stringify(camelize(p.arg.content))}: `;
            inline(p.exp);
            s += ',\n';
          } else if (p.name === 'on' && p.arg) {
            const key = handlerKey(p.arg.content);
            const arity = child.macros.emits?.events.find(e => e.key === key)?.arity;
            s += `${JSON.stringify(key)}: `;
            handler(
              p.exp,
              arity === undefined
                ? '$event: any'
                : Array.from({ length: arity }, (_, i) => (i ? `__runic_a${i}` : '$event')).join(
                    ', ',
                  ),
            );
            s += ',\n';
          } else if (p.name === 'model') {
            const m: string = p.arg?.content ?? 'modelValue';
            s += `${JSON.stringify(m)}: `;
            inline(p.exp);
            s += `,\n${JSON.stringify('onUpdate:' + m)}: (`;
            const start = s.length;
            s += '($event) => { ';
            copy(p.exp.loc.start.offset, p.exp.content);
            s += ' = $event }';
            u.starts.set(p, [start, s.length]);
            s += '),\n';
          }
        }
        s += '});\n';
        for (const p of n.props)
          if (
            p.type === DIRECTIVE &&
            p.exp &&
            (['if', 'else-if'].includes(p.name) || (p.name === 'bind' && p.arg?.content === 'key'))
          ) {
            inline(p.exp);
            s += ';\n';
          }
      } else {
        for (const p of n.props) {
          if (p.type !== DIRECTIVE || !p.exp || p.name === 'for') continue;
          if (p.name === 'on') handler(p.exp, '$event: any');
          else inline(p.exp);
          s += ';\n';
        }
        for (const c of n.children ?? []) walk(c);
      }
      if (vFor) s += '}\n';
    };
    for (const c of u.descriptor.template.ast.children) walk(c);
    s += '}\n';
    for (const [name, file] of u.children)
      s += `import type { __RunicProps as __RunicProps_${name} } from ${JSON.stringify(units.get(file)!.virtual)};\n`;
    const events = macros.emits?.events ?? [];
    s += `type __RunicEmits = { ${events.map(e => `${JSON.stringify(e.key)}: ${e.params} => void;`).join(' ')} };\n`;
    s += `type __RunicModels = { ${macros.models
      .map(m => {
        const t = m.nullable ? `(${m.typeText}) | undefined` : m.typeText;
        return `${JSON.stringify(m.prop)}: ${t}; ${JSON.stringify('onUpdate:' + m.prop)}: (value: ${t}) => void;`;
      })
      .join(' ')} };\n`;
    s += `export type __RunicProps = (${macros.props?.typeText ?? '{}'}) & Partial<__RunicEmits> & Partial<__RunicModels>;\n`;
    u.synthetic = s;
  }
  const files = new Map<string, string>();
  for (const u of order) files.set(u.virtual, u.synthetic);
  for (const [id, m] of graph.modules)
    if (/\.(ts|js|mjs)$/.test(id) && id.startsWith(root + path.sep)) files.set(id, m.code);
  const program = createProgram(files, [VUE]);
  const unitOf = new Map<ts.SourceFile, Unit>();
  for (const u of order) unitOf.set(program.getSourceFile(u.virtual)!, u);
  const sourceAt = (u: Unit, pos: number): Source => {
    if (pos < u.scriptLength) return locate(u.original, u.scriptStart + pos, u.rel);
    const seg = u.segments.find(s => pos >= s.synth && pos <= s.synth + s.length);
    return seg
      ? locate(u.original, seg.orig + (pos - seg.synth), u.rel)
      : { file: u.rel, line: 1, column: 1 };
  };
  const sourceOf = (n: ts.Node): Source => {
    const f = n.getSourceFile();
    const u = unitOf.get(f);
    if (!u) {
      const p = f.getLineAndCharacterOfPosition(n.getStart(f));
      return { file: rel(f.fileName), line: p.line + 1, column: p.character + 1 };
    }
    return sourceAt(u, n.getStart(f));
  };
  for (const u of order) {
    const syntax = program.getSyntacticDiagnostics(program.getSourceFile(u.virtual)!)[0];
    if (syntax)
      fail(
        'E_PARSE',
        ts.flattenDiagnosticMessageText(syntax.messageText, '\n'),
        syntax.start !== undefined ? sourceAt(u, syntax.start) : undefined,
      );
  }
  const tsFail = (n: ts.Node, code: string, message: string): never =>
    fail(code, message, sourceOf(n));
  const checker = program.getTypeChecker();
  const types = new TypeMapper(checker, tsFail);

  // --- Lowering state (one component at a time) ---
  let cells: Cell[] = [];
  /** Cells of defineModel refs (writable props). */
  let modelCells = new Set<number>();
  /** Model cells written so far in each function (reads after that are stale in Vue). */
  let written = new Map<FnBuilder, Set<number>>();
  /** Symbols of the component's emit function (`emit`, template `emit`/`$emit`). */
  let emitSymbols = new Set<ts.Symbol>();
  /** Emit prop cells by handler key (`onRemove`). */
  let emitCells = new Map<string, number>();
  const vueCall = (e: ts.Expression | undefined): string | undefined => {
    if (!e || !ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return undefined;
    const s = checker.getSymbolAtLocation(e.expression);
    const decl =
      s && (s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s).declarations?.[0];
    return decl && decl.getSourceFile().fileName === VUE ? e.expression.text : undefined;
  };
  const isPropsMember = (e: ts.Expression, lower: Lowerer) => {
    e = skipParens(e);
    return (
      (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) &&
      ts.isIdentifier(e.expression) &&
      lower.binding(e.expression)?.kind === 'props'
    );
  };
  const hooks: Hooks = {
    readCell(cell, ctx, node) {
      if (modelCells.has(cell) && written.get(ctx)?.has(cell))
        tsFail(
          node,
          'E_MODEL',
          'Reading a model after writing it in the same function: Vue returns the old value until the parent re-renders; keep the written value in a local instead',
        );
      return { op: 'cell', cell, read: 'current' };
    },
    cellType: cell => cells[cell].type,
    writeCell(cell, value, ctx, node) {
      const c = cells[cell];
      if (c.prop !== undefined && !modelCells.has(cell))
        tsFail(
          node,
          'E_PROPS',
          `Props are read-only in Vue (${c.prop}); emit an event or use defineModel`,
        );
      if (modelCells.has(cell)) {
        if (!written.has(ctx)) written.set(ctx, new Set());
        written.get(ctx)!.add(cell);
      }
      return [{ op: 'set', cell, value }];
    },
    call(node, ctx, lower) {
      const callee = node.expression;
      if (!ts.isIdentifier(callee)) return undefined;
      const sym = lower.symbol(callee);
      if (sym && emitSymbols.has(sym)) {
        const [first, ...rest] = node.arguments;
        if (!first || !ts.isStringLiteralLike(first))
          return tsFail(node, 'E_EMITS', 'emit takes a literal event name');
        const cell = emitCells.get(handlerKey(first.text));
        if (cell === undefined)
          return tsFail(first, 'E_EMITS', `Event ${first.text} is not declared in defineEmits`);
        const t = cells[cell].type as { fn: { params: Type[] } };
        if (rest.length > t.fn.params.length)
          return tsFail(
            node,
            'E_EMITS',
            `Event ${first.text} takes ${t.fn.params.length} arguments`,
          );
        const args = t.fn.params.map((p, i): Expr => {
          if (rest[i]) return lower.coerce(rest[i], ctx, p);
          if (maybeInner(p)) return { op: 'undefined', type: p };
          return tsFail(node, 'E_EMITS', `Event ${first.text} needs argument ${i + 1}`);
        });
        return { op: 'call-value', callee: { op: 'cell', cell, read: 'current' }, args };
      }
      if (MACROS.has(callee.text) && vueCall(node))
        return tsFail(node, 'E_MACRO', `${callee.text} is a top-level <script setup> declaration`);
      return undefined;
    },
    statement(node, _ctx, lower) {
      const K = ts.SyntaxKind;
      const target =
        ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)
          ? node.left
          : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
              [K.PlusPlusToken, K.MinusMinusToken].includes(node.operator)
            ? node.operand
            : undefined;
      if (target && isPropsMember(target, lower))
        tsFail(target, 'E_PROPS', 'Props are read-only in Vue; emit an event or use defineModel');
      return undefined;
    },
  };
  const lower = new Lowerer(program, checker, types, hooks, tsFail, sourceOf);
  // Ordinary local modules initialise first (dependencies first).
  for (const p of lowerModules(graph, program, lower, { skip: f => f === graph.entry })) p();

  const components: Component[] = [];
  for (const u of order) components[u.index] = lowerComponent(u);

  function lowerComponent(u: Unit): Component {
    cells = [];
    modelCells = new Set();
    written = new Map();
    emitSymbols = new Set();
    emitCells = new Map();
    const COMPONENT = u.index;
    const sf = program.getSourceFile(u.virtual)!;
    const loc = (n: VNode) => locate(u.original, n.loc?.start.offset ?? 0, u.rel);
    const statements = [...sf.statements].filter(s => s.getStart(sf) < u.scriptLength);
    const pending: (() => void)[] = [];
    const setupBindings = new Map<string, ts.Symbol>();

    /** A prop default: `withDefaults`/`default:` factories are called for non-function props. */
    const defaultValue = (e: ts.Expression, type: Type, name: string, factory: boolean): Expr => {
      let value = skipParens(e);
      if (factory && !(typeof type === 'object' && 'fn' in type)) {
        if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
          const body = value.body;
          if (ts.isBlock(body)) {
            const ret = body.statements[0];
            if (body.statements.length !== 1 || !ts.isReturnStatement(ret) || !ret.expression)
              return tsFail(value, 'E_PROPS', 'Default factories return a single expression');
            value = ret.expression;
          } else value = body;
        }
      }
      return coerceInit(
        lower.value(value, COMPONENT, `${name}$default`),
        lower.exprType(value),
        type,
      );
    };

    /** defineProps<T>() (destructured, as an object, or bare) → prop cells. */
    const props = (call: ts.CallExpression, d?: ts.VariableDeclaration) => {
      let define = call;
      let defaults: ts.ObjectLiteralExpression | undefined;
      if (vueCall(call) === 'withDefaults') {
        define = skipParens(call.arguments[0]) as ts.CallExpression;
        const dflt = call.arguments[1] && skipParens(call.arguments[1]);
        if (dflt && !ts.isObjectLiteralExpression(dflt))
          tsFail(dflt, 'E_PROPS', 'withDefaults takes an object literal');
        defaults = dflt as ts.ObjectLiteralExpression | undefined;
      }
      const typeArg = define.typeArguments![0];
      const names = typeMembers(sf, typeArg, (n, m) => tsFail(n, 'E_PROPS', m)).map(m =>
        memberName(m)!,
      );
      const propsType = checker.getTypeFromTypeNode(typeArg);
      const elements = new Map<string, ts.BindingElement>();
      if (d && ts.isObjectBindingPattern(d.name))
        for (const el of d.name.elements) {
          if (el.dotDotDotToken)
            tsFail(el, 'E_PROPS', 'Rest props are planned for a later milestone');
          if (!ts.isIdentifier(el.name))
            tsFail(el, 'E_PROPS', 'Nested prop destructuring is unsupported');
          const key = el.propertyName
            ? ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName)
              ? el.propertyName.text
              : tsFail(el, 'E_PROPS', 'Computed prop keys are unsupported')
            : (el.name as ts.Identifier).text;
          if (!names.includes(key)) tsFail(el, 'E_PROPS', `${key} is not a declared prop`);
          elements.set(key, el);
        }
      else if (d && !ts.isIdentifier(d.name))
        tsFail(d, 'E_PROPS', 'Destructure props as const { a, b } = defineProps<T>()');
      const fallbacks = new Map<string, ts.Expression>();
      for (const p of defaults?.properties ?? []) {
        const key =
          ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
            ? p.name.text
            : tsFail(p, 'E_PROPS', 'withDefaults takes `name: value` entries');
        if (!names.includes(key)) tsFail(p, 'E_PROPS', `${key} is not a declared prop`);
        fallbacks.set(key, (p as ts.PropertyAssignment).initializer);
      }
      const values = new Map<string, Expr>();
      for (const name of names) {
        const sym = checker.getPropertyOfType(propsType, name)!;
        let t = checker.getTypeOfSymbolAtLocation(sym, typeArg);
        if (sym.flags & ts.SymbolFlags.Optional)
          t = checker.getNullableType(t, ts.TypeFlags.Undefined);
        const el = elements.get(name);
        const fallback = el?.initializer ?? fallbacks.get(name);
        let type = types.map(t, typeArg);
        if (fallback) type = maybeInner(type) ?? type;
        // Boolean casting: an absent boolean prop is false.
        const boolean = !fallback && (type === 'boolean' || sameType(type, { maybe: 'boolean' }));
        if (boolean) type = 'boolean';
        const cell = cells.length;
        cells.push({
          name: el ? (el.name as ts.Identifier).text : name,
          type,
          init: boolean
            ? { op: 'lit', value: false }
            : maybeInner(type)
              ? { op: 'undefined', type }
              : required(type),
          tracking: isReference(type) ? 'deep' : 'identity',
          prop: name,
          source: sourceOf(el ?? typeArg),
        });
        if (fallback)
          pending.push(() => (cells[cell].init = defaultValue(fallback, type, name, !el)));
        if (el) {
          const s = checker.getSymbolAtLocation(el.name)!;
          lower.bindings.set(s, { kind: 'cell', cell });
          setupBindings.set((el.name as ts.Identifier).text, s);
        }
        values.set(name, { op: 'cell', cell, read: 'current' });
      }
      if (d && ts.isIdentifier(d.name)) {
        const s = checker.getSymbolAtLocation(d.name)!;
        lower.bindings.set(s, { kind: 'props', values });
        setupBindings.set(d.name.text, s);
      }
    };

    /** defineEmits<T>() → `on<Event>` prop cells defaulting to a no-op. */
    const emits = (call: ts.CallExpression, d?: ts.VariableDeclaration) => {
      const alias = sf.statements.find(
        s => ts.isTypeAliasDeclaration(s) && s.name.text === '__RunicEmits',
      ) as ts.TypeAliasDeclaration;
      for (const p of checker.getPropertiesOfType(checker.getTypeAtLocation(alias.name))) {
        const type = types.map(
          checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(p, alias)),
          call,
        );
        if (typeof type !== 'object' || !('fn' in type))
          return tsFail(call, 'E_EMITS', 'Unexpected emit type');
        const noop = lower.reserve();
        lower.functions[noop] = {
          name: `${p.name}$none`,
          params: type.fn.params.map((t, i) => ({ name: `a${i}`, type: t })),
          locals: [],
          result: 'void',
          body: [],
        };
        emitCells.set(p.name, cells.length);
        cells.push({
          name: p.name,
          type,
          init: { op: 'closure', function: noop, captures: [] },
          tracking: 'identity',
          prop: p.name,
          source: sourceOf(call),
        });
      }
      if (d) {
        const s = checker.getSymbolAtLocation(d.name)!;
        emitSymbols.add(s);
        setupBindings.set((d.name as ts.Identifier).text, s);
      }
    };

    /** defineModel<T>() → a writable prop cell, read and written through `.value`. */
    const model = (call: ts.CallExpression, d: ts.VariableDeclaration) => {
      let [nameArg, options] = call.arguments;
      if (nameArg && !ts.isStringLiteral(nameArg)) [nameArg, options] = [undefined!, nameArg];
      const prop = nameArg ? (nameArg as ts.StringLiteral).text : 'modelValue';
      const name = (d.name as ts.Identifier).text;
      const sym = checker.getSymbolAtLocation(d.name)!;
      const refType = checker.getTypeOfSymbolAtLocation(sym, d) as ts.TypeReference;
      const [inner] = checker.getTypeArguments(refType);
      if (!inner) tsFail(d, 'E_MODEL', 'Unexpected model type');
      const type = types.map(inner, d);
      let fallback: ts.Expression | undefined;
      let isRequired = false;
      for (const p of (options as ts.ObjectLiteralExpression | undefined)?.properties ?? []) {
        const a = p as ts.PropertyAssignment;
        if ((a.name as ts.Identifier).text === 'default') fallback = a.initializer;
        else if (a.initializer.kind === ts.SyntaxKind.TrueKeyword) isRequired = true;
      }
      const cell = cells.length;
      cells.push({
        name,
        type,
        init: isRequired && !fallback ? required(type) : { op: 'undefined', type },
        tracking: isReference(type) ? 'deep' : 'identity',
        prop,
        source: sourceOf(d),
      });
      if (fallback) {
        const f = fallback;
        pending.push(() => (cells[cell].init = defaultValue(f, type, name, true)));
      }
      modelCells.add(cell);
      lower.bindings.set(sym, { kind: 'ref', cell });
      setupBindings.set(name, sym);
    };

    // --- Setup bindings ---
    for (const stmt of statements) {
      if (ts.isImportDeclaration(stmt)) {
        const spec = (stmt.moduleSpecifier as ts.StringLiteral).text;
        if (stmt.importClause?.isTypeOnly) continue;
        if (spec === 'vue') {
          const named = stmt.importClause?.namedBindings;
          if (named && ts.isNamedImports(named))
            for (const el of named.elements) {
              const n = (el.propertyName ?? el.name).text;
              if (!['ref', 'computed', 'shallowRef'].includes(n))
                tsFail(el, 'E_CAPABILITY', `vue:${n} is planned for M3/M4`);
            }
          continue;
        }
        if (spec.endsWith('.vue')) continue;
        if (!spec.startsWith('.'))
          tsFail(stmt, 'E_DEPENDENCY', `No adapter for dependency ${spec} (npm libraries are M6)`);
        continue;
      }
      if (ts.isTypeAliasDeclaration(stmt) || ts.isInterfaceDeclaration(stmt)) continue;
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const sym = checker.getSymbolAtLocation(stmt.name)!;
        setupBindings.set(stmt.name.text, sym);
        const p = lower.declare(sym, stmt, stmt.name.text, COMPONENT);
        if (p) pending.push(p);
        continue;
      }
      if (ts.isExpressionStatement(stmt)) {
        const e = skipParens(stmt.expression);
        const kind = vueCall(e);
        if (kind === 'defineProps') props(e as ts.CallExpression);
        else if (kind === 'defineEmits') emits(e as ts.CallExpression);
        else
          tsFail(
            stmt,
            'E_STATEMENT',
            'Setup supports const declarations, functions and imports from vue (watchers/lifecycle are M4)',
          );
        continue;
      }
      if (ts.isVariableStatement(stmt) && stmt.declarationList.flags & ts.NodeFlags.Const) {
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer && skipParens(d.initializer);
          const kind = vueCall(init);
          if (kind === 'defineProps' || kind === 'withDefaults') {
            props(init as ts.CallExpression, d);
            continue;
          }
          if (kind === 'defineEmits') {
            emits(init as ts.CallExpression, d);
            continue;
          }
          if (kind === 'defineModel') {
            model(init as ts.CallExpression, d);
            continue;
          }
          if (!ts.isIdentifier(d.name) || !init)
            tsFail(d, 'E_DECLARATION', 'Destructuring is supported for defineProps only');
          const name = (d.name as ts.Identifier).text;
          const sym = checker.getSymbolAtLocation(d.name)!;
          setupBindings.set(name, sym);
          if (kind === 'ref' || kind === 'shallowRef') {
            const call = init as ts.CallExpression;
            const refType = checker.getTypeOfSymbolAtLocation(sym, d) as ts.TypeReference;
            const [inner] = checker.getTypeArguments(refType);
            if (!inner) tsFail(d, 'E_REF', 'Unexpected ref type');
            const type = types.map(inner, d);
            const cell = cells.length;
            cells.push({
              name,
              type,
              init: { op: 'undefined', type },
              tracking: kind === 'ref' ? 'deep' : 'identity',
              source: sourceOf(d),
            });
            lower.bindings.set(sym, { kind: 'ref', cell });
            pending.push(() => {
              const arg = call.arguments[0];
              if (!arg) return;
              cells[cell].init = coerceInit(
                lower.value(arg, COMPONENT, `${name}$init`),
                lower.exprType(arg),
                type,
              );
            });
            continue;
          }
          if (kind === 'computed') {
            const getter = (init as ts.CallExpression).arguments[0];
            if (!getter || !(ts.isArrowFunction(getter) || ts.isFunctionExpression(getter)))
              tsFail(init!, 'E_COMPUTED', 'computed takes a getter function');
            const index = lower.reserve();
            lower.bindings.set(sym, { kind: 'computed', fn: index });
            pending.push(() =>
              lower.function(getter as ts.ArrowFunction, name, undefined, COMPONENT, index),
            );
            continue;
          }
          if (ts.isArrowFunction(init!) || ts.isFunctionExpression(init!)) {
            const p = lower.declare(sym, init, name, COMPONENT);
            if (p) pending.push(p);
            continue;
          }
          // A setup constant, captured once.
          const cell = cells.length;
          const type = lower.exprType(init!);
          cells.push({
            name,
            type,
            init: { op: 'undefined', type },
            tracking: 'identity',
            source: sourceOf(d),
          });
          lower.bindings.set(sym, { kind: 'cell', cell });
          pending.push(() => (cells[cell].init = lower.value(init!, COMPONENT, `${name}$init`)));
        }
        continue;
      }
      tsFail(
        stmt,
        'E_STATEMENT',
        'Setup supports const declarations, functions and imports from vue (watchers/lifecycle are M4)',
      );
    }
    for (const p of pending) p();

    // Template-scope bindings: unwrapped setup bindings, props, $emit.
    const templateFn = sf.statements.find(
      s => ts.isFunctionDeclaration(s) && s.name?.text === '__runic_template',
    ) as ts.FunctionDeclaration;
    const propCells = new Map<string, number>();
    cells.forEach((c, i) => c.prop !== undefined && propCells.set(c.prop, i));
    for (const stmt of templateFn.body!.statements) {
      if (!ts.isVariableStatement(stmt)) break;
      const d = stmt.declarationList.declarations[0];
      const from = d.initializer && ts.isIdentifier(d.initializer) ? d.initializer.text : '';
      if (ts.isObjectBindingPattern(d.name))
        for (const el of d.name.elements) {
          const name = (el.name as ts.Identifier).text;
          const sym = checker.getSymbolAtLocation(el.name)!;
          if (from === '__runic_P') {
            lower.bindings.set(sym, { kind: 'cell', cell: propCells.get(name)! });
            continue;
          }
          const setup = setupBindings.get(name);
          if (setup && emitSymbols.has(setup)) emitSymbols.add(sym);
          const binding = setup && lower.bindings.get(setup);
          if (binding?.kind === 'ref')
            lower.bindings.set(sym, { kind: 'cell', cell: binding.cell });
          else if (binding?.kind === 'computed')
            lower.bindings.set(sym, { kind: 'derived', fn: binding.fn });
          else if (binding) lower.bindings.set(sym, binding);
        }
      else if (ts.isIdentifier(d.name) && d.name.text === '$emit')
        emitSymbols.add(checker.getSymbolAtLocation(d.name)!);
    }

    // --- Template ---
    const tb: FnBuilder = lower.template(COMPONENT);
    const handlers: Handler[] = [];
    /** The TS node of a template expression by its synthetic span. */
    const nodeAt = (key: VNode): ts.Node => {
      const span = u.starts.get(key);
      if (!span) return fail('E_INTERNAL', 'Template expression not mapped', loc(key));
      const [start, end] = span;
      let found: ts.Node | undefined;
      const walk = (x: ts.Node) => {
        if (found) return;
        if (x.getStart(sf) === start && x.end === end) {
          found = x;
          return;
        }
        if (x.getStart(sf) <= start && x.end >= end) ts.forEachChild(x, walk);
      };
      walk(sf);
      return found ?? fail('E_INTERNAL', 'Template expression not found', loc(key));
    };
    const exprNode = (e: VNode) => nodeAt(e) as ts.Expression;
    const value = (e: ts.Expression): Expr => lower.expr(e, tb);
    const typeOf = (v: Expr): Type => lower.irType(v, tb);
    const display = (e: ts.Expression): Expr => {
      // toDisplayString: nullish → '', arrays/objects → JSON with 2 spaces.
      const v = value(e);
      const t = typeOf(v);
      if (t === 'string') return v;
      if (t === 'number' || t === 'boolean') return { op: 'to-string', arg: v };
      if (typeof t === 'object' && ('array' in t || 'record' in t))
        return {
          op: 'builtin',
          name: 'JSON.stringify',
          args: [v, { op: 'undefined', type: { maybe: 'number' } }, { op: 'lit', value: 2 }],
          type: 'string',
        };
      const inner = maybeInner(t);
      if (inner === 'string' || inner === 'number' || inner === 'boolean')
        return maybeText(lower, v, t);
      return fail('E_TEMPLATE', `Interpolating ${JSON.stringify(t)} is unsupported`, sourceOf(e));
    };
    const condition = (e: ts.Expression): Expr => {
      const v = value(e);
      return typeOf(v) === 'boolean' ? v : { op: 'to-boolean', arg: v };
    };
    const setupDecl = (name: string): ts.FunctionLikeDeclaration | undefined => {
      for (const stmt of statements) {
        if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === name) return stmt;
        if (ts.isVariableStatement(stmt))
          for (const d of stmt.declarationList.declarations)
            if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) {
              const i = skipParens(d.initializer);
              if (ts.isArrowFunction(i) || ts.isFunctionExpression(i)) return i;
            }
      }
      return undefined;
    };
    const handlerFor = (p: VNode, event: 'click' | 'input'): Listener => {
      const e = skipParens(exprNode(p.exp));
      const input = event === 'input';
      let h: { params?: Local[]; locals?: Local[]; body: Stmt[]; args?: Expr[] };
      if (ts.isArrowFunction(e) || ts.isFunctionExpression(e))
        h = lower.handler(e, COMPONENT, input, tb);
      else if (ts.isIdentifier(e)) {
        const b = lower.binding(e);
        if (b?.kind === 'function' || b?.kind === 'generic') {
          // A method handler receives the event: lower its body with that parameter.
          const decl = setupDecl(e.text);
          if (decl && decl.parameters.length) h = lower.handler(decl, COMPONENT, input);
          else if (b.kind === 'function')
            h = { body: [{ op: 'expr', value: { op: 'call', function: b.fn, args: [] } }] };
          else return tsFail(e, 'E_EVENT', 'Unsupported handler');
        } else if (b?.kind === 'cell') {
          // A function-valued prop: called with the event, which it may not use.
          const t = cells[b.cell].type;
          if (typeof t !== 'object' || !('fn' in t))
            return tsFail(e, 'E_EVENT', 'Event handlers must be functions');
          if (t.fn.params.length)
            return tsFail(e, 'E_EVENT', 'Callbacks taking the event object are planned for M5');
          h = {
            body: [
              {
                op: 'expr',
                value: { op: 'call-value', callee: { op: 'cell', cell: b.cell }, args: [] },
              },
            ],
          };
        } else return tsFail(e, 'E_EVENT', 'Event handlers must be functions');
      } else return tsFail(e, 'E_EVENT', 'Unsupported event handler');
      const { args, ...rest } = h;
      handlers.push({ event, ...rest, source: loc(p) });
      return { event, handler: handlers.length - 1, ...(args?.length ? { args } : {}) };
    };
    /** Fit a value to a prop type (T → Maybe<T>). */
    const fit = (v: Expr, want: Type, what: string, at: VNode): Expr => {
      const t = typeOf(v);
      if (sameType(t, want)) return v;
      if (maybeInner(want) && sameType(maybeInner(want)!, t)) return { op: 'some', value: v };
      return fail(
        'E_PROPS',
        `${what} expects ${JSON.stringify(want)} but receives ${JSON.stringify(t)}${maybeInner(t) ? ' (an undefined value does not select the default)' : ''}`,
        loc(at),
      );
    };
    /**
     * A listener for an emit of type `want`. Vue calls it with all emitted
     * arguments, so a function taking fewer of them (or returning a value) is
     * wrapped.
     */
    const listenerFn = (v: Expr, want: Type, at: VNode): Expr => {
      const from = typeOf(v);
      if (sameType(from, want)) return v;
      const f = typeof from === 'object' && 'fn' in from ? from.fn : undefined;
      const w = (want as { fn: { params: Type[]; result: Type } }).fn;
      if (
        !f ||
        f.params.length > w.params.length ||
        f.params.some((p, i) => !sameType(p, w.params[i]))
      )
        return fail(
          'E_EVENT',
          `The listener has type ${JSON.stringify(from)}; the event passes ${JSON.stringify(w.params)}`,
          loc(at),
        );
      let captures: Local[] = [];
      let sources: number[] = [];
      let callee: Expr = v;
      if (v.op === 'closure') {
        captures = lower.functions[v.function].captures ?? [];
        sources = v.captures;
        callee = { op: 'closure', function: v.function, captures: captures.map((_, i) => i) };
      } else if (JSON.stringify(v).includes('"op":"local"'))
        return fail('E_EVENT', 'Use an arrow function for this listener', loc(at));
      const index = lower.reserve();
      lower.functions[index] = {
        name: 'listener',
        component: COMPONENT,
        ...(captures.length ? { captures } : {}),
        params: w.params.map((type, i) => ({ name: `a${i}`, type })),
        locals: [],
        result: 'void',
        body: [
          {
            op: 'expr',
            value: {
              op: 'call-value',
              callee,
              args: f.params.map((_, i): Expr => ({ op: 'local', local: captures.length + i })),
            },
          },
        ],
      };
      return { op: 'closure', function: index, captures: sources };
    };
    const children = (list: VNode[]): Node[] => {
      const out: Node[] = [];
      let parts: Expr[] = [];
      const flush = () => {
        if (parts.length) out.push({ kind: 'text', parts });
        parts = [];
      };
      const items = list.filter(n => n.type !== COMMENT);
      for (let i = 0; i < items.length; i++) {
        const n = items[i];
        if (n.type === TEXT) {
          if (n.content) parts.push({ op: 'lit', value: n.content });
        } else if (n.type === INTERPOLATION) parts.push(display(exprNode(n.content)));
        else if (n.type === ELEMENT) {
          flush();
          const vIf = dir(n, 'if');
          if (!vIf) {
            if (dir(n, 'else') || dir(n, 'else-if'))
              fail('E_TEMPLATE', 'v-else without v-if', loc(n));
            out.push(node(n));
            continue;
          }
          // v-if / v-else-if / v-else chain → nested if nodes.
          const chain: { test?: VNode; node: VNode }[] = [{ test: vIf, node: n }];
          while (items[i + 1]?.type === ELEMENT) {
            const next = items[i + 1];
            const d = dir(next, 'else-if') ?? dir(next, 'else');
            if (!d) break;
            chain.push({ test: d.name === 'else' ? undefined : d, node: next });
            i++;
          }
          for (const c of chain)
            if (dir(c.node, 'for'))
              fail(
                'E_TEMPLATE',
                'v-if and v-for on one element: Vue evaluates v-if first; wrap the list or filter it',
                loc(c.node),
              );
          const build = (k: number): Node[] => {
            if (k >= chain.length) return [];
            const { test, node: target } = chain[k];
            if (!test) return [node(target)];
            return [
              {
                kind: 'if',
                test: condition(exprNode(test.exp)),
                then: [node(target)],
                else: build(k + 1),
                source: loc(target),
              },
            ];
          };
          out.push(...build(0));
        } else fail('E_TEMPLATE', 'Unsupported template node', loc(n));
      }
      flush();
      return out;
    };
    const node = (n: VNode): Node => (dir(n, 'for') ? each(n) : single(n, false));
    const single = (n: VNode, listed: boolean): Node =>
      n.tagType === COMPONENT_TAG && childName(u, n.tag)
        ? component(n, listed)
        : element(n, listed);
    const each = (n: VNode): Node => {
      const r = dir(n, 'for').forParseResult;
      if (r.index)
        fail('E_TEMPLATE', 'v-for over objects (a third alias) is planned for later', loc(n));
      const items = value(exprNode(r.source));
      const itemType = arrayElement(typeOf(items));
      if (!itemType)
        fail(
          'E_TEMPLATE',
          'v-for requires an array (ranges, objects and maps are planned for later)',
          loc(n),
        );
      let pattern = nodeAt(r.value);
      if (ts.isVariableDeclaration(pattern)) pattern = pattern.name;
      if (!ts.isIdentifier(pattern))
        fail('E_TEMPLATE', 'Destructured v-for items are planned for a later M3 step', loc(n));
      const item = tb.local((pattern as ts.Identifier).text, itemType!);
      lower.bindings.set(checker.getSymbolAtLocation(pattern)!, {
        kind: 'local',
        owner: tb,
        local: item,
      });
      let index: number | undefined;
      if (r.key) {
        index = tb.local(r.key.content, 'number');
        lower.bindings.set(checker.getSymbolAtLocation(nodeAt(r.key))!, {
          kind: 'local',
          owner: tb,
          local: index,
        });
      }
      const k = n.props.find(
        (p: VNode) => p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'key',
      );
      const key = k?.exp ? value(exprNode(k.exp)) : undefined;
      return {
        kind: 'each',
        items,
        item,
        ...(index !== undefined ? { index } : {}),
        ...(key ? { key } : {}),
        body: [single(n, true)],
        source: loc(n),
      };
    };
    /** Directives handled by the enclosing chain or list. */
    const structural = (p: VNode, listed: boolean) => {
      if (['if', 'else-if', 'else', 'for'].includes(p.name)) return true;
      if (p.name === 'bind' && p.arg?.content === 'key') {
        if (!listed)
          fail('E_TEMPLATE', ':key outside v-for is planned for a later milestone', loc(p));
        return true;
      }
      return false;
    };
    const component = (n: VNode, listed: boolean): Node => {
      const name = childName(u, n.tag)!;
      const child = units.get(u.children.get(name)!)!;
      const target = components[child.index];
      const passed: { name: string; value: Expr; bind?: Expr }[] = [];
      const propCell = (prop: string, at: VNode, what = 'prop') => {
        const cell = target.cells.findIndex(c => c.prop === prop);
        if (cell < 0)
          fail(
            'E_PROPS',
            `${name} has no ${what} ${prop} (fallthrough attributes are planned for a later milestone)`,
            loc(at),
          );
        if (passed.some(p => p.name === prop)) fail('E_PROPS', `${prop} is passed twice`, loc(at));
        return cell;
      };
      for (const p of n.props) {
        if (p.type === ATTRIBUTE) {
          const prop = camelize(p.name);
          const want = target.cells[propCell(prop, p)].type;
          const text: string | undefined = p.value?.content;
          let v: Expr;
          if (want === 'boolean' && (text === undefined || text === '' || text === hyphenate(prop)))
            v = { op: 'lit', value: true };
          else if (want === 'string' || maybeInner(want) === 'string')
            v = fit({ op: 'lit', value: text ?? '' }, want, prop, p);
          else
            return fail(
              'E_PROPS',
              `${prop} expects ${JSON.stringify(want)}; use :${p.name}`,
              loc(p),
            );
          passed.push({ name: prop, value: v });
          continue;
        }
        if (structural(p, listed)) continue;
        if (!p.exp) fail('E_TEMPLATE', `v-${p.name} needs an expression`, loc(p));
        if (p.modifiers?.length)
          fail('E_TEMPLATE', 'Directive modifiers are planned for M5', loc(p));
        if (p.arg && !p.arg.isStatic)
          fail('E_TEMPLATE', 'Dynamic arguments are unsupported', loc(p));
        if (p.name === 'bind' && p.arg && p.exp) {
          const prop = camelize(p.arg.content);
          const want = target.cells[propCell(prop, p)].type;
          passed.push({ name: prop, value: fit(value(exprNode(p.exp)), want, prop, p) });
        } else if (p.name === 'on' && p.arg && p.exp) {
          const key = handlerKey(p.arg.content);
          if (!child.macros.emits?.events.some(e => e.key === key))
            fail('E_PROPS', `${name} declares no event ${p.arg.content} in defineEmits`, loc(p));
          const want = target.cells[propCell(key, p, 'event')].type;
          passed.push({ name: key, value: listenerFn(value(exprNode(p.exp)), want, p) });
        } else if (p.name === 'model' && p.exp) {
          const prop: string = p.arg?.content ?? 'modelValue';
          if (!child.macros.models.some(m => m.prop === prop))
            fail('E_MODEL', `${name} declares no defineModel(${JSON.stringify(prop)})`, loc(p));
          const want = target.cells[propCell(prop, p, 'model')].type;
          const v = value(exprNode(p.exp));
          if (!sameType(typeOf(v), want))
            fail(
              'E_MODEL',
              `v-model target has type ${JSON.stringify(typeOf(v))}; ${name} models ${JSON.stringify(want)} (a model without default or required is nullable)`,
              loc(p),
            );
          const bind = value(exprNode(p));
          if (!sameType(typeOf(bind), { fn: { params: [want], result: 'void' } }))
            fail('E_MODEL', 'Unsupported v-model target', loc(p));
          passed.push({ name: prop, value: v, bind });
        } else
          fail(
            'E_TEMPLATE',
            `v-${p.name}${p.arg ? ':' + p.arg.content : ''} on components is planned for a later milestone`,
            loc(p),
          );
      }
      for (const c of target.cells)
        if (c.prop && !passed.some(p => p.name === c.prop) && isRequired(c.init))
          fail('E_PROPS', `${name} requires the prop ${c.prop}`, loc(n));
      if (
        n.children.some((c: VNode) => c.type !== COMMENT && (c.type !== TEXT || c.content.trim()))
      )
        fail('E_TEMPLATE', 'Slots are planned for a later M3 step', loc(n));
      return {
        kind: 'component',
        component: child.index,
        ...(passed.length ? { props: passed } : {}),
        source: loc(n),
      };
    };
    const element = (n: VNode, listed: boolean): Node => {
      if (n.tagType !== PLAIN || !TAGS.has(n.tag))
        fail(
          'E_TEMPLATE',
          n.tagType === COMPONENT_TAG
            ? `${n.tag} is not an imported component`
            : `<${n.tag}> is outside the supported elements`,
          loc(n),
        );
      const attrs: { name: string; value: Expr }[] = [];
      const props: { name: string; value: Expr }[] = [];
      const listeners: Listener[] = [];
      for (const p of n.props) {
        if (p.type === ATTRIBUTE) {
          attrs.push({
            name: p.name,
            value: BOOLEAN_ATTRS.has(p.name)
              ? { op: 'lit', value: true }
              : { op: 'lit', value: p.value?.content ?? '' },
          });
          continue;
        }
        if (structural(p, listed)) continue;
        if (!p.exp) fail('E_TEMPLATE', `v-${p.name} needs an expression`, loc(p));
        if (p.modifiers?.length)
          fail('E_TEMPLATE', `Directive modifiers are planned for M5`, loc(p));
        if (p.name === 'on') {
          const event = p.arg?.content;
          if (event !== 'click' && event !== 'input')
            fail('E_EVENT', `@${event} is planned for M5`, loc(p));
          listeners.push(handlerFor(p, event));
          continue;
        }
        if (p.name === 'bind' && p.arg?.isStatic) {
          const name: string = p.arg.content;
          const v = value(exprNode(p.exp));
          const t = typeOf(v);
          if (name === 'value' && n.tag === 'input')
            props.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
          else if (BOOLEAN_ATTRS.has(name))
            attrs.push({ name, value: t === 'boolean' ? v : { op: 'to-boolean', arg: v } });
          else if (maybeInner(t) === 'string') attrs.push({ name, value: v });
          else if (t === 'string' || t === 'number' || t === 'boolean')
            attrs.push({ name, value: t === 'string' ? v : { op: 'to-string', arg: v } });
          else
            fail(
              'E_TEMPLATE',
              `:${name} with ${JSON.stringify(t)} (class/style objects are planned for later)`,
              loc(p),
            );
          continue;
        }
        if (p.name === 'model')
          fail(
            'E_TEMPLATE',
            'v-model on elements is planned for M5 (IME composition); use :value and @input',
            loc(p),
          );
        fail('E_TEMPLATE', `v-${p.name} is planned for a later milestone`, loc(p));
      }
      return {
        kind: 'element',
        tag: n.tag,
        ...(attrs.length ? { attrs } : {}),
        ...(props.length ? { props } : {}),
        ...(listeners.length ? { listeners } : {}),
        ...(n.children.length ? { children: children(n.children) } : {}),
        source: loc(n),
      };
    };
    const template = children(u.descriptor.template.ast.children);
    return {
      name: path.basename(u.file, '.vue'),
      cells,
      handlers,
      template,
      ...(tb.locals.length ? { templateLocals: tb.locals } : {}),
    };
  }

  const capabilities = ['dom', 'css', 'window', 'click', 'keyboard'];
  if (components.some(c => c.handlers.some(h => h.event === 'input')))
    capabilities.push('text-input');
  const ir: Program = {
    schema: 4,
    meta: {
      title: graph.config.title,
      sourceHash: graph.hash,
      frontend: {
        adapter: 'vue',
        version: 3,
        packages: graph.tooling.packages,
        tools: { typescript: ts.version },
      },
      provenance: graph.manifest,
      mappings: [],
    },
    ...(graph.config.renderer ? { renderer: graph.config.renderer } : {}),
    capabilities,
    styles: { css: graph.css, assets: graph.assets },
    records: types.records,
    functions: lower.functions,
    globals: lower.globals,
    components,
    root: units.get(rootFile!)!.index,
    // Vue's app.mount() marks the container.
    containerAttrs: { 'data-v-app': '' },
  };
  (ir as Program & { irHash?: string }).irHash = hash(ir);
  return { ir };
}

/** Widen an initial value to the cell type (T → Maybe<T>). */
function coerceInit(v: Expr, from: Type, to: Type): Expr {
  if (maybeInner(to) && !maybeInner(from)) return { op: 'some', value: v };
  return v;
}

const isReference = (t: Type): boolean =>
  typeof t === 'object' &&
  ('array' in t ||
    'record' in t ||
    'map' in t ||
    'set' in t ||
    ('maybe' in t && isReference(t.maybe)));

/** The initialiser of a required prop: reading it unpassed throws. */
function required(t: Type): Expr {
  return { op: 'unwrap', value: { op: 'undefined', type: { maybe: t } } };
}
const isRequired = (init: Expr) => init.op === 'unwrap' && init.value.op === 'undefined';

/** toDisplayString of a nullable primitive: '' when nullish. */
function maybeText(lower: Lowerer, v: Expr, t: Type): Expr {
  const fn = lower.reserve();
  lower.functions[fn] = {
    name: 'text$maybe',
    params: [{ name: '$v', type: t }],
    locals: [],
    result: 'string',
    body: [
      {
        op: 'if',
        test: {
          op: 'builtin',
          name: 'maybe.is-nullish',
          args: [{ op: 'local', local: 0 }],
          type: 'boolean',
        },
        then: [{ op: 'return', value: { op: 'lit', value: '' } }],
      },
      {
        op: 'return',
        value: { op: 'to-string', arg: { op: 'unwrap', value: { op: 'local', local: 0 } } },
      },
    ],
  };
  return { op: 'call', function: fn, args: [v] };
}
