<script setup lang="ts">
// Watchers of keyed list items that the parent's render triggers through
// their props, logged into one plain array: Vue runs them as its keyed diff
// patches the items (patchKeyedChildren): the common prefix forward, the
// common suffix backward, the rest in their previous order; new items run
// their setup (a watchEffect's first run) as the diff mounts them.
import { ref } from 'vue';
import Row from './Row.vue';

const items = ref([1, 2, 3]);
const n = ref(0);
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
function fresh(): number {
  const id = next.value;
  next.value += 1;
  return id;
}
function front() {
  items.value.unshift(fresh());
  n.value++;
}
function back() {
  items.value.push(fresh());
  n.value++;
}
function reverse() {
  items.value.reverse();
  n.value++;
}
function rotate() {
  const first = items.value.shift();
  if (first !== undefined) items.value.push(first);
  n.value++;
}
function shuffle() {
  const old = items.value.slice();
  const mid = Math.floor(old.length / 2);
  const out: number[] = [fresh()];
  for (const x of old.slice(mid).reverse()) out.push(x);
  out.push(fresh());
  for (const x of old.slice(0, mid)) out.push(x);
  items.value = out;
  n.value++;
}
</script>

<template>
  <main>
    <h1 id="title">Watchers of list items</h1>
    <Row v-for="i in items" :key="i" :id="i" :n="n" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="bump" @click="n++">Bump</button><button id="front" @click="front">Front</button><button id="back" @click="back">Back</button><button id="reverse" @click="reverse">Reverse</button><button id="rotate" @click="rotate">Rotate</button><button id="shuffle" @click="shuffle">Shuffle</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
