import ts from 'typescript';
import path from 'node:path';
import {Diagnostic,fail,location} from '../collect.mjs';
import {literal,evaluate,TAGS} from '../ir.mjs';
import {createExpressionLowerer,languageProgram,unwrap,globalMathReference,componentScriptFile} from '../language.mjs';
import {newIR,finishIR} from '../adapter.mjs';
import {loadRegistry} from '../mappings.mjs';
import {localModules} from '../modules.mjs';

// Runes and template syntax are frontend semantics. The backend receives only
// explicit scalar expressions, ordered writes and the existing live controls.
export async function lowerSvelte(graph,{registry=true,registryRoot}={}) {
 const {root,tooling}=graph,ir=newIR(graph,'svelte'),accepted=registry?await loadRegistry(registryRoot):[];
 const entry=ts.createSourceFile(graph.entry,graph.modules.get(graph.entry).code,ts.ScriptTarget.Latest,true),imports=new Map();let bootstrap;
 for(const stmt of entry.statements){
  if(ts.isImportDeclaration(stmt)){
   const edge=graph.modules.get(graph.entry).imports.find(e=>e.specifier===stmt.moduleSpecifier.text),c=stmt.importClause;
   if(!c){if(!edge.resolved.startsWith(root+path.sep)||!edge.resolved.endsWith('.css'))fail(stmt,root,'E_IMPORT','Only local CSS side effects are supported');continue;}
   if(c.isTypeOnly)fail(stmt,root,'E_IMPORT','Bootstrap imports require runtime values');
   if(stmt.moduleSpecifier.text==='svelte'&&!c.name&&c.namedBindings&&ts.isNamedImports(c.namedBindings)){
    for(const b of c.namedBindings.elements){if((b.propertyName??b.name).text!=='mount'||b.isTypeOnly)fail(b,root,'E_CAPABILITY','Entry supports Svelte mount only');imports.set(b.name.text,{kind:'mount'});}
   }else if(edge?.resolved.startsWith(root+path.sep)&&edge.resolved.endsWith('.svelte')&&c.name&&!c.namedBindings)imports.set(c.name.text,{kind:'component',file:edge.resolved});
   else fail(stmt,root,'E_IMPORT','Entry requires a local default Svelte component and mount');
  }else if(ts.isExpressionStatement(stmt)&&!bootstrap)bootstrap=stmt.expression;
  else fail(stmt,root,'E_BOOTSTRAP','Svelte entry may only import its component/CSS and mount once');
 }
 const call=bootstrap&&unwrap(bootstrap),arg=call?.arguments?.[1];
 const target=ts.isObjectLiteralExpression(arg??{})&&arg.properties.length===1&&ts.isPropertyAssignment(arg.properties[0])&&arg.properties[0].name.getText()==='target'&&arg.properties[0].initializer;
 const mountTarget=target&&ts.isCallExpression(target)&&ts.isPropertyAccessExpression(target.expression)&&ts.isIdentifier(target.expression.expression)&&target.expression.expression.text==='document'&&target.arguments.length===1&&ts.isStringLiteral(target.arguments[0])&&((target.expression.name.text==='getElementById'&&target.arguments[0].text==='root')||(target.expression.name.text==='querySelector'&&target.arguments[0].text==='#root'));
 if(!ts.isCallExpression(call??{})||!ts.isIdentifier(call.expression)||imports.get(call.expression.text)?.kind!=='mount'||call.arguments.length!==2||!ts.isIdentifier(call.arguments[0])||!mountTarget||imports.has('document'))fail(bootstrap??entry,root,'E_BOOTSTRAP','Expected mount(App, {target: document.getElementById("root")}) with the global document');
 const component=imports.get(call.arguments[0].text);if(component?.kind!=='component')fail(call.arguments[0],root,'E_BOOTSTRAP','Mount target must be a local Svelte component');
 const original=graph.modules.get(component.file).code;let parsed;
 try{parsed=tooling.compiler.parse(original,{filename:component.file,modern:true});}
 catch(e){throw new Diagnostic('E_PARSE',e.message,{file:path.relative(root,component.file),line:e.start?.line??1,column:(e.start?.column??0)+1});}
 const offset=n=>{const prefix=original.slice(0,n.start??0),lines=prefix.split('\n');return {file:path.relative(root,component.file),line:lines.length,column:lines.at(-1).length+1};};
 const die=(n,code,message)=>{throw new Diagnostic(code,message,offset(n));};
 if(parsed.module||parsed.css||parsed.options)die(parsed.module??parsed.css??parsed.options,'E_SVELTE_COMPONENT','Use one instance script and native markup, with imported external CSS');
 if(!parsed.instance)die(parsed,'E_SVELTE_COMPONENT','Component requires an instance script');
 for(const a of parsed.instance.attributes)if(a.name!=='lang'||!Array.isArray(a.value)||a.value.length!==1||a.value[0].type!=='Text'||!['js','ts'].includes(a.value[0].data))die(a,'E_SVELTE_COMPONENT','Instance script accepts only lang="js" or lang="ts"');
 const file=componentScriptFile(graph,component.file),pad=n=>original.slice(0,n).replace(/[^\n]/g,' '),script=parsed.instance.content;
 const virtual=pad(script.start)+original.slice(script.start,script.end),sources=[file,...[...graph.modules.keys()].filter(id=>id!==graph.entry&&id!==component.file&&!id.endsWith('.css'))],originals=new Map([...graph.modules].map(([id,m])=>[id,m.code]));originals.set(file,virtual);
 const {program,checker}=languageProgram(sources,{},originals);
 const modules=localModules(graph,{program,checker,accepted,ir,component:component.file,scriptFile:file});
 const ast=program.getSourceFile(file),env=new Map(),deriving=new Set();
 const loc=n=>({...location(n,root),file:path.relative(root,component.file)}),err=(n,code,message)=>{throw new Diagnostic(code,message,loc(n));};
 if(program.getSyntacticDiagnostics(ast).length)err(ast,'E_PARSE','Unsupported or malformed script syntax');
 const state=slot=>({op:'state',slot,type:ir.states[slot].type,effect:'pure'});
 const binding=(n,scope)=>{
  const b=scope.get(n.text);
  if(b?.kind==='state')return {kind:'value',value:scope.get('$writes')?.get(b.slot)??state(b.slot)};
  if(b?.kind==='derived'){
   if(deriving.has(b))err(n,'E_DERIVED','Cyclic derived expressions are unsupported');
   deriving.add(b);try{return {kind:'value',value:pure(b.body,scope)};}finally{deriving.delete(b);}
  }
  return b;
 };
 const read=(n,scope)=>ts.isPropertyAccessExpression(n)&&n.name.text==='value'&&ts.isPropertyAccessExpression(n.expression)&&['target','currentTarget'].includes(n.expression.name.text)&&ts.isIdentifier(n.expression.expression)&&scope.get(n.expression.expression.text)?.kind==='text-event'?{op:'payload',type:'string',effect:'pure',source:loc(n)}:undefined;
 const pure=createExpressionLowerer({root,checker,mathSymbol:modules.mathSymbol,binding,accepted,ir,err,read,sourceOf:loc,isMath:globalMathReference(ast,checker,modules.mathSymbol)});
 const fnLike=n=>ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n);
 const plain=(fn,params)=>{if(!fn.body||fn.asteriskToken||fn.type||fn.typeParameters||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||fn.parameters.length!==params||fn.parameters.some(p=>!ts.isIdentifier(p.name)||p.initializer||p.type||p.dotDotDotToken))err(fn,'E_FUNCTION','Expected a plain synchronous function with '+params+' parameters');};
 const add=(name,b,n)=>{if(env.has(name)||name.startsWith('$'))err(n,'E_DECLARATION','Duplicate binding or reserved rune name');env.set(name,b);};
 for(const stmt of ast.statements)if(ts.isImportDeclaration(stmt)&&stmt.importClause)for(const [name,b]of modules.imports(stmt,component.file))add(name,b,stmt);
 for(const stmt of ast.statements){
  if(ts.isImportDeclaration(stmt)){const edge=graph.modules.get(component.file).imports.find(e=>e.specifier===stmt.moduleSpecifier.text);if(!stmt.importClause&&(!edge?.resolved.startsWith(root+path.sep)||!edge.resolved.endsWith('.css')))err(stmt,'E_IMPORT','Side-effect imports support local CSS only');continue;}
  if(ts.isFunctionDeclaration(stmt)&&stmt.name){plain(stmt,stmt.parameters.length);add(stmt.name.text,{kind:'handler',fn:stmt},stmt);continue;}
  if(!ts.isVariableStatement(stmt))err(stmt,'E_EFFECT','Effects, lifecycle and unsupported setup statements are not dropped');
  for(const d of stmt.declarationList.declarations){
   if(!ts.isIdentifier(d.name)||!d.initializer||d.type)err(d,'E_DECLARATION','Use initialized identifiers without typed declarations');
   const n=unwrap(d.initializer),callee=ts.isCallExpression(n)&&n.expression,rune=callee&&(ts.isIdentifier(callee)?callee.text:ts.isPropertyAccessExpression(callee)&&ts.isIdentifier(callee.expression)?callee.expression.text+'.'+callee.name.text:null);
   if(rune==='$state'){
    if(!(stmt.declarationList.flags&ts.NodeFlags.Let)||n.arguments.length!==1||n.typeArguments)err(n,'E_STATE','Use let state initialized with one scalar literal');
    const initial=pure(n.arguments[0],env);if(initial.op!=='literal')err(n,'E_STATE','State initializes a scalar literal');
    const slot=ir.states.length;ir.states.push({id:slot,name:d.name.text,type:initial.type,initial:initial.value,source:loc(d)});add(d.name.text,{kind:'state',slot},d);
   }else if(rune==='$derived'||rune==='$derived.by'){
    if(n.arguments.length!==1||n.typeArguments)err(n,'E_DERIVED','Derived requires one pure expression');let body=n.arguments[0];
    if(rune==='$derived.by'){if(!fnLike(body))err(body,'E_DERIVED','Derived.by requires a plain zero-parameter getter');plain(body,0);body=body.body;if(ts.isBlock(body)){if(body.statements.length!==1||!ts.isReturnStatement(body.statements[0])||!body.statements[0].expression)err(body,'E_DERIVED','Getter contains one return');body=body.statements[0].expression;}}
    pure(body,env);add(d.name.text,{kind:'derived',body},d);
   }else if(fnLike(n)){if(!(stmt.declarationList.flags&ts.NodeFlags.Const))err(d,'E_DECLARATION','Handler values must be const');plain(n,n.parameters.length);add(d.name.text,{kind:'handler',fn:n},d);}
   else {if(!(stmt.declarationList.flags&ts.NodeFlags.Const))err(d,'E_MUTATION','Non-reactive setup values must be const');const value=pure(n,env);add(d.name.text,{kind:'value',value:literal(evaluate(value,ir.states.map(s=>s.initial)),loc(d))},d);}
  }
 }
 const expression=n=>{
  const sf=ts.createSourceFile(file,pad(n.start)+original.slice(n.start,n.end),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  if(sf.parseDiagnostics.length||sf.statements.length!==1||!ts.isExpressionStatement(sf.statements[0]))die(n,'E_TEMPLATE','Expected one supported expression');return unwrap(sf.statements[0].expression);
 };
 function handler(exp,kind){
  const n=expression(exp),b=ts.isIdentifier(n)?env.get(n.text):fnLike(n)?{kind:'handler',fn:n}:null;
  if(b?.kind!=='handler')err(n,'E_HANDLER','Event requires a setup handler or plain inline function');plain(b.fn,kind==='text-input'?1:0);
  const scope=new Map(env),writes=new Map();scope.set('$writes',writes);if(kind==='text-input')scope.set(b.fn.parameters[0].name.text,{kind:'text-event'});
  const statements=ts.isBlock(b.fn.body)?b.fn.body.statements:[b.fn.body],updates=[];
  for(const stmt of statements){
   if(ts.isVariableStatement(stmt)&&(stmt.declarationList.flags&ts.NodeFlags.Const)){
    for(const d of stmt.declarationList.declarations){if(!ts.isIdentifier(d.name)||scope.has(d.name.text)||!d.initializer||d.type)err(d,'E_HANDLER','Captures require new const identifiers');scope.set(d.name.text,{kind:'value',value:pure(d.initializer,scope)});}continue;
   }
   const e=ts.isExpressionStatement(stmt)?unwrap(stmt.expression):stmt===b.fn.body?unwrap(stmt):null;let left,right,op;
   if(e&&ts.isBinaryExpression(e)){left=e.left;right=e.right;op=new Map([[ts.SyntaxKind.EqualsToken,null],[ts.SyntaxKind.PlusEqualsToken,'add'],[ts.SyntaxKind.MinusEqualsToken,'sub'],[ts.SyntaxKind.AsteriskEqualsToken,'mul']]).get(e.operatorToken.kind);if(op===undefined)err(e,'E_HANDLER','Unsupported assignment operator');}
   else if(e&&(ts.isPostfixUnaryExpression(e)||ts.isPrefixUnaryExpression(e))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(e.operator)){left=e.operand;right=null;op=e.operator===ts.SyntaxKind.PlusPlusToken?'add':'sub';}
   else err(stmt,'E_HANDLER','Handler supports const captures and ordered scalar assignments');
   const target=ts.isIdentifier(left)&&scope.get(left.text);if(target?.kind!=='state')err(left,'E_HANDLER','Assignment target must be mutable scalar state; derived overrides are unsupported');
   let value=right?pure(right,scope):literal(1,loc(e));
   if(op){const current=binding(left,scope).value;if(current.type!=='number'||value.type!=='number')err(e,'E_TYPE','Compound assignments require numbers');value={op,type:'number',effect:'pure',left:current,right:value,source:loc(e)};}
   updates.push({slot:target.slot,value,source:loc(stmt)});writes.set(target.slot,value);
  }
  if(!updates.length)err(b.fn,'E_HANDLER','Empty handlers are unsupported');const id=ir.handlers.length;ir.handlers.push({id,kind,updates,source:loc(b.fn)});return id;
 }
 let identity=0;
 // Within the admitted native HTML subset, trim fragment edges and collapse
 // whitespace adjacent to elements; whitespace next to interpolations remains.
 function clean(fragment){
  const list=fragment.nodes.filter(n=>n.type!=='Comment').map(n=>({...n}));
  while(list[0]?.type==='Text'&&!list[0].data.trim())list.shift();while(list.at(-1)?.type==='Text'&&!list.at(-1).data.trim())list.pop();
  if(list[0]?.type==='Text')list[0].data=list[0].data.trimStart();if(list.at(-1)?.type==='Text')list.at(-1).data=list.at(-1).data.trimEnd();
  for(let i=0;i<list.length;i++)if(list[i].type==='Text'){if(list[i-1]?.type!=='ExpressionTag')list[i].data=list[i].data.replace(/^\s+/,' ');if(list[i+1]?.type!=='ExpressionTag')list[i].data=list[i].data.replace(/\s+$/,' ');}
  return list;
 }
 function children(fragment,conditional){
  const result=[];let parts=[];const flush=()=>{if(parts.length){result.push({id:'u'+identity++,kind:'text',parts});parts=[];}};
  for(const n of clean(fragment)){
   if(n.type==='Text'){if(n.data)parts.push(literal(n.data,offset(n)));}
   else if(n.type==='ExpressionTag'){const value=pure(expression(n.expression),env);parts.push(value.type==='boolean'?{op:'boolean-text',arg:value,type:'string',effect:'pure',source:offset(n)}:value);}
   else if(n.type==='RegularElement'){flush();result.push(element(n,conditional));}
   else if(n.type==='IfBlock'){
    flush();const test=pure(expression(n.test),env);result.push({id:'u'+identity++,kind:'conditional',test,children:children(n.consequent,true),source:offset(n)});
    if(n.alternate)result.push({id:'u'+identity++,kind:'conditional',test:{op:'not',type:'boolean',effect:'pure',arg:test},children:children(n.alternate,true),source:offset(n)});
   }else die(n,'E_TEMPLATE','Unsupported Svelte template capability '+n.type);
  }flush();return result;
 }
 function element(n,conditional){
  if(!TAGS.includes(n.name))die(n,'E_UI','Unsupported native element '+n.name);
  const node={id:'u'+identity++,kind:'element',tag:n.name,attrs:{},children:[],source:offset(n)};let bound;
  for(const a of n.attributes){
   if(a.type==='BindDirective'&&a.name==='value'&&!a.modifiers.length&&n.name==='input'){
    if(a.expression?.type!=='Identifier')die(a,'E_TEXT_CONTROL','Bind:value requires a scalar state identifier');const b=env.get(a.expression.name);if(b?.kind!=='state'||ir.states[b.slot].type!=='string')die(a,'E_TEXT_CONTROL','Bind:value requires string state');
    bound=b.slot;node.attrs.value=state(bound);const id=ir.handlers.length;ir.handlers.push({id,kind:'text-input',updates:[{slot:bound,value:{op:'payload',type:'string',effect:'pure',source:offset(a)}}],source:offset(a)});if(node.event!==undefined)die(a,'E_EVENT','One input route per control');node.event=id;continue;
   }
   if(a.type!=='Attribute')die(a,'E_TEMPLATE','Unsupported Svelte directive '+a.type);
   const v=a.value,parts=Array.isArray(v)?v:v?.type==='ExpressionTag'?[v]:[];
   if(['onclick','oninput'].includes(a.name)){
    if(parts.length!==1||parts[0].type!=='ExpressionTag'||(a.name==='onclick'?n.name!=='button':n.name!=='input')||node.event!==undefined)die(a,'E_EVENT','Use one supported event; bind:value plus a user input listener requires explicit ordering support');
    node.event=handler(parts[0].expression,a.name==='oninput'?'text-input':'click');continue;
   }
   if(!['id','class','title','aria-label','type','disabled','readonly','maxlength','value'].includes(a.name))die(a,'E_ATTRIBUTE','Unsupported attribute '+a.name);
   if(v===true){if(!['disabled','readonly'].includes(a.name))die(a,'E_ATTRIBUTE','Only boolean attributes can omit their value');node.attrs[a.name]=literal(true,offset(a));}
   else if(parts.length===1&&parts[0].type==='ExpressionTag')node.attrs[a.name]=pure(expression(parts[0].expression),env);
   else if(parts.every(p=>p.type==='Text')){const text=parts.map(p=>p.data).join('');if(['disabled','readonly'].includes(a.name))die(a,'E_ATTRIBUTE','Boolean attributes require a boolean expression');node.attrs[a.name]=literal(a.name==='maxlength'?Number(text):text,offset(a));}
   else die(a,'E_ATTRIBUTE','Use a static attribute or one pure expression');
  }
  if(n.name==='input'){
   const value=node.attrs.value;if(conditional||value?.op!=='state'||value.type!=='string'||node.event===undefined)die(n,'E_TEXT_CONTROL','Editor must be unconditional and bind one string state');ir.states[value.slot].domain={kind:'text',maxUtf16:256};
   if(bound!==undefined&&n.attributes.some(a=>a.type==='Attribute'&&['value','oninput'].includes(a.name)))die(n,'E_EVENT','Do not combine bind:value with value or a user input listener');
  }
  node.children=children(n.fragment,conditional);return node;
 }
 const roots=clean(parsed.fragment);if(roots.length!==1||roots[0].type!=='RegularElement')die(parsed,'E_TEMPLATE','Component requires one native root element');ir.ui=element(roots[0],false);
 modules.finish();
 const normalize=e=>{if(e?.source?.file===path.relative(root,file))e.source.file=path.relative(root,component.file);if(e&&typeof e==='object')Object.values(e).forEach(v=>{if(Array.isArray(v))v.forEach(normalize);else if(v&&typeof v==='object')normalize(v);});};normalize(ir);
 return finishIR(ir);
}
