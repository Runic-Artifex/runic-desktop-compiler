<script setup lang="ts">
// Unmounts of components an update removes, logged into one plain array with
// the watchers of the components after them: Vue unmounts a component where
// its patch reaches it (onBeforeUnmount, then its watchers' cleanups, parent
// first), before it patches or mounts what follows; a v-if branch replacing
// another is mounted after the old one is unmounted; onUnmounted runs in the
// post flush.
import { ref } from 'vue';
import Row from './Row.vue';

const items = ref([1, 2, 3]);
const n = ref(0);
const show = ref(true);
const mode = ref(true);
const next = ref(4);
const entries: string[] = [];
const log = ref('');

function record(line: string) {
  entries.push(line);
}
function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
function drop() {
  items.value.splice(1, 1);
  n.value++;
}
function clear() {
  items.value = [];
  n.value++;
}
function refill() {
  const out: number[] = [next.value];
  out.push(next.value + 1);
  next.value += 2;
  items.value = out;
  n.value++;
}
function replace() {
  const out: number[] = [next.value];
  if (items.value.length > 0) out.push(items.value[items.value.length - 1]);
  next.value += 1;
  items.value = out;
  n.value++;
}
function flip() {
  mode.value = !mode.value;
  n.value++;
}
function hide() {
  show.value = !show.value;
  n.value++;
}
</script>

<template>
  <main>
    <h1 id="title">Teardown order</h1>
    <Row v-if="show" :id="0" :n="n" :record="record" />
    <Row v-for="i in items" :key="i" :id="i" :n="n" :record="record" />
    <Row v-if="mode" :id="10" :n="n" :record="record" />
    <Row v-else :id="20" :n="n" :record="record" />
    <Row :id="9" :n="n" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="bump" @click="n++">Bump</button><button id="drop" @click="drop">Drop</button><button id="clear" @click="clear">Clear</button><button id="refill" @click="refill">Refill</button><button id="replace" @click="replace">Replace</button><button id="flip" @click="flip">Flip</button><button id="hide" @click="hide">Hide</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
