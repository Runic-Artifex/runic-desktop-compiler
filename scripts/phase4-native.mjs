import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {generate,inspectNativeInputs} from '../compiler/codegen.mjs';
import {buildApp} from '../compiler/cli.mjs';
import {transition} from '../compiler/ir.mjs';
import {out,apps,retained,versions,syncVersionFixture,readJSON} from './phase4-common.mjs';
const run=(file,args,input)=>{const p=spawnSync(file,args,{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});assert.equal(p.status,0,p.stderr||p.stdout);return p.stdout;};
const build=process.argv.includes('--build'),results=[],parity=[],versionResults=[];
async function ensure(app,ir,noOpt=false){
 const folder='artifacts/'+app.split('/').at(-1)+(noOpt?'-no-opt':'');
 if(build){
  let valid=false;try{const b=await readJSON(folder+'/build.json');if(b.irHash===ir.irHash&&b.optimize===!noOpt&&b.profile==='release'){await inspectNativeInputs(ir,folder,!noOpt);await readFile(folder+'/runic-app');valid=true;}}catch(e){if(!['ENOENT','E_COMPARE_BUILD'].includes(e.code))throw e;}
  if(!valid)await buildApp(app,{release:true,noOpt});
 }
 return folder;
}
await mkdir(out+'/native',{recursive:true});
const prior=await readJSON('evidence/phase3/source-manifest.json');
for(const name of [...apps,...retained]){
 const {ir,edges}=await lower(await collect('fixtures/'+name));
 let cases=edges;
 if(name.startsWith('editor')){
  cases=[];const values=['','é','😀','e\u0301','<&"',...Array.from({length:256},(_,i)=>'a'.repeat(i+1))];
  for(const locked of [false,true])for(const readonly of [false,true])for(const show of [false,true])for(const value of values){const from=['prior',locked,readonly,show];cases.push({from,event:0,payload:value,to:transition(ir,from,0,value)});}
 }
 for(const noOpt of [false,true]){
  const artifact=name+(noOpt?'-no-opt':'');if(apps.includes(name))await ensure('fixtures/'+name,ir,noOpt);
  const folder='artifacts/'+artifact,built=await readJSON(folder+'/build.json');assert.equal(built.irHash,ir.irHash);const nativeInputs=await inspectNativeInputs(ir,folder,!noOpt);
  const binaryHash=hash(await readFile(folder+'/runic-app'));
  if(retained.includes(name))assert.equal(binaryHash,prior.artifacts[artifact].binarySha256,'Retained binary changed');
  assert.deepEqual(JSON.parse(run(folder+'/runic-app',['--transitions'],cases)),cases.map(c=>c.to));
  results.push({artifact,status:'passed',sourceHash:ir.sourceHash,irHash:ir.irHash,binaryHash,nativeInputs,frontend:ir.frontend,nativeCases:cases.length,validation:ir.validation,build:apps.includes(name)?'Phase 4':'Exact Phase 3 artifact identity checked before re-execution'});
 }
 if(apps.includes(name))for(const width of [420,800])for(const [stage,events]of [['initial',[]],['sequence',[0,1,3]],['reset',[0,0,0,1,2]]]){
  const files=[];
  for(const suffix of ['','-no-opt']){const base=`${out}/native/${name}${suffix}-${stage}-${width}x600`;run('artifacts/'+name+suffix+'/runic-app',['--headless',String(width),'600',base,events.join(',')]);files.push(base);}
  const observations=trace=>trace.map(({state,elements,focused,event,irHash})=>({state,elements,focused,event,irHash}));
  assert.deepEqual(observations(await readJSON(files[0]+'.json')),observations(await readJSON(files[1]+'.json')));assert.equal(hash(await readFile(files[0]+'.png')),hash(await readFile(files[1]+'.png')));
  parity.push({app:name,width,height:600,stage,events,traceHash:hash(await readFile(files[0]+'.json')),pixelHash:hash(await readFile(files[0]+'.png')),status:'passed'});
 }
}
for(const v of versions){
 const app=await syncVersionFixture(v);
 const current=await lower(await collect('fixtures/modules-'+v.framework)),other=await lower(await collect(app));
 assert.equal(other.ir.frontend.packages[v.framework],v.version);assert.equal(current.ir.sourceHash,other.ir.sourceHash);assert.deepEqual(current.edges,other.edges);
 const behavior=ir=>hash(generate(ir).replaceAll(ir.irHash,'<IR_HASH>'));assert.equal(behavior(current.ir),behavior(other.ir));
 const folder=await ensure(app,other.ir),artifact='modules-'+v.framework+'-'+v.version;
 const nativeInputs=await inspectNativeInputs(other.ir,folder,true);assert.deepEqual(JSON.parse(run(folder+'/runic-app',['--transitions'],other.edges)),other.edges.map(e=>e.to));
 const result={artifact,status:'passed',sourceHash:other.ir.sourceHash,irHash:other.ir.irHash,binaryHash:hash(await readFile(folder+'/runic-app')),nativeInputs,frontend:other.ir.frontend,nativeCases:other.edges.length,validation:other.ir.validation};results.push(result);
 versionResults.push({artifact,sourceIdentical:true,transitionsIdentical:true,normalizedRustIdentical:true,current:current.ir.frontend,additional:other.ir.frontend});
}
const report={schema:1,status:'passed',results,parity,versions:versionResults,totalNativeCases:results.reduce((n,r)=>n+r.nativeCases,0)};
await writeFile(out+'/native.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({nativeCases:report.totalNativeCases,artifacts:results.length,parityPairs:parity.length,versions:versionResults.length}));
