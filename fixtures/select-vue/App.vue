<script setup lang="ts">
import { ref } from 'vue';
const units = ['day', 'hour', 'minute'];
const unit = ref('hour');
const kind = ref('text');
const extra = ref(false);
// A one-way value that nothing writes: Vue sets it again when the component re-renders.
const fixed = ref('b');
const log = ref<string[]>([]);
function onKind(e: Event) {
  kind.value = (e.target as HTMLSelectElement).value;
  log.value.push(`kind:${kind.value}`);
}
function onFree(e: Event) {
  log.value.push(`free:${(e.target as HTMLSelectElement).value}`);
}
</script>

<template>
  <main>
    <div class="row">
      <select id="unit" aria-label="Unit" v-model="unit">
        <option v-for="u in units" :key="u" :value="u">{{ u }}</option>
        <option v-if="extra" value="week">week</option>
      </select>
      <select id="kind" aria-label="Kind" :value="kind" @change="onKind">
        <option value="text">Text</option>
        <option value="input" disabled>Input</option>
        <option value="markup">Semantic markup</option>
      </select>
      <select id="free" aria-label="Free" @change="onFree" @click="log.push('free-click')">
        <option>Alpha</option>
        <option disabled>Off</option>
        <option>  Beta   gamma </option>
        <option>Gamma</option>
      </select>
      <select id="fixed" aria-label="Fixed" :value="fixed">
        <option value="a">A</option>
        <option value="b">B</option>
        <option value="c">C</option>
      </select>
    </div>
    <div class="row">
      <button id="extra" @click="extra = !extra">Extra</button>
      <button id="reset" @click="unit = 'day'">Reset</button>
      <button id="bad" @click="unit = 'month'">Bad</button>
    </div>
    <p id="state">{{ unit }} {{ kind }}</p>
    <p id="log">{{ log.join(' ') }}</p>
  </main>
</template>
