import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {inspectNativeInputs} from '../compiler/codegen.mjs';
import {loadRegistry} from '../compiler/mappings.mjs';
import {out,apps,retained,versions,additional,readJSON,sourceInputs} from './phase4-common.mjs';
await mkdir(out,{recursive:true});
const testInputs=async()=>Object.fromEntries(Object.entries(await sourceInputs()).filter(([file])=>!file.startsWith('docs/')&&!['README.md','AGENTS.md','PROMPT.md'].includes(file)));
if(process.argv.includes('--test')){
 const inputHash=hash(await testInputs()),run=spawnSync(process.execPath,['--test',...['compiler','phase1','phase2','phase3','phase4'].map(n=>'tests/'+n+'.test.mjs')],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 await writeFile(out+'/compiler-tests.txt',run.stdout+run.stderr);assert.equal(run.status,0,run.stderr);
 const tests=Number(run.stdout.match(/\btests (\d+)/)?.[1]);assert.ok(tests>0);
 await writeFile(out+'/compiler-tests.json',JSON.stringify({status:'passed',tests,inputHash,logHash:hash(await readFile(out+'/compiler-tests.txt'))},null,2)+'\n');
}
const checks=[],record=(name,details={})=>checks.push({name,status:'passed',...details});
try{
 const tests=await readJSON(out+'/compiler-tests.json');assert.equal(tests.inputHash,hash(await testInputs()));assert.equal(tests.logHash,hash(await readFile(out+'/compiler-tests.txt')));record('compiler-tests',{tests:tests.tests});
 const registry=await loadRegistry();record('existing-pinned-mappings',{rules:registry.map(r=>({id:r.id,version:r.version,sha256:r.sha256}))});
 const native=await readJSON(out+'/native.json');assert.equal(native.status,'passed');assert.equal(native.results.length,28);
 for(const r of native.results){
  const version=versions.find(v=>r.artifact==='modules-'+v.framework+'-'+v.version),name=r.artifact.replace(/-no-opt$/,''),app=version?additional(version):'fixtures/'+name,{ir}=await lower(await collect(app));
  assert.equal(r.status,'passed');assert.equal(r.sourceHash,ir.sourceHash);assert.equal(r.irHash,ir.irHash);assert.deepEqual(r.frontend,ir.frontend);assert.deepEqual(r.validation,ir.validation);
  assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.artifact+'/runic-app')));assert.deepEqual(r.nativeInputs,await inspectNativeInputs(ir,'artifacts/'+r.artifact,!r.artifact.endsWith('-no-opt')));
  assert.equal(r.nativeCases,name.startsWith('editor')?2088:ir.validation.transitions);
 }
 assert.equal(native.totalNativeCases,native.results.reduce((n,r)=>n+r.nativeCases,0));record('native-transitions',{cases:native.totalNativeCases,artifacts:native.results.length});
 assert.equal(native.parity.length,18);
 for(const p of native.parity){const base=`${out}/native/${p.app}-${p.stage}-${p.width}x600`,other=`${out}/native/${p.app}-no-opt-${p.stage}-${p.width}x600`;const observations=t=>t.map(({state,elements,focused,event,irHash})=>({state,elements,focused,event,irHash}));assert.deepEqual(observations(await readJSON(base+'.json')),observations(await readJSON(other+'.json')));assert.equal(p.traceHash,hash(await readFile(base+'.json')));assert.equal(p.pixelHash,hash(await readFile(base+'.png')));assert.equal(p.pixelHash,hash(await readFile(other+'.png')));}
 record('native-binding-mode-parity',{tracePairs:18,framebuffersIdentical:true,timingAndWriteCounts:'Recorded in traces, excluded from semantic equality'});
 assert.equal(native.versions.length,2);for(const v of native.versions)assert.ok(v.sourceIdentical&&v.transitionsIdentical&&v.normalizedRustIdentical);record('additional-framework-versions',{vue:['3.5.43','3.5.24'],svelte:['5.57.1','5.49.2']});
 let cases=0;
 for(const name of [...apps,...versions.map(v=>'modules-'+v.framework+'-'+v.version)])for(const width of apps.includes(name)?[420,800]:[800]){
  const r=await readJSON(`${out}/browser/${name}/report-${width}x600.json`),n=native.results.find(r=>r.artifact===name);assert.ok(r.complete&&r.semanticsPassed&&r.geometryPassed,name+' browser comparison');assert.equal(r.cases,n.validation.transitions);assert.equal(r.sourceHash,n.sourceHash);assert.equal(r.irHash,n.irHash);assert.equal(r.binaryHash,n.binaryHash);assert.deepEqual(r.nativeInputs,n.nativeInputs);cases+=r.cases;
 }
 record('fresh-original-runtime-conformance',{cases,frameworkRuntimes:5,geometryTolerancePx:2,route:'Programmatic browser clicks versus native internal events'});
 const inputs=await sourceInputs(),prior=await readJSON('evidence/phase3/source-manifest.json');
 for(const [file,digest]of Object.entries(prior.inputs))if(file.startsWith('fixtures/')||file.startsWith('native/')||['compiler/codegen.mjs','compiler/ir.mjs','package.json','package-lock.json','Cargo.toml','Cargo.lock','flake.nix','flake.lock'].includes(file)||file.startsWith('mappings/'))assert.equal(inputs[file],digest,'Preserved input changed: '+file);
 assert.equal(inputs['docs/CONTRACT-V4.md'],prior.inputs['docs/CONTRACT.md']);
 for(const r of native.results.filter(r=>retained.includes(r.artifact.replace(/-no-opt$/,''))))assert.equal(r.binaryHash,prior.artifacts[r.artifact].binarySha256);
 record('historical-source-and-native-identities',{retainedArtifacts:20,irValidatorRustGeneratorNativeBindingsAndLocksUnchanged:true});
 const baseline=await readJSON('baselines/phase0/baseline.json');for(const [file,digest]of Object.entries(baseline.archives))assert.equal(hash(await readFile('baselines/phase0/'+file)),digest);record('phase0-archives',{unchanged:true});
 const artifacts=Object.fromEntries(native.results.map(r=>[r.artifact,{sourceHash:r.sourceHash,irHash:r.irHash,binarySha256:r.binaryHash}]));
 await writeFile(out+'/source-manifest.json',JSON.stringify({schema:1,algorithm:'SHA-256',sourceHash:hash(inputs),inputs,artifacts,phase3FixturesAndBackendUnchanged:true,scope:'Phase 4 source and lockfiles; generated copies, dependencies, evidence and artifacts excluded. Historical native artifacts retain exact Phase 3 identities.'},null,2)+'\n');
 const os=await readJSON('evidence/phase2/native/os-input.json');checks.push({name:'inherited-native-os-keyboard-platform-ime-wayland-resize',status:os.status,evidence:'evidence/phase2/native/os-input.json',scope:'Phase 4 changes source lowering only and adds no OS certification'});
}catch(e){checks.push({name:'verification-driver',status:'failed',message:e.message});}
const status=checks.some(c=>c.status==='failed')?'failed':checks.every(c=>c.status==='passed')?'passed':'incomplete';
await writeFile(out+'/verification.json',JSON.stringify({schema:1,status,checks},null,2)+'\n');console.log(JSON.stringify({status,checks},null,2));process.exitCode=status==='failed'?1:status==='incomplete'?2:0;
