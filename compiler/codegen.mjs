import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { deps, validateIR } from './ir.mjs';
import { repository } from './mappings.mjs';
import { hash, Diagnostic } from './collect.mjs';

const quote = s => JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, '\\u{$1}');
export function expression(e, previous = '0i64') {
  const sub = x => expression(x, previous);
  switch (e.op) {
    case 'literal':
      return typeof e.value === 'string'
        ? `${quote(e.value)}.to_string()`
        : typeof e.value === 'number'
          ? `${e.value}i64`
          : String(e.value);
    case 'state':
      return `s.s${e.slot}${e.type === 'string' ? '.clone()' : ''}`;
    case 'payload':
      return 'payload.expect("typed payload").to_string()';
    case 'boolean-text':
      return `(${sub(e.arg)}).to_string()`;
    case 'utf16-length':
      return `((${sub(e.arg)}).encode_utf16().count() as i64)`;
    case 'previous':
      return e.type === 'string' ? `(${previous}).clone()` : previous;
    case 'mapping':
      return sub(e.value);
    case 'not':
      return `(!${sub(e.arg)})`;
    case 'neg':
      return `(-${sub(e.arg)})`;
    case 'select':
      return `(if ${sub(e.test)} { ${sub(e.yes)} } else { ${sub(e.no)} })`;
    case 'min':
    case 'max':
      return `(${sub(e.args[0])}).${e.op}(${sub(e.args[1])})`;
    default:
      return `(${sub(e.left)} ${{ add: '+', sub: '-', mul: '*', eq: '==', ne: '!=', lt: '<', le: '<=', gt: '>', ge: '>=', and: '&&', or: '||' }[e.op]} ${sub(e.right)})`;
  }
}
const flat = n => [n, ...(n.children ?? []).flatMap(flat)];
export function generate(ir, optimize = true) {
  validateIR(ir);
  ir.irHash ??= hash(ir);
  const nodes = flat(ir.ui),
    bindings = [],
    events = [],
    functions = [];
  const text = p => (p.type === 'boolean' ? 'String::new()' : `(${expression(p)}).to_string()`);
  for (const n of nodes) {
    let body = 'let mut out=String::new();\n';
    if (n.kind === 'text') {
      body += `out.push_str(${quote(`<runic-text data-runic="${n.id}">`)});\n`;
      n.parts.forEach(p => {
        body += `out.push_str(&escape(&${text(p)}));\n`;
      });
      body += 'out.push_str("</runic-text>");\n';
      if (n.parts.some(p => deps(p).length))
        bindings.push(
          `Binding { id:${quote(n.id)},kind:Kind::Text, deps:&[${[...new Set(n.parts.flatMap(deps))]}], value:|s| { ${n.parts.map(p => text(p)).join(' + &')} } }`,
        );
    } else if (n.kind === 'conditional') {
      body += `out.push_str(${quote(`<runic-if data-runic="${n.id}">`)}); if ${expression(n.test)} { ${n.children.map(c => `out.push_str(&node_${c.id}(s));`).join('\n')} } out.push_str("</runic-if>");\n`;
      bindings.push(
        `Binding {id:${quote(n.id)},kind:Kind::Conditional(|s| ${n.children.map(c => `node_${c.id}(s)`).join(' + &')}),deps:&[${deps(n.test)}],value:|s| (${expression(n.test)}).to_string() }`,
      );
    } else {
      body += `out.push_str(${quote(`<${n.tag} data-runic="${n.id}"`)});\n`;
      for (const [name, value] of Object.entries(n.attrs)) {
        if (value.type === 'boolean')
          body += `if ${expression(value)} { out.push_str(${quote(` ${name}=""`)}); }\n`;
        else
          body += `out.push_str(${quote(` ${name}="`)});out.push_str(&escape(&(${expression(value)}).to_string()));out.push('"');\n`;
        if (deps(value).length)
          bindings.push(
            `Binding {id:${quote(n.id)},kind:${name === 'value' ? 'Kind::LiveValue' : `Kind::Attribute(${quote(name)},${value.type === 'boolean'})`},deps:&[${deps(value)}],value:|s| (${expression(value)}).to_string()}`,
          );
      }
      body += `out.push('>'); ${n.children.map(c => `out.push_str(&node_${c.id}(s));`).join('\n')} ${n.tag === 'input' ? '' : `out.push_str(${quote(`</${n.tag}>`)});`}\n`;
      if (n.event !== undefined) events.push(`(${quote(n.id)},${n.event})`);
    }
    functions.push(`fn node_${n.id}(s:&State)->String { ${body} out }`);
  }
  const conditions = new Map(),
    focusConditions = new Map();
  const walk = (n, anc = []) => {
    if (n.event !== undefined) {
      const guards = [...anc, ...(n.attrs.disabled ? [{ op: 'not', arg: n.attrs.disabled }] : [])];
      focusConditions.set(n.event, guards);
      conditions.set(n.event, [
        ...guards,
        ...(n.tag === 'input' && n.attrs.readonly ? [{ op: 'not', arg: n.attrs.readonly }] : []),
      ]);
    }
    (n.children ?? []).forEach(c => walk(c, n.kind === 'conditional' ? [...anc, n.test] : anc));
  };
  walk(ir.ui);
  return `// Generated from validated framework-independent IR ${ir.irHash}. Do not edit.
#![allow(unused_parens,unused_variables,dead_code)]
use crate::runtime::{Binding,Kind,escape};
#[derive(Clone,Debug,PartialEq)] pub struct State { ${ir.states.map((s, i) => `pub s${i}:${s.type === 'number' ? 'i64' : s.type === 'string' ? 'String' : 'bool'}`).join(',')} }
pub const TITLE:&str=${quote(ir.title)};
pub const CSS:&str=${quote(ir.css)};
pub const OPTIMIZE:bool=${optimize};
pub const IR_HASH:&str=${quote(ir.irHash)};
pub fn initial()->State { State {${ir.states.map((s, i) => `s${i}:${expression({ op: 'literal', value: s.initial, type: s.type })}`).join(',')}} }
pub fn json(s:&State)->serde_json::Value { serde_json::json!([${ir.states.map((_, i) => `s.s${i}`).join(',')}]) }
pub fn from_json(values:&serde_json::Value)->State { State {${ir.states.map((s, i) => `s${i}:values[${i}].${s.type === 'number' ? 'as_i64' : s.type === 'string' ? 'as_str' : 'as_bool'}().expect("state type")${s.type === 'string' ? '.to_string()' : ''}`).join(',')}} }
pub fn enabled(event:usize,s:&State)->bool { match event {${ir.handlers
    .map(
      (h, i) =>
        `${i}=>${
          conditions
            .get(i)
            .map(e => expression(e))
            .join(' && ') || 'true'
        }`,
    )
    .join(',')},_=>false} }
pub fn focusable(event:usize,s:&State)->bool { match event {${ir.handlers
    .map(
      (h, i) =>
        `${i}=>${
          focusConditions
            .get(i)
            .map(e => expression(e))
            .join(' && ') || 'true'
        }`,
    )
    .join(',')},_=>false} }
pub fn is_text_event(event:usize)->bool { matches!(event,${
    ir.handlers
      .filter(h => h.kind === 'text-input')
      .map(h => h.id)
      .join('|') || 'usize::MAX'
  }) }
pub fn valid_text(value:&str)->bool { value.encode_utf16().count()<=256 && !value.chars().any(|c| c<' ' || c=='\\u{7f}') }
pub fn dispatch_event(state:&mut State,event:usize,payload:Option<&str>)->Result<Vec<bool>,String> {
 if event>=EVENTS.len() { return Err("Unknown event".into()); }
 if is_text_event(event) { if !payload.is_some_and(valid_text) { return Err("Invalid typed text payload".into()); } }
 else if payload.is_some() { return Err("Click cannot carry text".into()); }
 let s=state.clone(); let mut next=s.clone();
 if enabled(event,&s) { match event {
 ${ir.handlers.map((h, i) => `${i}=>{${h.updates.map(u => `next.s${u.slot}=${expression(u.value, `next.s${u.slot}`)};${ir.states[u.slot].domain?.kind === 'text' ? `assert!(valid_text(&next.s${u.slot}));` : ''}${ir.states[u.slot].type === 'number' ? `assert!(next.s${u.slot}.abs()<=64);` : ''}`).join('\n')}}`).join(',')},_=>{} } }
 let changed=vec![${ir.states.map((_, i) => `next.s${i}!=s.s${i}`).join(',')}]; *state=next; Ok(changed)
}
pub fn dispatch(state:&mut State,event:usize)->Vec<bool> { dispatch_event(state,event,None).expect("click event") }
pub const BINDINGS:&[Binding]=&[${bindings.join(',\n')}];
pub const EVENTS:&[(&str,usize)]=&[${events.join(',')}];
pub const ELEMENTS:&[&str]=&[${nodes
    .filter(n => n.kind === 'element' && n.attrs.id)
    .map(n => quote(n.attrs.id.value))
    .join(',')}];
pub fn body(s:&State)->String { node_${ir.ui.id}(s) }
${functions.join('\n')}
`;
}
export async function emit(ir, out, optimize = true) {
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'app.rs'), generate(ir, optimize));
  await copyFile(path.join(repository, 'native/runtime.rs'), path.join(out, 'runtime.rs'));
  await copyFile(path.join(repository, 'native/controls.rs'), path.join(out, 'controls.rs'));
  await writeFile(
    path.join(out, 'main.rs'),
    'mod app; mod controls; mod runtime; fn main() { runtime::launch(); }\n',
  );
  const cargo = await readFile(path.join(repository, 'Cargo.toml'), 'utf8');
  await writeFile(
    path.join(out, 'Cargo.toml'),
    cargo.split('[[bin]]')[0] + '[[bin]]\nname = "runic-app"\npath = "main.rs"\n',
  );
  await copyFile(path.join(repository, 'Cargo.lock'), path.join(out, 'Cargo.lock'));
  await writeFile(path.join(out, 'ir.json'), JSON.stringify(ir, null, 2) + '\n');
  return out;
}
export async function inspectNativeInputs(ir, out, optimize = true) {
  const cargo = await readFile(path.join(repository, 'Cargo.toml'), 'utf8');
  const expected = {
    'app.rs': generate(ir, optimize),
    'controls.rs': await readFile(path.join(repository, 'native/controls.rs')),
    'runtime.rs': await readFile(path.join(repository, 'native/runtime.rs')),
    'Cargo.lock': await readFile(path.join(repository, 'Cargo.lock')),
    'Cargo.toml': cargo.split('[[bin]]')[0] + '[[bin]]\nname = "runic-app"\npath = "main.rs"\n',
    'main.rs': 'mod app; mod controls; mod runtime; fn main() { runtime::launch(); }\n',
  };
  const hashes = {};
  for (const [file, bytes] of Object.entries(expected)) {
    const actual = await readFile(path.join(out, file));
    if (hash(actual) !== hash(bytes))
      throw new Diagnostic(
        'E_COMPARE_BUILD',
        'Native source/lock artifact is stale: ' + file + '; rebuild before verification',
      );
    hashes[file] = hash(actual);
  }
  return hashes;
}
