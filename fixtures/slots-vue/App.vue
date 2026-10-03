<script setup lang="ts">
import { ref } from 'vue';
import Card from './Card.vue';
import Picker from './Picker.vue';
import Tally from './Tally.vue';
const items = ref([{ id: 1, name: 'Apple' }, { id: 2, name: 'Pear' }, { id: 3, name: 'Plum' }]);
const picked = ref(0);
const note = ref('none');
function pick(id: number) { picked.value = id; }
</script>
<template>
<main><h1 id="title">Slots</h1>
<Card title="plain"><p id="plain-body">Picked {{ picked }}</p></Card>
<Card title="fancy">
  <template #header="{ title }"><span id="fancy-header">Header for {{ title }}</span></template>
  <p id="fancy-body">Note: {{ note }}</p>
  <button id="note" @click="note = note === 'none' ? 'set' : 'none'">Note</button>
</Card>
<Picker :items="items">
  <template #row="{ item, first }"><span :id="`name-${item.id}`">{{ first ? '* ' : '' }}{{ item.name }}</span><button :id="`pick-${item.id}`" :disabled="picked === item.id" @click="pick(item.id)">Pick</button><Tally :id="item.id" /></template>
</Picker>
<button id="drop" @click="items = items.slice(1)">Drop first</button>
</main>
</template>
