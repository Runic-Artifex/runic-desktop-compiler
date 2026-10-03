import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {generate,inspectNativeInputs} from '../compiler/codegen.mjs';
import {loadRegistry} from '../compiler/mappings.mjs';
import {editingCases} from './phase2-cases.mjs';
import {out,previous,svelteApps,version,readJSON,testInputs,additional} from './phase3-common.mjs';
await mkdir(out,{recursive:true});
if(process.argv.includes('--test')){
 const inputHash=await testInputs(),r=spawnSync(process.execPath,['--test','tests/compiler.test.mjs','tests/phase1.test.mjs','tests/phase2.test.mjs','tests/phase3.test.mjs'],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 await writeFile(out+'/compiler-tests.txt',r.stdout+r.stderr);assert.equal(r.status,0,r.stderr);
 const tests=Number(r.stdout.match(/\btests (\d+)/)?.[1]);assert.ok(tests>0);
 await writeFile(out+'/compiler-tests.json',JSON.stringify({status:'passed',tests,inputHash,logHash:hash(await readFile(out+'/compiler-tests.txt'))},null,2)+'\n');
}
const checks=[],record=(name,details={})=>checks.push({name,status:'passed',...details});
try{
 const tests=await readJSON(out+'/compiler-tests.json');assert.equal(tests.inputHash,await testInputs());assert.equal(tests.logHash,hash(await readFile(out+'/compiler-tests.txt')));record('compiler-tests',{tests:tests.tests});
 record('mapping-registry',{rules:(await loadRegistry()).map(r=>({id:r.id,version:r.version,sha256:r.sha256}))});
 const regression=await readJSON(out+'/native/regression.json');assert.equal(regression.results.length,20);const apps=[];
 for(const name of [...previous,...svelteApps]){
  const {ir}=await lower(await collect('fixtures/'+name));
  for(const optimize of [true,false]){const folder='artifacts/'+name+(optimize?'':'-no-opt'),r=regression.results.find(r=>r.name===name&&r.optimize===optimize);assert.equal(r?.status,'passed');assert.equal(r.irHash,ir.irHash);assert.equal(r.sourceHash,ir.sourceHash);assert.equal(r.binaryHash,hash(await readFile(folder+'/runic-app')));await inspectNativeInputs(ir,folder,optimize);}
  apps.push({name,ir});
 }
 record('native-regression',{cases:regression.results.reduce((n,r)=>n+r.nativeCases,0),builds:20,previousBuilds:'16 unchanged native-input identities checked before reuse and re-execution'});
 for(const suffix of [...editingCases.keys(),'composition','rejected']){
  const base=out+'/native/editor-svelte-'+suffix,noOpt=out+'/native/editor-svelte-no-opt-'+suffix;
  const observations=r=>r.map(({state,elements,focused})=>({state,elements,focused}));assert.deepEqual(observations(await readJSON(base+'.json')),observations(await readJSON(noOpt+'.json')));assert.deepEqual(await readFile(base+'.png'),await readFile(noOpt+'.png'));
 }
 record('svelte-editor-optimization-parity',{tracePairs:editingCases.length+2,pixelIdentical:true});
 const versions=await readJSON(out+'/versions.json');assert.equal(versions.results.length,2);let additionalCases=0;
 for(const r of versions.results){
  const name=path.basename(r.app),current=apps.find(a=>a.name===name.replace('-'+version,'')).ir,{ir}=await lower(await collect(r.app));
  const behavior=ir=>hash(generate(ir).replaceAll(ir.irHash,'<IR_HASH>'));
  assert.ok(r.sourceIdentical&&r.rustBehaviorIdentical&&r.validationIdentical);assert.equal(behavior(ir),behavior(current));assert.deepEqual(ir.validation,current.validation);assert.equal(r.sourceHash,ir.sourceHash);assert.equal(ir.sourceHash,current.sourceHash);assert.deepEqual(ir.frontend,r.additional);assert.deepEqual(current.frontend,r.current);assert.equal(ir.frontend.packages.svelte,version);assert.equal(r.compilerBackend,hash(await readFile('compiler/codegen.mjs')));assert.equal(r.nativeBindings,hash(await readFile('native/controls.rs')));assert.equal(r.binaryHash,hash(await readFile('artifacts/'+name+'/runic-app')));await inspectNativeInputs(ir,'artifacts/'+name,true);additionalCases+=r.nativeCases;apps.push({name,ir});
 }
 record('additional-svelte-version',{versions:['5.57.1',version],apps:2,sharedRustBehavior:true,nativeCases:additionalCases});
 let finiteCases=0,editingSteps=0;
 for(const app of apps.filter(a=>/^(counter|editor)-/.test(a.name))){
  const folder='artifacts/'+app.name,binaryHash=hash(await readFile(folder+'/runic-app')),nativeInputs=await inspectNativeInputs(app.ir,folder,true);
  if(app.name.startsWith('editor')){
   const r=await readJSON(out+'/browser/'+app.name+'.json');assert.ok(r.complete&&r.passed&&r.geometryPassed,app.name+' editor conformance');assert.equal(r.expectedCases,editingCases.length);assert.equal(r.results.length,editingCases.length);assert.equal(r.sourceHash,app.ir.sourceHash);assert.equal(r.irHash,app.ir.irHash);assert.equal(r.binaryHash,binaryHash);assert.deepEqual(r.nativeInputs,nativeInputs);editingSteps+=r.results.reduce((n,c)=>n+c.steps,0);
  }else for(const width of [420,800]){
   const r=await readJSON(out+'/browser/'+app.name+'/report-'+width+'x600.json');assert.ok(r.complete&&r.semanticsPassed&&r.geometryPassed,app.name+' finite conformance');assert.equal(r.cases,app.ir.validation.transitions);assert.equal(r.sourceHash,app.ir.sourceHash);assert.equal(r.irHash,app.ir.irHash);assert.equal(r.binaryHash,binaryHash);assert.deepEqual(r.nativeInputs,nativeInputs);finiteCases+=r.cases;
  }
 }
 record('fresh-browser-conformance',{finiteCases,editingScenarios:4*editingCases.length,editingSteps,geometryTolerancePx:2,route:'Original frameworks with programmatic browser actions versus native internal events'});
 // The four frozen Phase 1 apps have identical source, IR and binary inputs.
 // Their original-runtime Phase 2 reports are retained with explicit identity
 // checks, alongside newly executed native transitions above.
 let retainedCases=0;
 for(const name of previous.slice(0,4))for(const width of [420,800]){
  const app=apps.find(a=>a.name===name),r=await readJSON('evidence/phase2/browser/'+name+'/report-'+width+'x600.json');assert.ok(r.complete&&r.semanticsPassed&&r.geometryPassed);assert.equal(r.irHash,app.ir.irHash);assert.equal(r.sourceHash,app.ir.sourceHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+name+'/runic-app')));assert.deepEqual(r.nativeInputs,await inspectNativeInputs(app.ir,'artifacts/'+name,true));retainedCases+=r.cases;
 }
 record('retained-original-runtime-references',{cases:retainedCases,sourceIrAndNativeInputsUnchanged:true});
 const probe=await readJSON(out+'/native/editing-probe.json');assert.equal(probe.checks.length,14);assert.ok(probe.checks.every(r=>r.passed));for(const [file,digest]of Object.entries(probe.inputs))assert.equal(digest,hash(await readFile(file)));assert.equal(probe.binaryHash,hash(await readFile('target/release/editing-probe')));record('native-editing-probe',{checks:14,route:probe.route});
 const order=await readJSON(out+'/browser/binding-order.json'),orderSource=await readJSON(out+'/browser/binding-order-source.json');assert.equal(order.status,'passed');assert.equal(order.sourceHash,orderSource.sourceHash);assert.equal(hash(orderSource.source),orderSource.sourceHash);assert.deepEqual(order.results,[{payload:'first',before:'first',after:'first'},{payload:'second',before:'second',after:'second'}]);record('svelte-binding-listener-order',{route:order.route,observed:'Modern delegated oninput sees the updated bound value in the pinned runtime; combination remains rejected'});
 const keys=await readJSON(out+'/browser/keyboard-boundary.json');assert.equal(keys.status,'passed');assert.ok(keys.rejected.length===256&&keys.rejected.start===100&&keys.rejected.end===100&&keys.replaced.length===256&&keys.replaced.start===101&&keys.replaced.value[100]==='b');record('svelte-browser-keyboard-boundary',{route:keys.route});
 const calibration=await readJSON(out+'/probes/capture-path.json');assert.equal(calibration.status,'passed');const cal=spawnSync('magick',['compare','-metric','MAE',calibration.image,calibration.expected,'null:'],{encoding:'utf8',timeout:30000});assert.equal(cal.status,0,cal.stderr);assert.equal(calibration.meanAbsoluteError8Bit,0);
 const pixels=await readJSON(out+'/pixels.json');assert.equal(pixels.results.length,10);
 for(const r of pixels.results){const app=apps.find(a=>a.name===r.app);assert.ok(r.passed&&r.pixelMeanAbsoluteError8Bit<=3);assert.equal(r.tolerance8Bit,3);assert.equal(r.irHash,app.ir.irHash);assert.equal(r.sourceHash,app.ir.sourceHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.app+'/runic-app')));assert.equal(r.browserHash,hash(await readFile(r.browser)));assert.equal(r.nativeHash,hash(await readFile(r.native)));}
 record('svelte-pixels',{pairs:10,tolerance8Bit:3});
 const oldPixels=await readJSON('evidence/phase2/pixels.json');for(const r of oldPixels.results){const app=apps.find(a=>a.name===r.app);assert.ok(r.passed);assert.equal(r.irHash,app.ir.irHash);assert.equal(r.sourceHash,app.ir.sourceHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.app+'/runic-app')));assert.equal(r.browserHash,hash(await readFile(r.browser)));assert.equal(r.nativeHash,hash(await readFile(r.native)));}record('retained-react-vue-pixels',{pairs:24,sourceIrBinaryAndCapturesUnchanged:true});
 const tree=spawnSync('cargo',['tree','--locked','--edges','normal','--manifest-path','artifacts/editor-svelte/Cargo.toml'],{encoding:'utf8',timeout:30000});assert.equal(tree.status,0,tree.stderr);assert.doesNotMatch(tree.stdout,/boa_engine|quickjs|javascriptcore|webkit|wry|tauri|v8|deno_core/i);await writeFile(out+'/native/dependency-tree.txt',tree.stdout);record('engine-dependency-scan');
 const fresh=await readJSON(out+'/fresh-install.json');assert.equal(fresh.status,'passed');assert.equal(fresh.results.length,2);for(const r of fresh.results){const app=apps.find(a=>a.name===r.app),dir='artifacts/distribution/phase3/'+r.app;assert.equal(r.status,'passed');assert.equal(r.irHash,app.ir.irHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.app+'/runic-app')));assert.equal(r.appArchiveHash,hash(await readFile(dir+'/app.tar.gz')));assert.equal(r.closureArchiveHash,hash(await readFile(dir+'/closure.nar.gz')));}record('fresh-install',{apps:2,engineFree:true});
 const baseline=await readJSON('baselines/phase0/baseline.json');for(const [file,digest]of Object.entries(baseline.archives))assert.equal(hash(await readFile('baselines/phase0/'+file)),digest);record('phase0-archives',{unchanged:true});
 const os=await readJSON('evidence/phase2/native/os-input.json');checks.push({name:'os-keyboard-platform-ime-wayland-resize',status:os.status,evidence:'evidence/phase2/native/os-input.json',scope:'Unchanged native runtime and controls; Phase 3 adds no OS-delivery certification'});
}catch(e){checks.push({name:'verification-driver',status:'failed',message:e.message});}
const status=checks.some(c=>c.status==='failed')?'failed':checks.every(c=>c.status==='passed')?'passed':'incomplete';
await writeFile(out+'/verification.json',JSON.stringify({schema:1,status,checks},null,2)+'\n');console.log(JSON.stringify({status,checks},null,2));if(status==='failed')process.exitCode=1;else if(status==='incomplete')process.exitCode=2;
