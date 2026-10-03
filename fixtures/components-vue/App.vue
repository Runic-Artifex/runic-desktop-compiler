<script setup lang="ts">
import { ref } from 'vue';
import Row from './Row.vue';
import Editor from './Editor.vue';
interface Item { id: number; label: string }
const items = ref<Item[]>([{ id: 1, label: 'Alpha' }, { id: 2, label: 'Beta' }, { id: 3, label: 'Gamma' }]);
const next = ref(4);
const name = ref('Delta');
const showEditor = ref(true);
function add() { items.value.push({ id: next.value, label: name.value }); next.value += 1; }
function remove(id: number) { items.value = items.value.filter(i => i.id !== id); }
function up(id: number) {
  const i = items.value.findIndex(x => x.id === id);
  if (i > 0) { const moved = items.value[i]; items.value[i] = items.value[i - 1]; items.value[i - 1] = moved; }
}
function reverse() { items.value = items.value.toReversed(); }
</script>
<template>
  <main><h1 id="title">Components</h1>
    <ul><Row v-for="(item, i) in items" :key="item.id" :id="item.id" :label="item.label" :first="i === 0" @remove="remove" @up="(id) => up(id)" /><li v-if="items.length === 0" id="empty">Nothing left</li></ul>
    <p id="summary">{{ items.length }} items, next {{ next }}, name {{ name }}</p>
    <div class="controls"><button id="add" @click="add">Add</button><button id="reverse" @click="reverse">Reverse</button><button id="toggle" @click="showEditor = !showEditor">Toggle editor</button></div>
    <Editor v-if="showEditor" v-model="name" />
  </main>
</template>
