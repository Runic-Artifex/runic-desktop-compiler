<script setup lang="ts">
import { computed, ref } from 'vue';
const notes = ref('one\ntwo');
const agreed = ref(false);
const name = ref('');
const lines = computed(() => notes.value.split('\n').length);
const frozen = ref(false);
const fixed = ref('fixed');
const other = ref(0);
const memo = ref('');
</script>

<template>
  <main>
    <div class="row"><label id="notes-label" for="notes">Notes</label></div>
    <div class="row"><textarea id="notes" v-model="notes"></textarea></div>
    <p id="lines">{{ lines }} lines</p>
    <div class="row"><label id="agree-label"><input id="agree" type="checkbox" v-model="agreed" /> I agree</label></div>
    <div class="row"><label id="name-label">Name <input id="name" type="text" :value="name" @input="name = $event.target.value" /></label></div>
    <div class="row"><input id="frozen" type="checkbox" aria-label="Frozen" :checked="frozen" /><input id="fixed" type="text" aria-label="Fixed" :value="fixed" /><button id="other" @click="other++">Other {{ other }}</button></div>
    <p id="state">{{ agreed }} {{ name }}</p>
    <div class="row"><textarea id="memo" aria-label="Memo" :value="memo"></textarea></div>
  </main>
</template>
