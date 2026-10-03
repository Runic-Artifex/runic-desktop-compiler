<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
const count = ref(0);
const shown = ref('');
const log: string[] = [];
const runs = { getter: 0, unused: 0 };
const even = computed(() => count.value % 2 === 0);
const doubled = computed(() => {
  runs.getter += 1;
  return count.value * 2;
});
const unused = computed(() => {
  runs.unused += 1;
  return count.value + 1;
});
watchEffect(() => {
  log.push(`even ${even.value}`);
});
function addTwo() {
  count.value += 2;
  log.push(`read ${doubled.value} ${doubled.value} runs ${runs.getter}`);
}
function addOne() {
  count.value += 1;
}
function dump() {
  shown.value = `${log.join(' | ')} | getter ${runs.getter} unused ${runs.unused}`;
  log.splice(0, log.length);
}
</script>
<template><main><h1 id="title">Derived timing</h1>
<p id="values">{{ count }} {{ doubled }} {{ even ? 'even' : 'odd' }}</p>
<p id="log">{{ shown }}</p>
<div class="controls"><button id="add-two" @click="addTwo">Add two</button><button id="add-one" @click="addOne">Add one</button><button id="dump" @click="dump">Dump</button></div>
</main></template>
