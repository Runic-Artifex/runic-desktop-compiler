import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {hash} from '../compiler/collect.mjs';
export const out='evidence/phase3';
export const previous=['quantity','thermostat','pricing','settings-wizard','counter-react','counter-vue','editor-react','editor-vue'];
export const svelteApps=['counter-svelte','editor-svelte'];
export const version='5.49.2';
export const additional=name=>path.join('conformance/svelte-'+version+'/apps',name+'-'+version);
export const readJSON=async file=>JSON.parse(await readFile(file,'utf8'));
export async function testInputs(){
 const files=['Cargo.toml','Cargo.lock','flake.nix','flake.lock','package.json','package-lock.json','conformance/svelte-'+version+'/package.json','conformance/svelte-'+version+'/package-lock.json'];
 async function walk(dir){for(const e of await readdir(dir,{withFileTypes:true})){if(e.name==='dist')continue;const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else if(e.isFile())files.push(f);}}
 for(const dir of ['compiler','native','tests','mappings','fixtures','scripts'])await walk(dir);
 return hash(await Promise.all(files.sort().map(async f=>[f,hash(await readFile(f))])));
}
