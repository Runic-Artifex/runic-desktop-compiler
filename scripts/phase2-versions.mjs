import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {generate} from '../compiler/codegen.mjs';
import {buildApp} from '../compiler/cli.mjs';

export async function prepareVersions({build=false}={}) {
 const results=[];
 for(const name of ['counter-vue','editor-vue']){
  const app=path.join('conformance/vue-3.5.24/apps',name+'-3.5.24');await mkdir(app,{recursive:true});await cp('fixtures/'+name,app,{recursive:true});
  const current=await lower(await collect('fixtures/'+name)),previous=await lower(await collect(app));
  const behavior=ir=>hash(generate(ir).replaceAll(ir.irHash,'<IR_HASH>'));
  const result={app,sourceHash:previous.ir.sourceHash,current:current.ir.frontend,additional:previous.ir.frontend,sourceIdentical:current.ir.sourceHash===previous.ir.sourceHash,rustBehaviorIdentical:behavior(current.ir)===behavior(previous.ir),validationIdentical:JSON.stringify(current.ir.validation)===JSON.stringify(previous.ir.validation),compilerBackend:hash(await readFile('compiler/codegen.mjs')),nativeBindings:hash(await readFile('native/controls.rs'))};
  if(!result.sourceIdentical||!result.rustBehaviorIdentical||!result.validationIdentical)throw new Error('Version reuse mismatch for '+name);
  if(build)await buildApp(app,{release:true});results.push(result);
 }
 await mkdir('evidence/phase2',{recursive:true});await writeFile('evidence/phase2/versions.json',JSON.stringify({schema:1,status:'native-source-passed; browser conformance recorded separately',results},null,2)+'\n');return results;
}
if(process.argv[1]===new URL(import.meta.url).pathname)console.log(JSON.stringify(await prepareVersions({build:process.argv.includes('--build')}),null,2));
