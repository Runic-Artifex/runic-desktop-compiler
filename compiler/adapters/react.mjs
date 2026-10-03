import ts from 'typescript';
import path from 'node:path';
import { fail, location, Diagnostic, hash } from '../collect.mjs';
import { literal } from '../ir.mjs';
import { loadRegistry } from '../mappings.mjs';
import {createExpressionLowerer,languageProgram} from '../language.mjs';
import {newIR,finishIR} from '../adapter.mjs';
import { decodeHTMLStrict } from 'entities';

const tags = new Set(['input','main','article','section','div','span','p','h1','h2','button','strong','small','header','footer']);
const attributes = new Set(['value','maxLength','readOnly','id','className','disabled','title','aria-label','type']);
const unwrap = n => ts.isParenthesizedExpression(n) ? unwrap(n.expression) : n;
const jsx = n => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n);
const fnLike = n => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const cleanText = text => {
  const lines=text.replace(/\r/g,'').split('\n');
  const parts=lines.map((s,i)=>{s=s.replace(/\t/g,' ');if(i>0)s=s.replace(/^ +/,'');if(i<lines.length-1)s=s.replace(/ +$/,'');return s;});
  return decodeHTMLStrict(parts.filter(Boolean).join(' '));
};

export async function lowerReact(graph, { registry = true, registryRoot } = {}) {
  const accepted = registry ? await loadRegistry(registryRoot) : [];
  const {root}=graph;
  const {checker,program}=languageProgram([...graph.modules.keys()].filter(p=>!p.endsWith('.css')),{jsx:ts.JsxEmit.React},new Map([...graph.modules].map(([id,m])=>[id,m.code])));
  const syntax=program.getSyntacticDiagnostics().filter(d=>d.file?.fileName.startsWith(root));
  if(syntax.length){const d=syntax[0];fail(d.file,root,'E_PARSE',ts.flattenDiagnosticMessageText(d.messageText,'\n'));}
  const symbols=new Map(), globalEnv=new Map(), functions=new Map();
  const ir=newIR(graph,'react');
  let identity=0;
  const err=(n,c,m)=>fail(n,root,c,m);
  const symbol=n=>checker.getSymbolAtLocation(n);
  const ordered=[],seen=new Set(),active=new Set();
  const order=id=>{if(seen.has(id))return;if(active.has(id))throw new Diagnostic('E_MODULE_CYCLE','Cyclic module initialization is outside the contract');active.add(id);for(const edge of graph.modules.get(id).imports)if(graph.modules.has(edge.resolved)&&!edge.resolved.endsWith('.css'))order(edge.resolved);active.delete(id);seen.add(id);ordered.push(id);};
  order(graph.entry);
  const sources=ordered.map(p=>program.getSourceFile(p));
  const standardMath=program.getSourceFiles().filter(f=>program.isSourceFileDefaultLibrary(f)).flatMap(f=>[...f.statements]).find(n=>ts.isVariableStatement(n) && n.declarationList.declarations.some(d=>d.name.getText()==='Math'));
  const mathSymbol=standardMath && symbol(standardMath.declarationList.declarations.find(d=>d.name.getText()==='Math').name);
  function resolve(n) { const s=symbol(n);return symbols.get(s) ?? globalEnv.get(s) ?? (functions.has(s) ? {kind:'function',fn:functions.get(s),env:globalEnv} : undefined); }
  for(const file of sources) {
    for(const stmt of file.statements) {
      if(ts.isImportDeclaration(stmt)) {
        const edge=graph.modules.get(file.fileName).imports.find(i=>i.specifier===stmt.moduleSpecifier.text);
        const external=!edge.resolved.startsWith(root+path.sep);
        const spec=stmt.moduleSpecifier.text;
        if(!stmt.importClause) { if(!spec.endsWith('.css') || external) err(stmt,'E_IMPORT','Only local CSS side-effect imports are supported');continue; }
        if(external && !['react','react-dom/client'].includes(spec)) err(stmt,'E_DEPENDENCY',`No adapter for dependency ${spec}; source behavior must be covered`);
        const bindings=[];
        if(stmt.importClause.name) bindings.push([stmt.importClause.name,'default']);
        const named=stmt.importClause.namedBindings;
        if(named && !ts.isNamedImports(named)) err(named,'E_IMPORT','Namespace imports are unsupported');
        if(named) for(const e of named.elements) bindings.push([e.name,(e.propertyName??e.name).text]);
        for(const [name,exp] of bindings) {
          if(external) {
            if((spec==='react' && !['default','useState'].includes(exp)) || (spec==='react-dom/client' && exp!=='createRoot')) err(name,'E_CAPABILITY',`Missing capability for ${spec}:${exp}`);
            const expected=path.resolve('node_modules',spec.split('/')[0])+path.sep;
            if(!edge.resolved.startsWith(expected)) err(name,'E_DEPENDENCY','Resolved framework must be the pinned root package');
            symbols.set(symbol(name),{kind:'external',package:spec,export:exp});
          } else {
            const target=checker.getAliasedSymbol(symbol(name));
            if(!target?.declarations?.length) err(name,'E_IMPORT',`Cannot resolve local exported symbol ${exp}`);
            symbols.set(symbol(name),{kind:'alias',target});
          }
        }
      } else if(ts.isExportDeclaration(stmt)) {
        if(stmt.isTypeOnly||stmt.attributes||!stmt.exportClause||!ts.isNamedExports(stmt.exportClause)||stmt.exportClause.elements.some(e=>e.isTypeOnly))err(stmt,'E_MODULE_EXPORT','Use explicit named runtime exports');
        if(stmt.moduleSpecifier){const edge=graph.modules.get(file.fileName).imports.find(e=>e.specifier===stmt.moduleSpecifier.text);if(!edge?.resolved.startsWith(root+path.sep)||!graph.modules.has(edge.resolved))err(stmt,'E_DEPENDENCY','Re-exports must resolve inside the collected application');}
      } else if(ts.isFunctionDeclaration(stmt) && stmt.name) functions.set(symbol(stmt.name),stmt);
      else if(ts.isVariableStatement(stmt)) { for(const d of stmt.declarationList.declarations) if(ts.isIdentifier(d.name)&&d.initializer&&fnLike(unwrap(d.initializer))) functions.set(symbol(d.name),unwrap(d.initializer)); }
      else if(!ts.isVariableStatement(stmt) && !ts.isExpressionStatement(stmt) && !ts.isEmptyStatement(stmt)) err(stmt,'E_MODULE',`Unsupported module statement ${ts.SyntaxKind[stmt.kind]}`);
    }
  }
  function binding(n,env) {
    const s=symbol(n); let b=env.get(s)??resolve(n);
    if(b?.kind==='alias') b=globalEnv.get(b.target)??(functions.has(b.target)?{kind:'function',fn:functions.get(b.target),env:globalEnv}:undefined);
    return b;
  }
  function readEventValue(n,env) {
    if(ts.isPropertyAccessExpression(n)&&n.name.text==='value'&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='target'&&ts.isIdentifier(n.expression.expression)&&binding(n.expression.expression,env)?.kind==='text-event')return {op:'payload',type:'string',effect:'pure',source:location(n,root)};
  }
  const pure=createExpressionLowerer({root,checker,mathSymbol,binding,accepted,ir,err,read:readEventValue});
  function functionContract(fn,params) {
    if(!fn.body)err(fn,'E_FUNCTION','Functions require an implemented body');
    if(fn.asteriskToken||fn.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword)||fn.type||fn.typeParameters)err(fn,'E_FUNCTION','Async, generators and typed signatures are unsupported');
    if(fn.parameters.length!==params||fn.parameters.some(p=>p.initializer||p.dotDotDotToken||p.type||p.questionToken))err(fn,'E_PARAMETERS',`Expected ${params} plain parameter(s)`);
  }
  function updater(fn,env,type) {
    functionContract(fn,1);
    if(!ts.isIdentifier(fn.parameters[0].name))err(fn,'E_UPDATER','Updater parameter must be an identifier');
    const scoped=new Map(env);scoped.set(symbol(fn.parameters[0].name),{kind:'value',value:{op:'previous',type,effect:'pure',source:location(fn,root)}});
    let body=fn.body;
    if(ts.isBlock(body)){if(body.statements.length!==1||!ts.isReturnStatement(body.statements[0]))err(body,'E_UPDATER','Updater must contain one pure return');body=body.statements[0].expression;}
    return pure(body,scoped);
  }
  function eventHandler(b,node,kind='click') {
    if(b?.kind!=='function')err(node,'E_HANDLER','Click handler must be an inline or resolved local function');
    functionContract(b.fn,kind==='text-input'?1:0);
    const handlerEnv=new Map(b.env);
    if(kind==='text-input'){const param=b.fn.parameters[0].name;if(!ts.isIdentifier(param))err(param,'E_PARAMETERS','Text event parameter must be an identifier');handlerEnv.set(symbol(param),{kind:'text-event'});}
    const statements=ts.isBlock(b.fn.body)?[...b.fn.body.statements]:[ts.factory.createExpressionStatement(b.fn.body)];
    const updates=[];
    for(const s of statements) {
      const n=ts.isExpressionStatement(s)?unwrap(s.expression):null;
      if(!n||!ts.isCallExpression(n)||!ts.isIdentifier(n.expression)||n.arguments.length!==1)err(b.fn,'E_HANDLER','Handlers contain only ordered state-setter calls');
      const setter=binding(n.expression,handlerEnv);
      if(setter?.kind!=='setter')err(n,'E_HANDLER','Only a resolved useState setter may be called in a handler');
      const arg=unwrap(n.arguments[0]);
      const value=fnLike(arg)?updater(arg,handlerEnv,ir.states[setter.slot].type):pure(arg,handlerEnv);
      updates.push({slot:setter.slot,value,source:location(n,root)});
    }
    if(!updates.length)err(b.fn,'E_HANDLER','Empty handlers are unsupported');
    const event=ir.handlers.length;ir.handlers.push({id:event,kind,updates,source:location(b.fn,root)});return event;
  }
  const stack=[];
  function component(fn,props,conditional=false) {
    if(stack.includes(fn))err(fn,'E_COMPOSITION','Recursive composition is unsupported');
    stack.push(fn);
    functionContract(fn,props.size?1:fn.parameters.length);
    if(fn.parameters.length>1)err(fn,'E_COMPONENT','Components accept zero parameters or one destructured props object');
    const env=new Map(globalEnv);
    if(fn.parameters.length) {
      const pat=fn.parameters[0].name;
      if(!ts.isObjectBindingPattern(pat))err(pat,'E_PROPS','Use an explicit destructured props object');
      for(const e of pat.elements) {if(!ts.isIdentifier(e.name)||e.initializer||e.dotDotDotToken)err(e,'E_PROPS','Defaults/rest props are unsupported');const key=(e.propertyName??e.name).text;if(!props.has(key))err(e,'E_PROPS',`Missing prop ${key}`);env.set(symbol(e.name),props.get(key));}
      if(props.size!==pat.elements.length)err(pat,'E_PROPS','Every passed prop must be explicitly consumed');
    } else if(props.size)err(fn,'E_PROPS','Component does not accept props');
    if(!ts.isBlock(fn.body)){const result=ui(unwrap(fn.body),env,conditional);stack.pop();return result;}
    let returned;
    for(const s of fn.body.statements) {
      if(returned)err(s,'E_COMPONENT','Statements after return are unsupported');
      if(ts.isVariableStatement(s)) {
        if(!(s.declarationList.flags&ts.NodeFlags.Const))err(s,'E_MUTATION','Only const render declarations are supported');
        for(const d of s.declarationList.declarations) {
          if(!d.initializer||d.type)err(d,'E_DECLARATION','Declaration needs an untyped initializer');
          const n=unwrap(d.initializer),callee=ts.isCallExpression(n)&&ts.isIdentifier(n.expression)?binding(n.expression,env):null;
          if(callee?.kind==='external'&&callee.package==='react'&&callee.export==='useState') {
            if(conditional)err(d,'E_CONDITIONAL_STATE','Conditional component mount/unmount is restricted to stateless components');
            if(!ts.isArrayBindingPattern(d.name)||d.name.elements.length!==2||!d.name.elements.every(e=>ts.isBindingElement(e)&&ts.isIdentifier(e.name)&&!e.initializer&&!e.dotDotDotToken)||n.arguments.length!==1||n.typeArguments)err(d,'E_HOOK','useState requires [value, setter] and one plain literal initializer');
            const initial=pure(n.arguments[0],env);
            if(initial.op!=='literal'||!['number','boolean','string'].includes(initial.type))err(n,'E_HOOK','Initial state must be a numeric/boolean/string literal');
            const slot=ir.states.length;
            ir.states.push({id:slot,name:d.name.elements[0].name.text,type:initial.type,initial:initial.value,source:location(d,root)});
            env.set(symbol(d.name.elements[0].name),{kind:'value',value:{op:'state',slot,type:initial.type,effect:'pure',source:location(d,root)}});
            env.set(symbol(d.name.elements[1].name),{kind:'setter',slot});
          } else {
            if(!ts.isIdentifier(d.name))err(d,'E_DECLARATION','Destructuring is only supported for hooks and props');
            env.set(symbol(d.name),fnLike(n)?{kind:'function',fn:n,env}:{kind:'value',value:pure(n,env)});
          }
        }
      } else if(ts.isFunctionDeclaration(s)&&s.name)env.set(symbol(s.name),{kind:'function',fn:s,env});
      else if(ts.isReturnStatement(s)&&s.expression)returned=ui(unwrap(s.expression),env,conditional);
      else err(s,'E_COMPONENT',`Unsupported render statement ${ts.SyntaxKind[s.kind]}; effects and scheduling are unavailable`);
    }
    stack.pop();if(!returned)err(fn,'E_COMPONENT','Component must return one UI tree');return returned;
  }
  function ui(n,env,conditional=false) {
    const source=location(n,root);
    if(!jsx(n))err(n,'E_UI','Expected a static JSX element');
    const opening=ts.isJsxElement(n)?n.openingElement:n;
    if(!ts.isIdentifier(opening.tagName))err(opening,'E_UI','Member component names are unsupported');
    const tag=opening.tagName.text;
    const values=new Map();
    for(const a of opening.attributes.properties) {
      if(!ts.isJsxAttribute(a))err(a,'E_PROPS','Spread attributes are unsupported');
      const key=a.name.text;
      if(values.has(key))err(a,'E_PROPS','Duplicate attributes are unsupported');
      let b;
      if(!a.initializer)b={kind:'value',value:literal(true,location(a,root))};
      else if(ts.isStringLiteral(a.initializer))b={kind:'value',value:literal(decodeHTMLStrict(a.initializer.text),location(a,root))};
      else if(ts.isJsxExpression(a.initializer)&&a.initializer.expression) {
        const e=unwrap(a.initializer.expression);
        b=fnLike(e)?{kind:'function',fn:e,env}:ts.isIdentifier(e)?binding(e,env):null;
        if(!b || b.kind==='value') b={kind:'value',value:pure(e,env)};
      } else err(a,'E_ATTRIBUTE','Unsupported attribute value');
      values.set(key,b);
    }
    if(tag==='select'||tag==='option')err(opening,'E_CONTROL_UNSUPPORTED','The pinned Blitz backend does not render/select static options; use supported button choices. No change-event adapter is available');
    if(!tags.has(tag)) {
      if(!/^[A-Z]/.test(tag))err(opening,'E_UI','Unsupported HTML tag '+tag+'; component identifiers must follow JSX uppercase semantics');
      const b=binding(opening.tagName,env);
      if(b?.kind!=='function')err(opening,'E_COMPONENT',`Unsupported element or unresolved component ${tag}`);
      if(ts.isJsxElement(n)&&n.children.some(c=>!ts.isJsxText(c)||cleanText(c.text)))err(n,'E_PROPS','Component children props are unsupported');
      return component(b.fn,values,conditional);
    }
    const node={id:`u${identity++}`,kind:'element',tag,attrs:{},children:[],source};
    for(const [key,b] of values) {
      if(key==='onChange') {if(tag!=='input')err(opening,'E_EVENT','Change handlers require a controlled text input');node.event=eventHandler(b,opening,'text-input');continue;}
      if(key==='onClick') {if(tag!=='button')err(opening,'E_EVENT','Click handlers are restricted to buttons');node.event=eventHandler(b,opening);continue;}
      if(!attributes.has(key)||b.kind!=='value')err(opening,'E_ATTRIBUTE',`Unsupported attribute ${key}`);
      const type=['disabled','readOnly'].includes(key)?'boolean':key==='maxLength'?'number':'string';
      if(b.value.type!==type)err(opening,'E_ATTRIBUTE',`${key} requires ${type}`);
      if(key==='type'&&b.value.value!==(tag==='input'?'text':'button'))err(opening,'E_ATTRIBUTE','Only button type is accepted');
      if(key==='id'&&(b.value.op!=='literal'||!/^[-a-zA-Z0-9_]+$/.test(b.value.value)))err(opening,'E_ATTRIBUTE','IDs must be static simple strings');
      node.attrs[({className:'class',readOnly:'readonly',maxLength:'maxlength'})[key]??key]=b.value;
    }
    if(tag==='input'){
      const value=node.attrs.value;if(value?.op!=='state'||value.type!=='string'||node.event===undefined||node.attrs.type?.value!=='text'||node.attrs.maxlength?.value!==256)err(opening,'E_TEXT_CONTROL','Input requires type=text, maxLength=256, a direct string state value and onChange');
      ir.states[value.slot].domain={kind:'text',maxUtf16:256};
      const handler=ir.handlers[node.event];if(handler.updates.length!==1||handler.updates[0].slot!==value.slot||handler.updates[0].value.op!=='payload')err(opening,'E_TEXT_CONTROL','Text input must directly assign event.target.value to its bound state');
      if(ts.isJsxElement(n)&&n.children.length)err(n,'E_TEXT_CONTROL','Input cannot have children');
    }
    let text=[];
    const flush=()=>{if(text.length){node.children.push({id:`u${identity++}`,kind:'text',parts:text,source});text=[];}};
    const children=ts.isJsxElement(n)?n.children:[];
    for(const child of children) {
      if(ts.isJsxText(child)){const value=cleanText(child.text);if(value)text.push(literal(value,location(child,root)));}
      else if(jsx(child)){flush();node.children.push(ui(child,env,conditional));}
      else if(ts.isJsxExpression(child)) {
        if(!child.expression)continue;
        const e=unwrap(child.expression);
        if(ts.isBinaryExpression(e)&&e.operatorToken.kind===ts.SyntaxKind.AmpersandAmpersandToken&&jsx(unwrap(e.right))) {
          flush();const test=pure(e.left,env);if(test.type!=='boolean')err(e,'E_CONDITIONAL','UI condition must be boolean');
          node.children.push({id:`u${identity++}`,kind:'conditional',test,children:[ui(unwrap(e.right),env,true)],source:location(e,root)});
        } else if(jsx(e)){flush();node.children.push(ui(e,env,conditional));}
        else text.push(pure(e,env));
      } else err(child,'E_UI','Unsupported JSX child');
    }
    flush();
    const descendants=n=>(n.children??[]).flatMap(c=>[c,...descendants(c)]);
    if(['p','h1','h2','button','span','strong','small'].includes(tag)&&descendants(node).some(c=>c.kind==='element'&&!['span','strong','small'].includes(c.tag)))err(n,'E_CONTENT_MODEL','Phrasing elements may only contain text and inline stateless elements');
    return node;
  }
  // Validate module evaluation, including unused declarations (no dropped effects).
  const bootstrap=[];
  for(const file of sources) for(const stmt of file.statements) {
    if(ts.isVariableStatement(stmt)) {
      if(!(stmt.declarationList.flags&ts.NodeFlags.Const))err(stmt,'E_MODULE','Mutable module state is unsupported');
      for(const d of stmt.declarationList.declarations){if(!ts.isIdentifier(d.name)||!d.initializer||d.type)err(d,'E_MODULE','Only plain module constants are supported');globalEnv.set(symbol(d.name),fnLike(unwrap(d.initializer))?{kind:'function',fn:unwrap(d.initializer),env:globalEnv}:{kind:'value',value:pure(d.initializer,globalEnv)});}
    } else if(ts.isExpressionStatement(stmt)) {
      if(file.fileName!==graph.entry)err(stmt,'E_EFFECT','Top-level side effects are unsupported');
      bootstrap.push(stmt);
    }
  }
  if(bootstrap.length!==1)throw new Diagnostic('E_BOOTSTRAP','Entry must contain exactly one createRoot(...).render(<App />)');
  const n=bootstrap[0].expression;
  const renderCall=ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='render';
  const create=renderCall&&n.expression.expression;
  const createBinding=create&&ts.isCallExpression(create)&&ts.isIdentifier(create.expression)&&binding(create.expression,globalEnv);
  const target=create?.arguments?.[0];
  if(!renderCall||n.arguments.length!==1||!jsx(n.arguments[0])||createBinding?.kind!=='external'||createBinding.package!=='react-dom/client'||createBinding.export!=='createRoot'||create.arguments.length!==1||!ts.isCallExpression(target)||!ts.isPropertyAccessExpression(target.expression)||target.expression.getText()!=='document.getElementById'||target.arguments.length!==1||!ts.isStringLiteral(target.arguments[0])||target.arguments[0].text!=='root')err(n,'E_BOOTSTRAP','Expected pinned createRoot(document.getElementById("root")).render(<App />)');
  const documentSymbol=symbol(target.expression.expression);
  if(!documentSymbol?.declarations?.every(d=>program.isSourceFileDefaultLibrary(d.getSourceFile())))err(target,'E_BOOTSTRAP','document must resolve to the DOM global');
  ir.ui=ui(n.arguments[0],globalEnv);
  const elementIds=new Set();
  const checkIds=node=>{const id=node.attrs?.id?.value;if(id){if(elementIds.has(id))throw new Diagnostic('E_UI_ID','Duplicate element ID',node.source);elementIds.add(id);}(node.children??[]).forEach(checkIds);};checkIds(ir.ui);
  return finishIR(ir);
}
