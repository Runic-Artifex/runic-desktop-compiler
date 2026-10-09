<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
const form = ref<HTMLElement | null>(null);
const mode = ref('replace');
const log = ref('ready');
const changed = ref(false);
const installed = ref(false);
const firstCount = ref(0);
const laterCount = ref(0);
const freshCount = ref(0);
const addedCount = ref(0);
function note(s: string) {
  log.value = (log.value === 'ready' ? s : log.value + ' ' + s).slice(-512);
}
function later() {
  laterCount.value++;
  note('late');
}
function fresh() {
  freshCount.value++;
  note('fresh');
}
function added() {
  addedCount.value++;
  note('added');
}
function first() {
  firstCount.value++;
  note('first');
  if ((mode.value === 'replace' || mode.value === 'readd') && !changed.value) {
    changed.value = true;
    // The FORM callback slot can be reused, but its new occupant is not in this stage.
    form.value?.removeEventListener('submit', later);
    if (mode.value === 'replace') {
      form.value?.addEventListener('submit', fresh);
      note('replace');
    } else {
      form.value?.addEventListener('submit', later);
      note('readd');
    }
  }
}
function capture() {
  note('capture');
  if (mode.value === 'capture' && !installed.value) {
    installed.value = true;
    // FORM target bubble has not started; this callback belongs to that later stage.
    form.value?.addEventListener('submit', added);
    note('install');
  }
}
function removeBubble() {
  form.value?.removeEventListener('submit', first);
  form.value?.removeEventListener('submit', later);
  form.value?.removeEventListener('submit', fresh);
  form.value?.removeEventListener('submit', added);
}
function installBase() {
  removeBubble();
  form.value?.addEventListener('submit', first);
  form.value?.addEventListener('submit', later);
}
function cleanup() {
  document.removeEventListener('submit', capture, true);
  removeBubble();
}
function select(s: string) {
  mode.value = s;
  log.value = 'ready';
  changed.value = false;
  installed.value = false;
  firstCount.value = 0;
  laterCount.value = 0;
  freshCount.value = 0;
  addedCount.value = 0;
  installBase();
}
function submit(e: Event) {
  e.preventDefault();
  note('target');
}
function request() {
  note('before');
  form.value?.requestSubmit();
  note('after');
}
onMounted(() => {
  document.addEventListener('submit', capture, true);
  installBase();
});
onUnmounted(() => cleanup());
</script>
<template>
  <main>
    <h1>Submit element listener mutation</h1>
    <div class="controls">
      <button id="mode-replace" type="button" @click="select('replace')">
        Replace during bubble
      </button>
      <button id="mode-capture" type="button" @click="select('capture')">Add during capture</button>
      <button id="mode-readd" type="button" @click="select('readd')">Readd same callback</button>
    </div>
    <p id="mode">{{ mode }}</p>
    <form id="listener-form" ref="form" @submit="submit">
      <input id="field" aria-label="Submission field" type="text" />
      <button id="physical" type="submit">Physical submission</button>
    </form>
    <button id="request" type="button" @click="request">Request submission</button>
    <p id="counts">
      {{
        'first:' +
        firstCount +
        ' late:' +
        laterCount +
        ' fresh:' +
        freshCount +
        ' added:' +
        addedCount
      }}
    </p>
    <p id="log">{{ log }}</p>
  </main>
</template>
