<script setup lang="ts">
// Watchers whose order in a flush Runic proves to be Vue's (docs/design/
// REACTIVITY-ALIASING.md, "Watcher order"), each logging into one array.
import { ref, watch, watchEffect } from 'vue';
import Child from './Child.vue';

interface Inner {
  b: number;
}
const a = ref(0);
const list = ref<number[]>([]);
const state = ref<{ a: Inner }>({ a: { b: 0 } });
const n = ref(0);
const x = ref(0);
const y = ref(0);
const entries: string[] = [];
const log = ref('');

// The watcher after this one depends on a, which this one reads in every
// run: one write of a notifies both, this one first, whatever the flush
// wrote before (the list's length, which only this one reads).
watchEffect(() => {
  entries.push(`effect ${a.value} ${list.value.length}`);
});
watch(a, v => {
  entries.push(`watch a ${v}`);
});
// No handler writes both x and y: no flush runs both.
watch(x, v => {
  entries.push(`watch x ${v}`);
});
watch(y, v => {
  entries.push(`watch y ${v}`);
});

function listThenA() {
  list.value.push(1);
  a.value += 1;
}
function aThenList() {
  a.value += 1;
  list.value.push(2);
}
function deepThenN() {
  state.value.a.b += 1;
  n.value += 1;
}
function nThenDeep() {
  n.value += 1;
  state.value.a.b += 1;
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
    <h1 id="title">Watchers in declaration order</h1>
    <p id="values">{{ a }} {{ list.length }} {{ x }} {{ y }} {{ n }}</p>
    <Child :state="state" :n="n" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="list-a" @click="listThenA">List, a</button><button id="a-list" @click="aThenList">A, list</button><button id="x" @click="x++">X</button><button id="y" @click="y++">Y</button><button id="deep-n" @click="deepThenN">Deep, n</button><button id="n-deep" @click="nThenDeep">N, deep</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
