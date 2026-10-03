import ts from 'typescript';
import path from 'node:path';
import {Diagnostic,fail,location} from '../collect.mjs';
import {literal,evaluate,TAGS} from '../ir.mjs';
import {createExpressionLowerer,languageProgram,unwrap,globalMathReference,componentScriptFile} from '../language.mjs';
import {newIR,finishIR} from '../adapter.mjs';
import {loadRegistry} from '../mappings.mjs';
import {localModules} from '../modules.mjs';

// This adapter consumes original SFC syntax. Vue's generated runtime helpers do
// not become instructions in the shared IR or Rust renderer.
export async function lowerVue(graph,{registry=true,registryRoot}={}) {
  const {root,tooling}=graph,ir=newIR(graph,'vue');
  const accepted=registry?await loadRegistry(registryRoot):[];
  const entry=ts.createSourceFile(graph.entry,graph.modules.get(graph.entry).code,ts.ScriptTarget.Latest,true);
  const imports=new Map();let bootstrap;
  for(const stmt of entry.statements){
    if(ts.isImportDeclaration(stmt)){
      const edge=graph.modules.get(graph.entry).imports.find(e=>e.specifier===stmt.moduleSpecifier.text);
      if(!stmt.importClause){if(!edge.resolved.endsWith('.css'))fail(stmt,root,'E_IMPORT','Only local CSS side effects are supported');continue;}
      const clause=stmt.importClause;
      if(stmt.moduleSpecifier.text==='vue'&&clause.namedBindings&&ts.isNamedImports(clause.namedBindings)&&!clause.name){
        for(const b of clause.namedBindings.elements){if((b.propertyName??b.name).text!=='createApp')fail(b,root,'E_CAPABILITY','Vue entry only imports createApp');imports.set(b.name.text,{kind:'createApp'});}
      }else if(edge.resolved.endsWith('.vue')&&clause.name&&!clause.namedBindings)imports.set(clause.name.text,{kind:'component',file:edge.resolved});
      else fail(stmt,root,'E_IMPORT','Entry requires a local default SFC import and Vue createApp');
    }else if(ts.isExpressionStatement(stmt)&&!bootstrap)bootstrap=stmt.expression;
    else fail(stmt,root,'E_BOOTSTRAP','Vue entry may only import its component/CSS and mount once');
  }
  const mount=ts.isCallExpression(bootstrap??{})&&ts.isPropertyAccessExpression(bootstrap.expression)&&bootstrap.expression.name.text==='mount'&&bootstrap;
  const create=mount&&mount.expression.expression;
  if(!mount||mount.arguments.length!==1||!ts.isStringLiteral(mount.arguments[0])||mount.arguments[0].text!=='#root'||!ts.isCallExpression(create)||!ts.isIdentifier(create.expression)||imports.get(create.expression.text)?.kind!=='createApp'||create.arguments.length!==1||!ts.isIdentifier(create.arguments[0]))throw new Diagnostic('E_BOOTSTRAP','Expected createApp(App).mount("#root")');
  const component=imports.get(create.arguments[0].text);
  if(component?.kind!=='component')throw new Diagnostic('E_BOOTSTRAP','Mount target must be a resolved local SFC');
  const original=graph.modules.get(component.file).code,{descriptor,errors}=tooling.compiler.parse(original,{filename:component.file});
  if(errors.length)throw new Diagnostic('E_PARSE',String(errors[0]));
  if(!descriptor.scriptSetup||descriptor.script||!descriptor.template||descriptor.styles.length||descriptor.customBlocks.length||descriptor.scriptSetup.src||descriptor.template.src||descriptor.template.lang||!['js','ts',undefined].includes(descriptor.scriptSetup.lang)||descriptor.scriptSetup.attrs.generic)throw new Diagnostic('E_SFC','Use one plain template and script setup (js/ts), with external imported CSS');
  const file=componentScriptFile(graph,component.file),pad=offset=>original.slice(0,offset).replace(/[^\n]/g,' ');
  const code=pad(descriptor.scriptSetup.loc.start.offset)+descriptor.scriptSetup.content;
  const sources=[file,...[...graph.modules.keys()].filter(id=>id!==graph.entry&&id!==component.file&&!id.endsWith('.css'))];
  const originals=new Map([...graph.modules].map(([id,m])=>[id,m.code]));originals.set(file,code);
  const {program,checker}=languageProgram(sources,{},originals);
  const modules=localModules(graph,{program,checker,accepted,ir,component:component.file,scriptFile:file});
  const ast=program.getSourceFile(file),env=new Map();
  const loc=n=>{const s=location(n,root);if(s.file===path.relative(root,file))s.file=path.relative(root,component.file);return s;};
  const err=(n,c,m)=>{throw new Diagnostic(c,m,loc(n));};
  const stateExpr=slot=>({op:'state',slot,type:ir.states[slot].type,effect:'pure'});
  const refRead=(slot,scope)=>scope.get('$writes')?.get(slot)??stateExpr(slot);
  const binding=(n,scope)=>{
    const b=scope.get(n.text);
    if(b?.kind==='ref'&&scope.get('$template'))return {kind:'value',value:refRead(b.slot,scope)};
    if(b?.kind==='computed'&&scope.get('$template'))return {kind:'value',value:pure(b.body,scope)};
    return b;
  };
  const read=(n,scope)=>{
    if(ts.isPropertyAccessExpression(n)&&ts.isIdentifier(n.expression)){
      const b=scope.get(n.expression.text);
      if(n.name.text==='value'&&b?.kind==='ref')return refRead(b.slot,scope);
      if(n.name.text==='value'&&b?.kind==='computed')return pure(b.body,scope);
    }
    if(ts.isPropertyAccessExpression(n)&&n.name.text==='value'&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='target'&&ts.isIdentifier(n.expression.expression)&&scope.get(n.expression.expression.text)?.kind==='text-event')return {op:'payload',type:'string',effect:'pure',source:loc(n)};
  };
  const pure=createExpressionLowerer({root,checker,mathSymbol:modules.mathSymbol,binding,accepted,ir,err,read,sourceOf:loc,isMath:globalMathReference(ast,checker,modules.mathSymbol)});
  const syntax=program.getSyntacticDiagnostics(ast);if(syntax.length)err(ast,'E_PARSE',ts.flattenDiagnosticMessageText(syntax[0].messageText,'\n'));
  const plainFunction=(fn,params)=>{
    if(!fn.body||fn.asteriskToken||fn.type||fn.typeParameters||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||fn.parameters.length!==params||fn.parameters.some(p=>!ts.isIdentifier(p.name)||p.initializer||p.type||p.dotDotDotToken))err(fn,'E_FUNCTION','Expected a plain synchronous function with '+params+' parameters');
  };
  const fnLike=n=>ts.isFunctionDeclaration(n)||ts.isArrowFunction(n)||ts.isFunctionExpression(n);
  const add=(name,b,n)=>{if(env.has(name))err(n,'E_DECLARATION','Duplicate setup binding');env.set(name,b);};
  for(const stmt of ast.statements)if(ts.isImportDeclaration(stmt)&&stmt.moduleSpecifier.text!=='vue')for(const [name,b]of modules.imports(stmt,component.file))add(name,b,stmt);
  for(const stmt of ast.statements){
    if(ts.isImportDeclaration(stmt)){
      if(stmt.moduleSpecifier.text!=='vue')continue;
      const c=stmt.importClause;
      if(stmt.moduleSpecifier.text!=='vue'||!c||c.isTypeOnly||c.name||!c.namedBindings||!ts.isNamedImports(c.namedBindings))err(stmt,'E_IMPORT','Setup supports named Vue ref/computed imports only');
      for(const b of c.namedBindings.elements){const name=(b.propertyName??b.name).text;if(!['ref','computed'].includes(name)||b.isTypeOnly)err(b,'E_CAPABILITY','Unsupported Vue capability '+name);add(b.name.text,{kind:name+'-api'},b);}
    }else if(ts.isFunctionDeclaration(stmt)&&stmt.name){plainFunction(stmt,stmt.parameters.length);add(stmt.name.text,{kind:'handler',fn:stmt},stmt);}
    else if(ts.isVariableStatement(stmt)){
      if(!(stmt.declarationList.flags&ts.NodeFlags.Const))err(stmt,'E_MUTATION','Use const refs and const setup bindings');
      for(const d of stmt.declarationList.declarations){
        if(!ts.isIdentifier(d.name)||!d.initializer||d.type)err(d,'E_DECLARATION','Use plain initialized setup identifiers');
        const n=unwrap(d.initializer),api=ts.isCallExpression(n)&&ts.isIdentifier(n.expression)&&env.get(n.expression.text);
        if(api?.kind==='ref-api'){
          if(n.arguments.length!==1||n.typeArguments)err(n,'E_REF','ref requires one literal');
          const initial=pure(n.arguments[0],env);if(initial.op!=='literal')err(n,'E_REF','ref initializes a literal scalar');
          const slot=ir.states.length;ir.states.push({id:slot,name:d.name.text,type:initial.type,initial:initial.value,source:loc(d)});add(d.name.text,{kind:'ref',slot},d);
        }else if(api?.kind==='computed-api'){
          if(n.arguments.length!==1||n.typeArguments||!fnLike(n.arguments[0]))err(n,'E_COMPUTED','computed requires a pure zero-parameter getter');
          const fn=n.arguments[0];plainFunction(fn,0);let body=fn.body;
          if(ts.isBlock(body)){if(body.statements.length!==1||!ts.isReturnStatement(body.statements[0]))err(body,'E_COMPUTED','Getter contains one return');body=body.statements[0].expression;}
          pure(body,env);add(d.name.text,{kind:'computed',body},d);
        }else if(fnLike(n)){plainFunction(n,n.parameters.length);add(d.name.text,{kind:'handler',fn:n},d);}
        else {
          // Setup constants capture once, unlike React render constants.
          const value=pure(n,env);add(d.name.text,{kind:'value',value:literal(evaluate(value,ir.states.map(s=>s.initial)),loc(d))},d);
        }
      }
    }else err(stmt,'E_EFFECT','Unsupported setup statement; effects are not dropped');
  }
  const templateEnv=new Map(env);templateEnv.set('$template',true);
  const expression=exp=>{
    if(!exp?.content)throw new Diagnostic('E_TEMPLATE','Missing template expression');
    const sf=ts.createSourceFile(file,pad(exp.loc.start.offset)+exp.content,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
    if(sf.parseDiagnostics.length||sf.statements.length!==1||!ts.isExpressionStatement(sf.statements[0]))throw new Diagnostic('E_TEMPLATE','Template requires one supported expression');
    return unwrap(sf.statements[0].expression);
  };
  function handler(exp,kind){
    const n=expression(exp),b=ts.isIdentifier(n)&&env.get(n.text);
    if(b?.kind!=='handler')err(n,'E_HANDLER','Template events reference a setup function');
    plainFunction(b.fn,kind==='text-input'?1:0);
    const scope=new Map(env),writes=new Map();scope.set('$writes',writes);
    if(kind==='text-input')scope.set(b.fn.parameters[0].name.text,{kind:'text-event'});
    const statements=ts.isBlock(b.fn.body)?[...b.fn.body.statements]:[ts.factory.createExpressionStatement(b.fn.body)],updates=[];
    for(const stmt of statements){
      if(ts.isVariableStatement(stmt)&&(stmt.declarationList.flags&ts.NodeFlags.Const)){
        for(const d of stmt.declarationList.declarations){if(!ts.isIdentifier(d.name)||scope.has(d.name.text)||!d.initializer||d.type)err(d,'E_HANDLER','Handler captures require new plain const identifiers');scope.set(d.name.text,{kind:'value',value:pure(d.initializer,scope)});}continue;
      }
      const e=ts.isExpressionStatement(stmt)&&unwrap(stmt.expression);
      if(!e||!ts.isBinaryExpression(e)||e.operatorToken.kind!==ts.SyntaxKind.EqualsToken||!ts.isPropertyAccessExpression(e.left)||!ts.isIdentifier(e.left.expression)||e.left.name.text!=='value')err(stmt,'E_HANDLER','Handler supports const captures and ordered ref.value assignments');
      const target=scope.get(e.left.expression.text);if(target?.kind!=='ref')err(e.left,'E_HANDLER','Assignment target must resolve to a mutable ref');
      const value=pure(e.right,scope);updates.push({slot:target.slot,value,source:loc(stmt)});writes.set(target.slot,value);
    }
    if(!updates.length)err(b.fn,'E_HANDLER','Empty handlers are unsupported');
    const id=ir.handlers.length;ir.handlers.push({id,kind,updates,source:loc(b.fn)});return id;
  }
  let identity=0;
  const source=n=>({file:path.relative(root,component.file),line:n.loc.start.line,column:n.loc.start.column});
  function ui(n,conditional=false){
    if(n.type!==1||n.tagType!==0||!TAGS.includes(n.tag))throw new Diagnostic('E_UI','Vue supports native elements from the declared tag subset',source(n));
    const node={id:'u'+identity++,kind:'element',tag:n.tag,attrs:{},children:[],source:source(n)};let condition;
    for(const prop of n.props){
      if(prop.type===6){const name=prop.name;if(!['id','class','title','aria-label','type','disabled','readonly','maxlength'].includes(name))throw new Diagnostic('E_ATTRIBUTE','Unsupported attribute '+name,source(prop));node.attrs[name]=literal(['disabled','readonly'].includes(name)?true:name==='maxlength'?Number(prop.value?.content):prop.value?.content??'',source(prop));}
      else if(prop.type===7&&!prop.modifiers.length){
        if(prop.name==='if'){condition=pure(expression(prop.exp),templateEnv);continue;}
        const name=prop.arg?.isStatic&&prop.arg.content;
        if(prop.name==='bind'&&['value','class','title','aria-label','disabled','readonly'].includes(name))node.attrs[name]=pure(expression(prop.exp),templateEnv);
        else if(prop.name==='on'&&((name==='click'&&n.tag==='button')||(name==='input'&&n.tag==='input'))){if(node.event!==undefined)throw new Diagnostic('E_EVENT','One event per control',source(prop));node.event=handler(prop.exp,name==='input'?'text-input':'click');}
        else throw new Diagnostic('E_TEMPLATE','Unsupported directive '+prop.rawName,source(prop));
      }else throw new Diagnostic('E_TEMPLATE','Unsupported directive modifiers',source(prop));
    }
    if(n.tag==='input'){
      const value=node.attrs.value;if(conditional||condition||value?.op!=='state'||value.type!=='string'||node.event===undefined)throw new Diagnostic('E_TEXT_CONTROL','Input must be unconditional and bind one string ref',source(n));
      ir.states[value.slot].domain={kind:'text',maxUtf16:256};
    }
    let parts=[];const flush=()=>{if(parts.length){node.children.push({id:'u'+identity++,kind:'text',parts,source:source(n)});parts=[];}};
    for(const child of n.children){
      if(child.type===2){if(child.content)parts.push(literal(child.content,source(child)));}
      else if(child.type===5){const value=pure(expression(child.content),templateEnv);parts.push(value.type==='boolean'?{op:'boolean-text',arg:value,type:'string',effect:'pure',source:source(child)}:value);}
      else if(child.type===1){flush();node.children.push(ui(child,conditional||!!condition));}
      else if(child.type!==3)throw new Diagnostic('E_TEMPLATE','Unsupported template node',source(child));
    }flush();
    return condition?{id:'u'+identity++,kind:'conditional',test:condition,children:[node],source:source(n)}:node;
  }
  const roots=descriptor.template.ast.children.filter(n=>n.type!==3&&(n.type!==2||n.content.trim()));
  if(roots.length!==1)throw new Diagnostic('E_TEMPLATE','Template requires one root element');
  ir.ui=ui(roots[0]);
  modules.finish();
  const normalize=e=>{if(e?.source?.file===path.relative(root,file))e.source.file=path.relative(root,component.file);if(e&&typeof e==='object')Object.values(e).forEach(v=>{if(Array.isArray(v))v.forEach(normalize);else if(v&&typeof v==='object')normalize(v);});};normalize(ir);
  return finishIR(ir);
}
