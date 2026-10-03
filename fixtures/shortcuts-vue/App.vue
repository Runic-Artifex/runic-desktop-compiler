<script setup lang="ts">
import { ref, useTemplateRef, watch, onMounted, onBeforeUnmount } from 'vue';
const open = ref(false);
const shortcuts = ref(0);
const log = ref<string[]>([]);
const panel = useTemplateRef<HTMLElement>('panel');

function onKey(e: KeyboardEvent) {
  if (e.key === 'k' && e.ctrlKey) {
    e.preventDefault();
    shortcuts.value++;
  }
  if (e.key === 'Escape') open.value = false;
  log.value.push(`window:${e.key}`);
}
function onDocument() {
  log.value.push('document');
}
onMounted(() => {
  window.addEventListener('keydown', onKey);
  document.addEventListener('click', onDocument);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  document.removeEventListener('click', onDocument);
});

// Click outside: a document listener while the panel is open.
watch(open, (isOpen, _, onCleanup) => {
  if (!isOpen) return;
  const close = (e: MouseEvent) => {
    if (e.target !== panel.value) {
      open.value = false;
      log.value.push('outside');
    }
  };
  document.addEventListener('click', close);
  onCleanup(() => document.removeEventListener('click', close));
});
</script>

<template>
  <main><div class="row"><button id="open" @click.stop="open = true; log.push('open')">Open</button> <button id="open-late" @click="open = true; log.push('open-late')">Open late</button></div> <div v-if="open" id="panel" ref="panel">Panel</div> <div class="row"><input id="field" type="text" aria-label="Field" @keydown.q.stop /></div> <p id="state">{{ open }} {{ shortcuts }}</p> <p id="log">{{ log.join(' ') }}</p></main>
</template>
