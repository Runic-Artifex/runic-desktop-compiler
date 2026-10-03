import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,mkdir,rm,readFile } from 'node:fs/promises';
import path from 'node:path';
import { collect } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { transition,validateIR } from '../compiler/ir.mjs';
import { render } from '../compiler/ir.mjs';
import { validateCandidate } from '../compiler/mappings.mjs';
import { generate } from '../compiler/codegen.mjs';
import { discover } from '../compiler/discovery.mjs';

async function fixture(source,run,extra={}) {
  await mkdir('.cache/tests',{recursive:true});const root=await mkdtemp(path.resolve('.cache/tests/case-'));
  try {
    await writeFile(path.join(root,'runic.json'),JSON.stringify({entry:'main.jsx',title:'Test'}));
    await writeFile(path.join(root,'index.html'),'<!doctype html><html><head><title>Test</title></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
    await writeFile(path.join(root,'main.jsx'),`import React, {useState} from 'react'; import {createRoot} from 'react-dom/client'; ${source}\ncreateRoot(document.getElementById('root')).render(<App />);`);
    for(const [file,text] of Object.entries(extra))await writeFile(path.join(root,file),text);
    return await run(root);
  }finally{await rm(root,{recursive:true,force:true});}
}
const analyze=root=>collect(root).then(lower);
const reject=(source,code,extra)=>fixture(source,root=>assert.rejects(()=>analyze(root),e=>e.code===code),extra);

test('ordinary fixtures use identical accepted mapping with independent finite state spaces',async()=>{
  const a=await analyze('fixtures/quantity'),b=await analyze('fixtures/thermostat');
  assert.equal(a.ir.validation.reachableStates,16);assert.equal(b.ir.validation.reachableStates,14);
  assert.deepEqual(a.ir.mappings,b.ir.mappings);
  assert.deepEqual(transition(a.ir,[2,false],2),[4,false]);
  assert.deepEqual(transition(a.ir,[8,false],1),[8,false]);
  assert.deepEqual(transition(a.ir,[1,false],0),[1,false]);
  assert.deepEqual(transition(b.ir,[20,true],0),[18,true]);
  assert.equal(generate(a.ir),generate((await analyze('fixtures/quantity')).ir));
});
test('mapping is unavailable without the pinned registry',async()=>{
  await assert.rejects(()=>collect('fixtures/quantity').then(g=>lower(g,{registry:false})),e=>e.code==='E_MAPPING'&&e.source.file==='src/Quantity.jsx');
});
test('updates use pending previous values and captured render snapshot across slots',async()=>{
  await fixture(`function App(){const [a,setA]=useState(0);const [b,setB]=useState(0);function click(){setA(v=>Math.min(v+1,3));setA(v=>Math.min(v+1,3));setB(v=>a);}return <button id="go" onClick={click}>{a} {b}</button>;}`,async root=>{
    const {ir}=await analyze(root);assert.deepEqual(transition(ir,[0,0],0),[2,0]);assert.deepEqual(transition(ir,[2,0],0),[3,2]);
  });
});
test('state bounds require reachable closure, not a type annotation or hopeful range',async()=>{
  await reject('function App(){const[n,set]=useState(64);return <button onClick={()=>set(v=>v+1)}>{n}</button>;}','E_STATE_BOUND');
  await reject('function App(){const[n,set]=useState(-0);return <p>{n}</p>;}','E_NUMBER');
  await reject('function App(){const[n,set]=useState(1.5);return <p>{n}</p>;}','E_NUMBER');
  await reject('function App(){return <p>{1+"2"}</p>;}','E_TYPE');
});
test('unknown effect, dependency and unexecuted module side effect never disappear',async()=>{
  await reject('function App(){console.log("render");return <p>Hi</p>;}','E_COMPONENT');
  await reject('const discarded=Date.now();function App(){return <p>Hi</p>;}','E_CALL');
  await reject('import {useEffect} from "react";function App(){return <p>Hi</p>;}','E_CAPABILITY');
  await reject('function App(){return <p>{Math.random()}</p>;}','E_CALL');
});
test('conditional stateful components and nonliteral state payloads are rejected',async()=>{
  await reject('function Child(){const[n,set]=useState(1);return <p>{n}</p>;}function App(){const[show,set]=useState(true);return <div>{show&&<Child/>}</div>;}','E_CONDITIONAL_STATE');
  await reject('function App(){const[n,set]=useState(1);return <button onClick={()=>set(Date.now())}>{n}</button>;}','E_CALL');
});
test('resolved identities reject familiar names with incompatible behavior',async()=>{
  await reject('function constrain(a,b,c){return Math.min(Math.max(a,b),c)+1;}function App(){return <p>{constrain(2,1,8)}</p>;}','E_MAPPING');
  await reject('function constrain(a,b,c){return Math.min(Math.max(a,b),c);}function App(){return <p>{constrain(2,8,1)}</p>;}','E_MAPPING_PRECONDITION');
  await reject('const Math=0;function App(){return <p>{Math.min(1,2)}</p>;}','E_CALL');
});
test('IR validator rejects corrupted typed operations',async()=>{
  const {ir}=await analyze('fixtures/smoke');const broken=structuredClone(ir);broken.handlers[0].updates[0].value.args[0].type='boolean';
  assert.throws(()=>validateIR(broken),e=>e.code==='E_IR');
});
test('independent mapping validator accepts replay and rejects a wrong rewrite',async()=>{
  const report=await validateCandidate('mappings/replay/pure-clamp.json');assert.equal(report.cases,60430);assert.equal(report.structuralCases,11);
  const bad=JSON.parse(await readFile('mappings/replay/pure-clamp.json','utf8'));bad.lowering.op='max';
  const file='.cache/tests/bad-rule.json';await writeFile(file,JSON.stringify(bad));try{await assert.rejects(()=>validateCandidate(file),e=>e.code==='E_RULE_DIFFERENTIAL');}finally{await rm(file);}
});
test('discovery provider boundary retains hashes and labels a test candidate truthfully',async()=>{
  const graph=await collect('fixtures/quantity');
  await fixture('function App(){return <p>Provider test</p>;}',async root=>{
    const out=path.join(root,'discovery'),provider=path.join(root,'provider');
    const replay=await readFile('mappings/replay/pure-clamp.json','utf8');
    await writeFile(provider,`#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(replay)}));\n`,{mode:0o755});
    const evidence=await discover(graph,out,{provider});
    assert.equal(evidence.mode,'external-provider-command');assert.equal(evidence.liveDiscovery,false);
    const bundle=await readFile(path.join(out,'bundle.json'),'utf8');assert.doesNotMatch(bundle,/Thermostat|keepBetween|thermostat/);
    assert.equal(evidence.candidateHash,(await validateCandidate(path.join(out,'candidate.json'))).candidateHash);
  });
});
test('JSX entities lower to text, while unsafe string values are diagnosed',async()=>{
  await fixture('function App(){return <p title="A &amp; B">Fish &amp; chips &#169;</p>;}',async root=>{
    const {ir}=await analyze(root),tree=render(ir,[]);assert.equal(tree.attrs.title,'A & B');assert.equal(tree.children[0].text,'Fish & chips ©');
    ir.ui.children[0].parts[0].value='\u0000';assert.throws(()=>validateIR(ir),e=>e.code==='E_STRING');
  });
  await reject('function App(){return <p>{"\\u0000"}</p>;}','E_STRING');
  await reject('function App(){return <p>{"\\ud800"}</p>;}','E_STRING');
});
test('HTML effects are rejected and CSS preserves entry import order',async()=>{
  await fixture('function App(){return <p>Hi</p>;}',async root=>{
    const file=path.join(root,'index.html');await writeFile(file,(await readFile(file,'utf8')).replace('</body>','<script>window.sideEffect=1;</script></body>'));await assert.rejects(()=>collect(root),e=>e.code==='E_HTML');
  });
  const extra={'a.css':'body{color:red}','b.css':'body{color:blue}'};
  const css=await fixture('import "./b.css";import "./a.css";function App(){return <p>Hi</p>;}',async root=>(await collect(root)).css,extra);
  assert.ok(css.indexOf('blue')<css.indexOf('red'));
  const reversed=await fixture('import "./a.css";import "./b.css";function App(){return <p>Hi</p>;}',async root=>(await collect(root)).css,extra);
  assert.ok(reversed.indexOf('red')<reversed.indexOf('blue'));
});
