import {spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {buildApp} from '../compiler/cli.mjs';
import {transition} from '../compiler/ir.mjs';
import {editingCases,nativeComposition} from './phase2-cases.mjs';
import assert from 'node:assert/strict';

const run=(binary,args,input)=>{const p=spawnSync(binary,args,{input:input===undefined?undefined:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});if(p.status!==0)throw new Error(p.stderr||p.stdout);return p.stdout;};
await mkdir('evidence/phase2/native',{recursive:true});const results=[];
// This separate consumer probes Blitz's live control API before app conformance.
const probeBuild=spawnSync('cargo',['build','--locked','--release','--bin','editing-probe'],{encoding:'utf8',timeout:120000});assert.equal(probeBuild.status,0,probeBuild.stderr);
const probe=JSON.parse(run('target/release/editing-probe',[]));assert.ok(probe.checks.every(c=>c.passed));
probe.inputs=Object.fromEntries(await Promise.all(['native/editing_probe.rs','native/controls.rs','Cargo.toml','Cargo.lock'].map(async file=>[file,hash(await readFile(file))])));
probe.binaryHash=hash(await readFile('target/release/editing-probe'));await writeFile('evidence/phase2/native/editing-probe.json',JSON.stringify(probe,null,2)+'\n');
for(const name of ['quantity','thermostat','pricing','settings-wizard','counter-react','counter-vue','editor-react','editor-vue']){
 const {ir,edges}=await lower(await collect('fixtures/'+name));
 for(const noOpt of [false,true]){
  const folder=name+(noOpt?'-no-opt':'');if(process.argv.includes('--build'))await buildApp('fixtures/'+name,{out:'artifacts/'+folder,release:true,noOpt});
  const build=JSON.parse(await readFile('artifacts/'+folder+'/build.json','utf8'));assert.equal(build.irHash,ir.irHash);
  const binary='artifacts/'+folder+'/runic-app';let cases=edges;
  if(name.startsWith('editor')){
   cases=[];const values=['','é','😀','e\u0301','<&"',...Array.from({length:256},(_,i)=>'a'.repeat(i+1))];
   for(const locked of [false,true])for(const readonly of [false,true])for(const show of [false,true])for(const value of values){const from=['prior',locked,readonly,show];cases.push({from,event:0,payload:value,to:transition(ir,from,0,value)});}
  }
  const actual=JSON.parse(run(binary,['--transitions'],cases));assert.deepEqual(actual,cases.map(c=>c.to));
  const result={name,optimize:!noOpt,sourceHash:ir.sourceHash,irHash:ir.irHash,binaryHash:hash(await readFile(binary)),validation:ir.validation,nativeCases:cases.length,scope:name.startsWith('editor')?'Every input length and finite control combination, plus Unicode witnesses; compositional proof is in the IR validator':'Every finite reachable transition',status:'passed'};
  if(name.startsWith('editor')){
   for(const [index,c]of editingCases.entries())run(binary,['--edit-trace',`evidence/phase2/native/${folder}-${index}`],c.actions);
   const base=`evidence/phase2/native/${folder}-composition`;run(binary,['--edit-trace',base],nativeComposition);
   const trace=JSON.parse(await readFile(base+'.json'));assert.equal(trace.at(-1).state[0],'あ');assert.equal(trace[1].elements.editor.nodeIdentity,trace.at(-1).elements.editor.nodeIdentity);
   const rejected=`evidence/phase2/native/${folder}-rejected`;run(binary,['--edit-trace',rejected],[{kind:'focus'},{kind:'payload',value:'x'.repeat(257)}]);const invalid=JSON.parse(await readFile(rejected+'.json'));assert.equal(invalid.at(-1).state[0],'');assert.equal(invalid.at(-1).elements.editor.value,'');
   result.editingScenarios=editingCases.length;result.composition='internal EventDriver commit passed; no OS IME claim';result.invalidPayload='rejected and live control restored';
  }
  results.push(result);console.log(`${folder}: ${cases.length} native transitions passed`);
 }
}
await writeFile('evidence/phase2/native/regression.json',JSON.stringify({schema:1,status:'passed',results},null,2)+'\n');
