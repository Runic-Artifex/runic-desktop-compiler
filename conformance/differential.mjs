#!/usr/bin/env node
// Differential test of generated code against the reference interpreter (D8):
// seeded random event traces run through `runic-codegen interp` and through
// the native probe; DOM and cells must agree after every step. A failed native
// probe fails its trace and the run goes on; a fixture whose generated inputs
// are missing (`runic generate`, never run here) is incomplete.
//
//   node conformance/differential.mjs [fixture ...] [--traces N] [--length N] [--seed S] [--no-opt]
//                                    [--timezone Zone] [--locale tag] [--viewport WxH] [--out trace-evidence.json]
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readdir, readFile, writeFile, access, mkdir, stat, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret, migrate } from '../compiler/codegen.mjs';
import { buildApp } from '../compiler/cli.mjs';
import { runProbe, probeFailureReason } from './harness/native.mjs';
import { canonical, canonicalHost } from './harness/compare.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    traces: { type: 'string', default: '20' },
    length: { type: 'string', default: '25' },
    seed: { type: 'string', default: '1' },
    viewport: { type: 'string', default: '800x600' },
    'no-opt': { type: 'boolean' },
    out: { type: 'string' },
    // The time zone and locale Date and Intl see (both sides).
    timezone: { type: 'string', default: 'UTC' },
    locale: { type: 'string', default: 'en-US' },
  },
});

const requestedTraces = Number(values.traces);
const requestedActions = Number(values.length);
const viewportMatch = /^(\d+)x(\d+)$/.exec(values.viewport);
const viewport = viewportMatch && { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };
if (!viewport || !Object.values(viewport).every(n => Number.isSafeInteger(n) && n > 0))
  throw new Error('--viewport must be positive integer dimensions WxH');
if (!Number.isSafeInteger(requestedTraces) || requestedTraces <= 0 ||
    !Number.isSafeInteger(requestedActions) || requestedActions < 0)
  throw new Error('--traces must be a positive integer and --length a nonnegative integer');
const evidencePath = path.resolve(repo, values.out ?? path.join('artifacts',
  `differential-traces-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${values['no-opt'] ? 'no-opt' : 'opt'}.json`));
if (values.out === undefined) await mkdir(path.dirname(evidencePath), { recursive: true });
if (!(await stat(path.dirname(evidencePath))).isDirectory())
  throw new Error('Trace evidence parent is not a directory: ' + path.dirname(evidencePath));
await access(path.dirname(evidencePath), constants.W_OK);
try {
  await lstat(evidencePath);
  throw new Error('Refusing to overwrite differential trace evidence: ' + evidencePath);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

/** Built-ins that read or change the native layout (runic_ir::builtins::needs_layout). */
const LAYOUT_ELEMENT = new Set([
  'getBoundingClientRect',
  ...['offset', 'client'].flatMap(p => ['Width', 'Height', 'Left', 'Top'].map(s => p + s)),
  'scrollWidth',
  'scrollHeight',
  'scrollTop',
  'scrollLeft',
  'set-scrollTop',
  'set-scrollLeft',
  'scrollTo',
  'scrollBy',
  'scrollIntoView',
  // Inline styles and running animations need the native style engine (M6).
  'style-get',
  'style-set',
  'getAnimations',
  'computed-style',
]);
const LAYOUT_WINDOW = new Set(['innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'scrollTo', 'scrollBy']);
function layoutBuiltin(v) {
  if (!v || typeof v !== 'object') return undefined;
  if (v.op === 'builtin') {
    const [ns, m] = v.name.split('.');
    if ((ns === 'element' && LAYOUT_ELEMENT.has(m)) || (ns === 'window' && LAYOUT_WINDOW.has(m))) return v.name;
    // MutationObservers are reported unsupported when they observe.
    if (v.name === 'mutation.observe') return v.name;
    // ResizeObservers report sizes from layout (M6); M6 overlays: child-list
    // observations, IntersectionObservers, floating-ui, tabbable and the
    // document's client size.
    if (v.name === 'resize.observe') return v.name;
    if (
      [
        'mutation.observe-children',
        'intersection.observe',
        'element.getClientRects',
        'document.clientWidth',
        'document.clientHeight',
      ].includes(v.name) ||
      ns === 'floating' ||
      (ns === 'focus' && ['tabbables', 'focusables', 'is-tabbable', 'is-focusable'].includes(m))
    )
      return v.name;
    // Animation objects read the native style engine's animations (M6).
    if (ns === 'animation') return v.name;
    // Scroll events come from layout (scrolling) too.
    if (m === 'listen' && v.args[0]?.value === 'scroll') return `${v.name} scroll`;
  }
  if (v.event === 'scroll' && v.handler !== undefined) return 'scroll listener';
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    const found = layoutBuiltin(x);
    if (found) return found;
  }
  return undefined;
}

// Small deterministic PRNG (mulberry32).
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ['', 'a', 'Hello', 'ünï 😀', 'x'.repeat(256), 'x'.repeat(257), 'line\nbreak', ' ', 'Jell', '100', '-40', '1e3', ' 0x10 ', '3.25', 'NaN', '  milk'];

/** The harness action delivering each event kind (as `EventKind::action`). */
const ACTION = {
  click: 'click',
  submit: 'click',
  change: 'click',
  pointerdown: 'click',
  pointerup: 'click',
  mousedown: 'click',
  mouseup: 'click',
  dblclick: 'dblclick',
  contextmenu: 'contextmenu',
  pointermove: 'hover',
  pointerenter: 'hover',
  pointerleave: 'hover',
  pointerover: 'hover',
  pointerout: 'hover',
  mousemove: 'hover',
  mouseenter: 'hover',
  mouseleave: 'hover',
  mouseover: 'hover',
  mouseout: 'hover',
  input: 'input',
  keydown: 'keydown',
  keyup: 'keydown',
  wheel: 'wheel',
};

/** Literal option values of selects in the program (for `choose`). */
const optionValues = new Set();

/** Actions that deliver an event some listener in the program handles (any component). */
function eventKinds(ir) {
  const kinds = new Set();
  const walk = nodes => {
    for (const n of nodes ?? []) {
      // Select edits are chosen (a click would open a popup over other targets);
      // boundary and movement listeners still need real hover actions.
      for (const l of n.listeners ?? []) {
        // Image load and error events come from the network provider; the
        // interpreter loads no images (docs/gaps/VERIFICATION.md).
        if (l.event === 'load' || l.event === 'error') {
          const error = new Error(`the interpreter loads no images: <${n.tag}> listens for ${l.event}`);
          error.code = 'E_DIFFERENTIAL_ACTION';
          throw error;
        }
        const action = Object.hasOwn(ACTION, l.event) ? ACTION[l.event] : undefined;
        if (action === undefined) {
          const error = new Error(`No differential action is mapped for event ${JSON.stringify(l.event)}`);
          error.code = 'E_DIFFERENTIAL_ACTION';
          throw error;
        }
        kinds.add(n.tag === 'select' && action !== 'hover' ? 'choose' : action);
      }
      if (n.tag === 'option')
        for (const a of n.attrs ?? []) if (a.name === 'value' && a.value.op === 'lit') optionValues.add(a.value.value);
      for (const k of ['children', 'then', 'else', 'body', 'fallback']) walk(n[k]);
      for (const s of n.slots ?? []) walk(s.body);
    }
  };
  for (const c of ir.components) walk(c.template);
  return kinds;
}

/** Interpreter VNode JSON → the canonical shape used for native snapshots. */
function fromInterp(node) {
  if (typeof node === 'string') return { text: node };
  const out = { tag: node.tag };
  if (Object.keys(node.attrs).length) out.attributes = Object.fromEntries(Object.entries(node.attrs).sort());
  if (node.checked) out.checked = true;
  if (node.value !== undefined) out.value = node.value;
  const children = node.children.map(fromInterp);
  if (children.length) out.children = children;
  return out;
}

/** Strip runtime-only state (focus, selection, disabled flag) from canonical native nodes. */
function semantic(node) {
  if ('text' in node) return node;
  const { focused, selection, disabled, readOnly, composing, ...rest } = node;
  if (rest.children) rest.children = rest.children.map(semantic);
  return rest;
}

/** Compare action identities independently of JSON object key order. */
function sameTraceAction(a, b) {
  const stable = value => Array.isArray(value) ? value.map(stable) :
    value !== null && typeof value === 'object' ?
      Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

/** Replay the native physical pointer endpoint in the layout-free interpreter.
 * Only executed actions with their original identity can provide a replay path.
 * Unexecuted stopped suffixes retain the original actions and stay incomplete. */
function resolvedPointerActions(actions, result) {
  const replayActions = actions.map(action => ({ ...action }));
  const resolutions = [], issues = [], incomplete = [];
  if (!Array.isArray(result?.steps)) {
    issues.push({ kind: 'invalid-native-trace' });
    return { actions: replayActions, resolutions, issues, incomplete, complete: false };
  }
  for (const [stepIndex, step] of result.steps.entries()) {
    if (!sameTraceAction(step?.action, stepIndex === 0 ? null : actions[stepIndex - 1]))
      issues.push({ kind: 'native-step-action-mismatch', step: stepIndex });
  }
  // A shifted or malformed trace cannot dictate any interpreter action.
  if (issues.length) return { actions: replayActions, resolutions, issues, incomplete, complete: false };
  for (const [index, action] of actions.entries()) {
    const step = result.steps[index + 1];
    if (!step || !['click', 'dblclick', 'contextmenu', 'hover', 'wheel'].includes(action.kind)) continue;
    const target = step.pointerTarget;
    resolutions.push({ step: index + 1, target: target ?? null });
    if (target?.kind === 'none') continue;
    if (target?.kind !== 'element' || !Array.isArray(target.elementPath) || !target.elementPath.length ||
        !target.elementPath.every(ordinal => Number.isSafeInteger(ordinal) && ordinal >= 0) ||
        typeof target.tag !== 'string' || !target.tag.length ||
        !(target.id === null || typeof target.id === 'string') ||
        !target.point || !['x', 'y'].every(axis => typeof target.point[axis] === 'number' && Number.isFinite(target.point[axis]))) {
      incomplete.push({ kind: 'unavailable-pointer-resolution', step: index + 1,
        reason: target?.reason ?? (target ? 'malformed pointer target metadata' : 'missing pointer target metadata') });
      continue;
    }
    replayActions[index] = { ...action, elementPath: [...target.elementPath],
      targetTag: target.tag, targetId: target.id };
  }
  return { actions: replayActions, resolutions, issues, incomplete,
    complete: issues.length === 0 && incomplete.length === 0 };
}

/** Validate physical trace coverage before comparing a prefix. Native stops name
 * the first undelivered action; a render error can shorten only its own terminal
 * trace, with the same error present on the other side at that step. */
function traceCoverage(actions, expected, result, replayActions = actions) {
  const requestedSteps = actions.length + 1;
  const actual = result?.steps;
  const issues = [];
  if (!Array.isArray(expected)) issues.push({ kind: 'invalid-interpreter-trace' });
  if (!Array.isArray(actual)) issues.push({ kind: 'invalid-native-trace' });
  const expectedSteps = Array.isArray(expected) ? expected.length : null;
  const actualSteps = Array.isArray(actual) ? actual.length : null;
  const stopped = result?.stopped ?? null;
  const stopAction = typeof stopped === 'string' ? Number(stopped.match(/^action (\d+) targets /)?.[1]) : NaN;
  const validStop = stopped !== null && Number.isInteger(stopAction) &&
    stopAction >= 1 && stopAction <= actions.length && actualSteps === stopAction;
  if (stopped !== null && !validStop) issues.push({ kind: 'invalid-native-stop', stopped, stopAction, actualSteps });
  const matchingError = index => {
    const want = expected?.[index]?.state?.dom?.error;
    const errors = actual?.[index]?.renderErrors;
    return typeof want === 'string' && Array.isArray(errors) && errors.length > 0 &&
      errors.every(error => typeof error === 'string') && want.replace(/^E_THROW /, '') === errors[0];
  };
  for (const [side, rows] of [['interpreter', expected], ['native', actual]]) {
    if (!Array.isArray(rows)) continue;
    for (const [index, step] of rows.entries()) {
      const dom = side === 'interpreter' ? step?.state?.dom : step?.dom;
      if (!step || typeof step !== 'object' || dom === null || typeof dom !== 'object')
        issues.push({ kind: 'invalid-step-shape', side, index });
      if (!sameTraceAction(step?.action, index === 0 ? null : (side === 'interpreter' ? replayActions : actions)[index - 1]))
        issues.push({ kind: 'step-action-mismatch', side, index });
      if (side === 'native' && Object.hasOwn(step ?? {}, 'renderErrors') &&
          (!Array.isArray(step.renderErrors) || step.renderErrors.length === 0 ||
           step.renderErrors.some(error => typeof error !== 'string')))
        issues.push({ kind: 'invalid-render-error', side, index });
    }
    const terminalRenderError = rows.length > 0 && matchingError(rows.length - 1);
    if (rows.length === 0 || rows.length > requestedSteps ||
        (rows.length < requestedSteps && !terminalRenderError && !(side === 'native' && validStop)))
      issues.push({ kind: 'unreported-trace-length', side, requestedSteps, actualSteps: rows.length });
  }
  return { requestedSteps, expectedSteps, actualSteps, stopped, validStop,
    comparableSteps: issues.length ? 0 : Math.min(expectedSteps, actualSteps),
    issues, complete: issues.length === 0 && stopped === null &&
      expectedSteps === requestedSteps && actualSteps === requestedSteps &&
      !expected.some(step => step?.state?.dom?.error !== undefined) &&
      !actual.some(step => step?.renderErrors !== undefined) };
}

const fixtures = positionals.length
  ? positionals
  : (await readdir(path.join(repo, 'fixtures'), { withFileTypes: true }))
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .filter(n => !['unsupported-effect'].includes(n));
const random = rng(Number(values.seed));
let failures = 0;
let partial = 0;
let renderErrors = 0;
let probeFailures = 0;
let steps = 0;
const incomplete = [];
const fixtureSummaries = [];
for (const fixture of fixtures) {
  const fixtureSummary = { fixture, requestedTraces, requestedActionsPerTrace: requestedActions, traces: [], comparedSteps: 0, complete: false };
  fixtureSummaries.push(fixtureSummary);
  const dir = fixture.includes('/') ? path.join(repo, fixture) : path.join(repo, 'fixtures', fixture);
  let ir;
  try {
    ({ ir } = await lower(await collect(dir)));
  } catch (error) {
    // Generated inputs are not committed and builds never generate them
    // (compiler/generate.mjs): the fixture cannot be checked until the user
    // runs its generators.
    if (error.code !== 'E_GENERATED') throw error;
    incomplete.push(fixture);
    const command = `node compiler/cli.mjs generate ${path.relative(repo, dir)}`;
    fixtureSummary.reason = `needs generated inputs: run \`${command}\` from the repository root (E_GENERATED: ${error.message})`;
    fixtureSummary.command = command;
    console.log(`${fixture.padEnd(20)} incomplete (${fixtureSummary.reason})`);
    continue;
  }
  // The interpreter has no layout: such programs are compared against the
  // browser only (conformance/run.mjs), and reported here as incomplete.
  const layout = layoutBuiltin(ir);
  if (layout) {
    incomplete.push(fixture);
    fixtureSummary.reason = 'reads layout: ' + layout;
    console.log(`${fixture.padEnd(20)} incomplete (reads layout: ${layout})`);
    continue;
  }
  let kinds;
  try {
    kinds = eventKinds(migrate(ir));
  } catch (error) {
    if (error.code !== 'E_DIFFERENTIAL_ACTION') throw error;
    incomplete.push(fixture);
    fixtureSummary.reason = error.message;
    console.log(`${fixture.padEnd(20)} incomplete (${error.message})`);
    continue;
  }
  // Programs using the session history also get the user's back and forward.
  if (/"name":"(history|location)\./.test(JSON.stringify(ir))) kinds.add('back').add('forward');
  const out = path.join(repo, '.cache/conformance/diff-bin', path.basename(fixture) + (values['no-opt'] ? '-no-opt' : ''));
  await buildApp(dir, { out, probe: true, noOpt: values['no-opt'] });
  const binary = path.join(out, 'runic-app');
  // Targets are chosen from the live DOM: the n-th element listening for the
  // event, resolved identically by the interpreter and the probe.
  const weights = [
    ['click', 0.6],
    ['input', 0.3],
    ['keydown', 0.1],
    ['dblclick', 0.1],
    ['contextmenu', 0.1],
    ['hover', 0.2],
    ['wheel', 0.1],
    ['choose', 0.2],
    ['back', 0.1],
    ['forward', 0.1],
  ].filter(([k]) => kinds.has(k));
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let fixtureFailures = 0;
  let fixturePartial = 0;
  let fixtureRenderErrors = 0;
  let fixtureProbeFailures = 0;
  for (let t = 0; t < requestedTraces; t++) {
    const actions = [];
    for (let i = 0; i < requestedActions && weights.length; i++) {
      let r = random() * total;
      const [kind] = weights.find(([, w]) => (r -= w) < 0) ?? weights.at(-1);
      const nth = Math.floor(random() * 1000);
      if (kind === 'input') actions.push({ kind, nth, value: TEXTS[Math.floor(random() * TEXTS.length)] });
      else if (kind === 'keydown') actions.push({ kind, nth, key: random() < 0.7 ? 'Enter' : 'Escape' });
      else if (kind === 'wheel') actions.push({ kind, nth, deltaX: 0, deltaY: random() < 0.5 ? 100 : -40 });
      else if (kind === 'choose') {
        const values = [...optionValues];
        actions.push({ kind, nth, value: values[Math.floor(random() * values.length)] });
      } else if (kind === 'back' || kind === 'forward') actions.push({ kind });
      else actions.push({ kind, nth });
    }
    const env = { timezone: values.timezone, locale: values.locale };
    // Observe the physical native target first; snapshots themselves are never rewritten.
    let result;
    try {
      result = runProbe(binary, { actions, ...env, viewport, hiddenTargets: 'stop' });
    } catch (error) {
      // A failed probe (non-zero exit, panic) fails this trace; the remaining
      // traces and fixtures still run (with the same generated actions).
      if (error.code !== 'E_NATIVE_PROBE') throw error;
      const reason = probeFailureReason(error);
      fixtureFailures++;
      fixtureProbeFailures++;
      fixtureSummary.probeFailure ??= reason;
      fixtureSummary.traces.push({ index: t, requestedActions, generatedActions: actions.length,
        requestedSteps: requestedActions + 1, generatedSteps: actions.length + 1,
        expectedSteps: null, actualSteps: null, comparedSteps: 0, stopped: null, renderError: null, failures: 1,
        probeFailure: { reason, status: error.status, signal: error.signal, spawnError: error.spawnError ?? null,
          stderr: error.stderr.slice(-4000) },
        coverageIssues: [], pointerResolutionIssues: [], incompletePointerResolutions: [],
        nativeActions: actions, interpreterActions: null, pointerResolutions: [], complete: false });
      if (fixtureProbeFailures <= 3) console.log(`PROBE FAILED ${fixture} trace ${t}: ${reason}`);
      continue;
    }
    const replay = resolvedPointerActions(actions, result);
    const expected = interpret(ir, replay.actions, env);
    const actual = result.steps;
    const coverage = traceCoverage(actions, expected, result, replay.actions);
    const traceSummary = { index: t, requestedActions, generatedActions: actions.length,
      requestedSteps: requestedActions + 1, generatedSteps: coverage.requestedSteps,
      expectedSteps: coverage.expectedSteps, actualSteps: coverage.actualSteps,
      comparedSteps: 0, stopped: coverage.stopped, renderError: null, failures: 0,
      coverageIssues: coverage.issues, pointerResolutionIssues: replay.issues,
      incompletePointerResolutions: replay.incomplete,
      nativeActions: actions, interpreterActions: replay.actions, pointerResolutions: replay.resolutions, complete: false };
    fixtureSummary.traces.push(traceSummary);
    if (coverage.issues.length) {
      if (fixtureFailures <= 3) console.log(`MISMATCH ${fixture} trace ${t} coverage ${JSON.stringify(coverage)}`);
      fixtureFailures += coverage.issues.length;
      traceSummary.failures += coverage.issues.length;
    }
    if (replay.issues.length) {
      fixtureFailures += replay.issues.length;
      traceSummary.failures += replay.issues.length;
    }
    // A trace ends before a pointer action whose target is not fully visible
    // (scrolled out or covered): without layout, the interpreter would
    // deliver it to the target, the native pointer to what covers it.
    if (coverage.validStop) {
      partial++;
      fixturePartial++;
      if (partial <= 3) console.log(`  ${fixture} trace ${t} ends early: ${result.stopped}`);
    }
    for (let i = 0; i < coverage.comparableSteps; i++) {
      steps++;
      traceSummary.comparedSteps++;
      fixtureSummary.comparedSteps++;
      // A throw while rendering (a duplicate key) ends the trace: the
      // interpreter's snapshot is the error, the probe reports it for the
      // step. Both must report the same throw; what follows has no
      // browser model (the program's own error), so it is not compared.
      const interpError = expected[i].state.dom?.error;
      if (interpError !== undefined || actual[i].renderErrors) {
        const want = interpError?.replace(/^E_THROW /, '');
        const got = actual[i].renderErrors?.[0];
        if (want === undefined || want !== got) {
          fixtureFailures++;
          traceSummary.failures++;
          if (fixtureFailures <= 3)
            console.log(`MISMATCH ${fixture} trace ${t} step ${i} ${JSON.stringify(actions[i - 1] ?? null)}\n  interp render error ${JSON.stringify(interpError ?? null)}\n  native render errors ${JSON.stringify(actual[i].renderErrors ?? [])}`);
        } else {
          fixtureRenderErrors++;
          traceSummary.renderError = { index: i, error: got };
        }
        break;
      }
      const want = {
        dom: expected[i].state.dom.map(n => semantic(canonical(fromInterp(n)))),
        portals: (canonical({ tag: "body", children: (expected[i].state.portals ?? []).map(fromInterp) }).children ?? []).map(semantic),
        cells: expected[i].state.cells,
        instances: expected[i].state.instances ?? [],
        document: expected[i].state.document ?? {},
        body: expected[i].state.body ?? {},
        host: canonicalHost(expected[i].state.host),
      };
      const got = {
        dom: (canonical(actual[i].dom).children ?? []).map(semantic),
        portals: (canonical({ tag: "body", children: actual[i].portals ?? [] }).children ?? []).map(semantic),
        cells: actual[i].cells,
        instances: actual[i].instances ?? [],
        document: actual[i].document ?? {},
        body: actual[i].body ?? {},
        host: canonicalHost(actual[i].host),
      };
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        fixtureFailures++;
        traceSummary.failures++;
        if (fixtureFailures <= 3)
          console.log(`MISMATCH ${fixture} trace ${t} step ${i} ${JSON.stringify(actions[i - 1] ?? null)}\n  interp ${JSON.stringify(want).slice(0, process.env.DIFF_FULL ? undefined : 600)}\n  native ${JSON.stringify(got).slice(0, process.env.DIFF_FULL ? undefined : 600)}`);
        break;
      }
    }
    traceSummary.complete = coverage.complete && replay.complete && actions.length === requestedActions &&
      traceSummary.failures === 0 && traceSummary.renderError === null &&
      traceSummary.comparedSteps === traceSummary.requestedSteps;
  }
  fixtureSummary.complete = fixtureSummary.traces.length === requestedTraces &&
    fixtureSummary.traces.every(trace => trace.complete);
  fixtureSummary.failures = fixtureFailures;
  fixtureSummary.partialTraces = fixturePartial;
  fixtureSummary.renderErrorTraces = fixtureRenderErrors;
  fixtureSummary.probeFailureTraces = fixtureProbeFailures;
  failures += fixtureFailures;
  probeFailures += fixtureProbeFailures;
  renderErrors += fixtureRenderErrors;
  console.log(
    `${fixture.padEnd(20)} ${fixtureFailures ? 'FAIL' : fixtureSummary.complete ? 'ok' : 'incomplete'} (${values.traces} traces x ${values.length} actions${fixturePartial ? `; ${fixturePartial} ended early at a hidden pointer target` : ''}${fixtureRenderErrors ? `; ${fixtureRenderErrors} ended at the same render error` : ''}${fixtureProbeFailures ? `; native probe failed in ${fixtureProbeFailures}: ${fixtureSummary.probeFailure}` : ''})`,
  );
}
const traceEvidenceJSON = JSON.stringify({ schema: 1, seed: Number(values.seed),
  optimize: !values['no-opt'], viewport, requestedTraces, requestedActionsPerTrace: requestedActions, fixtureSummaries }, null, 2) + '\n';
await writeFile(evidencePath, traceEvidenceJSON, { flag: 'wx' });
const traceEvidence = { path: path.relative(repo, evidencePath),
  sha256: createHash('sha256').update(traceEvidenceJSON).digest('hex') };
const consoleFixtures = fixtureSummaries.map(({ traces, ...fixture }) => ({ ...fixture,
  traces: traces.map(({ nativeActions, interpreterActions, pointerResolutions, ...trace }) => ({
    ...trace, executedPointerActions: pointerResolutions.length,
  })),
}));
console.log(JSON.stringify({ fixtures: fixtures.length, viewport, requestedTraces, requestedActionsPerTrace: requestedActions,
  expectedComparedSteps: fixtures.length * requestedTraces * (requestedActions + 1),
  traceCount: fixtureSummaries.reduce((count, fixture) => count + fixture.traces.length, 0),
  complete: incomplete.length === 0 && failures === 0 && fixtureSummaries.every(fixture => fixture.complete),
  steps, failures, incomplete, partialTraces: partial, renderErrorTraces: renderErrors, probeFailureTraces: probeFailures,
  seed: Number(values.seed), optimize: !values['no-opt'], traceEvidence, fixtureSummaries: consoleFixtures }));
process.exitCode = failures ? 1 : 0;
