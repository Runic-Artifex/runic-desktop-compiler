<script setup lang="ts">
import { ref, shallowRef, onMounted, onUnmounted } from 'vue';

// ResizeObserver (M6) in Vue: the resize-svelte fixture's observers.
const outer = ref<HTMLDivElement | null>(null);
const inner = ref<HTMLDivElement | null>(null);
const hidden = ref<HTMLDivElement | null>(null);
const width = ref(200.5);
const shown = ref(false);
const innerWidth = ref(10);
const log = ref<string[]>([]);
const content = shallowRef<ResizeObserver | null>(null);
const border = shallowRef<ResizeObserver | null>(null);

function name(t: HTMLElement): string {
  if (t === outer.value) return 'outer';
  if (t === inner.value) return 'inner';
  if (t === hidden.value) return 'hidden';
  return '?';
}

function fmt(e: ResizeObserverEntry): string {
  const r = e.contentRect;
  const b = e.borderBoxSize[0];
  const c = e.contentBoxSize[0];
  const d = e.devicePixelContentBoxSize[0];
  return `${name(e.target)} rect ${r.x},${r.y},${r.width}x${r.height} ${r.top},${r.right},${r.bottom},${r.left} border ${b.inlineSize}x${b.blockSize} content ${c.inlineSize}x${c.blockSize} device ${d.inlineSize}x${d.blockSize}`;
}

onMounted(() => {
  const o = new ResizeObserver((entries, me) => {
    for (const e of entries) {
      log.value.push(`content ${fmt(e)} same ${me === o}`);
      if (e.target === outer.value) innerWidth.value = Math.floor(e.contentRect.width / 2);
    }
  });
  const bo = new ResizeObserver(entries => {
    log.value.push(`border ${entries.map(e => name(e.target)).join(' ')}`);
  });
  if (outer.value && inner.value && hidden.value) {
    o.observe(outer.value);
    o.observe(inner.value);
    o.observe(hidden.value);
    bo.observe(outer.value, { box: 'border-box' });
  }
  content.value = o;
  border.value = bo;
});

onUnmounted(() => {
  if (content.value) content.value.disconnect();
  if (border.value) border.value.disconnect();
});

function unobserve() {
  if (outer.value && content.value) content.value.unobserve(outer.value);
}
function observe() {
  if (outer.value && content.value) content.value.observe(outer.value);
}
function clear() {
  log.value = [];
}
function disconnect() {
  if (content.value) content.value.disconnect();
}
</script>

<template>
  <div id="app">
    <div class="controls">
      <button id="wider" @click="width += 40">Wider</button>
      <button id="show" @click="shown = !shown">Toggle hidden</button>
      <button id="unobserve" @click="unobserve">Unobserve</button>
      <button id="observe" @click="observe">Observe</button>
      <button id="disconnect" @click="disconnect">Disconnect</button>
      <button id="clear" @click="clear">Clear</button>
    </div>
    <div id="outer" ref="outer" :style="{ width: `${width}px` }">
      <div id="inner" ref="inner" :style="{ width: `${innerWidth}px` }"></div>
    </div>
    <div id="hidden" ref="hidden" :class="{ shown }"></div>
    <ol id="log">
      <li v-for="(line, i) in log" :key="i">{{ line }}</li>
    </ol>
  </div>
</template>
