<script lang="ts">
  // Svelte's proxies never write their target: $state(v) of a raw object
  // keeps writes in the proxy, so the raw object (a reset value, defaults)
  // stays as it was.
  type Todo = { text: string; done: boolean };
  const INITIAL: Todo[] = [
    { text: 'a', done: false },
    { text: 'b', done: false },
  ];
  const defaults = { name: 'Ada', tags: ['x'] };
  const inner = { n: 1 };

  let todos = $state(INITIAL);
  let form = $state(defaults);
  let outer = $state({ inner });
  let shown = $state('');

  function add() {
    todos.push({ text: 'c', done: false });
  }
  function toggle() {
    todos[0].done = !todos[0].done;
  }
  function reset() {
    todos = INITIAL;
  }
  function edit() {
    form.name = form.name + '!';
    form.tags.push('y');
  }
  function resetForm() {
    form = defaults;
  }
  function deep() {
    outer.inner.n += 1;
  }
  function show() {
    shown = `${INITIAL.length} ${INITIAL[0].done} ${defaults.name} ${defaults.tags.length} ${inner.n} ${outer.inner === inner}`;
  }
</script>

<main>
  <h1 id="title">Proxy targets</h1>
  <p id="todos">{todos.map((t) => t.text + (t.done ? '+' : '')).join(',')}</p>
  <p id="form">{form.name} {form.tags.join('')}</p>
  <p id="outer">{outer.inner.n}</p>
  <p id="shown">{shown}</p>
  <div class="controls">
    <button id="add" onclick={add}>Add</button>
    <button id="toggle" onclick={toggle}>Toggle</button>
    <button id="reset" onclick={reset}>Reset</button>
    <button id="edit" onclick={edit}>Edit</button>
    <button id="reset-form" onclick={resetForm}>Reset form</button>
    <button id="deep" onclick={deep}>Deep</button>
    <button id="show" onclick={show}>Show</button>
  </div>
</main>
