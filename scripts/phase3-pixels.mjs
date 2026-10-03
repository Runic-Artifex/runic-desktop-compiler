import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {hash} from '../compiler/collect.mjs';
import {out,svelteApps,version,readJSON} from './phase3-common.mjs';
const folder=out+'/pixels',results=[];await mkdir(folder,{recursive:true});
const run=(exe,args,input)=>{const r=spawnSync(exe,args,{encoding:'utf8',input,timeout:30000});assert.equal(r.status,0,r.stderr);return r;};
for(const app of [...svelteApps,...svelteApps.map(n=>n+'-'+version)])for(const width of app==='counter-svelte'?[420,800]:[800])for(const stage of ['initial','interaction']){
 const base=`${folder}/${app}-${stage}-${width}x600`;
 if(app.startsWith('editor'))run('artifacts/'+app+'/runic-app',['--edit-trace',base+'-native'],JSON.stringify(stage==='initial'?[]:[{kind:'focus'},{kind:'payload',value:'Native é😀'},{kind:'blur'}]));
 else run('artifacts/'+app+'/runic-app',['--headless',String(width),'600',base+'-native',stage==='initial'?'':'0']);
 const r={app,width,height:600,stage,browser:base+'-browser.png',native:base+'-native.png',reference:'Fresh original Svelte runtime in calibrated T3 background preview, DPR 1'},ir=await readJSON('artifacts/'+app+'/ir.json');
 const cmp=spawnSync('magick',['compare','-metric','MAE',r.browser,r.native,'null:'],{encoding:'utf8'});assert.ok([0,1].includes(cmp.status),cmp.stderr);
 const mae=Number(cmp.stderr.match(/\(([^)]+)\)/)?.[1])*255;assert.ok(Number.isFinite(mae));
 Object.assign(r,{pixelMeanAbsoluteError8Bit:mae,tolerance8Bit:3,passed:mae<=3,browserHash:hash(await readFile(r.browser)),nativeHash:hash(await readFile(r.native)),sourceHash:ir.sourceHash,irHash:ir.irHash,binaryHash:hash(await readFile('artifacts/'+app+'/runic-app'))});results.push(r);
}
await writeFile(out+'/pixels.json',JSON.stringify({schema:1,metric:'Raw ImageMagick normalized MAE in 8-bit units; unchanged tolerance 3/255, no filtering or reference adjustment',calibration:out+'/probes/capture-path.json',results},null,2)+'\n');
console.log(JSON.stringify(results.map(({app,width,stage,pixelMeanAbsoluteError8Bit,passed})=>({app,width,stage,pixelMeanAbsoluteError8Bit,passed})),null,2));if(results.some(r=>!r.passed))process.exitCode=1;
