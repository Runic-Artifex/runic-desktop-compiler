import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {buildApp} from '../compiler/cli.mjs';
import {startComparison} from '../compiler/compare.mjs';
import {loadRegistry} from '../compiler/mappings.mjs';
import {inspectNativeInputs} from '../compiler/codegen.mjs';
const {values}=parseArgs({options:{'run-dir':{type:'string'},build:{type:'boolean'},serve:{type:'boolean'},finalize:{type:'boolean'}}});
const out=path.resolve(values['run-dir']??'evidence/phase1/verification/current');
await mkdir(out,{recursive:true});
const apps=['quantity','thermostat','pricing','settings-wizard'],report={schema:2,created:new Date().toISOString(),runDirectory:out,checks:[],apps:[],status:'incomplete'};
const record=(name,status,details)=>report.checks.push({name,status,...details});
function run(cmd,args,input){const r=spawnSync(cmd,args,{encoding:'utf8',input,timeout:120000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr||r.stdout);return r.stdout;}
async function readJSON(file){try{return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function compilerTestInputHash(){
 const files=['Cargo.toml','Cargo.lock','package.json','package-lock.json','flake.nix','flake.lock'];
 async function walk(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name==='dist')continue;const file=path.join(dir,entry.name);if(entry.isDirectory())await walk(file);else if(entry.isFile())files.push(file);}}
 for(const dir of ['compiler','native','tests','mappings','fixtures'])await walk(dir);
 return hash(await Promise.all(files.sort().map(async file=>[file,hash(await readFile(file))])));
}
try{
 const testInputHash=await compilerTestInputHash();
 if(!values.finalize){const tests=run(process.execPath,['--test','--test-concurrency=1','tests/compiler.test.mjs','tests/phase1.test.mjs']);await writeFile(path.join(out,'compiler-tests.txt'),tests);const count=Number(tests.match(/\btests (\d+)/)?.[1]);assert.ok(count>0,'No compiler cases ran');record('compiler-tests','passed',{tests:count,inputHash:testInputHash});}
 else {const previous=await readJSON(path.join(out,'summary.json'));const old=previous?.checks.find(c=>c.name==='compiler-tests');if(old?.status==='passed'&&old.inputHash===testInputHash)report.checks.push(old);else record('compiler-tests','incomplete',{reason:'No passing compiler test result for current inputs; rerun without --finalize'});}
 const rules=await loadRegistry();record('registry','passed',{rules:rules.map(({id,version,sha256})=>({id,version,sha256}))});
 for(const app of apps){const graph=await collect('fixtures/'+app),{ir,edges}=await lower(graph);
  if(values.build)await buildApp(graph.root,{release:true,out:'artifacts/'+app});
  const built=await readJSON(`artifacts/${app}/ir.json`);
  if(!built||built.irHash!==ir.irHash){record('backend:'+app,'incomplete',{reason:'Missing or stale native artifact'});continue;}
  const binary=`artifacts/${app}/runic-app`;
  const build=await readJSON(`artifacts/${app}/build.json`);
  const compiledInputs=await inspectNativeInputs(ir,'artifacts/'+app,build.optimize);
  const actual=JSON.parse(run(binary,['--transitions'],JSON.stringify(edges)));assert.deepEqual(actual,edges.map(e=>e.to));
  const appReport={app,sourceHash:graph.hash,irHash:ir.irHash,binaryHash:hash(await readFile(binary)),compiledInputs,states:ir.validation.reachableStates,transitions:edges.length,browser:[]};
  const base=`artifacts/${app}-no-opt-release`;
  await inspectNativeInputs(ir,base,false);
  assert.deepEqual(JSON.parse(run(base+'/runic-app',['--transitions'],JSON.stringify(edges))),edges.map(e=>e.to));
  const trace=[0,1,2,3,0,1,2,3];
  for(const [label,exe]of [['opt',binary],['base',base+'/runic-app']])run(exe,['--headless','800','600',path.join(out,app+'-'+label),trace.join(',')]);
  const a=await readJSON(path.join(out,app+'-opt.json')),b=await readJSON(path.join(out,app+'-base.json'));
  assert.deepEqual(a.map(x=>({state:x.state,elements:x.elements})),b.map(x=>({state:x.state,elements:x.elements})));
  assert.deepEqual(await readFile(path.join(out,app+'-opt.png')),await readFile(path.join(out,app+'-base.png')));
  record('optimization-equivalence:'+app,'passed',{exhaustiveTransitions:edges.length,traceSnapshots:a.length,pixelIdentical:true});
  record('backend:'+app,'passed',{cases:edges.length});
  for(const width of [420,800]){
   const file=path.join(out,app,`report-${width}x600.json`),browser=await readJSON(file),complete=browser&&browser.complete&&browser.cases===edges.length&&browser.irHash===ir.irHash&&browser.sourceHash===graph.hash;
   const status=!complete?'incomplete':browser.semanticsPassed&&browser.geometryPassed?'passed':'failed';
   const item={width,height:600,status,cases:browser?.cases??0,expectedCases:edges.length,file:path.relative(process.cwd(),file)};appReport.browser.push(item);record(`browser:${app}:${width}`,status,item);
  }
  report.apps.push(appReport);
 }
 const tree=run('cargo',['tree','--locked','--edges','normal','--manifest-path','artifacts/quantity/Cargo.toml']);assert.doesNotMatch(tree,/boa_engine|quickjs|javascriptcore|webkit|wry|tauri|v8|deno_core/i);await writeFile(path.join(out,'dependency-tree.txt'),tree);record('engine-dependency-scan','passed',{});
 const experiment=await readJSON('evidence/phase1/discovery/experiment.json'),frozen=await readJSON('evidence/phase1/frozen-inputs.json');
 const discoveryCurrent=experiment?.status==='passed'&&experiment.acceptedCandidateBytesUnchanged&&experiment.sourceSchemaCorpusStillFrozen&&experiment.heldOutSourceIncluded===false&&experiment.attempts.length===2&&experiment.attempts.every(a=>a.exitCode===0&&a.toolItems.length===0)&&experiment.acceptedCandidateHash===rules.find(r=>r.id==='bounded-increase')?.sha256&&experiment.applications.length===2&&experiment.applications.every(a=>report.apps.some(r=>r.app===a.app&&r.sourceHash===a.sourceHash&&r.irHash===a.irHash))&&frozen?.schemaHash===hash(await readFile('mappings/schema.json'))&&frozen.corpusHash===hash(await readFile('mappings/validation-corpus.json'));
 record('live-discovery',!experiment?'untested':discoveryCurrent?'passed':'incomplete',{evidence:'evidence/phase1/discovery/experiment.json'});
 const native=await readJSON('evidence/phase1/native-checks.json');record('native-input',native?.keyboard?.status??'unavailable',{evidence:'evidence/phase1/native-checks.json'});record('native-resize',native?.resize?.status??'untested',{});record('wayland',native?.wayland?.status??'untested',{});
 const calibration=await readJSON('evidence/phase1/probes/capture-path.json');const corrected=calibration?.status==='passed'&&calibration.backgroundTab.meanAbsoluteError8Bit===0;
 const pixelFile=path.join(out,corrected?'corrected/pixels.json':'pixels.json'),pixels=await readJSON(pixelFile);
 let pixelsCurrent=!!pixels&&pixels.results.length===16&&new Set(pixels.results.map(r=>`${r.app}:${r.width}:${r.height}:${r.stage}`)).size===16;
 if(pixelsCurrent)for(const r of pixels.results){const app=report.apps.find(a=>a.app===r.app);pixelsCurrent&&=!!app&&r.sourceHash===app.sourceHash&&r.irHash===app.irHash&&[420,800].includes(r.width)&&r.height===600&&['initial','interaction'].includes(r.stage)&&r.tolerance8Bit===3&&hash(await readFile(r.browser))===r.browserHash&&hash(await readFile(r.native))===r.nativeHash;}
 record('pixel-comparison',!pixels?'untested':!pixelsCurrent?'incomplete':pixels.results.every(r=>r.passed&&r.pixelMeanAbsoluteError8Bit<=3)?'passed':'failed',{evidence:path.relative(process.cwd(),pixelFile),calibratedBackgroundCapture:corrected,artifactHashesCurrent:pixelsCurrent});
 const packages=await readJSON('evidence/phase1/fresh-install.json');
 let packagesCurrent=!!packages&&packages.results?.length===4&&new Set(packages.results.map(r=>r.app)).size===4;
 if(packagesCurrent)for(const r of packages.results){const app=report.apps.find(a=>a.app===r.app),dir=`artifacts/distribution/phase1/${r.app}`;packagesCurrent&&=!!app&&r.binaryHash===app.binaryHash&&r.irHash===app.irHash&&hash(await readFile(dir+'/app.tar.gz'))===r.appArchiveHash&&hash(await readFile(dir+'/closure.nar.gz'))===r.closureArchiveHash&&r.status==='passed';}
 record('fresh-install',!packages?'untested':packagesCurrent?packages.status:'incomplete',{evidence:'evidence/phase1/fresh-install.json',artifactHashesCurrent:packagesCurrent});
 const measurement=await readJSON('evidence/phase1/measurements.json');
 let measurementsCurrent=!!measurement&&measurement.results?.length===8&&new Set(measurement.results.map(r=>r.folder)).size===8;
 if(measurementsCurrent)for(const r of measurement.results){const app=report.apps.find(a=>a.app===r.app),expected=r.build.optimize?r.app:r.app+'-no-opt-release';measurementsCurrent&&=!!app&&r.folder===expected&&r.build.irHash===app.irHash&&r.build.sourceHash===app.sourceHash&&hash(await readFile(`artifacts/${r.folder}/runic-app`))===r.binaryHash&&r.startup.length===8&&r.updateRuns.length===5&&r.paintRuns.length===5;}
 record('measurements',!measurement?'untested':measurementsCurrent?'passed':'incomplete',{evidence:'evidence/phase1/measurements.json',artifactHashesCurrent:measurementsCurrent});
 const provenancePaths=['compiler/collect.mjs','compiler/frontend.mjs','compiler/ir.mjs','compiler/codegen.mjs','compiler/mappings.mjs','compiler/discovery.mjs','compiler/cli.mjs','native/runtime.rs','Cargo.toml','Cargo.lock','flake.nix','flake.lock','package-lock.json','mappings/registry.lock.json','scripts/verify.mjs'];
 report.provenance=Object.fromEntries(await Promise.all(provenancePaths.map(async file=>[file,hash(await readFile(file))])));
 report.toolchain={node:process.version,rust:run('rustc',['--version']).trim(),cargo:run('cargo',['--version']).trim()};
}catch(e){record('verification-driver','failed',{message:e.message});}
report.status=report.checks.some(c=>c.status==='failed')?'failed':report.checks.every(c=>c.status==='passed')?'passed':'incomplete';
await writeFile(path.join(out,'summary.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({summary:path.join(out,'summary.json'),status:report.status,checks:report.checks.map(({name,status,cases})=>({name,status,cases}))},null,2));
if(values.serve){for(const [i,app]of apps.entries())await startComparison(await collect('fixtures/'+app),{port:5180+i,out:path.join(out,app)});console.log('T3 preview: visit each port at /?runicCase=0, at 420x600 and 800x600. Then finalize the same run directory.');}
else if(report.status!=='passed')process.exitCode=report.status==='failed'?1:2;
