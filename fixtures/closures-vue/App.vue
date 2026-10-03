<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
const log = ref('');
function later() {
  count.value += 1;
  setTimeout(() => (log.value = `${log.value} later:${count.value}`), 100);
}
function micro() {
  count.value += 1;
  queueMicrotask(() => (log.value = `${log.value} micro:${count.value}`));
}
function functional() {
  setTimeout(() => (count.value += 10), 50);
  count.value += 1;
}
</script>
<template><main><h1 id="title">Closures</h1>
<p id="count">{{ count }}</p>
<p id="log">{{ log }}</p>
<div class="controls"><button id="later" @click="later">Later</button><button id="micro" @click="micro">Micro</button><button id="functional" @click="functional">Functional</button></div>
</main></template>
