<script setup lang="ts">
import { ref } from 'vue';
// Diagnostic reduction, intentionally not imported by the pass fixture entry.
const form = ref<HTMLElement | null>(null);
const log = ref('ready');
function note(s: string) {
  log.value = (log.value === 'ready' ? s : log.value + ' ' + s).slice(-512);
}
function submit(e: Event) {
  e.preventDefault();
  note('submit');
}
function request() {
  note('before');
  form.value?.requestSubmit();
  note('after');
}
</script>
<template>
  <main>
    <form id="gap-form" ref="form" @submit="submit">
      <input id="gap-field" type="text" aria-label="Required field" required />
      <button id="gap-default" type="submit" formnovalidate>Bypass only for this button</button>
    </form>
    <button id="gap-request" type="button" @click="request">Request without submitter</button>
    <p id="log">{{ log }}</p>
  </main>
</template>
