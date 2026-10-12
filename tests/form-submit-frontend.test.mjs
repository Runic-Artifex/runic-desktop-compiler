import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lowerReact } from '../frontend/adapters/react.ts';
import { lowerVue } from '../frontend/adapters/vue.ts';
import { lowerSvelte } from '../frontend/adapters/svelte.ts';

// Call adapters directly: these are frontend checks, with no backend build.
async function app(framework, source, run) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/form-submit-'));
  const extension = { react: 'tsx', vue: 'vue', svelte: 'svelte' }[framework];
  const entry = framework === 'react' ? 'main.jsx' : 'main.js';
  try {
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ framework, entry, title: 'T' }),
    );
    await writeFile(
      path.join(root, 'index.html'),
      `<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/${entry}"></script></body></html>`,
    );
    const bootstrap = {
      react: `import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './App.tsx';createRoot(document.getElementById('root')).render(<App/>);`,
      vue: `import {createApp} from 'vue';import App from './App.vue';createApp(App).mount('#root');`,
      svelte: `import {mount} from 'svelte';import App from './App.svelte';mount(App,{target:document.getElementById('root')});`,
    }[framework];
    await writeFile(path.join(root, entry), bootstrap);
    await writeFile(path.join(root, `App.${extension}`), source);
    const graph = await collect(root);
    return await run(graph, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const handlers = ir => ir.components.flatMap(component => component.handlers);
function builtins(value) {
  if (Array.isArray(value)) return value.flatMap(builtins);
  if (!value || typeof value !== 'object') return [];
  return [
    ...(value.op === 'builtin' ? [value.name] : []),
    ...Object.values(value).flatMap(builtins),
  ];
}
const lowering = { react: lowerReact, vue: lowerVue, svelte: lowerSvelte };

function element(ir, id) {
  const visit = value => {
    if (Array.isArray(value)) return value.flatMap(visit);
    if (!value || typeof value !== 'object') return [];
    return [
      ...(value.kind === 'element' &&
      value.attrs?.some(
        attr => attr.name === 'id' && attr.value.op === 'lit' && attr.value.value === id,
      )
        ? [value]
        : []),
      ...Object.values(value).flatMap(visit),
    ];
  };
  const matches = visit(ir.components);
  assert.equal(matches.length, 1, `Expected one element ${id}`);
  return matches[0];
}

test('Frontends preserve literal validation bypass flags and form ownership attributes', async () => {
  const sources = {
    react: `export function App(){return <main><form id="yes" noValidate={true}><button id="button" form="yes" formNoValidate={true}>Save</button></form><form id="no" noValidate={false}><button id="ordinary" formNoValidate={false}>Save</button></form></main>;}`,
    vue: `<script setup>const fixture=true;</script><template><main><form id="yes" :novalidate="true"><button id="button" form="yes" :formnovalidate="true">Save</button></form><form id="no" :novalidate="false"><button id="ordinary" :formnovalidate="false">Save</button></form></main></template>`,
    svelte: `<main><form id="yes" novalidate={true}><button id="button" form="yes" formnovalidate={true}>Save</button></form><form id="no" novalidate={false}><button id="ordinary" formnovalidate={false}>Save</button></form></main>`,
  };
  for (const [framework, source] of Object.entries(sources))
    await app(framework, source, async graph => {
      const { ir } = await lowering[framework](graph);
      for (const [id, name, flag] of [
        ['yes', 'novalidate', true],
        ['no', 'novalidate', false],
        ['button', 'formnovalidate', true],
        ['ordinary', 'formnovalidate', false],
      ])
        assert.deepEqual(element(ir, id).attrs.find(attr => attr.name === name)?.value, {
          op: 'lit',
          value: flag,
        });
      assert.deepEqual(element(ir, 'button').attrs.find(attr => attr.name === 'form')?.value, {
        op: 'lit',
        value: 'yes',
      });
    });
});

test('Dynamic form validation flags stay boolean through all frontend adapters', async () => {
  const sources = {
    react: `import {useState} from 'react';export function App(){const [bypass,setBypass]=useState(true);const [normal,setNormal]=useState(false);return <main><form id="yes" noValidate={bypass}><button id="button" formNoValidate={bypass}>Save</button></form><form id="no" noValidate={normal}><button id="ordinary" formNoValidate={normal}>Save</button></form><button onClick={()=>{setBypass(!bypass);setNormal(!normal);}}>Toggle</button></main>;}`,
    vue: `<script setup>import {ref} from 'vue';const bypass=ref(true);const normal=ref(false);</script><template><main><form id="yes" :novalidate="bypass"><button id="button" :formnovalidate="bypass">Save</button></form><form id="no" :novalidate="normal"><button id="ordinary" :formnovalidate="normal">Save</button></form><button @click="bypass=!bypass;normal=!normal">Toggle</button></main></template>`,
    svelte: `<script>let bypass=$state(true);let normal=$state(false);</script><main><form id="yes" novalidate={bypass}><button id="button" formnovalidate={bypass}>Save</button></form><form id="no" novalidate={normal}><button id="ordinary" formnovalidate={normal}>Save</button></form><button onclick={()=>{bypass=!bypass;normal=!normal;}}>Toggle</button></main>`,
  };
  for (const [framework, source] of Object.entries(sources))
    await app(framework, source, async graph => {
      const { ir } = await lowering[framework](graph);
      assert.equal(ir.components.length, 1);
      for (const [id, name, initial] of [
        ['yes', 'novalidate', true],
        ['no', 'novalidate', false],
        ['button', 'formnovalidate', true],
        ['ordinary', 'formnovalidate', false],
      ]) {
        const node = element(ir, id);
        const value = node.attrs.find(attr => attr.name === name)?.value;
        assert.equal(value?.op, 'cell', `${framework} ${name} must retain its boolean cell`);
        const owner = ir.components[0];
        assert.equal(owner.cells[value.cell].type, 'boolean');
        assert.deepEqual(owner.cells[value.cell].init, { op: 'lit', value: initial });
      }
    });
});

test('React still rejects unsupported canonical form props and nonflag booleans', async () => {
  for (const [prop, message] of [
    ['formAction="/submit"', /Unsupported prop formAction/],
    ['uncoveredFormProp="x"', /Unsupported prop uncoveredFormProp/],
    ['form={true}', /Boolean value for form/],
  ])
    await app(
      'react',
      `export function App(){return <form><button ${prop}>Save</button></form>;}`,
      async graph => {
        await assert.rejects(
          lowerReact(graph),
          error =>
            error instanceof Diagnostic &&
            error.code === 'E_JSX' &&
            error.source?.file === 'App.tsx' &&
            message.test(error.message),
        );
      },
    );
});

test('React onSubmit allows synchronous FormEvent currentTarget and stays discrete in schema 5', async () => {
  await app(
    'react',
    `import {useState} from 'react';import type {FormEvent} from 'react';
export function App(){const [log,setLog]=useState('');function submitted(e:FormEvent){e.preventDefault();e.stopPropagation();setLog(e.type+String(e.defaultPrevented)+String(e.currentTarget===e.target));}return <form id="form" onSubmit={submitted}><button>Save</button><p>{log}</p></form>;}`,
    async graph => {
      const { ir } = await lowerReact(graph);
      assert.equal(ir.schema, 5);
      assert.equal(handlers(ir).filter(handler => handler.event === 'submit').length, 1);
      assert.ok(!(ir.schedule.continuous ?? []).includes('submit'));
      assert.ok(builtins(ir).includes('event.preventDefault'));
      assert.ok(builtins(ir).includes('event.stopPropagation'));
      assert.ok(builtins(ir).includes('event.currentTarget'));
    },
  );
});

test('Vue and Svelte route typed SubmitEvent through generic listeners', async () => {
  const sources = {
    vue: `<script setup lang="ts">import {ref} from 'vue';const log=ref('');function submitted(e:SubmitEvent){log.value=String(e instanceof SubmitEvent)+e.type;}</script><template><form @submit.prevent.stop="submitted($event)"><button>Save</button><p>{{log}}</p></form></template>`,
    svelte: `<script lang="ts">let log=$state('');function submitted(e:SubmitEvent){e.preventDefault();e.stopPropagation();log=String(e instanceof SubmitEvent)+String(e instanceof Event)+e.type;}</script><form onsubmit={submitted}><button>Save</button><p>{log}</p></form>`,
  };
  for (const [framework, source] of Object.entries(sources))
    await app(framework, source, async graph => {
      const { ir } = await lowering[framework](graph);
      assert.equal(ir.schema, 5);
      assert.equal(handlers(ir).filter(handler => handler.event === 'submit').length, 1);
      assert.ok(builtins(ir).includes('event.preventDefault'));
      assert.ok(builtins(ir).includes('event.stopPropagation'));
      assert.match(JSON.stringify(ir), /SubmitEvent/);
    });
});

test('React submit preserves synthetic event and currentTarget diagnostics', async () => {
  for (const [handler, message] of [
    ['e => (e as unknown as Event).stopImmediatePropagation()', /stopImmediatePropagation/],
    ['e => queueMicrotask(() => setLog(String(e.currentTarget === null)))', /currentTarget/],
    ['e => setLog(String(e.nativeEvent))', /Event objects support/],
  ])
    await app(
      'react',
      `import {useState} from 'react';export function App(){const [log,setLog]=useState('');return <form onSubmit={${handler}}><button>Save</button><p>{log}</p></form>;}`,
      async graph => {
        await assert.rejects(lowerReact(graph), error => {
          assert.ok(error instanceof Diagnostic);
          assert.match(error.message, message);
          assert.equal(error.source.file, 'App.tsx');
          assert.ok(error.source.line > 0 && error.source.column > 0);
          return true;
        });
      },
    );
});

test('SubmitEvent submitter, constructor and requestSubmit arguments stay rejected', async () => {
  for (const [statement, message] of [
    ['const value=e.submitter;', /Event objects support/],
    ["const value=new SubmitEvent('submit');", /SubmitEvent|construct/],
    ['e.target.requestSubmit(e.target);', /requestSubmit|arguments|submitter/],
  ])
    await app(
      'vue',
      `<script setup lang="ts">function submitted(e:SubmitEvent){${statement}}</script><template><form @submit="submitted"><button>Save</button></form></template>`,
      async graph => {
        await assert.rejects(
          lowerVue(graph),
          error => error instanceof Diagnostic && message.test(error.message),
        );
      },
    );
});

test('React rejects DOM instanceof in direct and forwarded synthetic listeners', async () => {
  const sources = [
    `import {useState} from 'react';export function App(){const [log,setLog]=useState('');return <form onSubmit={e=>setLog(String(e instanceof SubmitEvent))}><button>Save</button><p>{log}</p></form>;}`,
    `import {useState} from 'react';export function App(){const [log,setLog]=useState('');return <form onSubmit={e=>setLog(String(e instanceof Event))}><button>Save</button><p>{log}</p></form>;}`,
    `import {useState} from 'react';import type {FormEvent} from 'react';function Form({onSubmit}:{onSubmit:(e:FormEvent)=>void}){return <form onSubmit={e=>onSubmit(e)}><button>Save</button></form>;}export function App(){const [log,setLog]=useState('');return <main><Form onSubmit={e=>setLog(String(e instanceof SubmitEvent))}/><p>{log}</p></main>;}`,
    `import {useState} from 'react';import type {HTMLAttributes} from 'react';function Form({...rest}:HTMLAttributes){return <form {...rest}><button>Save</button></form>;}export function App(){const [log,setLog]=useState('');return <main><Form onSubmit={e=>setLog(String(e instanceof SubmitEvent))}/><p>{log}</p></main>;}`,
  ];
  for (const source of sources)
    await app('react', source, async graph => {
      await assert.rejects(lowerReact(graph), error => {
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, 'E_EVENT');
        assert.match(error.message, /synthetic events.*DOM event interfaces/);
        assert.equal(error.source.file, 'App.tsx');
        assert.ok(error.source.line > 0 && error.source.column > 0);
        assert.match(source.slice(error.source.column - 1), /^e instanceof/);
        return true;
      });
    });
});

test('React membership tests and independent native listeners remain admitted without marks', async () => {
  await app(
    'react',
    `import {useEffect,useState} from 'react';export function App(){const [log,setLog]=useState('');useEffect(()=>{function native(e:SubmitEvent){setLog(String(e instanceof SubmitEvent));}document.addEventListener('submit',native);return ()=>document.removeEventListener('submit',native);},[]);return <form onSubmit={e=>setLog(String('type' in e))}><button>Save</button><p>{log}</p></form>;}`,
    async graph => {
      const { ir } = await lowerReact(graph);
      assert.ok(builtins(ir).includes('event.instance-of'));
      assert.doesNotMatch(JSON.stringify(ir), /\$reactEventInstanceOf/);
    },
  );
});

test('React rejects mixed native element submit and onSubmit at the registration call', async () => {
  const source = `import {useEffect,useRef} from 'react';
export function App(){
  const form=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const node=form.current;
    if(!node)return;
    function native(e:SubmitEvent){e.preventDefault();e.stopPropagation();}
    node.addEventListener('submit',native);
    return ()=>node.removeEventListener('submit',native);
  },[]);
  return <form ref={form} noValidate onSubmit={e=>e.preventDefault()}><button>Save</button></form>;
}`;
  await app('react', source, graph =>
    assert.rejects(lowerReact(graph), error => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, 'E_EVENT');
      assert.match(error.message, /React delegates onSubmit.*after native element listeners/);
      assert.deepEqual(error.source, { file: 'App.tsx', line: 8, column: 5 });
      return true;
    }),
  );
});

test('React mixed submit detection includes optional ref calls and helper registrations', async () => {
  for (const [helper, registration, line, column] of [
    ['', "    form.current?.addEventListener('submit',native);", 7, 5],
    [
      "function install(node:HTMLElement,listener:(e:SubmitEvent)=>void){\n  node.addEventListener('submit',listener);\n}\n",
      '    const node=form.current; if(node)install(node,native);',
      3,
      3,
    ],
  ]) {
    const source = `import {useEffect,useRef} from 'react';
${helper}export function App(){
  const form=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    function native(e:SubmitEvent){e.preventDefault();e.stopPropagation();}

${registration}
  },[]);
  return <form ref={form} noValidate onSubmit={e=>e.preventDefault()}><button>Save</button></form>;
}`;
    await app('react', source, graph =>
      assert.rejects(lowerReact(graph), error => {
        assert.ok(error instanceof Diagnostic);
        assert.equal(error.code, 'E_EVENT');
        assert.match(error.message, /Native element submit listeners together with onSubmit/);
        assert.deepEqual(error.source, { file: 'App.tsx', line, column });
        return true;
      }),
    );
  }
});

test('React mixed native submit rejection includes synthetic handlers passed in rest props', async () => {
  const source = `import {useEffect} from 'react';
import type {HTMLAttributes} from 'react';
function Form({...rest}:HTMLAttributes){return <form {...rest}><button>Save</button></form>;}
export function App(){
  useEffect(()=>{
    const node=document.getElementById('form');
    if(!node)return;
    function native(e:SubmitEvent){e.preventDefault();e.stopPropagation();}
    node.addEventListener('submit',native);
    return ()=>node.removeEventListener('submit',native);
  },[]);
  return <Form id="form" onSubmit={e=>e.preventDefault()}/>;
}`;
  await app('react', source, graph =>
    assert.rejects(lowerReact(graph), error => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, 'E_EVENT');
      assert.match(error.message, /Native element submit listeners together with onSubmit/);
      assert.deepEqual(error.source, { file: 'App.tsx', line: 9, column: 5 });
      return true;
    }),
  );
});

test('React native element submit listeners remain admitted without synthetic submit handlers', async () => {
  await app(
    'react',
    `import {useEffect,useRef} from 'react';
export function App(){
  const form=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    const node=form.current;
    if(!node)return;
    function native(e:SubmitEvent){e.preventDefault();e.stopPropagation();}
    node.addEventListener('submit',native);
    return ()=>node.removeEventListener('submit',native);
  },[]);
  return <form ref={form} noValidate><button>Save</button></form>;
}`,
    async graph => {
      const { ir } = await lowerReact(graph);
      assert.equal(handlers(ir).filter(handler => handler.event === 'submit').length, 0);
      assert.ok(builtins(ir).includes('element.listen'));
      assert.ok(builtins(ir).includes('element.unlisten'));
      assert.ok(builtins(ir).includes('event.stopPropagation'));
    },
  );
});

test('React window and document submit listeners stay admitted alongside onSubmit', async () => {
  for (const host of ['window', 'document'])
    await app(
      'react',
      `import {useEffect} from 'react';
export function App(){
  useEffect(()=>{
    function native(e:SubmitEvent){e.preventDefault();}
    ${host}.addEventListener('submit',native);
    return ()=>${host}.removeEventListener('submit',native);
  },[]);
  return <form noValidate onSubmit={e=>e.preventDefault()}><button>Save</button></form>;
}`,
      async graph => {
        const { ir } = await lowerReact(graph);
        assert.equal(handlers(ir).filter(handler => handler.event === 'submit').length, 1);
        assert.ok(builtins(ir).includes(`${host}.listen`));
        assert.ok(builtins(ir).includes(`${host}.unlisten`));
      },
    );
});

test('React removal-only element submit calls do not trigger mixed listener rejection', async () => {
  await app(
    'react',
    `import {useEffect,useRef} from 'react';
export function App(){
  const form=useRef<HTMLElement|null>(null);
  useEffect(()=>{
    function native(e:SubmitEvent){e.preventDefault();}
    form.current?.removeEventListener('submit',native);
  },[]);
  return <form ref={form} noValidate onSubmit={e=>e.preventDefault()}><button>Save</button></form>;
}`,
    async graph => {
      const { ir } = await lowerReact(graph);
      assert.equal(handlers(ir).filter(handler => handler.event === 'submit').length, 1);
      assert.ok(builtins(ir).includes('element.unlisten'));
      assert.ok(!builtins(ir).includes('element.listen'));
    },
  );
});
