<script lang="ts">
  import TodoItem from './TodoItem.svelte';
  import { visible, plural, type Todo, type Filter } from './todos.ts';

  let todos = $state<Todo[]>([
    { id: 1, title: 'Read the TodoMVC spec', done: true },
    { id: 2, title: 'Compile it to Rust', done: false },
  ]);
  let next = $state(3);
  let draft = $state('');
  let filter = $state<Filter>('all');
  let shown = $derived(visible(todos, filter));
  let left = $derived(todos.filter(t => !t.done).length);
  let completed = $derived(todos.length - left);

  function add() {
    const title = draft.trim();
    if (title === '') return;
    todos.push({ id: next, title, done: false });
    next += 1;
    draft = '';
  }
  function remove(id: number) {
    todos = todos.filter(t => t.id !== id);
  }
  function toggleAll(done: boolean) {
    for (const t of todos) t.done = done;
  }
  function clearCompleted() {
    todos = todos.filter(t => !t.done);
  }
</script>
<main>
  <h1>todos</h1>
  <div class="new">
    {#if todos.length > 0}<input id="toggle-all" type="checkbox" aria-label="Mark all as complete" checked={left === 0} onchange={(e) => toggleAll(e.currentTarget.checked)} />{/if}
    <input id="new-todo" type="text" aria-label="New todo" bind:value={draft} onkeydown={(e) => { if (e.key === 'Enter') add(); else if (e.key === 'Escape') draft = ''; }} />
  </div>
  <ul>
    {#each shown as todo (todo.id)}<TodoItem {todo} onremove={remove} />{/each}
  </ul>
  {#if todos.length > 0}
    <footer>
      <span id="count" class="count">{plural(left, 'item')} left</span>
      <div class="filters">
        <button id="filter-all" class={filter === 'all' ? 'selected' : ''} onclick={() => filter = 'all'}>All</button>
        <button id="filter-active" class={filter === 'active' ? 'selected' : ''} onclick={() => filter = 'active'}>Active</button>
        <button id="filter-completed" class={filter === 'completed' ? 'selected' : ''} onclick={() => filter = 'completed'}>Completed</button>
      </div>
      {#if completed > 0}<button id="clear" onclick={clearCompleted}>Clear completed</button>{/if}
    </footer>
  {/if}
</main>
