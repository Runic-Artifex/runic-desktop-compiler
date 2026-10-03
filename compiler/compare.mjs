import { createServer } from 'vite';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lower } from './frontend.mjs';
import { Diagnostic, hash } from './collect.mjs';
import { inspectNativeInputs } from './codegen.mjs';

export function plans(ir, edges) {
  const initial = ir.states.map(s => s.initial),
    paths = new Map([[JSON.stringify(initial), []]]);
  // Edges are BFS ordered by the IR validator.
  for (const e of edges)
    if (!paths.has(JSON.stringify(e.to)))
      paths.set(JSON.stringify(e.to), [...paths.get(JSON.stringify(e.from)), e.event]);
  return edges.map(e => [...paths.get(JSON.stringify(e.from)), e.event]);
}
export async function startComparison(graph, { port = 5173, out } = {}) {
  const { ir, edges } = await lower(graph);
  if (ir.states.some(s => s.domain?.kind === 'text'))
    throw new Diagnostic(
      'E_COMPARE',
      'Text uses typed conformance traces; see docs/ROADMAP.md for the conformance harness. Finite BFS paths are not exhaustive text tests',
    );
  const output = path.resolve(out ?? `artifacts/compare/${path.basename(graph.root)}`);
  const binary = path.resolve(`artifacts/${path.basename(graph.root)}/runic-app`);
  await readFile(binary);
  await mkdir(output, { recursive: true });
  const built = JSON.parse(await readFile(path.join(path.dirname(binary), 'ir.json'), 'utf8'));
  if (built.irHash !== ir.irHash)
    throw new Diagnostic(
      'E_COMPARE_BUILD',
      'Native artifact is stale. Rebuild this application before comparing',
    );
  const build = JSON.parse(await readFile(path.join(path.dirname(binary), 'build.json'), 'utf8'));
  const nativeInputs = await inspectNativeInputs(ir, path.dirname(binary), build.optimize),
    binaryHash = hash(await readFile(binary));
  const buttons = [];
  const walk = n => {
    if (n.event !== undefined) {
      if (!n.attrs.id)
        throw new Diagnostic('E_COMPARE', 'Comparison fixture buttons require static IDs');
      buttons[n.event] = n.attrs.id.value;
    }
    (n.children ?? []).forEach(walk);
  };
  walk(ir.ui);
  const cases = plans(ir, edges),
    results = [];
  const script = `
const ids=${JSON.stringify(
    ir.ui
      ? (() => {
          const ids = [];
          const go = n => {
            if (n.attrs?.id) ids.push(n.attrs.id.value);
            (n.children ?? []).forEach(go);
          };
          go(ir.ui);
          return ids;
        })()
      : [],
  )};
const buttons=${JSON.stringify(buttons)},cases=${JSON.stringify(cases)};
// Supported updates commit synchronously or in a microtask. A timer also lets
// conformance run in a background preview whose animation frames are paused.
const frame=()=>new Promise(r=>setTimeout(r,40));
const snapshot=()=>Object.fromEntries(ids.flatMap(id=>{const e=document.getElementById(id);if(!e)return [];const r=e.getBoundingClientRect();return [[id,{text:e.textContent,class:e.className,disabled:e.hasAttribute('disabled'),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}]];}));
window.runicCompare=async(events=[])=>{await document.fonts.ready;await frame();for(const e of events){document.getElementById(buttons[e]).click();await frame();}const q=new URLSearchParams(location.search);const record={events,elements:snapshot(),width:innerWidth,height:innerHeight,caseIndex:q.has('runicCase')?Number(q.get('runicCase')):null};const r=await fetch('/__runic/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(record)});const report=await r.json();window.runicResult=report;return report;};
async function run(){while(!document.getElementById('root').childNodes.length)await frame();await document.fonts.ready;await frame();const q=new URLSearchParams(location.search);if(!q.has('runicCase'))return;const index=Number(q.get('runicCase'));const report=await window.runicCompare(cases[index]);if(index+1<cases.length){location.search='?runicCase='+(index+1);}else{window.runicSuite={complete:true,cases:cases.length};document.title='Comparison complete';await fetch('/__runic/complete',{method:'POST',body:JSON.stringify({width:innerWidth,height:innerHeight})});}}
run().catch(e=>{window.runicError=String(e);console.error(e);});
`;
  const plugin = {
    name: 'runic-browser-compare',
    transformIndexHtml: () => [
      { tag: 'script', attrs: { type: 'module', src: '/@runic-compare' }, injectTo: 'body' },
    ],
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/@runic-compare') {
          res.setHeader('Content-Type', 'application/javascript');
          res.end(script);
          return;
        }
        if (req.url === '/__runic/complete') {
          let body = '';
          for await (const chunk of req) body += chunk;
          const viewport = JSON.parse(body);
          const selected = results.filter(
            r => r.width === viewport.width && r.height === viewport.height && r.caseIndex !== null,
          );
          const complete =
            selected.length === cases.length &&
            cases.length > 0 &&
            new Set(selected.map(r => r.caseIndex)).size === cases.length;
          await writeFile(
            path.join(output, `report-${viewport.width}x${viewport.height}.json`),
            JSON.stringify(
              {
                schema: 2,
                sourceHash: graph.hash,
                irHash: ir.irHash,
                binaryHash,
                nativeInputs,
                expectedCases: cases.length,
                cases: selected.length,
                complete,
                semanticsPassed: complete && selected.every(r => r.semanticErrors.length === 0),
                geometryTolerancePx: 2,
                geometryPassed: complete && selected.every(r => r.geometryErrors.length === 0),
                results: selected,
              },
              null,
              2,
            ) + '\n',
          );
          res.end('ok');
          return;
        }
        if (req.url !== '/__runic/result' || req.method !== 'POST') {
          next();
          return;
        }
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            if (body.length > 65536) throw new Error('Body too large');
          }
          const reference = JSON.parse(body);
          if (
            !Array.isArray(reference.events) ||
            reference.events.length > 128 ||
            reference.events.some(e => !Number.isInteger(e) || e < 0 || e >= buttons.length) ||
            ![reference.width, reference.height].every(
              v => Number.isInteger(v) && v > 0 && v <= 2048,
            )
          )
            throw new Error('Invalid comparison input');
          const base = path.join(output, `native-${reference.width}x${reference.height}`);
          const run = spawnSync(
            binary,
            [
              '--headless',
              String(reference.width),
              String(reference.height),
              base,
              reference.events.join(','),
            ],
            { encoding: 'utf8', timeout: 10000 },
          );
          if (run.status !== 0)
            throw new Error(`Native comparison failed: ${run.stderr.slice(0, 1000)}`);
          const trace = JSON.parse(await readFile(base + '.json', 'utf8')),
            native = trace.at(-1);
          const semanticErrors = [],
            geometryErrors = [];
          for (const id of new Set([
            ...Object.keys(reference.elements),
            ...Object.keys(native.elements),
          ])) {
            const a = reference.elements[id],
              b = native.elements[id];
            if (!a || !b) {
              semanticErrors.push({ id, missing: !a ? 'browser' : 'native' });
              continue;
            }
            for (const key of ['text', 'class', 'disabled'])
              if (a[key] !== b[key])
                semanticErrors.push({ id, key, browser: a[key], native: b[key] });
            for (const key of ['x', 'y', 'width', 'height'])
              if (Math.abs(a.rect[key] - b.rect[key]) > 2)
                geometryErrors.push({
                  id,
                  key,
                  browser: a.rect[key],
                  native: b.rect[key],
                  delta: b.rect[key] - a.rect[key],
                });
          }
          if (reference.caseIndex === 0)
            for (let i = results.length - 1; i >= 0; i--)
              if (results[i].width === reference.width && results[i].height === reference.height)
                results.splice(i, 1);
          const report = {
            caseIndex: reference.caseIndex,
            events: reference.events,
            width: reference.width,
            height: reference.height,
            semanticErrors,
            geometryErrors,
            browser: reference.elements,
            native: native.elements,
            state: native.state,
          };
          results.push(report);
          await writeFile(path.join(output, 'latest.json'), JSON.stringify(report, null, 2) + '\n');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ semanticErrors, geometryErrors, state: native.state }));
        } catch (e) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
  const server = await createServer({
    root: graph.root,
    cacheDir: path.resolve('.cache/vite-references', path.basename(graph.root)),
    configFile: false,
    plugins: [plugin, ...graph.tooling.plugins],
    server: { host: '127.0.0.1', port, strictPort: true },
    logLevel: 'error',
  });
  await server.listen();
  console.log(
    `Browser reference: http://localhost:${port}/\nExhaustive browser cases: http://localhost:${port}/?runicCase=0\nEvidence: ${output}`,
  );
  return server;
}
