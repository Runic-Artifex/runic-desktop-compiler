<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import TodoItem from './TodoItem.vue';
import { visible, plural, load, nextId, STORAGE_KEY, type Todo, type Filter } from './todos.ts';

const todos = ref<Todo[]>(load());
const next = ref(nextId(todos.value));
const draft = ref('');
const filter = ref<Filter>('all');
const shown = computed(() => visible(todos.value, filter.value));
const left = computed(() => todos.value.filter(t => !t.done).length);
const completed = computed(() => todos.value.length - left.value);
// Saved after every change.
watchEffect(() => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(todos.value));
});

function add() {
  const title = draft.value.trim();
  if (title === '') return;
  todos.value.push({ id: next.value, title, done: false });
  next.value += 1;
  draft.value = '';
}
function remove(id: number) {
  todos.value = todos.value.filter(t => t.id !== id);
}
function toggleAll(done: boolean) {
  for (const t of todos.value) t.done = done;
}
function clearCompleted() {
  todos.value = todos.value.filter(t => !t.done);
}
</script>
<template>
  <main>
    <h1>todos</h1>
    <div class="new">
      <input v-if="todos.length > 0" id="toggle-all" type="checkbox" aria-label="Mark all as complete" :checked="left === 0" @change="toggleAll($event.target.checked)" /> <input id="new-todo" type="text" aria-label="New todo" :value="draft" @input="draft = $event.target.value" @keydown.enter="add" @keydown.esc="draft = ''" />
    </div>
    <ul>
      <TodoItem v-for="todo in shown" :key="todo.id" :todo="todo" @remove="remove" />
    </ul>
    <footer v-if="todos.length > 0">
      <span id="count" class="count">{{ plural(left, 'item') }} left</span>
      <div class="filters">
        <button id="filter-all" :class="filter === 'all' ? 'selected' : ''" @click="filter = 'all'">All</button>
        <button id="filter-active" :class="filter === 'active' ? 'selected' : ''" @click="filter = 'active'">Active</button>
        <button id="filter-completed" :class="filter === 'completed' ? 'selected' : ''" @click="filter = 'completed'">Completed</button>
      </div>
      <button v-if="completed > 0" id="clear" @click="clearCompleted">Clear completed</button>
    </footer>
  </main>
</template>
