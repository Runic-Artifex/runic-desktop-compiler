<script setup lang="ts">
// Writes of the value a slot already holds: Vue's set trap (hasChanged)
// and RefImpl notify nothing, so a watcher reading the slot does not run.
import { ref, watchEffect } from 'vue';

const state = ref({ count: 0, items: [1, 2, 3] });
const n = ref(0);
const entries: string[] = [];
const log = ref('');

watchEffect(() => {
  entries.push(`run ${state.value.count} ${state.value.items[0]} ${n.value}`);
});

function same() {
  state.value.count = state.value.count;
  state.value.items[0] = state.value.items[0];
  n.value = n.value;
}
function palindrome() {
  state.value.items = [1, 2, 1];
}
function flip() {
  // Reversing [1, 2, 1] sets indices 0 and 2 to the values they hold.
  state.value.items.reverse();
}
function dump() {
  log.value = entries.join(' | ');
  entries.splice(0, entries.length);
}
</script>

<template>
  <main>
    <h1 id="title">Equal writes</h1>
    <p id="values">{{ state.count }} {{ state.items.join(',') }} {{ n }}</p>
    <p id="log">{{ log }}</p>
    <div class="controls"><button id="same" @click="same">Same</button><button id="palindrome" @click="palindrome">Palindrome</button><button id="flip" @click="flip">Flip</button><button id="dump" @click="dump">Dump</button></div>
  </main>
</template>
