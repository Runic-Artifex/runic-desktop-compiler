<script setup lang="ts">
// shallowRef tracks .value only: replacing the object updates the view, a
// mutation in place does not (Vue shows it at the next render).
import { ref, shallowRef } from 'vue';

const box = shallowRef({ count: 0 });
const other = ref(0);

function replace() {
  box.value = { count: box.value.count + 1 };
}
function mutate() {
  box.value.count += 10;
}
</script>

<template>
  <main>
    <h1 id="title">Shallow refs</h1>
    <p id="count">{{ box.count }}</p>
    <p id="other">{{ other }}</p>
    <div class="controls">
      <button id="replace" @click="replace">Replace</button>
      <button id="mutate" @click="mutate">Mutate</button>
      <button id="other-bump" @click="other += 1">Other</button>
    </div>
  </main>
</template>
