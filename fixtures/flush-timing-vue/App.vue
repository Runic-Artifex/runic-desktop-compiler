<script setup lang="ts">
import { ref, watchEffect, nextTick } from 'vue';
const count = ref(0);
const shown = ref('');
const log: string[] = [];
watchEffect(() => {
  log.push(`effect ${count.value}`);
});
function inc() {
  nextTick().then(() => log.push(`tick-before ${count.value}`));
  queueMicrotask(() => log.push('micro-before'));
  count.value += 1;
  queueMicrotask(() => log.push('micro-after'));
  nextTick(() => log.push(`tick-after ${count.value}`));
  log.push('handler');
}
async function later() {
  count.value += 1;
  log.push('before await');
  await nextTick();
  log.push(`after await ${count.value}`);
}
function dump() {
  shown.value = log.join(' | ');
  log.splice(0, log.length);
}
</script>
<template><main><h1 id="title">Flush timing</h1>
<p id="count">{{ count }}</p>
<p id="log">{{ shown }}</p>
<div class="controls"><button id="inc" @click="inc">Increment</button><button id="later" @click="later">Later</button><button id="dump" @click="dump">Dump</button></div>
</main></template>
