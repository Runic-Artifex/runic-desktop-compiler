import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {generate,inspectNativeInputs} from '../compiler/codegen.mjs';
import {buildApp} from '../compiler/cli.mjs';
import {transition} from '../compiler/ir.mjs';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {svelteApps,additional,out,version} from './phase3-common.mjs';
export async function prepareVersions({build=false}={}){
 const results=[];
 for(const name of svelteApps){
  const app=additional(name);await mkdir(app,{recursive:true});await cp('fixtures/'+name,app,{recursive:true});
  const current=await lower(await collect('fixtures/'+name)),previous=await lower(await collect(app));
  const behavior=ir=>hash(generate(ir).replaceAll(ir.irHash,'<IR_HASH>'));
  const result={app,sourceHash:previous.ir.sourceHash,current:current.ir.frontend,additional:previous.ir.frontend,sourceIdentical:current.ir.sourceHash===previous.ir.sourceHash,rustBehaviorIdentical:behavior(current.ir)===behavior(previous.ir),validationIdentical:JSON.stringify(current.ir.validation)===JSON.stringify(previous.ir.validation),compilerBackend:hash(await readFile('compiler/codegen.mjs')),nativeBindings:hash(await readFile('native/controls.rs'))};
  if(previous.ir.frontend.packages.svelte!==version||!result.sourceIdentical||!result.rustBehaviorIdentical||!result.validationIdentical)throw new Error('Actual version reuse mismatch for '+name);
  if(build)await buildApp(app,{release:true});const folder='artifacts/'+name+'-'+version;await inspectNativeInputs(previous.ir,folder,true);
  let cases=previous.edges;
  if(name.startsWith('editor')){cases=[];const values=['','é','😀','e\u0301','<&"',...Array.from({length:256},(_,i)=>'a'.repeat(i+1))];for(const locked of [false,true])for(const readonly of [false,true])for(const show of [false,true])for(const value of values){const from=['prior',locked,readonly,show];cases.push({from,event:0,payload:value,to:transition(previous.ir,from,0,value)});}}
  const run=spawnSync(folder+'/runic-app',['--transitions'],{input:JSON.stringify(cases),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});assert.equal(run.status,0,run.stderr);assert.deepEqual(JSON.parse(run.stdout),cases.map(c=>c.to));
  result.nativeCases=cases.length;result.binaryHash=hash(await readFile(folder+'/runic-app'));results.push(result);
 }
 await mkdir(out,{recursive:true});await writeFile(out+'/versions.json',JSON.stringify({schema:1,status:'native-source-passed; browser conformance recorded separately',results},null,2)+'\n');return results;
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await prepareVersions({build:process.argv.includes('--build')}),null,2));
