import { createHash } from 'node:crypto';
import { Diagnostic, hash } from './collect.mjs';

export const LIMIT = 1_000_000;
export const STATE_LIMIT = 64;
export const TEXT_LIMIT = 256;
export function validateText(value, source) {
  if (
    typeof value !== 'string' ||
    value.length > TEXT_LIMIT ||
    /[\u0000-\u001f\u007f\uD800-\uDFFF]/u.test(value)
  )
    error(
      'Text payload must be single-line Unicode scalar text of at most 256 UTF-16 units',
      source,
      'E_TEXT_PAYLOAD',
    );
  return value;
}
export const TAGS = [
  'input',
  'main',
  'article',
  'section',
  'div',
  'span',
  'p',
  'h1',
  'h2',
  'button',
  'strong',
  'small',
  'header',
  'footer',
];
const TYPES = ['number', 'boolean', 'string'];
const object = x =>
  x &&
  typeof x === 'object' &&
  !Array.isArray(x) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(x));
const error = (message, source, code = 'E_IR') => {
  throw new Diagnostic(code, message, source);
};
function shape(value, required, optional = [], source) {
  if (
    !object(value) ||
    required.some(k => !Object.hasOwn(value, k)) ||
    Object.keys(value).some(k => ![...required, ...optional].includes(k))
  )
    error('Invalid fields in serialized IR', source);
}
function source(value) {
  if (value === undefined) return;
  shape(value, ['file', 'line', 'column']);
  if (
    typeof value.file !== 'string' ||
    value.file.length > 4096 ||
    !Number.isInteger(value.line) ||
    value.line < 1 ||
    !Number.isInteger(value.column) ||
    value.column < 1
  )
    error('Invalid source location');
}
export function literal(value, source) {
  if (typeof value === 'string' && value.length > 65536)
    error('A text literal exceeds 65536 code units', source, 'E_RESOURCE');
  if (
    typeof value === 'string' &&
    (/[\u0000-\u0008\u000b-\u001f\u007f]/u.test(value) || /[\uD800-\uDFFF]/u.test(value))
  )
    error(
      'Text must contain Unicode scalar values without unsupported control characters',
      source,
      'E_STRING',
    );
  return { op: 'literal', value, type: typeof value, effect: 'pure', source };
}
export function deps(expr) {
  const children = Object.values(expr ?? {})
    .filter(v => object(v) && v.op)
    .concat(expr?.args ?? [], expr?.requirements ?? []);
  return [
    ...new Set([...(expr?.op === 'state' ? [expr.slot] : []), ...children.flatMap(deps)]),
  ].sort((a, b) => a - b);
}
const numeric = (x, source) => {
  if (!Number.isSafeInteger(x) || Object.is(x, -0) || Math.abs(x) > LIMIT)
    error('Value ' + x + ' leaves the exact finite-integer domain', source, 'E_NUMBER');
  return x;
};
export function evaluate(e, state, previous, payload) {
  const ev = x => evaluate(x, state, previous, payload);
  let v;
  switch (e.op) {
    case 'literal':
      v = e.value;
      break;
    case 'state':
      v = state[e.slot];
      break;
    case 'previous':
      v = previous;
      break;
    case 'payload':
      v = payload;
      break;
    case 'utf16-length':
      v = ev(e.arg).length;
      break;
    case 'boolean-text':
      v = String(ev(e.arg));
      break;
    case 'not':
      v = !ev(e.arg);
      break;
    case 'neg':
      v = -ev(e.arg);
      break;
    case 'select':
      v = ev(e.test) ? ev(e.yes) : ev(e.no);
      break;
    case 'and':
      v = ev(e.left) && ev(e.right);
      break;
    case 'or':
      v = ev(e.left) || ev(e.right);
      break;
    case 'add':
      v = ev(e.left) + ev(e.right);
      break;
    case 'sub':
      v = ev(e.left) - ev(e.right);
      break;
    case 'mul':
      v = ev(e.left) * ev(e.right);
      break;
    case 'eq':
      v = ev(e.left) === ev(e.right);
      break;
    case 'ne':
      v = ev(e.left) !== ev(e.right);
      break;
    case 'lt':
      v = ev(e.left) < ev(e.right);
      break;
    case 'le':
      v = ev(e.left) <= ev(e.right);
      break;
    case 'gt':
      v = ev(e.left) > ev(e.right);
      break;
    case 'ge':
      v = ev(e.left) >= ev(e.right);
      break;
    case 'min':
      v = Math.min(...e.args.map(ev));
      break;
    case 'max':
      v = Math.max(...e.args.map(ev));
      break;
    case 'mapping': {
      // JS evaluates every argument, including ones removed by a rewrite.
      e.args.forEach(ev);
      if (e.requirements.some(p => !ev(p)))
        error(
          'Mapping ' + e.rule + ' precondition fails in a reachable execution',
          e.source,
          'E_MAPPING_PRECONDITION',
        );
      const reference = ev(e.reference);
      v = ev(e.value);
      if (!Object.is(reference, v))
        error(
          'Mapping ' + e.rule + ' differs in a reachable execution',
          e.source,
          'E_RULE_DIFFERENTIAL',
        );
      break;
    }
    default:
      error('Unknown operation ' + e.op, e.source);
  }
  return typeof v === 'number' ? numeric(v, e.source) : v;
}
export function render(ir, state) {
  const walk = n => {
    if (n.kind === 'text')
      return {
        id: n.id,
        kind: 'text',
        text: n.parts
          .map(e => {
            const v = evaluate(e, state);
            return typeof v === 'boolean' ? '' : String(v);
          })
          .join(''),
      };
    if (n.kind === 'conditional')
      return {
        id: n.id,
        kind: 'conditional',
        children: evaluate(n.test, state) ? n.children.map(walk) : [],
      };
    return {
      id: n.id,
      kind: 'element',
      tag: n.tag,
      attrs: Object.fromEntries(Object.entries(n.attrs).map(([k, e]) => [k, evaluate(e, state)])),
      children: n.children.map(walk),
      event: n.event,
    };
  };
  return walk(ir.ui);
}
export function eventNode(ir, event, state) {
  const visit = n => (n.event === event ? n : (n.children ?? []).map(visit).find(Boolean));
  return visit(render(ir, state));
}
export function transition(ir, state, event, payload) {
  if (!Number.isInteger(event) || event < 0 || event >= ir.handlers.length)
    error('Unknown event identity');
  if (ir.handlers[event].kind === 'text-input') validateText(payload);
  else if (payload !== undefined)
    error('Click events cannot carry a payload', undefined, 'E_TEXT_PAYLOAD');
  const node = eventNode(ir, event, state);
  if (
    !node ||
    node.attrs.disabled === true ||
    (ir.handlers[event].kind === 'text-input' && node.attrs.readonly === true)
  )
    return [...state];
  const next = [...state];
  for (const u of ir.handlers[event].updates) {
    const value = evaluate(u.value, state, next[u.slot], payload);
    if (typeof value !== ir.states[u.slot].type)
      error('State type must remain constant', u.source, 'E_STATE_TYPE');
    if (typeof value === 'number' && Math.abs(value) > STATE_LIMIT)
      error(
        'State transition reaches ' + value + '; accepted state domain is [-64,64]',
        u.source,
        'E_STATE_BOUND',
      );
    if (ir.states[u.slot].domain?.kind === 'text') validateText(value, u.source);
    if (typeof value === 'string' && value.length > 256)
      error(
        'String enum alternatives are limited to 256 UTF-16 code units',
        u.source,
        'E_STATE_BOUND',
      );
    next[u.slot] = value;
  }
  return next;
}
export function validateIR(ir) {
  shape(
    ir,
    [
      'schema',
      'sourceHash',
      'frontend',
      'title',
      'states',
      'handlers',
      'ui',
      'css',
      'assets',
      'mappings',
      'capabilities',
      'provenance',
    ],
    ['validation', 'irHash', 'container'],
  );
  if (
    ![2, 3].includes(ir.schema) ||
    typeof ir.title !== 'string' ||
    ir.title.length > 256 ||
    typeof ir.css !== 'string' ||
    ir.css.length > 4 * 1024 * 1024 ||
    !/^([a-f0-9]{64})$/.test(ir.sourceHash)
  )
    error('Invalid IR envelope');
  if (
    !Array.isArray(ir.states) ||
    ir.states.length > 16 ||
    !Array.isArray(ir.handlers) ||
    ir.handlers.length > 64
  )
    error('Invalid state or handler list');
  for (const [i, s] of ir.states.entries()) {
    shape(s, ['id', 'name', 'type', 'initial'], ['source', 'domain']);
    source(s.source);
    if (
      s.id !== i ||
      typeof s.name !== 'string' ||
      !TYPES.includes(s.type) ||
      typeof s.initial !== s.type
    )
      error('Invalid state declaration', s.source);
    literal(s.initial, s.source);
    if (s.type === 'number') {
      numeric(s.initial, s.source);
      if (Math.abs(s.initial) > STATE_LIMIT)
        error('Invalid initial state', s.source, 'E_STATE_BOUND');
    }
    if (s.type === 'string' && s.initial.length > 256)
      error('Initial string enum value exceeds 256 code units', s.source, 'E_STATE_BOUND');
    if (s.domain?.kind === 'text') {
      shape(s.domain, ['kind', 'maxUtf16']);
      if (ir.schema !== 3 || s.type !== 'string' || s.domain.maxUtf16 !== TEXT_LIMIT)
        error('Invalid text state domain', s.source);
      validateText(s.initial, s.source);
    } else if (s.domain !== undefined) {
      shape(s.domain, ['kind', 'values']);
      if (
        !['finite-integer', 'finite-string', 'boolean'].includes(s.domain.kind) ||
        !Array.isArray(s.domain.values) ||
        s.domain.values.length > 129 ||
        s.domain.values.some(v => typeof v !== s.type)
      )
        error('Invalid declared state domain', s.source);
    }
  }
  if (
    !Array.isArray(ir.capabilities) ||
    ir.capabilities.some(
      c =>
        ![
          'dom',
          'css',
          'window',
          'click',
          'keyboard',
          'finite-state',
          ...(ir.schema === 3 ? ['text-input'] : []),
        ].includes(c),
    ) ||
    new Set(ir.capabilities).size !== ir.capabilities.length
  )
    error('Unknown runtime capability');
  if (
    !Array.isArray(ir.assets) ||
    !Array.isArray(ir.mappings) ||
    !Array.isArray(ir.provenance) ||
    !object(ir.frontend)
  )
    error('Invalid IR metadata');
  if (ir.schema === 2) {
    shape(ir.frontend, ['react', 'vite', 'typescript']);
    if (Object.values(ir.frontend).some(v => typeof v !== 'string' || v.length > 64))
      error('Invalid frontend versions');
  } else {
    shape(ir.frontend, ['adapter', 'version', 'packages', 'tools']);
    if (
      typeof ir.frontend.adapter !== 'string' ||
      !/^[-a-z0-9]{1,64}$/.test(ir.frontend.adapter) ||
      !Number.isInteger(ir.frontend.version) ||
      ir.frontend.version < 1
    )
      error('Invalid adapter identity');
    for (const versions of [ir.frontend.packages, ir.frontend.tools])
      if (
        !object(versions) ||
        Object.keys(versions).length > 32 ||
        Object.entries(versions).some(
          ([k, v]) => !k || k.length > 128 || typeof v !== 'string' || !v || v.length > 64,
        )
      )
        error('Invalid dependency identities');
  }
  if (ir.assets.length > 64 || ir.mappings.length > 128 || ir.provenance.length > 256)
    error('Metadata exceeds resource limits');
  for (const a of ir.assets) {
    shape(a, ['path', 'sha256', 'bytes', 'mime']);
    if (
      typeof a.path !== 'string' ||
      !a.path ||
      a.path.startsWith('/') ||
      a.path.split('/').includes('..') ||
      !Number.isInteger(a.bytes) ||
      a.bytes < 1 ||
      a.bytes > 1048576 ||
      a.mime !== 'font/woff2' ||
      typeof a.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(a.sha256)
    )
      error('Invalid embedded asset');
  }
  for (const m of ir.mappings) {
    shape(m, ['id', 'version', 'sha256']);
    if (
      typeof m.id !== 'string' ||
      !/^[-a-z0-9]{1,64}$/.test(m.id) ||
      !Number.isInteger(m.version) ||
      m.version < 1 ||
      typeof m.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(m.sha256)
    )
      error('Invalid mapping identity');
  }
  for (const p of ir.provenance) {
    shape(p, ['path', 'sha256', 'imports']);
    if (
      typeof p.path !== 'string' ||
      typeof p.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.sha256) ||
      !Array.isArray(p.imports) ||
      p.imports.length > 128
    )
      error('Invalid source provenance');
    for (const i of p.imports) {
      shape(i, ['specifier', 'resolved']);
      if (typeof i.specifier !== 'string' || typeof i.resolved !== 'string')
        error('Invalid resolved import');
    }
  }
  if (ir.validation !== undefined) {
    shape(ir.validation, ['reachableStates', 'transitions', 'transitionHash', 'domain']);
    if (
      !Number.isInteger(ir.validation.reachableStates) ||
      !Number.isInteger(ir.validation.transitions) ||
      typeof ir.validation.transitionHash !== 'string' ||
      typeof ir.validation.domain !== 'string'
    )
      error('Invalid validation metadata');
  }
  const textSlots = ir.states.filter(s => s.domain?.kind === 'text');
  if (textSlots.length > 1)
    error('This text contract supports one text state', undefined, 'E_TEXT_DOMAIN');
  const open = e =>
    e.op === 'payload' ||
    (e.op === 'state' && ir.states[e.slot].domain?.kind === 'text') ||
    (e.op === 'previous' && previousText) ||
    (e.op === 'select' && (open(e.yes) || open(e.no)));
  let payloadContext = false,
    previousText = false;
  const path = new WeakSet();
  let expressionCount = 0,
    textUnits = 0;
  const expr = (e, previousType, depth = 0) => {
    if (depth > 64 || ++expressionCount > 32768 || !object(e) || path.has(e))
      error('Invalid or excessive expression tree', e?.source);
    path.add(e);
    source(e.source);
    const fields = {
      literal: ['value'],
      state: ['slot'],
      previous: [],
      ...(ir.schema === 3 ? { payload: [], 'utf16-length': ['arg'], 'boolean-text': ['arg'] } : {}),
      not: ['arg'],
      neg: ['arg'],
      select: ['test', 'yes', 'no'],
      and: ['left', 'right'],
      or: ['left', 'right'],
      add: ['left', 'right'],
      sub: ['left', 'right'],
      mul: ['left', 'right'],
      eq: ['left', 'right'],
      ne: ['left', 'right'],
      lt: ['left', 'right'],
      le: ['left', 'right'],
      gt: ['left', 'right'],
      ge: ['left', 'right'],
      min: ['args'],
      max: ['args'],
      mapping: ['args', 'reference', 'value', 'requirements', 'rule'],
    }[e.op];
    if (!fields || e.effect !== 'pure' || !TYPES.includes(e.type))
      error('Unknown expression or invalid type/effect', e.source);
    shape(e, ['op', 'type', 'effect', ...fields], ['source'], e.source);
    for (const key of fields.filter(
      k =>
        ['arg', 'left', 'right', 'test', 'yes', 'no', 'reference', 'value'].includes(k) &&
        e.op !== 'literal',
    ))
      if (!object(e[key]) || typeof e[key].op !== 'string')
        error('Missing expression child ' + key, e.source);
    if (e.op === 'literal') {
      if (typeof e.value !== e.type) error('Literal type mismatch', e.source);
      literal(e.value, e.source);
      if (e.type === 'string' && (textUnits += e.value.length) > 1048576)
        error('UI text exceeds 1 MiB', e.source, 'E_RESOURCE');
      if (e.type === 'number') numeric(e.value, e.source);
    }
    if (
      e.op === 'state' &&
      (!Number.isInteger(e.slot) || !ir.states[e.slot] || ir.states[e.slot].type !== e.type)
    )
      error('Invalid state reference', e.source);
    if (e.op === 'payload' && (e.type !== 'string' || !payloadContext))
      error('Text payload outside a typed input handler', e.source);
    if (e.op === 'boolean-text' && (e.arg.type !== 'boolean' || e.type !== 'string'))
      error('Boolean text type mismatch', e.source);
    if (e.op === 'utf16-length' && (e.arg.type !== 'string' || e.type !== 'number'))
      error('UTF-16 length type mismatch', e.source);
    if (e.op === 'previous' && e.type !== previousType)
      error('Previous value outside its typed updater', e.source);
    if (['min', 'max'].includes(e.op) && (!Array.isArray(e.args) || e.args.length !== 2))
      error('Min/max require two arguments', e.source);
    if (
      e.op === 'mapping' &&
      (!Array.isArray(e.args) ||
        e.args.length < 1 ||
        e.args.length > 4 ||
        !Array.isArray(e.requirements) ||
        e.requirements.length > 16 ||
        typeof e.rule !== 'string')
    )
      error('Invalid mapping expression', e.source);
    const children = Object.values(e)
      .filter(v => object(v) && v.op)
      .concat(e.args ?? [], e.requirements ?? []);
    children.forEach(c => expr(c, previousType, depth + 1));
    const all = t => children.every(c => c.type === t);
    if (
      ['add', 'sub', 'mul', 'min', 'max', 'neg'].includes(e.op) &&
      (!all('number') || e.type !== 'number')
    )
      error('Numeric operation type mismatch', e.source);
    if (['not', 'and', 'or'].includes(e.op) && (!all('boolean') || e.type !== 'boolean'))
      error('Boolean operation type mismatch', e.source);
    if (['lt', 'le', 'gt', 'ge'].includes(e.op) && (!all('number') || e.type !== 'boolean'))
      error('Comparison type mismatch', e.source);
    if (['eq', 'ne'].includes(e.op) && (e.left.type !== e.right.type || e.type !== 'boolean'))
      error('Equality type mismatch', e.source);
    if (
      e.op === 'select' &&
      (e.test.type !== 'boolean' || e.yes.type !== e.no.type || e.type !== e.yes.type)
    )
      error('Selection type mismatch', e.source);
    if (
      e.op === 'mapping' &&
      (e.args.some(x => x.type !== 'number') ||
        e.requirements.some(x => x.type !== 'boolean') ||
        e.reference.type !== e.type ||
        e.value.type !== e.type)
    )
      error('Mapping type mismatch', e.source);
    if (
      ['eq', 'ne'].includes(e.op) &&
      (open(e.left) || open(e.right)) &&
      !(
        (e.left.op === 'literal' && e.left.value === '') ||
        (e.right.op === 'literal' && e.right.value === '')
      )
    )
      error(
        'Open text equality supports only empty-string comparisons',
        e.source,
        'E_TEXT_OPERATION',
      );
    path.delete(e);
  };
  const ids = new Set(),
    elementIds = new Set(),
    events = new Set();
  const walk = (n, depth = 0, phrasing = false, conditional = false) => {
    if (
      depth > 64 ||
      !object(n) ||
      typeof n.id !== 'string' ||
      !/^u\d+$/.test(n.id) ||
      ids.has(n.id) ||
      ids.size >= 1024
    )
      error('Invalid, duplicate or excessive UI identity', n?.source);
    ids.add(n.id);
    source(n.source);
    if (n.kind === 'text') {
      shape(n, ['id', 'kind', 'parts'], ['source']);
      if (!Array.isArray(n.parts) || n.parts.length < 1 || n.parts.length > 64)
        error('Invalid text parts', n.source);
      n.parts.forEach(e => expr(e));
      return;
    }
    if (n.kind === 'conditional') {
      shape(n, ['id', 'kind', 'test', 'children'], ['source']);
      expr(n.test);
      if (n.test.type !== 'boolean') error('Conditional requires boolean', n.source);
    } else if (n.kind === 'element') {
      shape(n, ['id', 'kind', 'tag', 'attrs', 'children'], ['event', 'source']);
      if (
        !TAGS.includes(n.tag) ||
        !object(n.attrs) ||
        (phrasing && !['input', 'span', 'strong', 'small'].includes(n.tag))
      )
        error('Invalid tag or content model', n.source);
      for (const [k, e] of Object.entries(n.attrs)) {
        if (
          ![
            'id',
            'class',
            'disabled',
            'title',
            'aria-label',
            'type',
            ...(ir.schema === 3 ? ['value', 'readonly', 'maxlength'] : []),
          ].includes(k) ||
          e?.type !==
            (['disabled', 'readonly'].includes(k)
              ? 'boolean'
              : k === 'maxlength'
                ? 'number'
                : 'string')
        )
          error('Invalid attribute', n.source);
        expr(e);
        if (open(e) && k !== 'value')
          error(
            'Open text is restricted to text nodes and live input values',
            n.source,
            'E_TEXT_OPERATION',
          );
        if (k === 'id') {
          if (e.op !== 'literal' || !/^[-a-zA-Z0-9_]+$/.test(e.value) || elementIds.has(e.value))
            error('Invalid or duplicate element ID', n.source);
          elementIds.add(e.value);
        }
        if (
          k === 'type' &&
          (!['button', 'input'].includes(n.tag) ||
            e.op !== 'literal' ||
            e.value !== (n.tag === 'input' ? 'text' : 'button'))
        )
          error('Invalid button type', n.source);
      }
      if (n.event !== undefined) {
        if (
          !['button', ...(ir.schema === 3 ? ['input'] : [])].includes(n.tag) ||
          !Number.isInteger(n.event) ||
          !ir.handlers[n.event] ||
          events.has(n.event)
        )
          error('Invalid event target', n.source);
        events.add(n.event);
      }
      if (n.tag === 'input') {
        if (
          conditional ||
          n.children?.length ||
          n.attrs.value?.op !== 'state' ||
          ir.states[n.attrs.value.slot]?.domain?.kind !== 'text' ||
          n.attrs.type?.value !== 'text' ||
          n.attrs.maxlength?.op !== 'literal' ||
          n.attrs.maxlength.value !== TEXT_LIMIT ||
          ir.handlers[n.event]?.kind !== 'text-input'
        )
          error('Invalid controlled text input', n.source, 'E_TEXT_CONTROL');
        const h = ir.handlers[n.event];
        if (
          h.updates?.length !== 1 ||
          h.updates[0].slot !== n.attrs.value.slot ||
          h.updates[0].value?.op !== 'payload'
        )
          error(
            'Text events must copy payload directly to the bound state',
            n.source,
            'E_TEXT_CONTROL',
          );
      } else if (['value', 'readonly', 'maxlength'].some(k => Object.hasOwn(n.attrs, k)))
        error('Text properties require an input', n.source);
      phrasing = ['p', 'h1', 'h2', 'button', 'span', 'strong', 'small'].includes(n.tag);
    } else error('Unknown UI kind', n.source);
    if (!Array.isArray(n.children) || n.children.length > 1024)
      error('Invalid UI children', n.source);
    n.children.forEach(c => walk(c, depth + 1, phrasing, conditional || n.kind === 'conditional'));
  };
  walk(ir.ui);
  for (const [i, h] of ir.handlers.entries()) {
    shape(h, ['id', 'updates', ...(ir.schema === 3 ? ['kind'] : [])], ['source']);
    if (ir.schema === 3 && !['click', 'text-input'].includes(h.kind))
      error('Invalid typed event', h.source);
    source(h.source);
    if (
      h.id !== i ||
      !events.has(i) ||
      !Array.isArray(h.updates) ||
      h.updates.length < 1 ||
      h.updates.length > 64
    )
      error('Invalid or orphan handler', h.source);
    payloadContext = h.kind === 'text-input';
    for (const u of h.updates) {
      shape(u, ['slot', 'value'], ['source']);
      source(u.source);
      if (
        !Number.isInteger(u.slot) ||
        !ir.states[u.slot] ||
        ir.states[u.slot].type !== u.value?.type
      )
        error('Update type mismatch', u.source);
      previousText = ir.states[u.slot].domain?.kind === 'text';
      expr(u.value, ir.states[u.slot].type);
    }
  }
  const project = s =>
    s.map((v, i) => (ir.states[i].domain?.kind === 'text' ? 'a'.repeat(v.length) : v));
  const initial = project(ir.states.map(s => s.initial)),
    queue = [initial],
    seen = new Set([JSON.stringify(initial)]),
    edges = [],
    digest = createHash('sha256');
  let transitionCount = 0;
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i];
    render(ir, s);
    for (let event = 0; event < ir.handlers.length; event++) {
      const payloads =
        ir.handlers[event].kind === 'text-input'
          ? Array.from({ length: TEXT_LIMIT + 1 }, (_, n) => 'a'.repeat(n))
          : [undefined];
      for (const payload of payloads) {
        const next = project(transition(ir, s, event, payload));
        render(ir, next);
        const edge = { from: s, event, ...(payload === undefined ? {} : { payload }), to: next };
        transitionCount++;
        if (textSlots.length) digest.update(JSON.stringify(edge) + '\n');
        else edges.push(edge);
        const key = JSON.stringify(next);
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(next);
          if (queue.length > 4096)
            error('Reachability exceeds 4096 states', ir.handlers[event].source, 'E_STATE_SPACE');
        }
      }
    }
  }
  ir.states.forEach((slot, i) => {
    if (slot.domain?.kind === 'text') return;
    const values = [...new Set(queue.map(s => s[i]))];
    if (slot.type === 'number') values.sort((a, b) => a - b);
    if (slot.type === 'string') values.sort();
    if (slot.type === 'string' && values.length > 32)
      error('A string state has more than 32 literal alternatives', slot.source, 'E_STATE_BOUND');
    const domain = {
      kind:
        slot.type === 'number'
          ? 'finite-integer'
          : slot.type === 'string'
            ? 'finite-string'
            : 'boolean',
      values,
    };
    if (slot.domain !== undefined && JSON.stringify(slot.domain) !== JSON.stringify(domain))
      error('Declared domain differs from reachable domain', slot.source);
    slot.domain = domain;
  });
  const validation = {
    reachableStates: queue.length,
    transitions: transitionCount,
    transitionHash: textSlots.length ? digest.digest('hex') : hash(edges),
    domain: textSlots.length
      ? 'length-quotient-v1: one scalar single-line text <= 256 UTF-16 units; copy/reset, empty equality, UTF-16 length; exact finite control closure'
      : 'exact integers |x| <= 1000000; state |x| <= 64; finite string enums <= 32 alternatives',
  };
  if (ir.validation !== undefined && JSON.stringify(ir.validation) !== JSON.stringify(validation))
    error('Stale validation metadata');
  if (ir.irHash !== undefined) {
    const { irHash, ...body } = ir;
    if (typeof irHash !== 'string' || irHash !== hash(body))
      error('IR content hash differs from serialized contents');
  }
  ir.validation = validation;
  return { ir, reachable: queue, edges };
}

// Explicit migration keeps old serialized inputs usable without rewriting their evidence.
export function migrateIR(ir) {
  validateIR(ir);
  if (ir.schema === 3) return structuredClone(ir);
  const next = structuredClone(ir);
  delete next.irHash;
  delete next.validation;
  next.schema = 3;
  next.frontend = {
    adapter: 'react',
    version: 1,
    packages: { react: ir.frontend.react },
    tools: { vite: ir.frontend.vite, typescript: ir.frontend.typescript },
  };
  next.handlers.forEach(h => (h.kind = 'click'));
  validateIR(next);
  next.irHash = hash(next);
  return next;
}
