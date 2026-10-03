import {readFile,readdir,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {hash} from '../compiler/collect.mjs';
export const out='evidence/phase4';
export const apps=['modules-react','modules-vue','modules-svelte'];
export const retained=['quantity','thermostat','pricing','settings-wizard','counter-react','counter-vue','editor-react','editor-vue','counter-svelte','editor-svelte'];
export const versions=[{framework:'vue',version:'3.5.24',port:5303},{framework:'svelte',version:'5.49.2',port:5304}];
export const additional=({framework,version})=>`conformance/${framework}-${version}/apps/modules-${framework}-${version}`;
export const readJSON=async file=>JSON.parse(await readFile(file,'utf8'));
// Repeated verification must not trigger reference-server hot reloads when
// source is unchanged. Copy only changed/missing files into owned version apps.
export async function syncVersionFixture(v){
 const src='fixtures/modules-'+v.framework,dest=additional(v);
 async function walk(relative=''){
  await mkdir(path.join(dest,relative),{recursive:true});
  for(const entry of await readdir(path.join(src,relative),{withFileTypes:true})){
   if(entry.name==='dist')continue;const name=path.join(relative,entry.name);
   if(entry.isDirectory())await walk(name);
   else if(entry.isFile()){
    const bytes=await readFile(path.join(src,name));let same=false;
    try{same=bytes.equals(await readFile(path.join(dest,name)));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(!same)await copyFile(path.join(src,name),path.join(dest,name));
   }else throw new Error('Version fixture requires regular source files: '+name);
  }
 }
 await walk();return dest;
}
export async function sourceInputs(){
 const files=['.envrc','.gitignore','AGENTS.md','PROMPT.md','README.md','flake.nix','flake.lock','Cargo.toml','Cargo.lock','package.json','package-lock.json',...versions.flatMap(v=>['package.json','package-lock.json'].map(f=>`conformance/${v.framework}-${v.version}/${f}`))];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='dist')continue;const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else if(e.isFile())files.push(file);}}
 for(const dir of ['compiler','native','fixtures','mappings','tests','scripts','docs'])await walk(dir);
 return Object.fromEntries(await Promise.all(files.sort().map(async file=>[file,hash(await readFile(file))])));
}
