<script setup lang="ts">
// A computed value evaluated for the first time in a watchEffect's cleanup
// (inside the watchEffect's next run) takes over the active link of the
// signals it shares with it: the watchEffect subscribes to them again, after
// the watcher declared below it, which then runs first in later flushes.
import { ref, computed, watch, watchEffect, onWatcherCleanup } from 'vue';

const state = ref({ count: 0 });
const entries: string[] = [];
const log = ref('');
const doubled = computed(() => state.value.count * 2);

watchEffect(() => {
  const seen = state.value.count;
  onWatcherCleanup(() => {
    entries.push(`cleanup ${seen} d${doubled.value}`);
  });
});
watch(
  () => state.value.count,
  v => {
    entries.push(`watch ${v}`);
  },
);

function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
</script>

<template>
  <main>
    <h1 id="title">Cleanup computed</h1>
    <p id="values">{{ state.count }}</p>
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="bump" @click="state.count++">Bump</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
