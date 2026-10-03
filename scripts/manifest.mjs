import { readdir,readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const files=['.envrc','.gitignore','PROMPT.md','README.md','flake.nix','flake.lock','Cargo.toml','Cargo.lock','package.json','package-lock.json'];
async function walk(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    if(entry.name==='dist')continue;
    const name=`${dir}/${entry.name}`;
    if(entry.isDirectory())await walk(name);else if(entry.isFile())files.push(name);
  }
}
for(const root of ['compiler','native','fixtures','mappings','tests','scripts','docs'])await walk(root);
const inputs={};for(const file of files.sort())inputs[file]=sha256(await readFile(file));
const artifacts={};
for(const folder of ['quantity','thermostat','pricing','settings-wizard'].flatMap(a=>[a,a+'-no-opt-release']).concat('quantity-lto-thin')) {
  const build=JSON.parse(await readFile(`artifacts/${folder}/build.json`,'utf8'));
  artifacts[folder]={...build,binarySha256:sha256(await readFile(`artifacts/${folder}/runic-app`))};
}
const baseline=JSON.parse(await readFile('baselines/phase0/baseline.json'));
for(const [file,digest]of Object.entries(baseline.archives))if(sha256(await readFile('baselines/phase0/'+file))!==digest)throw new Error('Historical baseline archive changed');
const manifest={schema:2,algorithm:'SHA-256',scope:'Phase1 implementation, fixtures, documentation and lockfiles; generated artifacts and evidence excluded from source hash. Historical baseline archive hashes checked.',sourceHash:sha256(JSON.stringify(inputs)),inputs,artifacts,phase0Baseline:baseline.sourceHash,baselineArchives:baseline.archives};
await writeFile('evidence/phase1/source-manifest.json',JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({files:files.length,sourceHash:manifest.sourceHash}));
