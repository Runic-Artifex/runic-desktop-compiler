<script setup lang="ts">
import { ref } from 'vue';
const on = ref(false);
const other = ref(true);
const base = ref('card  wide');
const extra = ref<string | null>(null);

function rebase() {
  base.value = base.value === 'card  wide' ? 'card on' : 'card  wide';
  if (extra.value === null) extra.value = ' extra ';
  else extra.value = null;
}
</script>

<template>
  <main>
    <div class="row">
      <button id="toggle" @click="on = !on">Toggle</button>
      <button id="other" @click="other = !other">Other</button>
      <button id="base" @click="rebase">Base</button>
    </div>
    <p id="bare" :class="{ on }">Bare</p>
    <p id="fixed" class="fixed  text" :class="{ on, off: !on }">Fixed</p>
    <p id="dynamic" :class="[base, { on, other }]">Dynamic</p>
    <p id="list" :class="[on ? 'on' : '', extra, ['  wide ', { 'other card': other }], '']" class="fixed">List</p>
  </main>
</template>
