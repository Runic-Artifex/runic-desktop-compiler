import {collect,hash} from '../compiler/collect.mjs';
import {frontendTooling} from '../compiler/adapters/tooling.mjs';
import {startComparison} from '../compiler/compare.mjs';
import {editingReference} from './phase2-browser.mjs';
import {out,additional,version} from './phase3-common.mjs';
import {createServer} from 'vite';
import {cp,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
// These are fresh references for both Svelte pins and for the original React
// and Vue consumers affected by collection's new adapter-owned extraction.
for(const [name,app,port]of [
 ['counter-svelte','fixtures/counter-svelte',5200],['editor-svelte','fixtures/editor-svelte',5201],
 ['counter-svelte-'+version,additional('counter-svelte'),5202],['editor-svelte-'+version,additional('editor-svelte'),5203],
 ['counter-react','fixtures/counter-react',5204],['counter-vue','fixtures/counter-vue',5205],
 ['editor-react','fixtures/editor-react',5206],['editor-vue','fixtures/editor-vue',5207],
]){
 if(name.startsWith('editor'))await editingReference(app,{port,out:out+'/browser'});
 else await startComparison(await collect(app),{port,out:out+'/browser/'+name});
}
// Reference-only probe: deliberately excluded from the native contract. It
// observes the public bind:value listener order instead of compiling an
// unsupported listener combination and guessing its behavior.
const root=path.resolve('.cache/phase3-binding-order');await mkdir(root,{recursive:true});await cp('fixtures/editor-svelte',root,{recursive:true});
const file=root+'/App.svelte',source=(await readFile(file,'utf8')).replace("let text=$state('');","let text=$state('');let before=$state('');").replace('bind:value={text}','oninput={() => before = text} bind:value={text}').replace('<p id="preview">','<p id="before">{before}</p><p id="preview">');
await writeFile(file,source);const tooling=await frontendTooling(root,{framework:'svelte'});
await mkdir(out+'/browser',{recursive:true});await writeFile(out+'/browser/binding-order-source.json',JSON.stringify({source,sourceHash:hash(source),frontend:tooling.packages,scope:'Original runtime reference only; combined oninput and bind:value is rejected by native lowering'},null,2)+'\n');
const server=await createServer({root,configFile:false,cacheDir:path.resolve('.cache/vite-references/svelte-binding-order'),plugins:tooling.plugins,server:{host:'127.0.0.1',port:5208,strictPort:true},logLevel:'error'});await server.listen();console.log('Binding order probe: http://localhost:5208/');
console.log('Finite suites: /?runicCase=0 at 420x600 and 800x600. Editors: /?case=0 at 800x600. All output stays in evidence/phase3.');
