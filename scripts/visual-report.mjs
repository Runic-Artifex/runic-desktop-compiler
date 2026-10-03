import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {hash} from '../compiler/collect.mjs';
const out=process.argv[2]??'evidence/phase1/verification/run-1',results=[];
for(const app of ['quantity','thermostat','pricing','settings-wizard'])for(const width of [420,800])for(const stage of ['initial','interaction']){
 const base=`${out}/${app}/${stage}-${width}x600`,browser=base+'-browser.png',native=base+'-native.png';
 const image=spawnSync('magick',['compare','-metric','MAE',browser,native,'null:'],{encoding:'utf8'});if(![0,1].includes(image.status))throw new Error(image.stderr);
 const mae=Number(image.stderr.match(/\(([^)]+)\)/)[1])*255;
 const semantics=JSON.parse(await readFile(`${out}/${app}/report-${width}x600.json`));
 results.push({app,width,height:600,stage,pixelMeanAbsoluteError8Bit:mae,tolerance8Bit:3,passed:mae<=3,browser,native,browserHash:hash(await readFile(browser)),nativeHash:hash(await readFile(native)),sourceHash:semantics.sourceHash,irHash:semantics.irHash});
}
await writeFile(out+'/pixels.json',JSON.stringify({schema:2,metric:'ImageMagick normalized MAE converted to 8-bit units, unchanged 3/255 tolerance. T3 browser capture vs CPU native framebuffer, DPR/scale 1. Initial plus selected interactions, fixed embedded WOFF2. No filtering or reference adjustment.',results},null,2)+'\n');
console.log(JSON.stringify(results.map(({app,width,stage,pixelMeanAbsoluteError8Bit,passed})=>({app,width,stage,pixelMeanAbsoluteError8Bit,passed})),null,2));if(results.some(r=>!r.passed))process.exitCode=1;
