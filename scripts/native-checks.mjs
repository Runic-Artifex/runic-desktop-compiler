import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const keys=['tab','enter','tab','space-down','space-up','shift-tab','tab','tab','tab','space-down','space-up','space-down','space-up','tab','shift-tab'];
const file='evidence/phase1/probes/quantity-internal-keys-final.json';
const r=spawnSync('artifacts/quantity/runic-app',['--ui-events',file,keys.join(',')],{encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
const trace=JSON.parse(await readFile(file));
assert.equal(trace[1].focused,'minus');assert.deepEqual(trace[2].state,[1,false]);assert.equal(trace[2].focused,null);
assert.equal(trace[3].focused,'plus');assert.deepEqual(trace[4].state,[1,false]);assert.deepEqual(trace[5].state,[2,false]);assert.equal(trace[6].focused,'minus');assert.equal(trace[9].focused,'details');
assert.equal(trace[10].elements.note,undefined);assert.equal(trace[11].elements.note.text,'Each item costs 7 EUR. Maximum 8 items.');assert.equal(trace[13].elements.note,undefined);assert.equal(trace[14].focused,null);assert.equal(trace[15].focused,'details');
const resize=spawnSync('artifacts/quantity/runic-app',['--x11','--resize-probe'],{encoding:'utf8',timeout:20000});assert.equal(resize.status,0,resize.stderr);
await writeFile('evidence/phase1/probes/quantity-x11-resize-final.log',resize.stdout);
const frames=resize.stdout.split('\n').filter(s=>s.startsWith('NATIVE_RESIZE ')).map(s=>JSON.parse(s.slice(14)));assert.deepEqual(frames.map(f=>f.size),[[800,600],[420,600],[800,600]]);assert.notEqual(frames[0].snapshot.elements.plus.rect.x,frames[1].snapshot.elements.plus.rect.x);assert.deepEqual(frames[0].snapshot.elements,frames[2].snapshot.elements);
const report={schema:2,irHash:trace[0].irHash,keyboard:{status:'incomplete',internal:{status:'passed',events:keys.length,file},os:{status:'incomplete',verifiedKeys:['Tab'],reason:'A native Tab event is retained in the application log, but CUA keyboard requests time out and subsequent key delivery could not be established. Enter/Space/Shift+Tab are verified only through the separate internal UiEvent layer.',file:'evidence/phase1/probes/quantity-native-os-input.log'},visibleFocus:{status:'untested',implementation:'Native fallback button focus border uses currentColor; original source CSS can override it.'}},resize:{status:'passed',route:'X11/XWayland',frames:3,sizes:frames.map(f=>f.size),evidence:'evidence/phase1/probes/quantity-x11-resize-final.log'},wayland:{status:'incomplete',reason:'Default desktop-route first presentation succeeded; resize requests were ignored. Native Wayland mouse/keyboard delivery is not verified. Guaranteed input/resize contract is X11 only.'}};
try {
 const observed=JSON.parse(await readFile('evidence/phase1/probes/os-observations.json'));
 const events=JSON.parse('[]');
 const logs=await readFile('evidence/phase1/probes/pricing-wayland-mouse.log','utf8');
 for(const line of logs.split('\n').filter(l=>l.startsWith('NATIVE_EVENT ')))events.push(JSON.parse(line.slice(13)));
 assert.deepEqual(events.map(e=>e.state),observed.pricing.mouse.observedStates);
 report.keyboard.visibleFocus=observed.quantity.visibleFocus;
 report.wayland.mouse=observed.pricing.mouse;
 report.wayland.reason='Genuine Wayland mouse input and presentation verified on pricing; keyboard and resize remain incomplete. X11 mouse/resize and internal keyboard dispatch are separately verified.';
 report.osObservations='evidence/phase1/probes/os-observations.json';
}catch(e){if(e.code!=='ENOENT')throw e;}
await writeFile('evidence/phase1/native-checks.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
