<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';

// Scroll events: one per moved scroller in the rendering step after the
// action; none at the wrapper (scroll does not bubble). Shrinking the
// content clamps the scroll position, whose event follows a frame later.
const n = ref(40);
const log = ref<number[]>([]);
const outer = ref(0);
const readout = ref('');
const list = ref<HTMLDivElement | null>(null);
const items = computed(() => range(n.value));

function range(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i);
  return out;
}

function scrolled() {
  log.value.push(list.value!.scrollTop);
}
function down() {
  list.value!.scrollTop = 400;
}
async function read() {
  n.value = 10;
  await nextTick();
  // A forced layout clamps at once.
  readout.value = String(list.value!.scrollTop);
}
</script>

<template>
  <main>
    <!-- First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). -->
    <div id="outer" @scroll="outer += 1">
      <div id="list" ref="list" @scroll="scrolled">
        <div v-for="i in items" :key="i" class="item">Item {{ i }}</div>
      </div>
    </div>
    <div class="row">
      <button id="down" @click="down">Down</button>
      <button id="shrink" @click="n = 20">Shrink</button>
      <button id="tiny" @click="n = 3">Tiny</button>
      <button id="grow" @click="n = 40">Grow</button>
      <button id="read" @click="read">Read</button>
    </div>
    <p id="log">{{ log.join(' ') }}</p>
    <p id="state">{{ outer }} {{ readout }}</p>
  </main>
</template>
