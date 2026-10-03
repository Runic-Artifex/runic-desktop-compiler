import {readFile,writeFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hash} from '../compiler/collect.mjs';
import {previous,svelteApps,out,version,readJSON} from './phase3-common.mjs';
const files=['.envrc','.gitignore','AGENTS.md','PROMPT.md','README.md','flake.nix','flake.lock','Cargo.toml','Cargo.lock','package.json','package-lock.json',...['vue-3.5.24','svelte-'+version].flatMap(n=>['conformance/'+n+'/package.json','conformance/'+n+'/package-lock.json'])];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='dist')continue;const f=dir+'/'+e.name;if(e.isDirectory())await walk(f);else if(e.isFile())files.push(f);}}
for(const dir of ['compiler','native','fixtures','mappings','tests','scripts','docs'])await walk(dir);
const inputs={};for(const file of files.sort())inputs[file]=hash(await readFile(file));
const historical=await readJSON('evidence/phase2/source-manifest.json');
for(const [file,digest]of Object.entries(historical.inputs))if(previous.some(n=>file.startsWith('fixtures/'+n+'/'))||file.startsWith('native/')||['compiler/codegen.mjs','compiler/ir.mjs'].includes(file))assert.equal(inputs[file],digest,'Historical input changed: '+file);
assert.equal(inputs['docs/CONTRACT-V3.md'],historical.inputs['docs/CONTRACT.md']);
const baseline=await readJSON('baselines/phase0/baseline.json');for(const [file,digest]of Object.entries(baseline.archives))assert.equal(hash(await readFile('baselines/phase0/'+file)),digest);
const artifacts={};
for(const name of [...previous,...svelteApps].flatMap(n=>[n,n+'-no-opt']).concat('counter-vue-3.5.24','editor-vue-3.5.24',...svelteApps.map(n=>n+'-'+version)))artifacts[name]={...await readJSON('artifacts/'+name+'/build.json'),binarySha256:hash(await readFile('artifacts/'+name+'/runic-app'))};
const report={schema:1,algorithm:'SHA-256',scope:'Final Phase 3 source, fixtures, docs, mappings and all pinned lockfiles. Dependencies/generated copies/evidence/artifacts excluded from source hash. Phase 0 archives, prior ordinary fixtures, IR, Rust generator and native sources unchanged; contract v3 preserved.',sourceHash:hash(inputs),inputs,artifacts,phase0Archives:baseline.archives,phase2FixturesAndBackendUnchanged:true};
await writeFile(out+'/source-manifest.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({files:files.length,artifacts:Object.keys(artifacts).length,sourceHash:report.sourceHash}));
