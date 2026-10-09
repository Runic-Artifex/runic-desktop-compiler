<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
const form = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
const mode = ref('open');
const log = ref('ready');
const submits = ref(0);
function note(s: string) {
  log.value = (log.value === 'ready' ? s : log.value + ' ' + s).slice(-512);
}
function select(s: string) {
  mode.value = s;
  log.value = 'ready';
  submits.value = 0;
}
function unstopped() {
  // Keep the same mounted form and listeners: a later event proves guard release.
  mode.value = 'open';
  note('clear');
}
function windowCaptureFirst(e: Event) {
  e.preventDefault();
  submits.value++;
  note('wc1');
  queueMicrotask(() => note('micro'));
  if (mode.value === 'window-stop') e.stopPropagation();
}
function windowCaptureSecond() {
  note('wc2');
}
function documentCaptureFirst(e: Event) {
  note('dc1');
  if (mode.value === 'document-stop') e.stopPropagation();
  if (mode.value === 'document-immediate') e.stopImmediatePropagation();
}
function documentCaptureSecond() {
  note('dc2');
}
function formBubble(e: Event) {
  e.preventDefault();
  note('fb');
}
function formScript() {
  note('fs');
}
function innerFirst(e: Event) {
  note('ib1');
  if (mode.value === 'ancestor-stop') e.stopPropagation();
}
function innerSecond() {
  note('ib2');
}
function outerBubble() {
  note('ob');
}
function documentBubble() {
  note('db');
}
function windowBubble() {
  note('wb');
}
function request() {
  note('before');
  form.value?.requestSubmit();
  note('after');
}
function cleanup() {
  window.removeEventListener('submit', windowCaptureFirst, true);
  window.removeEventListener('submit', windowCaptureSecond, true);
  document.removeEventListener('submit', documentCaptureFirst, true);
  document.removeEventListener('submit', documentCaptureSecond, true);
  form.value?.removeEventListener('submit', formScript);
  inner.value?.removeEventListener('submit', innerFirst);
  inner.value?.removeEventListener('submit', innerSecond);
  document.removeEventListener('submit', documentBubble);
  window.removeEventListener('submit', windowBubble);
}
onMounted(() => {
  window.addEventListener('submit', windowCaptureFirst, true);
  window.addEventListener('submit', windowCaptureSecond, true);
  document.addEventListener('submit', documentCaptureFirst, true);
  document.addEventListener('submit', documentCaptureSecond, true);
  form.value?.addEventListener('submit', formScript);
  inner.value?.addEventListener('submit', innerFirst);
  inner.value?.addEventListener('submit', innerSecond);
  document.addEventListener('submit', documentBubble);
  window.addEventListener('submit', windowBubble);
});
onBeforeUnmount(() => cleanup());
</script>
<template>
  <main>
    <h1>Submit propagation stops</h1>
    <div class="controls">
      <button id="mode-window-stop" type="button" @click="select('window-stop')">
        Window stop
      </button>
      <button id="mode-document-stop" type="button" @click="select('document-stop')">
        Document stop
      </button>
      <button id="mode-document-immediate" type="button" @click="select('document-immediate')">
        Document immediate
      </button>
      <button id="mode-ancestor-stop" type="button" @click="select('ancestor-stop')">
        Ancestor stop
      </button>
    </div>
    <p id="mode">{{ mode }}</p>
    <div id="outer" @submit="outerBubble">
      <div id="inner" ref="inner">
        <form id="stop-form" ref="form" @submit="formBubble">
          <input id="field" aria-label="Submission field" type="text" />
          <button id="physical" type="submit">Physical submission</button>
        </form>
      </div>
    </div>
    <div class="controls">
      <button id="request" type="button" @click="request">Request submission</button>
      <button id="unstopped" type="button" @click="unstopped">Next unstopped</button>
    </div>
    <p id="count">{{ 'submits:' + submits }}</p>
    <p id="log">{{ log }}</p>
  </main>
</template>
