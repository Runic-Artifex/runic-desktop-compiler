import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,cp,rm,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {collect,hash,Diagnostic} from '../compiler/collect.mjs';
import {lower} from '../compiler/frontend.mjs';
import {transition,render} from '../compiler/ir.mjs';
import {generate} from '../compiler/codegen.mjs';

const cache=new Map(),graph=name=>{if(!cache.has(name))cache.set(name,collect('fixtures/'+name));return cache.get(name);};
const nodes=n=>[n,...(n.children??[]).flatMap(nodes)];
async function changed(name,from,to,{entry=false}={}){
 const g=await graph(name),modules=new Map(g.modules),id=entry?g.entry:[...modules.keys()].find(f=>f.endsWith('.svelte')),m=modules.get(id);
 assert.ok(m.code.includes(from),'Replacement must match');const code=m.code.replace(from,to);modules.set(id,{...m,code});
 return lower({...g,modules,hash:hash(code)},{registry:false});
}
test('Svelte immediate writes, intermediate derived reads and captures reach the shared IR',async()=>{
 const {ir,edges}=await lower(await graph('counter-svelte'));assert.equal(ir.schema,3);assert.equal(edges.length,36);
 assert.deepEqual(transition(ir,[1,0,0,0,true],0),[3,1,6,4,true]);
 const tree=nodes(render(ir,[3,1,6,4,false]));assert.equal(tree.find(n=>n.attrs?.id==='initial').children[0].text,'1');assert.equal(tree.find(n=>n.attrs?.id==='flag').children[0].text,'false');assert.ok(!tree.some(n=>n.attrs?.id==='details'));
 const rust=generate(ir).replace(/^pub const (TITLE|CSS):.*$/gm,'');assert.doesNotMatch(rust,/svelte|\$state|\$derived|virtual.?dom/i);
 const state=ir.states.find(s=>s.name==='n');assert.equal(state.source.file,'App.svelte');assert.equal(state.source.line,2);
});
test('Svelte bind:value shares exact UTF16 validation, guards and live editor operations',async()=>{
 const {ir}=await lower(await graph('editor-svelte'));assert.equal(ir.validation.reachableStates,2056);assert.equal(ir.validation.transitions,536616);
 for(const value of ['é','😀','e\u0301','日本語','<&"','😀'.repeat(128)]){
  const state=transition(ir,['',false,false,true],0,value),tree=nodes(render(ir,state));assert.equal(tree.find(n=>n.attrs?.id==='count').children[0].text,String(value.length));assert.equal(tree.find(n=>n.attrs?.id==='preview').children[0].text,value);
  assert.deepEqual(transition(ir,state,1),['',false,false,true]);
 }
 for(const locked of [false,true])for(const readonly of [false,true])if(locked||readonly)assert.deepEqual(transition(ir,['before',locked,readonly,true],0,'after'),['before',locked,readonly,true]);
 assert.throws(()=>transition(ir,['',false,false,true],0,'a'.repeat(257)),e=>e.code==='E_TEXT_PAYLOAD');
 const explicit=await changed('editor-svelte','bind:value={text}','value={text} oninput={(event) => text = event.currentTarget.value}');assert.deepEqual(transition(explicit.ir,['',false,false,true],0,'é😀'),['é😀',false,false,true]);
});
test('Svelte inline handlers and compound assignments retain ordered reads',async()=>{
 const {ir}=await changed('counter-svelte','onclick={increment}','onclick={() => { n += 1; n = Math.min(n, 3); }}');assert.deepEqual(transition(ir,[1,0,0,0,true],1),[2,0,0,0,true]);
 const arrow=await changed('counter-svelte','onclick={toggle}','onclick={() => show = !show}');assert.deepEqual(transition(arrow.ir,[1,0,0,0,true],2),[1,0,0,0,false]);
});
test('Svelte bounded getter blocks, if/else and original whitespace lower explicitly',async()=>{
 const derived=await changed('counter-svelte','()=>n*2','() => { return n*2; }');assert.deepEqual(transition(derived.ir,[1,0,0,0,true],0),[3,1,6,4,true]);
 const conditional=await changed('counter-svelte','Visible</p>{/if}','Visible</p>{:else}<p id="hidden">Hidden</p>{/if}');assert.equal(nodes(render(conditional.ir,[1,0,0,0,false])).find(n=>n.attrs?.id==='hidden').children[0].text,'Hidden');
 const whitespace=await changed('counter-svelte','<p id="value">{label}</p>','<p id="value">  Count {label} units  </p>');assert.equal(nodes(render(whitespace.ir,[1,0,0,0,true])).find(n=>n.attrs?.id==='value').children[0].text,'Count 1 units');
});
test('Svelte rejects uncovered reactive, component and template behavior with source diagnostics',async()=>{
 const cases=[
  ['counter-svelte','let n=$state(1)','let n=$state({value:1})','E_EXPRESSION'],
  ['counter-svelte','const initial=n;','$effect(() => console.log(n)); const initial=n;','E_EFFECT'],
  ['counter-svelte','n=2;','doubled=2;','E_HANDLER'],
  ['counter-svelte','()=>n*2','() => { console.log(n); return n*2; }','E_DERIVED'],
  ['counter-svelte','const initial=n;','let initial=n;','E_MUTATION'],
  ['counter-svelte','<script>','<script context="module">','E_SVELTE_COMPONENT'],
  ['counter-svelte','<script>','<script generics="T">','E_SVELTE_COMPONENT'],
  ['counter-svelte','</script>','</script><style>p { color:red; }</style>','E_SVELTE_COMPONENT'],
  ['counter-svelte','onclick={toggle}','on:click={toggle}','E_TEMPLATE'],
  ['counter-svelte','<main>','<main use:action>','E_TEMPLATE'],
  ['counter-svelte','<main>','<main class:active={show}>','E_TEMPLATE'],
  ['counter-svelte','{#if show}<p id="details">Visible</p>{/if}','{#each [1] as x}<p>{x}</p>{/each}','E_TEMPLATE'],
  ['counter-svelte','const initial=n;','const Math=0;const initial=n;','E_CALL'],
  ['counter-svelte','const captured=n;','const Math=0;const captured=n;','E_CALL'],
  ['counter-svelte','const initial=n;','const initial=$state.raw(1);','E_CALL'],
  ['editor-svelte','bind:value={text}','bind:value={() => text, value => text = value}','E_TEXT_CONTROL'],
  ['editor-svelte','bind:value={text}','oninput={(e) => text = e.target.value} bind:value={text}','E_EVENT'],
  ['editor-svelte','bind:value={text}','bind:value={text} oninput={(e) => text = e.target.value}','E_EVENT'],
  ['editor-svelte','bind:value={text}','bind:value={length}','E_TEXT_CONTROL'],
  ['editor-svelte','maxlength="256"','maxlength="257"','E_TEXT_CONTROL'],
  ['editor-svelte','<input id="editor" aria-label="Text" type="text" maxlength="256" bind:value={text} disabled={locked} {readonly}/>','{#if show}<input id="editor" aria-label="Text" type="text" maxlength="256" bind:value={text} disabled={locked} {readonly}/>{/if}','E_TEXT_CONTROL'],
 ];
 for(const [name,from,to,code]of cases)await assert.rejects(()=>changed(name,from,to),e=>e instanceof Diagnostic&&e.code===code&&e.source?.file==='App.svelte'&&e.source.line>0,`${name}: ${to}`);
});
test('Svelte bootstrap requires the public mount API and the actual local component',async()=>{
 await assert.rejects(()=>changed('counter-svelte','mount(App,','mount(Other,',{entry:true}),e=>e.code==='E_BOOTSTRAP'&&e.source.file==='main.js'&&e.source.line===4);
 await assert.rejects(()=>changed('counter-svelte','mount(App,','new App(',{entry:true}),e=>e.code==='E_BOOTSTRAP'&&e.source.file==='main.js'&&e.source.line===4);
 const {ir}=await changed('counter-svelte',"document.getElementById('root')","document.querySelector('#root')",{entry:true});assert.equal(ir.frontend.adapter,'svelte');
 const g=await graph('counter-svelte'),modules=new Map(g.modules),m=modules.get(g.entry);modules.set(g.entry,{...m,code:m.code.replace('import App from','import document from').replace('mount(App,','mount(document,')});await assert.rejects(()=>lower({...g,modules}),e=>e.code==='E_BOOTSTRAP');
 modules.set(g.entry,{...m,imports:m.imports.map(e=>e.specifier==='./App.svelte'?{...e,resolved:path.resolve(g.root,'../outside/App.svelte')}:e)});await assert.rejects(()=>lower({...g,modules}),e=>e.code==='E_IMPORT');
});
test('Svelte collection preserves script CSS imports and reports malformed source',async()=>{
 await mkdir('.cache/tests',{recursive:true});const root=await mkdtemp(path.resolve('.cache/tests/svelte-'));
 try{
  await cp('fixtures/counter-svelte',root,{recursive:true});const file=path.join(root,'App.svelte'),source=await readFile(file,'utf8');await writeFile(file,source.replace('<script>',"<script>\nimport './style.css';"));
  const g=await collect(root);assert.ok(g.modules.get(file).imports.some(e=>e.specifier==='./style.css'));assert.equal((await lower(g)).ir.frontend.adapter,'svelte');
  await writeFile(file,source.replace('{/if}',''));await assert.rejects(()=>collect(root),e=>e instanceof Diagnostic&&e.code==='E_PARSE'&&e.source.file==='App.svelte');
 }finally{await rm(root,{recursive:true,force:true});}
});
