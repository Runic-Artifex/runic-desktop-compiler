// Quick semantic check without native builds: the original framework in
// Chromium vs the reference interpreter, comparing the text of every element
// with an id after each action of a case. Conformance (run.mjs) remains the
// authority; this is for iterating on adapters and interpreter semantics.
//
//   node conformance/interp-vs-browser.mjs <case> [fixture ...] [--show]
//
// --show prints the browser's text of every element with an id per step.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserHarness } from './harness/browser.mjs';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const show = args.includes('--show');
const [caseName, ...only] = args.filter(a => a !== '--show');
if (!caseName) {
  console.error('usage: interp-vs-browser.mjs <case> [fixture ...]');
  process.exit(2);
}
const c = JSON.parse(readFileSync(path.join(repo, 'conformance/cases', `${caseName}.json`), 'utf8'));
// Interpreter nodes: { attrs, children: [string | node] }; browser nodes: { id, children: [{ text } | node] }.
const flat = n =>
  (Array.isArray(n) ? n : [n]).flatMap(x =>
    typeof x === 'string' || x.text !== undefined ? [] : [x, ...flat(x.children ?? [])],
  );
const text = n =>
  typeof n === 'string' ? n : n.text !== undefined ? n.text : (n.children ?? []).map(text).join('');
const texts = dom =>
  Object.fromEntries(
    flat(dom)
      .map(n => [n.attrs?.id ?? n.id, n])
      .filter(([id]) => id && id !== 'root')
      .map(([id, n]) => [id, text(n).replace(/\s+/g, ' ').trim()]),
  );

const browser = await createBrowserHarness();
let mismatches = 0;
try {
  for (const fixture of c.fixtures.filter(f => !only.length || only.includes(f))) {
    const dir = path.join(repo, fixture.includes('/') ? fixture : `fixtures/${fixture}`);
    const env = {
      storage: c.storage,
      timezone: c.timezone,
      locale: c.locale,
      url: c.url,
      clipboard: c.clipboard,
      seed: c.seed,
    };
    const b = await browser.run(dir, {
      actions: c.actions,
      ...env,
      clock: c.clock === true,
      out: path.join(repo, '.cache/interp-vs-browser', path.basename(fixture)),
    });
    let steps;
    try {
      steps = interpret((await lower(await collect(dir))).ir, c.actions, env);
    } catch (e) {
      console.log(`${fixture}: interpreter failed: ${e.code ?? ''} ${e.message}`);
      mismatches++;
      // The browser's text still shows what the framework does (expected rejections).
      if (show)
        b.steps.forEach((s, i) =>
          console.log(`${fixture} step ${i} (${JSON.stringify(s.action)})`, texts(s.dom)),
        );
      continue;
    }
    b.steps.forEach((s, i) => {
      const [x, y] = [texts(s.dom), texts(steps[i]?.state.dom ?? [])];
      if (show) console.log(`${fixture} step ${i} (${JSON.stringify(s.action)})`, x);
      for (const id of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (x[id] !== y[id]) {
          mismatches++;
          console.log(
            `${fixture} step ${i} (${JSON.stringify(s.action)}) #${id}\n  browser: ${x[id] ?? '∅'}\n  interp:  ${y[id] ?? '∅'}`,
          );
        }
    });
    console.log(`${fixture}: ${b.steps.length} steps compared`);
  }
} finally {
  await browser.close();
}
console.log(mismatches ? `${mismatches} mismatches` : 'all steps agree');
process.exitCode = mismatches ? 1 : 0;
