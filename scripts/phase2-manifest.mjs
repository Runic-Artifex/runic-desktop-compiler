import {readFile,writeFile,readdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {hash} from '../compiler/collect.mjs';
const files=['.envrc','.gitignore','AGENTS.md','PROMPT.md','README.md','flake.nix','flake.lock','Cargo.toml','Cargo.lock','package.json','package-lock.json','conformance/vue-3.5.24/package.json','conformance/vue-3.5.24/package-lock.json'];
async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='dist')continue;const f=dir+'/'+e.name;if(e.isDirectory())await walk(f);else if(e.isFile())files.push(f);}}
for(const dir of ['compiler','native','fixtures','mappings','tests','scripts','docs'])await walk(dir);
const inputs={};for(const file of files.sort())inputs[file]=hash(await readFile(file));
const historical=JSON.parse(await readFile('evidence/phase1/source-manifest.json'));
for(const [file,digest]of Object.entries(historical.inputs))if(['quantity','thermostat','pricing','settings-wizard'].some(n=>file.startsWith('fixtures/'+n+'/')))assert.equal(inputs[file],digest,'Phase 1 fixture changed: '+file);
const baseline=JSON.parse(await readFile('baselines/phase0/baseline.json'));for(const [file,digest]of Object.entries(baseline.archives))assert.equal(hash(await readFile('baselines/phase0/'+file)),digest);
const artifacts={};
for(const name of ['quantity','thermostat','pricing','settings-wizard','counter-react','counter-vue','editor-react','editor-vue'].flatMap(n=>[n,n+'-no-opt']).concat('counter-vue-3.5.24','editor-vue-3.5.24')){
 artifacts[name]={...JSON.parse(await readFile('artifacts/'+name+'/build.json')),binarySha256:hash(await readFile('artifacts/'+name+'/runic-app'))};
}
const report={schema:1,algorithm:'SHA-256',scope:'Final Phase 2 implementation, ordinary source fixtures, documentation, mapping registry and root/additional-version lockfiles. Generated copies, dependencies, evidence and artifacts excluded from source hash. Historical Phase 1 fixtures and Phase 0 archives checked.',sourceHash:hash(inputs),inputs,artifacts,phase0Archives:baseline.archives,phase1FixturesUnchanged:true};
await writeFile('evidence/phase2/source-manifest.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({files:files.length,artifacts:Object.keys(artifacts).length,sourceHash:report.sourceHash}));
