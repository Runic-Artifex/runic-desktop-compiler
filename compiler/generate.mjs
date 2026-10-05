// `runic generate <app>`: the app's build-time generators, run explicitly
// (docs/design/M6-SVELTEKIT.md, phase 2). runic.json declares them as an
// ordered list of steps; each step's tools are pinned (name, exact version
// and the SHA-256 of the package's files, compiler/generate-pins.mjs) and
// each run is recorded in `.runic/generate.json` with the hashes of its
// inputs and outputs. A SvelteKit app's server code (server loads and
// prerendered endpoints) is evaluated after the steps, as Kit's prerender
// evaluates it (compiler/adapters/kit-server.mjs).
//
// Builds never run a step: `checkGeneration` recomputes the hashes and
// reports a missing or stale record or output as E_GENERATED. Generation is
// the one place where the app's own code and its svelte.config.js run at
// build time; it makes no model calls and needs no network.
//
// Step kinds:
//   { "name", "command": ["node", "scripts/x.mjs"] | ["<tool bin>", …],
//     "tools": ["pkg@1.2.3", …], "inputs": [globs], "outputs": [dirs] }
//   { "name", "preprocess": "<glob>", "tools": [...], "inputs": [globs] }
//     runs svelte.config.js's `preprocess` over the files the glob names;
//     each output is `.runic/generate/<name>/<file>.svelte`.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Diagnostic } from './collect.mjs';
import { TOOL_PINS } from './generate-pins.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The record's format. */
export const RECORD_FORMAT = 1;
export const RECORD = '.runic/generate.json';
export const OUTPUT_DIR = '.runic/generate';
/** Directories that are never inputs (dependencies, Kit's and the generator's outputs). */
const NOT_SOURCES = new Set(['node_modules', '.runic', '.svelte-kit', 'build', 'dist', '.git']);

const at = (line = 1) => ({ file: 'runic.json', line, column: 1 });
const fail = (message, line) => {
  throw new Diagnostic('E_GENERATED', message, at(line));
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** The line of runic.json declaring step `name` (for diagnostics). */
function stepLine(root, name) {
  try {
    const lines = readFileSync(path.join(root, 'runic.json'), 'utf8').split('\n');
    const i = lines.findIndex(l => l.includes(`"name": ${JSON.stringify(name)}`));
    return i < 0 ? 1 : i + 1;
  } catch {
    return 1;
  }
}

/** The app's declared steps, checked. */
export function steps(root, config) {
  const list = config.generate ?? [];
  if (!Array.isArray(list)) fail('runic.json generate must be a list of steps');
  const names = new Set();
  return list.map(step => {
    const line = stepLine(root, step?.name);
    if (!step || typeof step.name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(step.name))
      fail('Each generation step needs a name (lowercase letters, digits and -)', line);
    if (names.has(step.name)) fail(`Two generation steps are named ${step.name}`, line);
    names.add(step.name);
    const known = new Set(['name', 'command', 'preprocess', 'tools', 'inputs', 'outputs']);
    for (const key of Object.keys(step))
      if (!known.has(key)) fail(`Generation step ${step.name}: unknown key ${key}`, line);
    const tools = step.tools ?? [];
    if (
      !Array.isArray(tools) ||
      tools.some(t => typeof t !== 'string' || !/^(@[^/@]+\/)?[^/@]+@\d[^@]*$/.test(t))
    )
      fail(`Generation step ${step.name}: tools are "name@version" strings`, line);
    const inputs = step.inputs ?? [];
    if (
      !Array.isArray(inputs) ||
      !inputs.length ||
      inputs.some(g => typeof g !== 'string' || g.startsWith('/') || g.includes('..'))
    )
      fail(`Generation step ${step.name}: inputs are globs inside the app (at least one)`, line);
    if ((step.command === undefined) === (step.preprocess === undefined))
      fail(`Generation step ${step.name} has either a command or a preprocess glob`, line);
    if (step.command !== undefined) {
      if (
        !Array.isArray(step.command) ||
        !step.command.length ||
        step.command.some(a => typeof a !== 'string')
      )
        fail(`Generation step ${step.name}: command is a list of strings`, line);
      const outputs = step.outputs;
      if (
        !Array.isArray(outputs) ||
        !outputs.length ||
        outputs.some(
          o =>
            typeof o !== 'string' ||
            o.startsWith('/') ||
            o.includes('..') ||
            o.startsWith('.runic'),
        )
      )
        fail(`Generation step ${step.name}: outputs are directories inside the app`, line);
    } else {
      if (
        typeof step.preprocess !== 'string' ||
        step.preprocess.startsWith('/') ||
        step.preprocess.includes('..')
      )
        fail(`Generation step ${step.name}: preprocess is a glob of files inside the app`, line);
      if (step.outputs !== undefined)
        fail(
          `Generation step ${step.name}: a preprocess step's outputs are its own (${OUTPUT_DIR}/${step.name})`,
          line,
        );
    }
    return { ...step, tools, inputs, line };
  });
}

/** The directory of package `name` as the app resolves it (node_modules upwards). */
function packageDir(root, name) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** Every file below `dir` (not following nested node_modules), relative and sorted. */
function filesBelow(dir, skip = new Set(['node_modules'])) {
  const out = [];
  const walk = rel => {
    for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(r);
      else if (entry.isFile()) out.push(r);
    }
  };
  if (existsSync(dir)) walk('');
  return out.sort();
}

/** The SHA-256 of a package's files (paths and contents, sorted; nested node_modules excluded). */
export function packageHash(dir) {
  const h = createHash('sha256');
  for (const f of filesBelow(dir))
    h.update(f)
      .update('\0')
      .update(sha256(readFileSync(path.join(dir, f))))
      .update('\n');
  return h.digest('hex');
}

/** A step's tools: resolved, version-checked and (with `hash`) checked against the pins. */
function tools(root, step, hash) {
  return step.tools.map(spec => {
    const i = spec.lastIndexOf('@');
    const name = spec.slice(0, i);
    const version = spec.slice(i + 1);
    const dir = packageDir(root, name);
    if (!dir) fail(`Generation step ${step.name}: the tool ${name} is not installed`, step.line);
    const info = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (info.version !== version)
      fail(
        `Generation step ${step.name}: ${name} is ${info.version}, the step pins ${version}`,
        step.line,
      );
    const pinned = TOOL_PINS[spec];
    if (!pinned)
      fail(
        `Generation step ${step.name}: ${spec} is not a pinned generator tool (compiler/generate-pins.mjs)`,
        step.line,
      );
    if (hash) {
      const actual = packageHash(dir);
      if (actual !== pinned)
        fail(
          `Generation step ${step.name}: ${spec} differs from the published package (SHA-256 ${actual})`,
          step.line,
        );
    }
    return { name, version, sha256: pinned, dir, bin: info.bin };
  });
}

/** The files `globs` name in the app (sources only), with their hashes. */
function hashGlobs(root, globs) {
  const files = new Set();
  for (const g of globs)
    for (const f of globSync(g, { cwd: root }))
      if (!f.split(path.sep).some(p => NOT_SOURCES.has(p)) && statSync(path.join(root, f)).isFile())
        files.add(f.split(path.sep).join('/'));
  return Object.fromEntries(
    [...files].sort().map(f => [f, sha256(readFileSync(path.join(root, f)))]),
  );
}

/** The files below the output directories, with their hashes. */
function hashOutputs(root, dirs) {
  const out = {};
  for (const d of dirs) {
    const full = path.join(root, d);
    if (existsSync(full) && statSync(full).isFile()) out[d] = sha256(readFileSync(full));
    else
      for (const f of filesBelow(full, new Set()))
        out[`${d}/${f}`] = sha256(readFileSync(path.join(full, f)));
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Every source file of the app (the server phase's inputs). */
function hashSources(root) {
  return Object.fromEntries(
    filesBelow(root, NOT_SOURCES)
      .filter(f => f !== 'runic.json')
      .map(f => [f, sha256(readFileSync(path.join(root, f)))]),
  );
}

/** The environment of every generator run: deterministic time zone, locale and date. */
function environment() {
  return { ...process.env, TZ: 'UTC', LC_ALL: 'C', LANG: 'C', SOURCE_DATE_EPOCH: '0' };
}

const definition = step => sha256(JSON.stringify({ ...step, line: undefined }));

function outputsOf(step) {
  return step.command ? step.outputs : [`${OUTPUT_DIR}/${step.name}`];
}

/** Runs the app's steps, then (SvelteKit apps) its server code, and writes the record. */
export async function generate(app) {
  const root = path.resolve(app);
  const config = JSON.parse(readFileSync(path.join(root, 'runic.json'), 'utf8'));
  const list = steps(root, config);
  const record = { format: RECORD_FORMAT, steps: [] };
  rmSync(path.join(root, RECORD), { force: true });
  for (const step of list) {
    const used = tools(root, step, true);
    const inputs = hashGlobs(root, step.inputs);
    for (const o of outputsOf(step)) rmSync(path.join(root, o), { recursive: true, force: true });
    let argv;
    if (step.command) {
      const [command, ...args] = step.command;
      if (command === 'node') argv = args;
      else {
        const tool = used.find(t => {
          const bins =
            typeof t.bin === 'string' ? { [t.name.split('/').pop()]: t.bin } : (t.bin ?? {});
          return Object.hasOwn(bins, command);
        });
        if (!tool)
          fail(
            `Generation step ${step.name}: ${command} is neither node nor a bin of the step's tools`,
            step.line,
          );
        const bins =
          typeof tool.bin === 'string' ? { [tool.name.split('/').pop()]: tool.bin } : tool.bin;
        argv = [path.join(tool.dir, bins[command]), ...args];
      }
    } else
      argv = [
        path.join(here, 'generate-preprocess.mjs'),
        root,
        step.preprocess,
        path.join(root, OUTPUT_DIR, step.name),
      ];
    const r = spawnSync(process.execPath, argv, {
      cwd: root,
      env: environment(),
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    });
    if (r.status !== 0)
      fail(
        `Generation step ${step.name} failed (exit ${r.status}):\n${(r.stderr || r.stdout).slice(-4000)}`,
        step.line,
      );
    record.steps.push({
      name: step.name,
      definition: definition(step),
      tools: used.map(({ name, version, sha256 }) => ({ name, version, sha256 })),
      inputs,
      outputs: hashOutputs(root, outputsOf(step)),
    });
  }
  if (config.kit === true) {
    const out = path.join(root, OUTPUT_DIR, 'server.json');
    rmSync(out, { force: true });
    const inputs = hashSources(root);
    const r = spawnSync(
      process.execPath,
      [path.join(here, 'adapters', 'kit-server.mjs'), root, out],
      {
        cwd: root,
        env: environment(),
        encoding: 'utf8',
        maxBuffer: 1 << 28,
      },
    );
    if (r.status !== 0) {
      // A located diagnostic of the server phase.
      const last = (r.stdout ?? '').trim().split('\n').at(-1) ?? '';
      let diagnostic;
      try {
        diagnostic = JSON.parse(last);
      } catch {}
      if (diagnostic?.code)
        throw new Diagnostic(diagnostic.code, diagnostic.message, diagnostic.source);
      throw new Diagnostic(
        'E_GENERATED',
        `SvelteKit server code failed at generation:\n${(r.stderr || r.stdout).slice(-4000)}`,
        at(),
      );
    }
    record.server = { inputs, outputs: hashOutputs(root, [`${OUTPUT_DIR}/server.json`]) };
  }
  mkdirSync(path.dirname(path.join(root, RECORD)), { recursive: true });
  writeFileSync(path.join(root, RECORD), JSON.stringify(record, null, 2) + '\n');
  return record;
}

/** The first difference between a recorded and a current hash table, as text, or undefined. */
function difference(recorded, current) {
  for (const [f, h] of Object.entries(current)) {
    if (!(f in recorded)) return `${f} is new`;
    if (recorded[f] !== h) return `${f} changed`;
  }
  for (const f of Object.keys(recorded)) if (!(f in current)) return `${f} is missing`;
  return undefined;
}

/**
 * Checks the generation record against the app (builds; nothing is run):
 * every step as declared, with the same tools, the same input hashes and its
 * outputs unchanged; for a SvelteKit app, the server phase over the same
 * sources. Returns the record. `kit` is whether the app is a SvelteKit app
 * (its server data is part of the record).
 */
export function checkGeneration(root, config, kit) {
  const list = steps(root, config);
  const file = path.join(root, RECORD);
  if (!list.length && !kit) return undefined;
  if (!existsSync(file))
    fail(
      `The app's generated inputs are missing: run \`runic-compiler generate\` (node compiler/cli.mjs generate ${path.basename(root)}) first`,
    );
  const record = JSON.parse(readFileSync(file, 'utf8'));
  if (record.format !== RECORD_FORMAT) fail(`${RECORD} has another format; run generate again`);
  if (record.steps.length !== list.length)
    fail(
      `runic.json declares ${list.length} generation steps, ${RECORD} records ${record.steps.length}: run generate again`,
    );
  list.forEach((step, i) => {
    const r = record.steps[i];
    const stale = why =>
      fail(`Generation step ${step.name} is stale (${why}): run generate again`, step.line);
    if (r.name !== step.name || r.definition !== definition(step)) stale('its declaration changed');
    const used = tools(root, step, true);
    for (const t of used) {
      const rt = r.tools.find(x => x.name === t.name);
      if (!rt || rt.version !== t.version || rt.sha256 !== t.sha256) stale(`${t.name} changed`);
    }
    const inputs = difference(r.inputs, hashGlobs(root, step.inputs));
    if (inputs) stale(`input ${inputs}`);
    const outputs = difference(r.outputs, hashOutputs(root, outputsOf(step)));
    if (outputs) stale(`output ${outputs}`);
  });
  if (kit) {
    if (!record.server) fail(`${RECORD} has no server data: run generate again`);
    const sources = difference(record.server.inputs, hashSources(root));
    if (sources) fail(`The generated server data is stale (${sources}): run generate again`);
    const outputs = difference(
      record.server.outputs,
      hashOutputs(root, [`${OUTPUT_DIR}/server.json`]),
    );
    if (outputs) fail(`The generated server data is stale (output ${outputs}): run generate again`);
  }
  return record;
}

/** The preprocessed output of `file` (relative to the app) of a recorded preprocess step, if any. */
export function preprocessed(root, config, file) {
  for (const step of config.generate ?? [])
    if (step.preprocess !== undefined) {
      const out = path.join(root, OUTPUT_DIR, step.name, file + '.svelte');
      if (existsSync(out)) return { step: step.name, path: out };
    }
  return undefined;
}
