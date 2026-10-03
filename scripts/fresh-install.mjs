import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,rm,realpath,readdir,lstat,chmod} from 'node:fs/promises';
import path from 'node:path';
import {hash} from '../compiler/collect.mjs';
const phase=process.argv[2]??'phase1';if(!/^phase[1-9][0-9]*$/.test(phase))throw new Error('Invalid phase');
const apps=phase==='phase3'?['counter-svelte','editor-svelte']:phase==='phase2'?['counter-react','counter-vue','editor-react','editor-vue']:['quantity','thermostat','pricing','settings-wizard'],root=path.resolve(`.cache/${phase}-fresh`);
const run=(cmd,args,opts={})=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024,...opts});if(r.status!==0)throw new Error(r.stderr||r.stdout||`${cmd} failed ${r.status}`);return r.stdout;};
await mkdir(root,{recursive:true});
const store='local?root='+root;
run('nix-store',['--store',store,'--init']);
async function importArchive(file){const gzip=spawn('gzip',['-dc',file],{stdio:['ignore','pipe','inherit']}),nix=spawn('nix-store',['--store',store,'--import'],{stdio:['pipe','ignore','inherit']});gzip.stdout.pipe(nix.stdin);await Promise.all([gzip,nix].map(p=>new Promise((r,j)=>p.on('error',j).on('close',c=>c===0?r():j(new Error('Import failed '+c))))));}
const first=JSON.parse(await readFile(`evidence/${phase}/packages/${apps[0]}.json`));
await importArchive(`artifacts/distribution/${phase}/${apps[0]}/closure.nar.gz`);
// The POSIX shell is an explicit host prerequisite, isolated from development tools.
const shell=await realpath('/bin/sh'),shellRoot=shell.split('/').slice(0,4).join('/');
const shellClosure=run('nix-store',['--query','--requisites',shellRoot]).trim().split('\n');
const exporter=spawn('nix-store',['--export',...shellClosure],{stdio:['ignore','pipe','inherit']}),importer=spawn('nix-store',['--store',store,'--import'],{stdio:['pipe','ignore','inherit']});exporter.stdout.pipe(importer.stdin);
await Promise.all([exporter,importer].map(p=>new Promise((r,j)=>p.on('error',j).on('close',c=>c===0?r():j(new Error('Shell import failed'))))));
const results=[];
for(const app of apps){
 const pkg=JSON.parse(await readFile(`evidence/${phase}/packages/${app}.json`));if(JSON.stringify(pkg.closure)!==JSON.stringify(first.closure))await importArchive(`artifacts/distribution/${phase}/${app}/closure.nar.gz`);
 const directory=path.join(root,'apps',app);await mkdir(directory,{recursive:true});run('tar',['-xzf',`artifacts/distribution/${phase}/${app}/app.tar.gz`,'-C',directory]);
 const base=['--unshare-all','--die-with-parent','--new-session','--clearenv','--ro-bind',path.join(root,'nix/store'),'/nix/store','--ro-bind',directory,'/app','--ro-bind',shell,'/bin/sh','--proc','/proc','--dev','/dev','--tmpfs','/tmp','--setenv','PATH','/app','--setenv','HOME','/tmp','--setenv','DISPLAY',process.env.DISPLAY,'--ro-bind','/tmp/.X11-unix','/tmp/.X11-unix'];
 if(process.env.XAUTHORITY)base.push('--ro-bind',process.env.XAUTHORITY,'/auth','--setenv','XAUTHORITY','/auth');
 const stdout=run('bwrap',[...base,'--setenv','RUNIC_MEASURE_EXIT','1','/app/launch','--x11']);if(!/FIRST_PRESENT_US/.test(stdout))throw new Error('No actual window paint');
 const trace=path.join(root,app+'-trace');await mkdir(trace,{recursive:true});
 const built=JSON.parse(await readFile(`artifacts/${app}/ir.json`));
 if(built.capabilities.includes('text-input'))run('bwrap',[...base,'--bind',trace,'/results','/app/launch','--edit-trace','/results/frame'],{input:JSON.stringify([{kind:'focus'},{kind:'payload',value:'é😀'},{kind:'click',id:'clear'}])});
 else run('bwrap',[...base,'--bind',trace,'/results','/app/launch','--headless','420','600','/results/frame','0,1,2']);
 const frame=JSON.parse(await readFile(path.join(trace,'frame.json')));if(frame.at(-1).irHash!==built.irHash)throw new Error('Installed source mismatch');
 await writeFile(`evidence/${phase}/packages/${app}-fresh-launch.log`,stdout);
 await writeFile(`evidence/${phase}/packages/${app}-fresh-trace.json`,JSON.stringify(frame,null,2)+'\n');
 results.push({app,status:'passed',appArchiveHash:hash(await readFile(`artifacts/distribution/${phase}/${app}/app.tar.gz`)),closureArchiveHash:hash(await readFile(`artifacts/distribution/${phase}/${app}/closure.nar.gz`)),binaryHash:hash(await readFile(path.join(directory,'runic-app'))),irHash:built.irHash,firstPresentUs:Number(stdout.match(/FIRST_PRESENT_US ([\d.]+)/)[1]),headlessSnapshots:frame.length});
}
const report={schema:2,status:'passed',installation:'Fresh root-backed local Nix store, populated only through exported runtime closures and the explicit POSIX-shell host prerequisite; each compressed app archive unpacked into an empty directory. Bubblewrap namespaces expose imported store, app, /proc, /dev and the existing X11 display/auth sockets. Empty environment and PATH=/app; no home directory, compiler, Node, browser, shared font directory or host store is exposed.',hostBoundary:'Same existing Linux kernel and XWayland/KDE compositor; this is an isolated fresh installation, not another machine or cold page-cache experiment.',hostShellClosure:shellClosure,results};
await writeFile(`evidence/${phase}/fresh-install.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report.results));
// Disposable imported store and extraction copies have no further consumers.
run('nix-store',['--store',store,'--gc']);
// Root-backed stores share logical /nix/store names with running host processes,
// so their GC may retain these disposable copies. Make only task-owned copy
// directories writable; never traverse symlinks into the real host store.
async function writableDirectories(directory){const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink())return;if(info.uid!==process.getuid())throw new Error('Unexpected imported-store owner');await chmod(directory,info.mode|0o200);for(const entry of await readdir(directory,{withFileTypes:true}))if(entry.isDirectory())await writableDirectories(path.join(directory,entry.name));}
if(await realpath(root)!==root)throw new Error('Unexpected fresh-store symlink');
await writableDirectories(root);
await rm(root,{recursive:true,force:true});
