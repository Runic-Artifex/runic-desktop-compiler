<script setup lang="ts">
// Watchers that write what they read: Vue does not run a watcher again for
// its own writes while it runs.
import { ref, watchEffect } from 'vue';

const items = ref([1, 2, 3, 4, 5]);
const count = ref(5);
const box = ref({ value: 5 });
const shown = ref('');
const log: string[] = [];

watchEffect(() => {
  log.push(`len ${items.value.length}`);
  if (items.value.length > 3) items.value.pop();
});
watchEffect(() => {
  log.push(`count ${count.value}`);
  if (count.value > 3) count.value -= 1;
});
watchEffect(() => {
  log.push(`box ${box.value.value}`);
  if (box.value.value > 3) box.value.value -= 1;
});

function grow() {
  items.value.push(6, 7);
  count.value = 6;
  box.value.value = 6;
}
function dump() {
  shown.value = log.join(' | ');
  log.splice(0, log.length);
}
</script>

<template>
  <main>
    <h1 id="title">Watchers writing what they read</h1>
    <p id="values">{{ items.length }} {{ count }} {{ box.value }}</p>
    <p id="log">{{ shown }}</p>
    <div class="controls">
      <button id="grow" @click="grow">Grow</button>
      <button id="dump" @click="dump">Dump</button>
    </div>
  </main>
</template>
