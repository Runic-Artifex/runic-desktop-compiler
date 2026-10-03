import ts from 'typescript';
import path from 'node:path';
import {Diagnostic,location} from './collect.mjs';
import {literal,evaluate} from './ir.mjs';
import {createExpressionLowerer,unwrap} from './language.mjs';
import {helperPattern} from './mappings.mjs';

// Ordinary modules have no framework scheduling or reactive state. Resolve the
// collected graph, then evaluate its admitted immutable initialization only.
export function localModules(graph,{program,checker,accepted,ir,component,scriptFile}) {
 const {root}=graph,done=new Map(),active=new Set();
 const source=n=>{const loc=location(n,root);if(n.getSourceFile().fileName===scriptFile)loc.file=path.relative(root,component);return loc;};
 const err=(n,code,message)=>{throw new Diagnostic(code,message,source(n));};
 const math=program.getSourceFiles().filter(f=>program.isSourceFileDefaultLibrary(f)).flatMap(f=>[...f.statements]).filter(ts.isVariableStatement).flatMap(s=>[...s.declarationList.declarations]).find(d=>d.name.getText()==='Math');
 const mathSymbol=math&&checker.getSymbolAtLocation(math.name);
 const fnLike=n=>ts.isFunctionDeclaration(n)||ts.isFunctionExpression(n)||ts.isArrowFunction(n);
 const exported=n=>n.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword);
 const modifiers=n=>{if(n.modifiers?.some(m=>m.kind!==ts.SyntaxKind.ExportKeyword&&m.kind!==ts.SyntaxKind.AsyncKeyword))err(n,'E_MODULE','Only named runtime exports are supported');};
 const add=(env,name,b,n)=>{if(env.has(name)||name.startsWith('$'))err(n,'E_MODULE_BINDING','Duplicate or reserved module binding '+name);env.set(name,b);};
 const target=(stmt,file)=>{
  const spec=stmt.moduleSpecifier;
  if(!spec||!ts.isStringLiteral(spec)||stmt.attributes)err(stmt,'E_IMPORT','Use plain local named imports and re-exports');
  const edge=graph.modules.get(file)?.imports.find(e=>e.specifier===spec.text),id=edge?.resolved;
  if(!spec.text.startsWith('.')||!id?.startsWith(root+path.sep)||!graph.modules.has(id))err(stmt,'E_DEPENDENCY','Shared modules must resolve inside the collected application');
  if(!['.js','.ts'].includes(path.extname(id))||/\.svelte\.[jt]s$/.test(id)||id===graph.entry||id===component)err(stmt,'E_COMPOSITION','Expected an ordinary local .js or .ts module');
  return id;
 };
 function imports(stmt,file) {
  const c=stmt.importClause;
  if(!c||c.isTypeOnly||c.name||!c.namedBindings||!ts.isNamedImports(c.namedBindings)||c.namedBindings.elements.some(b=>b.isTypeOnly))err(stmt,'E_IMPORT','Shared modules support runtime named imports only');
  const exports=module(target(stmt,file),stmt),result=new Map();
  for(const b of c.namedBindings.elements){
   const name=(b.propertyName??b.name).text,value=exports.get(name);
   if(!value)err(b,'E_MODULE_EXPORT','No admitted named export '+name);
   add(result,b.name.text,value,b);
  }
  return result;
 }
 function module(file,via) {
  if(done.has(file))return done.get(file);
  if(active.has(file))err(via,'E_MODULE_CYCLE','Cyclic module initialization is outside the contract');
  active.add(file);
  const sf=program.getSourceFile(file);
  if(!sf)err(via,'E_RESOLVE','Collected module is absent from the language program');
  const syntax=program.getSyntacticDiagnostics(sf);if(syntax.length){const d=syntax[0],pos=sf.getLineAndCharacterOfPosition(d.start??0);throw new Diagnostic('E_PARSE',ts.flattenDiagnosticMessageText(d.messageText,'\n'),{file:path.relative(root,file),line:pos.line+1,column:pos.character+1});}
  const env=new Map(),exports=new Map(),reexports=new Map();
  const put=(name,b,n)=>{if(exports.has(name))err(n,'E_MODULE_EXPORT','Duplicate named export '+name);exports.set(name,b);};
  const functionBinding=fn=>{if(!helperPattern(fn,checker,mathSymbol))err(fn,'E_HELPER','Module helper must be a bounded pure numeric expression without captured values');return {kind:'function',fn};};
  // Static dependencies initialize before this module, independent of where
  // their declarations appear. Function declarations are hoisted; const values
  // remain in source initialization order and cannot read a later declaration.
  for(const stmt of sf.statements){
   if(ts.isImportDeclaration(stmt))for(const [name,b]of imports(stmt,file))add(env,name,b,stmt);
   else if(ts.isExportDeclaration(stmt)&&stmt.moduleSpecifier){
    if(stmt.isTypeOnly||!stmt.exportClause||!ts.isNamedExports(stmt.exportClause)||stmt.exportClause.elements.some(b=>b.isTypeOnly))err(stmt,'E_MODULE_EXPORT','Use explicit named runtime re-exports');
    reexports.set(stmt,module(target(stmt,file),stmt));
   }
  }
  for(const stmt of sf.statements)if(ts.isFunctionDeclaration(stmt)){
   modifiers(stmt);if(!stmt.name)err(stmt,'E_MODULE','Module functions require a name');add(env,stmt.name.text,functionBinding(stmt),stmt);
  }
  const pure=createExpressionLowerer({root,checker,mathSymbol,binding:(n,scope)=>scope.get(n.text),accepted,ir,err});
  for(const stmt of sf.statements){
   if(ts.isImportDeclaration(stmt))continue;
   if(ts.isFunctionDeclaration(stmt)){if(exported(stmt))put(stmt.name.text,env.get(stmt.name.text),stmt);continue;}
   if(ts.isVariableStatement(stmt)){
    modifiers(stmt);if(!(stmt.declarationList.flags&ts.NodeFlags.Const))err(stmt,'E_MODULE_MUTATION','Shared module declarations must be const');
    for(const d of stmt.declarationList.declarations){
     if(!ts.isIdentifier(d.name)||!d.initializer||d.type||d.exclamationToken)err(d,'E_DECLARATION','Module constants require plain initialized identifiers');
     const init=unwrap(d.initializer),b=fnLike(init)?functionBinding(init):{kind:'value',value:literal(evaluate(pure(init,env),[]),location(d,root))};
     add(env,d.name.text,b,d);if(exported(stmt))put(d.name.text,b,d);
    }
   }else if(!ts.isExportDeclaration(stmt))err(stmt,'E_MODULE_EFFECT','Unsupported module statement; initialization effects are not dropped');
  }
  for(const stmt of sf.statements)if(ts.isExportDeclaration(stmt)){
   if(stmt.isTypeOnly||stmt.attributes||!stmt.exportClause||!ts.isNamedExports(stmt.exportClause))err(stmt,'E_MODULE_EXPORT','Use explicit named runtime exports');
   const scope=reexports.get(stmt)??env;
   for(const b of stmt.exportClause.elements){if(b.isTypeOnly)err(b,'E_MODULE_EXPORT','Type exports are outside this runtime contract');const name=(b.propertyName??b.name).text,value=scope.get(name);if(!value)err(b,'E_MODULE_EXPORT','No admitted binding '+name);put(b.name.text,value,b);}
  }
  active.delete(file);done.set(file,exports);return exports;
 }
 return {imports,mathSymbol,finish(){
  for(const m of graph.modules.values())if(m.id!==graph.entry&&m.id!==component&&!m.id.endsWith('.css')&&!done.has(m.id))throw new Diagnostic('E_COMPOSITION','Collected source is not covered by component imports',{file:path.relative(root,m.id),line:1,column:1});
 }};
}
