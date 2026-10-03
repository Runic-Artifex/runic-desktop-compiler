<script setup lang="ts">
import type { Todo } from './todos.ts';
const { todo } = defineProps<{ todo: Todo }>();
const emit = defineEmits<{ remove: [id: number] }>();
</script>
<template>
  <li :id="`todo-${todo.id}`" :class="todo.done ? 'completed' : ''">
    <input :id="`toggle-${todo.id}`" type="checkbox" aria-label="Done" v-model="todo.done" />
    <span :id="`title-${todo.id}`">{{ todo.title }}</span>
    <button :id="`destroy-${todo.id}`" class="destroy" @click="emit('remove', todo.id)">Delete</button>
  </li>
</template>
