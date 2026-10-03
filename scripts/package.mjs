import { spawnSync,spawn } from 'node:child_process';
import { mkdir,readFile,writeFile,copyFile,stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

const folder=process.argv[2]??'quantity',phase=process.argv[3]??'phase1';
if(!/^phase[1-9][0-9]*$/.test(phase))throw new Error('Invalid evidence phase');
if(!/^[-a-z0-9]+$/.test(folder))throw new Error('Invalid artifact folder');
const out=path.resolve(`artifacts/distribution/${phase}/${folder}`);await mkdir(out,{recursive:true});await mkdir(`evidence/${phase}/packages`,{recursive:true});
const binary=path.resolve(`artifacts/${folder}/runic-app`);
const run=(cmd,args)=>{const r=spawnSync(cmd,args,{encoding:'utf8',timeout:30000,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const ld=run('ldd',[binary]);
const roots=new Set([...ld.matchAll(/\/nix\/store\/[^\s/]+/g)].map(m=>m[0]));
for(const dir of (process.env.LD_LIBRARY_PATH??'').split(':').filter(Boolean)){const m=dir.match(/^\/nix\/store\/[^/]+/);if(m)roots.add(m[0]);}
const closure=run('nix-store',['--query','--requisites',...[...roots]]).trim().split('\n').sort();
const infos=JSON.parse(run('nix',['path-info','--json',...closure]));
const paths=Array.isArray(infos)?infos:Object.values(infos);
const dependencyNarBytes=paths.reduce((sum,i)=>sum+i.narSize,0);
await copyFile(binary,path.join(out,'runic-app'));
if((process.env.LD_LIBRARY_PATH??'').split(':').some(p=>!/^\/nix\/store\/[^'\s]+\/lib$/.test(p)))throw new Error('Expected locked Nix runtime library paths');
const wrapper=`#!/bin/sh\nunset LOCALE_ARCHIVE\nexport LC_ALL=C\nexport LD_LIBRARY_PATH='${process.env.LD_LIBRARY_PATH}'\ncase "$0" in */*) runic_directory=\${0%/*};; *) runic_directory=.;; esac\nexec "$runic_directory/runic-app" "$@"\n`;
await writeFile(path.join(out,'launch'),wrapper,{mode:0o755});
await writeFile(path.join(out,'closure.txt'),closure.join('\n')+'\n');
await copyFile('docs/FONT-LICENSE.txt',path.join(out,'FONT-LICENSE.txt'));
await writeFile(path.join(out,'IMPORT.txt'),'On another x86_64 Linux system with Nix installed, import the runtime closure with: gzip -dc closure.nar.gz | nix-store --import\nThen unpack app.tar.gz and run ./launch. Requires an existing X11/Wayland desktop. Fonts and CSS are embedded. No Node, Bun, browser, WebView or JavaScript engine is required.\n');
async function compressed(cmd,args,file) {const producer=spawn(cmd,args,{stdio:['ignore','pipe','inherit']}),gzip=spawn('gzip',['-n','-9'],{stdio:['pipe','pipe','inherit']});producer.stdout.pipe(gzip.stdin);const output=createWriteStream(file);gzip.stdout.pipe(output);await Promise.all([new Promise((r,j)=>producer.on('close',c=>c===0?r():j(new Error(cmd+' failed')))),new Promise((r,j)=>gzip.on('close',c=>c===0?r():j(new Error('gzip failed')))),new Promise((r,j)=>output.on('finish',r).on('error',j))]);}
await compressed('nix-store',['--export',...closure],path.join(out,'closure.nar.gz'));
await compressed('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','-C',out,'-cf','-','runic-app','launch','closure.txt','IMPORT.txt','FONT-LICENSE.txt'],path.join(out,'app.tar.gz'));
const appBytes=(await stat(path.join(out,'app.tar.gz'))).size,closureBytes=(await stat(path.join(out,'closure.nar.gz'))).size,executableBytes=(await stat(binary)).size;
let artifactInstalledBytes=0;for(const file of ['runic-app','launch','closure.txt','IMPORT.txt','FONT-LICENSE.txt'])artifactInstalledBytes+=(await stat(path.join(out,file))).size;
const report={schema:1,artifact:folder,executableBytes,artifactInstalledBytes,dependencyNarBytes,installedBoundaryNarBytes:dependencyNarBytes+artifactInstalledBytes,appTarGzipBytes:appBytes,closureGzipBytes:closureBytes,completeCompressedDistributionBytes:appBytes+closureBytes,nixRuntimeRoots:[...roots].sort(),closure,linkedLibraries:ld,hostBoundary:'Existing x86_64 Linux kernel, Nix installation, POSIX shell, desktop compositor/X server and display/input permissions. Host OS and compositor not included. Launcher sets LC_ALL=C and unsets host LOCALE_ARCHIVE. No GPU driver required by the CPU renderer.',sizeMetric:'Dependencies counted using full Nix NAR sizes including metadata/docs in each selected output; shared libraries dlopened by winit/softbuffer included through the complete configured runtime closure. Installed artifact includes executable, launcher and import/closure instructions.'};
await writeFile(`evidence/${phase}/packages/${folder}.json`,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({artifact:folder,completeCompressedDistributionBytes:report.completeCompressedDistributionBytes,installedBoundaryNarBytes:report.installedBoundaryNarBytes}));
