<script setup lang="ts">
// Watchers of different instances that a prop update triggers: Vue runs
// each while the parent's render patches its instance, in document order,
// also for an item inserted at the front of a list and a branch shown
// before existing siblings (created after them). Watchers a write triggers
// directly run in creation order instead (fixture watch-instances-deep-vue).
import { ref } from 'vue';
import Row from './Row.vue';

const items = ref([1, 2]);
const n = ref(0);
const show = ref(false);
const entries: string[] = [];
const log = ref('');

function front() {
  items.value.unshift(items.value.length + 1);
}
function record(line: string) {
  entries.push(line);
}
function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
</script>

<template>
  <main>
    <h1 id="title">Watchers of instances</h1>
    <Row v-if="show" :id="0" :n="n" :record="record" />
    <Row v-for="i in items" :key="i" :id="i" :n="n" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="bump" @click="n++">Bump</button><button id="front" @click="front">Front</button><button id="show" @click="show = !show">Show</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
