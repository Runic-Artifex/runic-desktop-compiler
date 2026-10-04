<script lang="ts">
  import { TodoList, tally, type Mode } from './todos.svelte.ts';

  const list = new TodoList('Chores');
  const names = ['milk', 'bread', 'eggs', 'tea'];
  let added = $state(0);

  /** A class declared in the component script, reading component state. */
  class Counter {
    clicks = $state(0);
    label = $derived(`${this.clicks} clicks, ${added} added`);
    bump(): void {
      this.clicks += 1;
    }
  }
  const counter = new Counter();

  // Effects depend on the derived fields they read: the second re-runs only
  // when the number of done items changes.
  $effect(() => {
    console.log(`summary ${list.summary}`);
  });
  $effect(() => {
    console.log(`done ${list.done}`);
  });

  function add() {
    list.add(names[added % names.length]);
    added += 1;
    counter.bump();
  }
  function show(mode: Mode) {
    list.filter.mode = mode;
    tally.count += 1;
    counter.bump();
  }
</script>

<main>
  <h1 id="title">{list.title}</h1>
  <p id="summary">{list.summary}</p>
  <p id="counts">{list.remaining} open, {list.done} done, next #{list.nextId}</p>
  <p id="filter">Showing {list.filter.mode}: {list.visible.length}</p>
  <p id="last">Last: {list.last}</p>
  <p id="counter">{counter.label}</p>
  <p id="tally">{tally.label}</p>
  <ul>
    {#each list.visible as todo (todo.id)}
      <li>
        <span class:done={todo.done}>{todo.text}</span>
        <button id={`toggle-${todo.id}`} onclick={() => list.toggle(todo)}>Toggle</button>
      </li>
    {/each}
  </ul>
  <div class="controls">
    <button id="add" onclick={add}>Add</button>
    <button id="clear" onclick={() => list.clearDone()} disabled={list.done === 0}>Clear done</button>
    <button id="rename" onclick={() => list.rename()}>Rename</button>
    <button id="adopt" onclick={() => list.adopt()}>Adopt</button>
    <button id="show-all" onclick={() => show('all')}>All</button>
    <button id="show-open" onclick={() => show('open')}>Open</button>
    <button id="show-done" onclick={() => show('done')}>Done</button>
  </div>
</main>
