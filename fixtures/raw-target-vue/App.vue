<script setup lang="ts">
// Vue's reactive proxies write through to their target; writes to the raw
// object are not tracked, so the view shows them only when it re-renders
// for another reason.
import { ref } from 'vue';

const raw = { n: 1 };
const r = ref(raw);
const other = ref(0);
const shown = ref('');

function proxyWrite() {
  r.value.n += 1;
}
function rawWrite() {
  raw.n += 10;
}
function bumpOther() {
  other.value += 1;
}
function show() {
  shown.value = `${raw.n} ${r.value.n}`;
}
</script>

<template>
  <main>
    <h1 id="title">Raw targets</h1>
    <p id="value">{{ r.n }}</p>
    <p id="other">{{ other }}</p>
    <p id="shown">{{ shown }}</p>
    <div class="controls">
      <button id="proxy-write" @click="proxyWrite">Proxy write</button>
      <button id="raw-write" @click="rawWrite">Raw write</button>
      <button id="other-bump" @click="bumpOther">Other</button>
      <button id="show" @click="show">Show</button>
    </div>
  </main>
</template>
