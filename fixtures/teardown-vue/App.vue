<script setup lang="ts">
// Vue's cleanups read live values: a watcher's cleanup runs before its
// next run, after the writes that re-run it, and reads them, through a deep
// ref's proxy and a computed value too (where Svelte reads the values
// before the flush, case teardown-proxy).
import { ref, computed, watch, watchEffect, onWatcherCleanup } from 'vue';
import Child from './Child.vue';

const state = ref({ count: 0 });
const n = ref(0);
const show = ref(true);
const log = ref('');
const entries: string[] = [];
const doubled = computed(() => state.value.count * 2);

watchEffect(() => {
  const seen = state.value.count;
  const seenN = n.value;
  onWatcherCleanup(() => {
    entries.push(`cleanup ${seen}/${state.value.count} ${seenN}/${n.value} d${doubled.value}`);
  });
});
watch(
  () => state.value.count,
  (value, old, onCleanup) => {
    onCleanup(() => entries.push(`watch cleanup ${value}/${state.value.count} ${n.value}`));
  },
);

function bump() {
  state.value.count += 1;
  n.value += 1;
}
function twice() {
  state.value.count += 1;
  state.value.count += 1;
  n.value += 1;
  n.value += 1;
}
function hide() {
  show.value = false;
  state.value.count += 10;
  n.value += 10;
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
    <h1 id="title">Teardown reads</h1>
    <p id="values">{{ state.count }} {{ n }} {{ doubled }}</p>
    <Child v-if="show" :state="state" :n="n" :record="record" />
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="bump" @click="bump">Bump</button><button id="twice" @click="twice">Twice</button><button id="hide" @click="hide">Hide</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
