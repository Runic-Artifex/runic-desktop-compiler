<script lang="ts">
  import type { Todo } from './todos.ts';
  let { todo, onremove }: { todo: Todo; onremove: (id: number) => void } = $props();
</script>
<li id={`todo-${todo.id}`} class={todo.done ? 'completed' : ''}>
  <input id={`toggle-${todo.id}`} type="checkbox" aria-label="Done" bind:checked={todo.done} />
  <span id={`title-${todo.id}`}>{todo.title}</span>
  <button id={`destroy-${todo.id}`} class="destroy" onclick={() => onremove(todo.id)}>Delete</button>
</li>
