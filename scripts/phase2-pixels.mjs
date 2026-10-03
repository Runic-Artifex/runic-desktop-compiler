import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {hash} from '../compiler/collect.mjs';

const out='evidence/phase2/pixels',results=[];await mkdir(out,{recursive:true});
const run=(exe,args,input)=>{const r=spawnSync(exe,args,{encoding:'utf8',input,timeout:30000});assert.equal(r.status,0,r.stderr);return r;};
const historical=JSON.parse(await readFile('evidence/phase1/verification/run-1/corrected/pixels.json'));
for(const r of historical.results){
 const ir=JSON.parse(await readFile('artifacts/'+r.app+'/ir.json'));assert.equal(ir.sourceHash,r.sourceHash);assert.equal(hash(await readFile(r.browser)),r.browserHash);
 const base=`${out}/${r.app}-${r.stage}-${r.width}x600-native`;
 const oldTrace=JSON.parse(await readFile(`evidence/phase1/verification/run-1/${r.app}/${r.stage}-${r.width}x600-native.json`));
 run('artifacts/'+r.app+'/runic-app',['--headless',String(r.width),'600',base,oldTrace.slice(1).map(x=>x.event).join(',')]);
 results.push({app:r.app,width:r.width,height:600,stage:r.stage,browser:r.browser,native:base+'.png',reference:'Unchanged original Phase 1 browser capture, source and embedded font; replayed with current binary'});
}
for(const app of ['counter-react','counter-vue','editor-react','editor-vue'])for(const stage of ['initial','interaction']){
 const base=`${out}/${app}-${stage}-800x600`;
 if(app.startsWith('editor'))run('artifacts/'+app+'/runic-app',['--edit-trace',base+'-native'],JSON.stringify(stage==='initial'?[]:[{kind:'focus'},{kind:'payload',value:'Native é😀'},{kind:'blur'}]));
 else run('artifacts/'+app+'/runic-app',['--headless','800','600',base+'-native',stage==='initial'?'':'0']);
 results.push({app,width:800,height:600,stage,browser:base+'-browser.png',native:base+'-native.png',reference:'Fresh original framework in calibrated T3 background preview, DPR 1'});
}
for(const r of results){
 const ir=JSON.parse(await readFile('artifacts/'+r.app+'/ir.json'));
 const cmp=spawnSync('magick',['compare','-metric','MAE',r.browser,r.native,'null:'],{encoding:'utf8'});assert.ok([0,1].includes(cmp.status),cmp.stderr);
 const mae=Number(cmp.stderr.match(/\(([^)]+)\)/)?.[1])*255;assert.ok(Number.isFinite(mae));
 Object.assign(r,{pixelMeanAbsoluteError8Bit:mae,tolerance8Bit:3,passed:mae<=3,browserHash:hash(await readFile(r.browser)),nativeHash:hash(await readFile(r.native)),sourceHash:ir.sourceHash,irHash:ir.irHash,binaryHash:hash(await readFile('artifacts/'+r.app+'/runic-app'))});
}
const report={schema:1,metric:'ImageMagick normalized MAE in 8-bit units; unchanged tolerance 3/255. Raw captures, no filtering or reference adjustment. CPU native framebuffer; exact scale 1.',calibration:'evidence/phase2/probes/capture-path.json',results};
await writeFile('evidence/phase2/pixels.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(results.map(({app,width,stage,pixelMeanAbsoluteError8Bit,passed})=>({app,width,stage,pixelMeanAbsoluteError8Bit,passed})),null,2));if(results.some(r=>!r.passed))process.exitCode=1;
