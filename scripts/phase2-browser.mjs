import {createServer} from 'vite';
import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collect,hash} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {inspectNativeInputs} from '../compiler/codegen.mjs';
import {editingCases} from './phase2-cases.mjs';

export async function editingReference(app,{port=5190,out='evidence/phase2/browser'}={}) {
 const graph=await collect(app),{ir}=await lower(graph),name=path.basename(app),folder=path.resolve('artifacts/'+name),binary=folder+'/runic-app';
 const built=JSON.parse(await readFile(folder+'/build.json','utf8'));if(built.irHash!==ir.irHash)throw new Error('Stale native build');
 const nativeInputs=await inspectNativeInputs(ir,folder,built.optimize);await mkdir(out,{recursive:true});
 const all=n=>[n,...(n.children??[]).flatMap(all)],ids=all(ir.ui).flatMap(n=>n.attrs?.id?[n.attrs.id.value]:[]);
 const script=`
 const scenarios=${JSON.stringify(editingCases)},ids=${JSON.stringify(ids)};
 // Framework commits are synchronous/microtask based in this supported subset.
 // Attribute-driven disabling can defer browser focus teardown until paint.
 // Background previews paint slowly. Observe the browser settling naturally;
 // never force blur or change the app to manufacture focus parity.
 const frame=()=>new Promise(r=>setTimeout(r,40));
 async function settleFocus(){
   if(!document.activeElement?.disabled)return;
   // The T3 driver captures an actual frame, then acknowledges only when the
   // browser has naturally released disabled focus. Timers alone cannot make
   // an offscreen Chromium tab paint. This barrier does not mutate app state.
   await new Promise(resolve=>{window.phase2NeedsPaint=true;window.phase2AfterPaint=()=>{
     if(document.activeElement?.disabled)return {settled:false};
     window.phase2NeedsPaint=false;delete window.phase2AfterPaint;resolve();return {settled:true};
   };});
 }
 let editorIdentity;
 function snapshot(){const elements=Object.fromEntries(ids.flatMap(id=>{const e=document.getElementById(id);if(!e)return [];const r=e.getBoundingClientRect();return [[id,{text:e.textContent,class:e.className,disabled:e.hasAttribute('disabled'),...(e.tagName==='INPUT'?{value:e.value,selectionStart:e.selectionStart,selectionEnd:e.selectionEnd}:{}),rect:{x:r.x,y:r.y,width:r.width,height:r.height}}]];}));return {elements,focused:document.activeElement?.id||null,editorStable:document.getElementById('editor')===editorIdentity};}
 async function apply(a){const e=document.getElementById(a.id||'editor'),editor=document.getElementById('editor');
   if(a.kind==='focus')e.focus();
   else if(a.kind==='blur')e.blur();
   else if(a.kind==='select')e.setSelectionRange(a.start,a.end);
   else if(a.kind==='click'){if(!e.disabled){e.focus();e.click();}}
   else if(a.kind==='payload'){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,a.value);e.dispatchEvent(new Event('input',{bubbles:true}));}
   else if(['text','backspace','delete'].includes(a.kind)&&document.activeElement===editor&&!editor.disabled&&!editor.readOnly){
     let from=editor.selectionStart,to=editor.selectionEnd,value=a.kind==='text'?a.value:'';
     if(from===to&&a.kind==='backspace')from=Math.max(0,from-1);
     if(from===to&&a.kind==='delete')to=Math.min(editor.value.length,to+1);
     const before=editor.value.slice(0,from),after=editor.value.slice(to);
     if((before+value+after).length<=editor.maxLength){Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(editor,before+value+after);editor.setSelectionRange(before.length+value.length,before.length+value.length);editor.dispatchEvent(new Event('input',{bubbles:true}));}
   }
   await frame();
   await settleFocus();
 }
 async function run(){if(!new URLSearchParams(location.search).has('case'))return;while(!document.getElementById('root').childNodes.length)await frame();await document.fonts.ready;await frame();editorIdentity=document.getElementById('editor');const index=Number(new URLSearchParams(location.search).get('case')),scenario=scenarios[index],trace=[snapshot()];for(const a of scenario.actions){await apply(a);trace.push(snapshot());}const result=await (await fetch('/__phase2/result',{method:'POST',body:JSON.stringify({index,trace,width:innerWidth,height:innerHeight})})).json();window.phase2Result=result;if(index+1<scenarios.length)location.search='?case='+(index+1);else {window.phase2Complete=true;document.title='Phase 2 editor complete';}}
 run().catch(e=>{window.phase2Error=String(e);console.error(e);});`;
 const results=[];
 const plugin={name:'runic-phase2-conformance',transformIndexHtml:()=>[{tag:'script',attrs:{type:'module',src:'/@phase2'},injectTo:'body'}],configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(req.url==='/@phase2'){res.setHeader('Content-Type','application/javascript');res.end(script);return;}
  if(req.url!=='/__phase2/result'||req.method!=='POST')return next();
  try{
   let body='';for await(const chunk of req){body+=chunk;if(body.length>262144)throw new Error('Oversized trace');}const reference=JSON.parse(body);
   const scenario=editingCases[reference.index];if(!scenario||reference.width!==800||reference.height!==600||reference.trace.length!==scenario.actions.length+1)throw new Error('Invalid scenario or viewport');
   const base=path.resolve(out,name+'-'+reference.index);const run=spawnSync(binary,['--edit-trace',base],{input:JSON.stringify(scenario.actions),encoding:'utf8',timeout:15000});if(run.status!==0)throw new Error(run.stderr);
   const native=JSON.parse(await readFile(base+'.json','utf8')),errors=[],geometry=[];
   for(let i=0;i<native.length;i++){
    const a=reference.trace[i],b=native[i];if(a.focused!==b.focused)errors.push({step:i,key:'focused',browser:a.focused,native:b.focused});
    if(!a.editorStable||b.elements.editor.nodeIdentity!==native[0].elements.editor.nodeIdentity)errors.push({step:i,key:'editorIdentity'});
    for(const id of new Set([...Object.keys(a.elements),...Object.keys(b.elements)])){
     if(!a.elements[id]||!b.elements[id]){errors.push({step:i,id,key:'mounted'});continue;}
     for(const key of ['text','class','disabled',...(id==='editor'?['value','selectionStart','selectionEnd']:[])])if(a.elements[id][key]!==b.elements[id][key])errors.push({step:i,id,key,browser:a.elements[id][key],native:b.elements[id][key]});
     for(const key of ['x','y','width','height'])if(Math.abs(a.elements[id].rect[key]-b.elements[id].rect[key])>2)geometry.push({step:i,id,key,browser:a.elements[id].rect[key],native:b.elements[id].rect[key]});
    }
   }
   results[reference.index]={name:scenario.name,steps:native.length,errors,geometry,browser:reference.trace,native};
   const report={schema:1,app:name,sourceHash:graph.hash,irHash:ir.irHash,binaryHash:hash(await readFile(binary)),nativeInputs,frontend:ir.frontend,route:'Browser programmatic edit actions versus native internal EventDriver; OS and platform IME are separate gates',settling:'40 ms after microtasks; disabled active focus uses a T3 painted-frame barrier and acknowledgement of natural blur; no forced blur',expectedCases:editingCases.length,complete:results.filter(Boolean).length===editingCases.length,passed:results.filter(Boolean).length===editingCases.length&&results.every(r=>!r.errors.length),geometryPassed:results.filter(Boolean).length===editingCases.length&&results.every(r=>!r.geometry.length),results:results.filter(Boolean)};
   await writeFile(path.join(out,name+'.json'),JSON.stringify(report,null,2)+'\n');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({errors,geometry,complete:report.complete}));
  }catch(e){res.statusCode=400;res.end(JSON.stringify({error:e.message}));}
 });}};
 const server=await createServer({root:graph.root,cacheDir:path.resolve('.cache/vite-references',name),configFile:false,plugins:[plugin,...graph.tooling.plugins],server:{host:'127.0.0.1',port,strictPort:true},logLevel:'error'});await server.listen();console.log(`Editing reference: http://localhost:${port}/?case=0`);return server;
}
if(process.argv[1]===new URL(import.meta.url).pathname)await editingReference(process.argv[2],{port:Number(process.argv[3]??5190)});
