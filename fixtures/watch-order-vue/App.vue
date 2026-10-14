<script setup lang="ts">
// Vue runs a component's watchers in the order their sources were
// triggered in the flush, not in the order they are declared.
import { ref, watch, watchEffect } from 'vue';

const a = ref(0);
const b = ref(0);
const status = ref('');
const entries: string[] = [];
const log = ref('');

watch(a, v => {
  status.value = `a${v}`;
  entries.push(`a${v}`);
});
watch(b, v => {
  status.value = `b${v}`;
  entries.push(`b${v}`);
});
watchEffect(() => {
  entries.push(`effect ${b.value}`);
});

function ab() {
  a.value += 1;
  b.value += 1;
}
function ba() {
  b.value += 1;
  a.value += 1;
}
function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
</script>

<template>
  <main>
    <h1 id="title">Watch order</h1>
    <p id="values">{{ a }} {{ b }} {{ status }}</p>
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="ab" @click="ab">A then B</button><button id="ba" @click="ba">B then A</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
