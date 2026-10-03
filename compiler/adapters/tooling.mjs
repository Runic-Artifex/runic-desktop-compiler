import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import vuePlugin from '@vitejs/plugin-vue';
import {Diagnostic} from '../collect.mjs';

export const supportedVersions={react:['19.3.0'],vue:['3.5.43','3.5.24'],svelte:['5.57.1','5.49.2']};
async function resolvedPackage(entry,name){
  for(let folder=path.dirname(entry);;folder=path.dirname(folder)){
    try{const info=JSON.parse(await readFile(path.join(folder,'package.json'),'utf8'));if(info.name===name)return info;}catch(e){if(e.code!=='ENOENT')throw e;}
    if(path.dirname(folder)===folder)throw new Diagnostic('E_FRONTEND_VERSION','Cannot locate package metadata for '+name);
  }
}
function svelteScripts(compiler,root,code,id){
  if(!id.endsWith('.svelte'))return [{code,offset:0}];
  try{return Object.values(compiler.parse(code,{filename:id,modern:true})).filter(n=>n?.type==='Script').map(n=>({code:code.slice(n.content.start,n.content.end),offset:n.content.start}));}
  catch(e){throw new Diagnostic('E_PARSE',e.message,{file:path.relative(root,id),line:e.start?.line??1,column:(e.start?.column??0)+1});}
}
export async function frontendTooling(root,config) {
  const name=config.framework??'react',require=createRequire(path.join(root,'runic.json'));
  if(!Object.hasOwn(supportedVersions,name))throw new Diagnostic('E_FRONTEND','No frontend adapter for '+name);
  const version=JSON.parse(await readFile(require.resolve(name+'/package.json'),'utf8')).version;
  if(!supportedVersions[name].includes(version))throw new Diagnostic('E_FRONTEND_VERSION',`Unsupported ${name} version ${version}; checked versions: ${supportedVersions[name].join(', ')}`);
  if(name==='react'){
    const domVersion=JSON.parse(await readFile(require.resolve('react-dom/package.json'),'utf8')).version;
    if(domVersion!==version)throw new Diagnostic('E_FRONTEND_VERSION','React and React DOM versions must match');
    return {name,version,plugins:[],packages:{react:version,'react-dom':domVersion},packageRoot:path.dirname(require.resolve('react/package.json'))};
  }
  if(name==='svelte'){
    const compiler=require('svelte/compiler');
    if(compiler.VERSION!==version)throw new Diagnostic('E_FRONTEND_VERSION','Svelte runtime and compiler versions must match');
    const {svelte}=await import(require.resolve('@sveltejs/vite-plugin-svelte'));
    const pluginVersion=(await resolvedPackage(require.resolve('@sveltejs/vite-plugin-svelte'),'@sveltejs/vite-plugin-svelte')).version;
    if(pluginVersion!=='7.3.1')throw new Diagnostic('E_FRONTEND_VERSION','Checked Svelte Vite plugin is 7.3.1');
    return {name,version,compiler,plugins:[svelte({configFile:false,compilerOptions:{runes:true}})],packages:{svelte:version,'@sveltejs/vite-plugin-svelte':pluginVersion},
      extensions:['.svelte'],scripts:(code,id)=>svelteScripts(compiler,root,code,id)};
  }
  const compiler=require('@vue/compiler-sfc');
  if(compiler.version!==version)throw new Diagnostic('E_FRONTEND_VERSION','Vue runtime and SFC compiler versions must match');
  return {name,version,compiler,plugins:[vuePlugin({compiler})],packages:{vue:version,'@vue/compiler-sfc':compiler.version},packageRoot:path.dirname(require.resolve('vue/package.json')),
    extensions:['.vue'],scripts:(code,id)=>{if(!id.endsWith('.vue'))return [{code,offset:0}];const parsed=compiler.parse(code,{filename:id});if(parsed.errors.length)throw new Diagnostic('E_PARSE',String(parsed.errors[0]));return [parsed.descriptor.script,parsed.descriptor.scriptSetup].filter(Boolean).map(s=>({code:s.content,offset:s.loc.start.offset}));}};
}
