import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {inspectNativeInputs} from '../compiler/codegen.mjs';
import {loadRegistry} from '../compiler/mappings.mjs';
import {startComparison} from '../compiler/compare.mjs';
import {editingReference} from './phase2-browser.mjs';
import {editingCases} from './phase2-cases.mjs';

const out='evidence/phase2',names=['quantity','thermostat','pricing','settings-wizard','counter-react','counter-vue','editor-react','editor-vue'];
await mkdir(out,{recursive:true});
const readJSON=async file=>JSON.parse(await readFile(file,'utf8'));
const checks=[],record=(name,details={})=>checks.push({name,status:'passed',...details});
async function testInputs(){
 const files=['Cargo.toml','Cargo.lock','flake.nix','flake.lock','package.json','package-lock.json'];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='dist')continue;const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(e.isFile())files.push(f);}}
 for(const dir of ['compiler','native','tests','mappings','fixtures'])await walk(dir);
 return hash(await Promise.all(files.sort().map(async f=>[f,hash(await readFile(f))])));
}
if(process.argv.includes('--test')){
 const inputHash=await testInputs(),r=spawnSync(process.execPath,['--test','tests/compiler.test.mjs','tests/phase1.test.mjs','tests/phase2.test.mjs'],{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 await writeFile(out+'/compiler-tests.txt',r.stdout+r.stderr);assert.equal(r.status,0,r.stderr);
 const tests=Number(r.stdout.match(/\btests (\d+)/)?.[1]);assert.ok(tests>0);
 await writeFile(out+'/compiler-tests.json',JSON.stringify({status:'passed',tests,inputHash,logHash:hash(await readFile(out+'/compiler-tests.txt'))},null,2)+'\n');
}
if(process.argv.includes('--serve')){
 for(const [name,port]of [['editor-react',5190],['editor-vue',5191],['editor-vue-3.5.24',5194]])await editingReference(name.endsWith('3.5.24')?'conformance/vue-3.5.24/apps/'+name:'fixtures/'+name,{port});
 for(const [name,port]of [['counter-react',5192],['counter-vue',5193],['counter-vue-3.5.24',5195],['quantity',5196],['thermostat',5197],['pricing',5198],['settings-wizard',5199]])await startComparison(await collect(name.endsWith('3.5.24')?'conformance/vue-3.5.24/apps/'+name:'fixtures/'+name),{port,out:out+'/browser/'+name});
 console.log('Run finite references at 800x600 and 420x600 with /?runicCase=0; editors at 800x600 with /?case=0. Capture pixels separately, then rerun without --serve.');
}else{
 try{
  const tests=await readJSON(out+'/compiler-tests.json');assert.equal(tests.inputHash,await testInputs());assert.equal(tests.logHash,hash(await readFile(out+'/compiler-tests.txt')));record('compiler-tests',{tests:tests.tests});
  const rules=await loadRegistry();record('mapping-registry',{rules:rules.map(r=>({id:r.id,version:r.version,sha256:r.sha256}))});
  const regression=await readJSON(out+'/native/regression.json');assert.equal(regression.results.length,16);const apps=[];
  for(const name of names){
   const {ir}=await lower(await collect('fixtures/'+name));
   for(const optimize of [true,false]){const folder=name+(optimize?'':'-no-opt'),row=regression.results.find(r=>r.name===name&&r.optimize===optimize);assert.equal(row?.status,'passed');assert.equal(row.irHash,ir.irHash);assert.equal(row.sourceHash,ir.sourceHash);assert.equal(row.binaryHash,hash(await readFile('artifacts/'+folder+'/runic-app')));await inspectNativeInputs(ir,'artifacts/'+folder,optimize);}
   apps.push({name,sourceHash:ir.sourceHash,irHash:ir.irHash,frontend:ir.frontend,validation:ir.validation});
  }
  record('native-regression',{cases:regression.results.reduce((n,r)=>n+r.nativeCases,0),builds:16});
  for(const name of ['editor-react','editor-vue']){
   for(const suffix of [...editingCases.keys(),'composition','rejected']){
    const base=out+'/native/'+name+'-'+suffix,noOpt=out+'/native/'+name+'-no-opt-'+suffix;
    const observations=r=>r.map(({state,elements,focused})=>({state,elements,focused}));
    assert.deepEqual(observations(await readJSON(base+'.json')),observations(await readJSON(noOpt+'.json')));
    assert.deepEqual(await readFile(base+'.png'),await readFile(noOpt+'.png'));
   }
  }
  record('editor-optimization-parity',{tracePairs:2*(editingCases.length+2),pixelIdentical:true});
  const versions=await readJSON(out+'/versions.json');assert.equal(versions.results.length,2);
  const versionApps=[];
  for(const r of versions.results){assert.ok(r.sourceIdentical&&r.rustBehaviorIdentical&&r.validationIdentical);assert.equal(r.compilerBackend,hash(await readFile('compiler/codegen.mjs')));assert.equal(r.nativeBindings,hash(await readFile('native/controls.rs')));const name=path.basename(r.app),ir=await readJSON('artifacts/'+name+'/ir.json');assert.equal(ir.sourceHash,r.sourceHash);assert.deepEqual(ir.frontend,r.additional);await inspectNativeInputs(ir,'artifacts/'+name,true);versionApps.push({name,sourceHash:ir.sourceHash,irHash:ir.irHash,frontend:ir.frontend,validation:ir.validation});}
  record('additional-framework-version',{versions:['3.5.43','3.5.24'],apps:2,sharedRustBehavior:true});
  let finiteCases=0,editingSteps=0;
  for(const app of [...apps,...versionApps]){
   const folder='artifacts/'+app.name,binaryHash=hash(await readFile(folder+'/runic-app')),nativeInputs=await inspectNativeInputs(await readJSON(folder+'/ir.json'),folder,true);
   if(app.name.startsWith('editor')){
    const r=await readJSON(out+'/browser/'+app.name+'.json');assert.ok(r.complete&&r.passed&&r.geometryPassed);assert.equal(r.results.length,editingCases.length);assert.equal(r.expectedCases,editingCases.length);assert.equal(r.sourceHash,app.sourceHash);assert.equal(r.irHash,app.irHash);assert.equal(r.binaryHash,binaryHash);assert.deepEqual(r.nativeInputs,nativeInputs);editingSteps+=r.results.reduce((n,c)=>n+c.steps,0);
   }else for(const width of [420,800]){
    const r=await readJSON(out+'/browser/'+app.name+'/report-'+width+'x600.json');assert.ok(r.complete&&r.semanticsPassed&&r.geometryPassed);assert.equal(r.cases,app.validation.transitions);assert.equal(r.sourceHash,app.sourceHash);assert.equal(r.irHash,app.irHash);assert.equal(r.binaryHash,binaryHash);assert.deepEqual(r.nativeInputs,nativeInputs);finiteCases+=r.cases;
   }
  }
  record('browser-conformance',{finiteCases,editingScenarios:3*editingCases.length,editingSteps,geometryTolerancePx:2,route:'Original framework execution with programmatic browser actions versus native internal events'});
  const probe=await readJSON(out+'/native/editing-probe.json');assert.equal(probe.checks.length,14);assert.ok(probe.checks.every(r=>r.passed));for(const file of ['native/editing_probe.rs','native/controls.rs','Cargo.toml','Cargo.lock'])assert.equal(probe.inputs[file],hash(await readFile(file)));assert.equal(probe.binaryHash,hash(await readFile('target/release/editing-probe')));record('native-editing-probe',{checks:14,route:probe.route});
  const keyboard=await readJSON(out+'/browser/keyboard-boundary.json');assert.equal(keyboard.results.length,2);assert.ok(keyboard.results.every(r=>r.status==='passed'&&r.rejected.length===256&&r.rejected.start===100&&r.rejected.end===100&&r.replaced.length===256&&r.replaced.start===101&&r.replaced.value[100]==='b'));record('browser-keyboard-boundary',{apps:2,route:keyboard.route});
  const tree=spawnSync('cargo',['tree','--locked','--edges','normal','--manifest-path','artifacts/editor-vue/Cargo.toml'],{encoding:'utf8',timeout:30000});assert.equal(tree.status,0,tree.stderr);assert.doesNotMatch(tree.stdout,/boa_engine|quickjs|javascriptcore|webkit|wry|tauri|v8|deno_core/i);await writeFile(out+'/native/dependency-tree.txt',tree.stdout);record('engine-dependency-scan');
  const pixels=await readJSON(out+'/pixels.json');assert.equal(pixels.results.length,24);const calibration=await readJSON(out+'/probes/capture-path.json');assert.equal(calibration.status,'passed');const cal=spawnSync('magick',['compare','-metric','MAE',calibration.image,calibration.expected,'null:'],{encoding:'utf8',timeout:30000});assert.equal(cal.status,0,cal.stderr);assert.equal(calibration.meanAbsoluteError8Bit,0);
  for(const r of pixels.results){assert.ok(r.passed&&r.pixelMeanAbsoluteError8Bit<=3);assert.equal(r.tolerance8Bit,3);assert.equal(hash(await readFile(r.browser)),r.browserHash);assert.equal(hash(await readFile(r.native)),r.nativeHash);const app=apps.find(a=>a.name===r.app);assert.equal(r.irHash,app.irHash);assert.equal(r.sourceHash,app.sourceHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.app+'/runic-app')));}
  record('pixel-comparison',{pairs:24,tolerance8Bit:3,archivedBrowserReferences:16});
  const fresh=await readJSON(out+'/fresh-install.json');assert.equal(fresh.status,'passed');assert.equal(fresh.results.length,4);
  for(const r of fresh.results){const dir='artifacts/distribution/phase2/'+r.app,app=apps.find(a=>a.name===r.app);assert.equal(r.status,'passed');assert.equal(r.irHash,app.irHash);assert.equal(r.binaryHash,hash(await readFile('artifacts/'+r.app+'/runic-app')));assert.equal(r.appArchiveHash,hash(await readFile(dir+'/app.tar.gz')));assert.equal(r.closureArchiveHash,hash(await readFile(dir+'/closure.nar.gz')));}
  record('fresh-install',{apps:4,engineFree:true});
  const historical=await readJSON('baselines/phase0/baseline.json');for(const [file,digest]of Object.entries(historical.archives))assert.equal(hash(await readFile('baselines/phase0/'+file)),digest);record('phase0-archives',{unchanged:true});
  const os=await readJSON(out+'/native/os-input.json');checks.push({name:'os-keyboard-platform-ime-wayland-resize',status:os.status,evidence:out+'/native/os-input.json'});
 }catch(e){checks.push({name:'verification-driver',status:'failed',message:e.message});}
 const status=checks.some(c=>c.status==='failed')?'failed':checks.every(c=>c.status==='passed')?'passed':'incomplete';
 await writeFile(out+'/verification.json',JSON.stringify({schema:1,status,checks},null,2)+'\n');console.log(JSON.stringify({status,checks},null,2));if(status==='failed')process.exitCode=1;else if(status==='incomplete')process.exitCode=2;
}
