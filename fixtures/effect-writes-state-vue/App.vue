<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue';
import Child from './Child.vue';
const a = ref(0);
const b = ref(0);
const shown = ref('');
const log: string[] = [];
function note(s: string) {
  log.push(s);
}
function dump() {
  shown.value = log.join(' | ');
  log.splice(0, log.length);
}
function bump() {
  queueMicrotask(() => note('handler micro'));
  a.value++;
}
watchEffect(() => note(`App a ${a.value}`));
watch(a, value => {
  note(`write b ${value * 10}`);
  b.value = value * 10;
  queueMicrotask(() => note(`effect micro b ${b.value}`));
});
</script>

<template>
  <main>
    <h1 id="title">Effect writes</h1>
    <p id="a">a: {{ a }}</p>
    <p id="b">b: {{ b }}</p>
    <Child :b="b" :note="note" />
    <p id="log">{{ shown }}</p>
    <div class="controls"><button id="bump" @click="bump">Bump</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
