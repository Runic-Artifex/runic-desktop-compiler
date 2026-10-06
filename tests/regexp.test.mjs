// RegExp values (docs/IR.md, built-ins): lowering of literals, new RegExp,
// their methods and properties and the String methods taking one, run by
// the reference interpreter and compared with Node evaluating the same
// code; and the rejections, with locations. Engine semantics are covered by
// crates/runic-js/tests/regexp.rs (Node-generated vectors); behaviour
// against Chromium by conformance/run.mjs (case patterns).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const graphs = new Map();
const graph = name => {
  if (!graphs.has(name)) graphs.set(name, collect('fixtures/' + name));
  return graphs.get(name);
};

/** The collected fixture with replacements in `file`. */
async function edits(name, file, pairs) {
  const g = await graph(name);
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `Replacement must match in ${name}: ${from}`);
    code = code.replace(from, () => to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

const rejects = async (g, code, pattern) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    assert.equal(e.source?.file, 'App.svelte', e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) => textOf(flat(step.state.dom).find(n => n.attrs.id === id));

/** Adds `<p id="extra">{extra(message)}</p>` computed by `fn` (TypeScript source). */
const withExtra = fn =>
  edits('patterns-svelte', 'App.svelte', [
    ['  function sample(', `  ${fn}\n  function sample(`],
    [
      '<p id="dates">{dates}</p>',
      '<p id="dates">{dates}</p>\n  <p id="extra">{extra(message)}</p>',
    ],
  ]);

/** Evaluates the TypeScript function source in Node (annotations stripped). */
const evaluate = (fn, arg) => {
  const js = fn
    .replace(/: (string|number|boolean)(\[\])?( \| (undefined|null))?/g, '')
    .replace(/: RegExp(ExecArray)?( \| null)?/g, '')
    .replace(/!\./g, '.');
  return new Function(`${js}; return extra;`)()(arg);
};

const MESSAGES = [
  'Hello {$user}, you have {$count :number} new {$kind}.',
  'x-y_z 2024-05-17 a1b2 😀x',
];

/** The texts of fixtures/patterns-svelte/App.svelte, computed by Node. */
const view = (name, message) => ({
  valid: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? 'valid' : 'invalid',
  parts: message.split(/(\{[^}]*\})/).join(''),
  names: [...message.matchAll(/\{\$([\p{L}_][\p{L}\p{N}_-]*)/gu)]
    .map(m => `${m[1]}@${m.index}`)
    .join(' '),
  preview: message.replace(/\{\$([\p{L}_][\p{L}\p{N}_-]*)(?:\s+:[^}]*)?\}/gu, (_, f) =>
    f === name ? `[${f.toUpperCase()}]` : `‹${f}›`,
  ),
  stats: `${
    new Set(
      message
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(w => w.length > 1),
    ).size
  } words, first at ${message.search(/\{\$/)}, marked ${message.match(/\{\$\w+( :\w+)?\}/)?.[1] ?? '-'}`,
  'plural-one': /^\s*one\s+\{\{([\s\S]*?)\}\}\s*$/mu.exec(message)?.[1] ?? '(none)',
  dates: message.replace(/(?<y>\d{4})-(?<m>\d\d)-(?<d>\d\d)/g, '$<d>.$<m>.$<y>'),
});

test('patterns fixture: the interpreter computes what Node computes', async () => {
  const { ir } = await lower(await graph('patterns-svelte'));
  const plural = '.match {$n :number}\none {{One file on 2024-05-17}}\n* {{{$n} files}}';
  const states = [
    ['count', 'Hello {$user}, you have {$count :number} new {$kind}.'],
    ['count_2', 'Hello {$user}, you have {$count :number} new {$kind}.'],
    ['count_2', plural],
    ['count_2', 'one {{x}} {$ünï_2 :x} 2020-10-04 😀\n  one {{two}}  '],
    ['2x', 'one {{x}} {$ünï_2 :x} 2020-10-04 😀\n  one {{two}}  '],
    ['2x', 'Dates: 2001-02-03, 1999-12-31.'],
  ];
  const steps = interpret(ir, [
    { kind: 'input', id: 'name', value: 'count_2' },
    { kind: 'click', id: 'plural' },
    { kind: 'input', id: 'message', value: states[3][1] },
    { kind: 'input', id: 'name', value: '2x' },
    { kind: 'click', id: 'plain' },
  ]);
  states.forEach(([name, message], i) => {
    for (const [id, want] of Object.entries(view(name, message)))
      assert.equal(text(steps[i], id), want, `step ${i} #${id}`);
  });
});

const SEMANTICS = `function extra(s: string): string {
    const out: string[] = [];
    const re = /(\\w)(\\d)?/g;
    for (let i = 0; i < 5; i++) {
      const m = re.exec(s);
      if (!m) {
        out.push('null:' + re.lastIndex);
        break;
      }
      out.push(m[0] + '|' + m[1] + '|' + (m[2] ?? 'u') + '@' + m.index + '/' + re.lastIndex);
    }
    const y = /a/y;
    y.lastIndex = 1;
    out.push(String(y.test('ba')), String(y.lastIndex), String(y.test('ba')), String(y.lastIndex));
    out.push('x-y_z'.split(/([-_])/, 3).join(','), s.split(/\\s+/).length + '');
    out.push('abc'.replace(/(b)/, "[$1|$&|$\`|$'|$$|$2|$01]"), 'aaa'.replace(/a/gy, 'b'), 'aaba'.replaceAll(/a/g, '$&$&'));
    out.push(String(s.search(/\\d/)), String('xyz'.search(/q/)));
    out.push('2024-05-17'.replace(/(\\d+)-(\\d+)-(\\d+)/, (all, y, mo, d, pos, input) => d + '/' + mo + '/' + y + '@' + pos + '#' + input.length + all.length));
    out.push(s.replace(/\\{\\$(\\w+)( :\\w+)?\\}/g, (_, n, f: string | undefined) => '<' + n + (f ?? '') + '>'));
    const g = /o/g;
    g.lastIndex = 5;
    out.push(String('foo boo'.search(g)), String(g.lastIndex));
    for (const mm of s.matchAll(/[a-z](\\d)/g)) out.push(mm[1] + '@' + mm.index + ':' + mm.input.length);
    out.push(String(/^\\p{Lu}/u.test('Ünï')), String(/./su.exec('😀x')?.[0].length), String(/./s.exec('😀x')?.[0].length));
    out.push(String(new RegExp('a/b', 'gi')), /x/gimsuy.flags, new RegExp('').source, String(/a/g.global), String(/a/.sticky));
    const named = /(?<word>[a-z]+)\\s(?<num>\\d+)?/.exec(s);
    if (named) out.push(named.groups?.word ?? '-', named.groups?.num ?? '-', named.groups!.word ?? '');
    const ws = s.match(/[a-z]+/g);
    out.push(ws ? ws.join('+') : 'none', String(s.match(/(z)(q)?/)?.[2]), String(s.match(/(z)/)?.index));
    const opt = /(z)(q)?/.exec(s);
    if (opt) for (let i = -1; i <= opt.length; i++) out.push(String(opt.at(i)));
    const all = /(x)-(y)/.exec(s);
    if (all) for (let i = -1; i <= all.length; i++) out.push(String(all.at(i)));
    const words = new Set(s.toLowerCase().split(/[^\\p{L}\\p{N}]+/u).filter((w) => w.length > 1));
    out.push(String(words.size), String(/\\u212A/i.test('k')), String(/[a-z]/i.test('\\u017F')), String(/[a-z]/iu.test('\\u017F')));
    return out.join(' ');
  }`;

test('RegExp semantics through the interpreter match Node', async () => {
  const { ir } = await lower(await withExtra(SEMANTICS));
  const steps = interpret(
    ir,
    MESSAGES.map(value => ({ kind: 'input', id: 'message', value })),
  );
  for (const [i, message] of [[0, MESSAGES[0]], ...MESSAGES.map((m, k) => [k + 1, m])])
    assert.equal(text(steps[i], 'extra'), evaluate(SEMANTICS, message), message);
});

test('rejected: v flag, invalid literals, dynamic flags, unsupported members', async () => {
  const reject = (from, to, code, pattern) =>
    edits('patterns-svelte', 'App.svelte', [[from, to]]).then(g => rejects(g, code, pattern));
  await reject('/^[A-Za-z_][A-Za-z0-9_]*$/;', '/^[A-Za-z_]$/v;', 'E_REGEXP', /v flag/);
  await reject('IDENT.test(name)', "new RegExp('(').test(name)", 'E_REGEXP', /Unterminated group/);
  await reject('IDENT.test(name)', 'new RegExp(name, name).test(name)', 'E_REGEXP', /literal/);
  await reject('IDENT.test(name)', 'new RegExp(IDENT).test(name)', 'E_REGEXP', /pattern source/);
  await reject('IDENT.test(name)', 'IDENT.compile()', 'E_REGEXP', /compile is unsupported/);
  await reject('IDENT.test(name)', "RegExp.escape(name) === ''", 'E_REGEXP', /RegExp.escape/);
  await reject('IDENT.test(name)', 'IDENT[Symbol.match] !== undefined', 'E_MEMBER');
});

test('rejected: captures that may be undefined read as strings, groups objects, iterators', async () => {
  const reject = (fn, pattern, code = 'E_REGEXP') =>
    withExtra(fn).then(g => rejects(g, code, pattern));
  await reject(
    "function extra(s: string): string { const m = /(a)?b/.exec(s); return m ? m[1] : ''; }",
    /may not participate/,
  );
  await reject(
    'function extra(s: string): string { return s.replace(/(a)?b/g, (_, a: string) => a); }',
    /string \| undefined/,
  );
  await reject(
    "function extra(s: string): string { const m = /(?<a>x)?/.exec(s); return m ? String(m.groups) : ''; }",
    /m.groups.name/,
  );
  await reject(
    'function extra(s: string): string { const it = s.matchAll(/a/g); return String(it); }',
    /matchAll/,
  );
  await reject(
    'function extra(s: string, re: RegExp): string { return s.replace(re, (_, a) => a); }'.replace(
      'function extra(s: string, re: RegExp)',
      'function extra(s: string, re: RegExp = /a/)',
    ),
    /captures are known/,
  );
  await reject(
    'function extra(s: string): string { const [, a] = /(a)?b/.exec(s)!; return a; }',
    /may not participate/,
  );
  // `?? undefined` keeps the undefined TypeScript then narrows away.
  await reject(
    "function extra(s: string): string { const m = /(a)?b/.exec(s); const a: string | undefined = m ? m[1] ?? undefined : ''; return String(a); }",
    /sides of \?\?/,
    'E_TYPE_UNION',
  );
  await reject(
    'function extra(s: string): string { return String(([s] as RegExpExecArray).index); }',
    /asserted/,
  );
});

test('rejected: rendering reads a RegExp whose lastIndex changes', async () => {
  const g = await edits('patterns-svelte', 'App.svelte', [
    ['<p id="dates">{dates}</p>', '<p id="dates">{dates} {PLACEHOLDER.lastIndex}</p>'],
    [
      '  function sample(text: string) {',
      '  function sample(text: string) {\n    PLACEHOLDER.test(text);',
    ],
  ]);
  await assert.rejects(lower(g), e => {
    assert.equal(e.code, 'E_REACTIVITY', e.message);
    assert.match(e.message, /lastIndex/);
    return true;
  });
  // A literal without g or y never changes its lastIndex.
  const ok = await edits('patterns-svelte', 'App.svelte', [
    ['<p id="dates">{dates}</p>', '<p id="dates">{dates} {IDENT.lastIndex}</p>'],
    [
      '  function sample(text: string) {',
      '  function sample(text: string) {\n    IDENT.test(text);',
    ],
  ]);
  await lower(ok);
});
