<script setup lang="ts">
import { ref, watchEffect } from 'vue';
interface Item {
  done: boolean;
}
const a = ref<number[]>([1]);
const b = ref<number[]>([1]);
const items = ref<Item[]>([{ done: false }, { done: false }]);
const shown = ref('');
const log: string[] = [];
watchEffect(() => {
  log.push(`a ${a.value.length}`);
});
watchEffect(() => {
  log.push(`first ${items.value[0].done}`);
});
watchEffect(() => {
  log.push(`count ${items.value.length}`);
});
function dump() {
  shown.value = log.join(' | ');
  log.splice(0, log.length);
}
</script>
<template><main><h1 id="title">Deep tracking</h1>
<p id="values">{{ a.length }} {{ b.length }} {{ items.length }}</p>
<p id="log">{{ shown }}</p>
<div class="controls"><button id="push-b" @click="b.push(1)">Push b</button><button id="push-a" @click="a.push(1)">Push a</button><button id="toggle-second" @click="items[1].done = !items[1].done">Toggle second</button><button id="toggle-first" @click="items[0].done = !items[0].done">Toggle first</button><button id="add-item" @click="items.push({ done: false })">Add item</button><button id="dump" @click="dump">Dump</button></div>
</main></template>
