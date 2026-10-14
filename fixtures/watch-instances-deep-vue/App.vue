<script setup lang="ts">
// Watchers of different instances that a write triggers directly, through a
// reactive object the parent passes: Vue queues them by instance uid, so an
// item inserted at the front of a list and a branch shown before existing
// siblings (created after them) run last; Runic runs them in document order.
import { ref } from 'vue';
import Row from './Row.vue';

const items = ref([1, 2]);
const state = ref({ n: 0 });
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
    <Row v-if="show" :id="0" :state="state" :record="record" />
    <Row v-for="i in items" :key="i" :id="i" :state="state" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="deep" @click="state.n++">Deep</button><button id="front" @click="front">Front</button><button id="show" @click="show = !show">Show</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
