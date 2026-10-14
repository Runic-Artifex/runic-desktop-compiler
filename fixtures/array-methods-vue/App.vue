<script setup lang="ts">
// pop, shift, unshift, splice and copyWithin on the array a deep ref holds
// go through its reactive proxy element by element: a set of an unchanged
// (SameValue) element notifies nothing, so a watchEffect reading only it
// does not run again (docs/design/REACTIVITY-ALIASING.md, R4).
import { ref, watchEffect } from 'vue';

const items = ref([1, 2, 3, 4, 5]);
const log = ref('');
const entries: string[] = [];

// One watcher (several logging into one array are rejected, R10).
watchEffect(() => {
  entries.push(`b ${items.value[1]}`);
});

function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
function reset() {
  items.value = [1, 2, 3, 4, 5];
}
</script>

<template>
  <main>
    <h1 id="title">Array methods</h1>
    <p id="items">{{ items.join(',') }}</p>
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="pop" @click="items.pop()">Pop</button><button id="shift" @click="items.shift()">Shift</button><button id="unshift" @click="items.unshift(0)">Unshift</button><button id="splice-cut" @click="items.splice(2, 1)">Splice cut</button><button id="splice-same" @click="items.splice(1, 1, items[1])">Splice same</button><button id="splice-add" @click="items.splice(3, 0, 8)">Splice add</button><button id="reset" @click="reset">Reset</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
