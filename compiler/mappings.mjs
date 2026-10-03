import ts from 'typescript';
import { readFile,writeFile,mkdir,rename,open,rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { hash,Diagnostic } from './collect.mjs';
import { literal,evaluate,deps } from './ir.mjs';

export const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const unwrap=n=>ts.isParenthesizedExpression(n)?unwrap(n.expression):n;
const issue=(code,message,source)=>{throw new Diagnostic(code,message,source);};
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const shape=(x,keys)=>{if(!object(x)||keys.some(k=>!Object.hasOwn(x,k))||Object.keys(x).some(k=>!keys.includes(k)))issue('E_RULE','Invalid declarative mapping fields');};
const operators=new Map([[ts.SyntaxKind.PlusToken,'add'],[ts.SyntaxKind.MinusToken,'sub'],[ts.SyntaxKind.AsteriskToken,'mul'],[ts.SyntaxKind.EqualsEqualsEqualsToken,'eq'],[ts.SyntaxKind.ExclamationEqualsEqualsToken,'ne'],[ts.SyntaxKind.LessThanToken,'lt'],[ts.SyntaxKind.LessThanEqualsToken,'le'],[ts.SyntaxKind.GreaterThanToken,'gt'],[ts.SyntaxKind.GreaterThanEqualsToken,'ge'],[ts.SyntaxKind.AmpersandAmpersandToken,'and'],[ts.SyntaxKind.BarBarToken,'or']]);
const binary={add:'+',sub:'-',mul:'*',eq:'===',ne:'!==',lt:'<',le:'<=',gt:'>',ge:'>=',and:'&&',or:'||'};
const arity={neg:1,not:1,min:2,max:2,add:2,sub:2,mul:2,eq:2,ne:2,lt:2,le:2,gt:2,ge:2,and:2,or:2,select:3};
export const clampPattern={op:'min',args:[{op:'max',args:[{op:'param',index:0},{op:'param',index:1}]},{op:'param',index:2}]};
const legacyConditions={domain:'finite-integer',maxAbs:1000000,constantBounds:true,orderedBounds:true,evaluation:'pure-left-to-right'};
export function migrateV1(rule) {
  shape(rule,['schema','id','version','matcher','preconditions','lowering','capabilities','provenance','tests']);
  if(rule.schema!==1||rule.id!=='pure-clamp'||rule.version!==1||JSON.stringify(rule.matcher)!==JSON.stringify({kind:'pure-function',parameters:3,body:clampPattern})||JSON.stringify(rule.preconditions)!==JSON.stringify(legacyConditions))issue('E_RULE','Unknown legacy mapping interface');
  return {...rule,schema:2,capabilities:requiredCapabilities(rule.lowering,3),preconditions:{domain:'finite-integer',maxAbs:1000000,constantParameters:[1,2],predicates:[{op:'le',args:[{op:'param',index:1},{op:'param',index:2}]}],evaluation:'pure-left-to-right'},tests:{positive:[],negative:[],boundary:[]}};
}
export function patternType(tree,parameters,budget={nodes:0},depth=0) {
  if(depth>16||++budget.nodes>63||!object(tree))issue('E_RULE','Expression exceeds depth/node limits');
  if(tree.op==='param'){shape(tree,['op','index']);if(!Number.isInteger(tree.index)||tree.index<0||tree.index>=parameters)issue('E_RULE','Invalid parameter capture');return 'number';}
  if(tree.op==='literal'){shape(tree,['op','value']);if(typeof tree.value==='boolean')return 'boolean';if(!Number.isSafeInteger(tree.value)||Object.is(tree.value,-0)||Math.abs(tree.value)>1e6)issue('E_RULE','Invalid exact integer literal');return 'number';}
  shape(tree,['op','args']);
  if(!Object.hasOwn(arity,tree.op)||!Array.isArray(tree.args)||tree.args.length!==arity[tree.op])issue('E_RULE','Unsupported operation or arity');
  const types=tree.args.map(x=>patternType(x,parameters,budget,depth+1));
  if(['not','and','or'].includes(tree.op)){if(types.some(x=>x!=='boolean'))issue('E_RULE','Boolean pattern type mismatch');return 'boolean';}
  if(tree.op==='select'){if(types[0]!=='boolean'||types[1]!==types[2])issue('E_RULE','Selection pattern type mismatch');return types[1];}
  if(types.some(x=>x!=='number'))issue('E_RULE','Numeric pattern type mismatch');
  return ['eq','ne','lt','le','gt','ge'].includes(tree.op)?'boolean':'number';
}
function requiredCapabilities(tree,parameters) {
  const out=new Set();
  const walk=n=>{if(n.args){out.add((patternType(n,parameters)==='number'?'integer-':'boolean-')+n.op);n.args.forEach(walk);}};
  walk(tree);return [...out].sort();
}
export function validateRule(input) {
  const rule=input?.schema===1?migrateV1(input):input;
  shape(rule,['schema','id','version','matcher','preconditions','lowering','capabilities','provenance','tests']);
  if(rule.schema!==2||typeof rule.id!=='string'||!/^[-a-z0-9]{1,64}$/.test(rule.id)||!Number.isInteger(rule.version)||rule.version<1||rule.version>1000000)issue('E_RULE','Invalid mapping identity/version');
  shape(rule.matcher,['kind','parameters','body']);
  if(rule.matcher.kind!=='pure-function'||!Number.isInteger(rule.matcher.parameters)||rule.matcher.parameters<1||rule.matcher.parameters>4)issue('E_RULE','Only bounded pure numeric helper matchers are supported');
  const count=rule.matcher.parameters;
  if(patternType(rule.matcher.body,count)!==patternType(rule.lowering,count))issue('E_RULE','Matcher/lowering result type mismatch');
  shape(rule.preconditions,['domain','maxAbs','constantParameters','predicates','evaluation']);
  const pre=rule.preconditions;
  if(pre.domain!=='finite-integer'||pre.maxAbs!==1000000||pre.evaluation!=='pure-left-to-right'||!Array.isArray(pre.constantParameters)||new Set(pre.constantParameters).size!==pre.constantParameters.length||pre.constantParameters.some(x=>!Number.isInteger(x)||x<0||x>=count)||!Array.isArray(pre.predicates)||pre.predicates.length>16)issue('E_RULE','Invalid applicability conditions');
  pre.predicates.forEach(p=>{if(patternType(p,count)!=='boolean')issue('E_RULE','Applicability predicates must be boolean');});
  if(!Array.isArray(rule.capabilities)||rule.capabilities.some(x=>typeof x!=='string')||JSON.stringify([...rule.capabilities].sort())!==JSON.stringify(requiredCapabilities(rule.lowering,count)))issue('E_RULE','Capabilities must exactly describe the lowering operations');
  shape(rule.provenance,['mode','provider','model','liveDiscovery']);
  if(!['replay','live','migration','handwritten'].includes(rule.provenance.mode)||typeof rule.provenance.provider!=='string'||!(rule.provenance.model===null||typeof rule.provenance.model==='string')||typeof rule.provenance.liveDiscovery!=='boolean')issue('E_RULE','Invalid candidate provenance');
  shape(rule.tests,['positive','negative','boundary']);
  for(const values of Object.values(rule.tests)) {
    if(!Array.isArray(values)||values.length>64)issue('E_RULE','Proposed test list exceeds limit');
    for(const t of values){if(!object(t)||!Array.isArray(t.args)||t.args.length!==count||Object.keys(t).some(k=>!['args','expected','reason'].includes(k))||t.reason!==undefined&&typeof t.reason!=='string')issue('E_RULE','Invalid proposed test');}
  }
  return rule;
}
export function helperPattern(fn,checker,mathSymbol) {
  if(!fn||!fn.body||fn.asteriskToken||fn.type||fn.typeParameters||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||fn.parameters.length<1||fn.parameters.length>4||fn.parameters.some(p=>!ts.isIdentifier(p.name)||p.type||p.initializer||p.dotDotDotToken||p.questionToken))return null;
  let body=fn.body;
  if(ts.isBlock(body)){if(body.statements.length!==1||!ts.isReturnStatement(body.statements[0]))return null;body=body.statements[0].expression;}
  const params=fn.parameters.map(p=>checker.getSymbolAtLocation(p.name));
  let count=0;
  const walk=node=>{
    if(!node||++count>63)return null;
    const n=unwrap(node);
    if(ts.isIdentifier(n)){const index=params.indexOf(checker.getSymbolAtLocation(n));return index<0?null:{op:'param',index};}
    if(ts.isNumericLiteral(n)){const v=Number(n.text);return Number.isSafeInteger(v)&&Math.abs(v)<=1e6?{op:'literal',value:v}:null;}
    if(n.kind===ts.SyntaxKind.TrueKeyword||n.kind===ts.SyntaxKind.FalseKeyword)return {op:'literal',value:n.kind===ts.SyntaxKind.TrueKeyword};
    const make=(op,nodes)=>{const args=nodes.map(walk);return args.some(x=>!x)?null:{op,args};};
    if(ts.isPrefixUnaryExpression(n)) {
      if(n.operator===ts.SyntaxKind.MinusToken&&ts.isNumericLiteral(unwrap(n.operand))){const v=-Number(unwrap(n.operand).text);return !Object.is(v,-0)&&Math.abs(v)<=1e6?{op:'literal',value:v}:null;}
      if(n.operator===ts.SyntaxKind.MinusToken)return make('neg',[n.operand]);
      if(n.operator===ts.SyntaxKind.ExclamationToken)return make('not',[n.operand]);
    }
    if(ts.isBinaryExpression(n)&&operators.has(n.operatorToken.kind))return make(operators.get(n.operatorToken.kind),[n.left,n.right]);
    if(ts.isConditionalExpression(n))return make('select',[n.condition,n.whenTrue,n.whenFalse]);
    if(ts.isCallExpression(n)&&!n.typeArguments?.length&&ts.isPropertyAccessExpression(n.expression)&&ts.isIdentifier(n.expression.expression)&&checker.getSymbolAtLocation(n.expression.expression)===mathSymbol&&['min','max'].includes(n.expression.name.text)&&n.arguments.length===2)return make(n.expression.name.text,[...n.arguments]);
    return null;
  };
  const pattern=walk(body);
  if(pattern){try{patternType(pattern,params.length);}catch{return null;}}
  return pattern;
}
export function matchHelper(fn,rule,checker,mathSymbol) {
  const normalized=validateRule(rule.schema===1?rule:Object.fromEntries(Object.entries(rule).filter(([k])=>k!=='sha256')));
  const body=helperPattern(fn,checker,mathSymbol);
  const canonical=p=>p.op==='param'?{op:p.op,index:p.index}:p.op==='literal'?{op:p.op,value:p.value}:{op:p.op,args:p.args.map(canonical)};
  return fn.parameters.length===normalized.matcher.parameters&&body!==null&&hash(canonical(body))===hash(canonical(normalized.matcher.body));
}
export function instantiate(pattern,args,source) {
  if(pattern.op==='param')return args[pattern.index];
  if(pattern.op==='literal')return literal(pattern.value,source);
  const children=pattern.args.map(x=>instantiate(x,args,source));
  const fields=['min','max'].includes(pattern.op)?{args:children}:pattern.op==='select'?{test:children[0],yes:children[1],no:children[2]}:['neg','not'].includes(pattern.op)?{arg:children[0]}:{left:children[0],right:children[1]};
  return {op:pattern.op,type:patternType(pattern,args.length),effect:'pure',...fields,source};
}
const hasPrevious=e=>e.op==='previous'||Object.values(e).filter(v=>object(v)&&v.op).concat(e.args??[],e.requirements??[]).some(hasPrevious);
export function mappedExpression(rule,args,source) {
  if(args.length!==rule.matcher.parameters)issue('E_ARITY','Mapped helper argument count differs from its signature',source);
  if(args.some(x=>x.type!=='number'))issue('E_TYPE','This mapping interface accepts exact numeric arguments',source);
  if(rule.preconditions.constantParameters.some(i=>deps(args[i]).length||hasPrevious(args[i])))issue('E_MAPPING_PRECONDITION','Mapping requires constant arguments at positions '+rule.preconditions.constantParameters.join(','),source);
  const requirements=rule.preconditions.predicates.map(p=>instantiate(p,args,source));
  for(const p of requirements)if(!deps(p).length&&!hasPrevious(p)&&!evaluate(p,[]))issue('E_MAPPING_PRECONDITION','Mapping '+rule.id+' constant precondition failed',source);
  const reference=instantiate(rule.matcher.body,args,source),value=instantiate(rule.lowering,args,source);
  return {op:'mapping',type:value.type,effect:'pure',args,reference,value,requirements,rule:rule.id+'@'+rule.version,source};
}
export async function validatorHash(){return hash(Buffer.concat(await Promise.all(['compiler/mappings.mjs','compiler/ir.mjs','mappings/validation-corpus.json'].map(p=>readFile(path.join(repository,p))))));}
async function readLock(root) {
  try{return JSON.parse(await readFile(path.join(root,'registry.lock.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return {schema:2,rules:[]};throw e;}
}
export async function loadRegistry(root=path.join(repository,'mappings')) {
  const lock=await readLock(root);
  if(![1,2].includes(lock.schema)||!Array.isArray(lock.rules)||lock.rules.length>128)issue('E_REGISTRY','Invalid registry lock');
  const rules=[],identities=new Set();
  const current=await validatorHash();
  for(const pinned of lock.rules) {
    if(!/^[-a-z0-9]+\.json$/.test(pinned.file)||typeof pinned.evidence!=='string')issue('E_REGISTRY','Invalid registry paths');
    const evidence=path.resolve(repository,pinned.evidence);
    if(!evidence.startsWith(repository+path.sep))issue('E_REGISTRY','Validation evidence must stay inside repository');
    const bytes=await readFile(path.join(root,'accepted',pinned.file),'utf8');
    if(hash(bytes)!==pinned.sha256)issue('E_REGISTRY','Accepted rule hash mismatch');
    const parsed=JSON.parse(bytes),rule=validateRule(parsed),proof=JSON.parse(await readFile(evidence,'utf8'));
    if(!proof.accepted||proof.candidateHash!==pinned.sha256)issue('E_REGISTRY','Rule lacks matching independent evidence');
    if(parsed.schema===2&&proof.validatorHash!==current)issue('E_REGISTRY_STALE','Validator changed; explicitly validate/accept the pinned candidate again');
    if(identities.has(rule.id))issue('E_REGISTRY','Duplicate active rule identity');identities.add(rule.id);
    rules.push({...rule,sha256:pinned.sha256});
  }
  return rules.sort((a,b)=>a.id.localeCompare(b.id));
}
function javascript(p) {
  if(p.op==='param')return 'p'+p.index;
  if(p.op==='literal')return String(p.value);
  const a=p.args.map(javascript);
  if(['min','max'].includes(p.op))return 'Math.'+p.op+'('+a.join(',')+')';
  if(p.op==='select')return '('+a[0]+'?'+a[1]+':'+a[2]+')';
  if(['neg','not'].includes(p.op))return '('+(p.op==='neg'?'-':'!')+a[0]+')';
  return '('+a[0]+binary[p.op]+a[1]+')';
}
function applicable(rule,a){return a.length===rule.matcher.parameters&&a.every(n=>Number.isSafeInteger(n)&&!Object.is(n,-0)&&Math.abs(n)<=1e6)&&rule.preconditions.predicates.every(p=>evaluate(instantiate(p,a.map(x=>literal(x))),[]));}
function* product(values,count,prefix=[]) {if(prefix.length===count){yield prefix;return;}for(const n of values)yield* product(values,count,[...prefix,n]);}
async function structuralCorpus(rule) {
  const count=rule.matcher.parameters,params=Array.from({length:count},(_,i)=>'p'+i),body=javascript(rule.matcher.body);
  const canonical='function renamed('+params.join(',')+'){return '+body+';}';
  const corpus=[
    [true,canonical],
    [true,canonical.replaceAll(/\bp(\d)\b/g,'argument$1')],
    [true,'const helper=('+params.join(',')+')=>('+body+');'],
    [false,canonical.replace('return ','console.log(1);return ')],
    [false,'async '+canonical],
    [false,canonical.replace(params[0],params[0]+'=1')],
    [false,canonical.replace(params.at(-1), '...'+params.at(-1))],
    [false,canonical.replace('return ','return Date.now()+')],
    [false,canonical.replace('return ','return (p0++,') .replace(/;\}$/ ,');}')],
  ];
  if(body.includes('Math.'))corpus.push([false,canonical.replace('return ','const Math={};return ')]);
  const changed=body.replace(/\bp0\b/g,count>1?'p1':'1');
  if(changed!==body)corpus.push([false,'function different('+params.join(',')+'){return '+changed+';}']);
  for(const [expected,text] of corpus) {
    const file='/__runic_owned_mapping_corpus__.js',options={allowJs:true,noEmit:true};
    const host=ts.createCompilerHost(options),read=host.getSourceFile.bind(host);
    host.getSourceFile=(name,language,...rest)=>name===file?ts.createSourceFile(file,text,language,true):read(name,language,...rest);
    const program=ts.createProgram([file],options,host),checker=program.getTypeChecker(),stmt=program.getSourceFile(file).statements[0];
    const fn=ts.isVariableStatement(stmt)?stmt.declarationList.declarations[0].initializer:stmt;
    const libs=program.getSourceFiles().filter(f=>program.isSourceFileDefaultLibrary(f));
    const math=libs.flatMap(f=>[...f.statements]).filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText()==='Math');
    if(matchHelper(fn,rule,checker,checker.getSymbolAtLocation(math.name))!==expected)issue('E_RULE_MATCHER','Compiler-owned structural counterexample: '+text);
  }
  return corpus.length;
}
export async function validateCandidate(candidatePath) {
  const bytes=await readFile(candidatePath,'utf8');if(Buffer.byteLength(bytes)>65536)issue('E_RULE','Candidate exceeds 64 KiB');
  const rule=validateRule(JSON.parse(bytes)),corpus=JSON.parse(await readFile(path.join(repository,'mappings/validation-corpus.json'),'utf8'));
  const count=rule.matcher.parameters,values=count<4?Array.from({length:corpus.exhaustive[1]-corpus.exhaustive[0]+1},(_,i)=>i+corpus.exhaustive[0]):corpus.fourParameterValues;
  const context=vm.createContext(Object.create(null),{codeGeneration:{strings:false,wasm:false}});
  const source='(function('+Array.from({length:count},(_,i)=>'p'+i).join(',')+'){return '+javascript(rule.matcher.body)+';})';
  const reference=new vm.Script(source).runInContext(context,{timeout:1000});
  let cases=0,excludedOutsideContract=0,exhaustiveCases=0;
  const check=a=>{
    if(!applicable(rule,a))return;
    const args=a.map(x=>literal(x));
    let original;
    try{original=evaluate(instantiate(rule.matcher.body,args),[]);}catch(e){if(e.code==='E_NUMBER'){excludedOutsideContract++;return;}throw e;}
    const actual=evaluate(instantiate(rule.lowering,args),[]),expected=reference(...a);
    if(!Object.is(original,expected)||!Object.is(actual,expected))issue('E_RULE_DIFFERENTIAL','Compiler-owned numeric counterexample '+JSON.stringify({args:a,reference:expected,lowering:actual}));
    cases++;
  };
  for(const a of product(values,count))check(a);exhaustiveCases=cases;
  for(const a of product(corpus.boundaries,count))check(a);
  if(cases===0)issue('E_RULE_PRECONDITION','Preconditions exclude the entire independent corpus');
  const badInputs=[...corpus.invalidValues,NaN,Infinity,-Infinity,-0].map(v=>[v,...Array(count-1).fill(1)]);
  if(badInputs.some(a=>applicable(rule,a)))issue('E_RULE_PRECONDITION','Invalid numeric input accepted');
  const structuralCases=await structuralCorpus(rule);
  for(const t of [...rule.tests.positive,...rule.tests.boundary]){if(!applicable(rule,t.args))issue('E_RULE_TEST','Proposed positive does not satisfy applicability');try{evaluate(instantiate(rule.matcher.body,t.args.map(x=>literal(x))),[]);}catch(e){if(e.code==='E_NUMBER')issue('E_RULE_TEST','Proposed positive exceeds an exact integer intermediate bound');throw e;}check(t.args);if(t.expected!==undefined&&!Object.is(reference(...t.args),t.expected))issue('E_RULE_TEST','Incorrect proposed expected result');}
  for(const t of rule.tests.negative){let valid=false;try{valid=applicable(rule,t.args);if(valid)evaluate(instantiate(rule.matcher.body,t.args.map(x=>literal(x))),[]);}catch(e){if(e.code==='E_NUMBER')valid=false;else throw e;}if(valid)issue('E_RULE_TEST','Proposed negative is within the accepted contract');}
  return {schema:2,accepted:true,candidateHash:hash(bytes),validator:'runic-independent-v2',validatorHash:await validatorHash(),corpusHash:hash(corpus),oracle:'JavaScript execution of compiler-owned source generated from the structurally checked matcher; independent IR lowering evaluation',exhaustive:{range:count<4?corpus.exhaustive:null,values:count===4?values:undefined,parameters:count,cases:exhaustiveCases},cases,excludedOutsideContract,negativeNumericCases:badInputs.length,structuralCases,scope:'Bounded pure numeric matcher; independent differential corpus plus exact reachable application closure. Not general JavaScript equivalence.'};
}
async function atomic(file,bytes){await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.writing-'+process.pid;try{await writeFile(temporary,bytes);await rename(temporary,file);}finally{await rm(temporary,{force:true});}}
export async function accept(candidatePath,evidencePath,{registryRoot=path.join(repository,'mappings')}={}) {
  const report=await validateCandidate(candidatePath),bytes=await readFile(candidatePath,'utf8'),rule=validateRule(JSON.parse(bytes));
  await mkdir(registryRoot,{recursive:true});
  let mutex;const mutexPath=path.join(registryRoot,'registry.mutation.lock');
  try{mutex=await open(mutexPath,'wx');}catch(e){if(e.code==='EEXIST')issue('E_REGISTRY_BUSY','Another registry mutation is in progress; inspect the lock owner before recovery');throw e;}
  try {
    await mutex.writeFile(JSON.stringify({pid:process.pid}));
    const lock=await readLock(registryRoot),old=[];
    for(const entry of lock.rules){const r=JSON.parse(await readFile(path.join(registryRoot,'accepted',entry.file),'utf8'));old.push({...entry,id:r.id,version:r.version});}
    const previous=old.find(r=>r.id===rule.id);
    if(previous&&(previous.version>rule.version||previous.version===rule.version&&previous.sha256!==report.candidateHash))issue('E_RULE_VERSION','Accepted versions are immutable; increment the version for changed bytes');
    const file=rule.id+'-v'+rule.version+'-'+report.candidateHash.slice(0,12)+'.json';
    const proof=path.resolve(evidencePath??path.join(repository,'evidence/phase1/mappings',file));
    if(!proof.startsWith(repository+path.sep))issue('E_REGISTRY','Evidence must stay inside repository');
    await atomic(path.join(registryRoot,'accepted',file),bytes);await atomic(proof,JSON.stringify(report,null,2)+'\n');
    const pinned={id:rule.id,version:rule.version,file,sha256:report.candidateHash,evidence:path.relative(repository,proof)};
    const rules=[...old.filter(x=>x.id!==rule.id),pinned].sort((a,b)=>a.id.localeCompare(b.id));
    await atomic(path.join(registryRoot,'registry.lock.json'),JSON.stringify({schema:2,rules},null,2)+'\n');return report;
  } finally {await mutex.close();await rm(mutexPath,{force:true});}
}
