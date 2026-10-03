import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {buildApp} from '../compiler/cli.mjs';
import {inspectNativeInputs} from '../compiler/codegen.mjs';
import {transition} from '../compiler/ir.mjs';
import {editingCases,nativeComposition} from './phase2-cases.mjs';
import {previous,svelteApps,out,readJSON} from './phase3-common.mjs';
import assert from 'node:assert/strict';
const run=(binary,args,input)=>{const p=spawnSync(binary,args,{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});assert.equal(p.status,0,p.stderr||p.stdout);return p.stdout;};
await mkdir(out+'/native',{recursive:true});const results=[];
// The controls and probe are unchanged. Check their identities before reusing
// the binary, then execute it again for this phase's independent receipt.
const oldProbe=await readJSON('evidence/phase2/native/editing-probe.json');
for(const file of Object.keys(oldProbe.inputs))assert.equal(oldProbe.inputs[file],hash(await readFile(file)));
assert.equal(oldProbe.binaryHash,hash(await readFile('target/release/editing-probe')));
const probe=JSON.parse(run('target/release/editing-probe',[]));assert.ok(probe.checks.every(c=>c.passed));
Object.assign(probe,{inputs:oldProbe.inputs,binaryHash:oldProbe.binaryHash});await writeFile(out+'/native/editing-probe.json',JSON.stringify(probe,null,2)+'\n');
for(const name of [...previous,...svelteApps]){
 const {ir,edges}=await lower(await collect('fixtures/'+name));
 for(const noOpt of [false,true]){
  const folder=name+(noOpt?'-no-opt':'');if(process.argv.includes('--build')&&svelteApps.includes(name))await buildApp('fixtures/'+name,{release:true,noOpt});
  const build=await readJSON('artifacts/'+folder+'/build.json');assert.equal(build.irHash,ir.irHash);await inspectNativeInputs(ir,'artifacts/'+folder,!noOpt);
  const binary='artifacts/'+folder+'/runic-app';let cases=edges;
  if(name.startsWith('editor')){
   cases=[];const values=['','é','😀','e\u0301','<&"',...Array.from({length:256},(_,i)=>'a'.repeat(i+1))];
   for(const locked of [false,true])for(const readonly of [false,true])for(const show of [false,true])for(const value of values){const from=['prior',locked,readonly,show];cases.push({from,event:0,payload:value,to:transition(ir,from,0,value)});}
  }
  assert.deepEqual(JSON.parse(run(binary,['--transitions'],cases)),cases.map(c=>c.to));
  const result={name,optimize:!noOpt,sourceHash:ir.sourceHash,irHash:ir.irHash,binaryHash:hash(await readFile(binary)),validation:ir.validation,nativeCases:cases.length,status:'passed',build:svelteApps.includes(name)?'Phase 3':'Unchanged native inputs verified before reuse'};
  if(name==='editor-svelte'){
   for(const [index,c]of editingCases.entries())run(binary,['--edit-trace',`${out}/native/${folder}-${index}`],c.actions);
   const base=`${out}/native/${folder}-composition`;run(binary,['--edit-trace',base],nativeComposition);const trace=await readJSON(base+'.json');assert.equal(trace.at(-1).state[0],'あ');assert.equal(trace[1].elements.editor.nodeIdentity,trace.at(-1).elements.editor.nodeIdentity);
   const rejected=`${out}/native/${folder}-rejected`;run(binary,['--edit-trace',rejected],[{kind:'focus'},{kind:'payload',value:'x'.repeat(257)}]);const invalid=await readJSON(rejected+'.json');assert.equal(invalid.at(-1).state[0],'');assert.equal(invalid.at(-1).elements.editor.value,'');
   result.editingScenarios=editingCases.length;result.composition='Internal EventDriver commit; OS/platform IME remains separate';result.invalidPayload='Rejected and live control restored';
  }
  results.push(result);console.log(`${folder}: ${cases.length} native transitions passed`);
 }
}
await writeFile(out+'/native/regression.json',JSON.stringify({schema:1,status:'passed',results},null,2)+'\n');
