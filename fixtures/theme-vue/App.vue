<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue';
type Mode = 'system' | 'light' | 'dark';
const modes: Mode[] = ['system', 'light', 'dark'];
const palettes = ['runic', 'moss', 'fjord'];
const mode = ref<Mode>('system');
const palette = ref('runic');
const accent = ref(false);
const wide = matchMedia('(min-width: 600px)').matches;

function apply() {
  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = mode.value === 'dark' || (mode.value === 'system' && systemDark);
  document.documentElement.dataset.reducedMotion = String(matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (accent.value) document.documentElement.style.setProperty('--desktop-accent', 'rgb(32 80 160)');
  else document.documentElement.style.removeProperty('--desktop-accent');
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.dataset.theme = palette.value;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

watchEffect(() => {
  apply();
});
onMounted(() => {
  document.documentElement.lang = 'en';
  document.documentElement.dir = wide ? 'ltr' : 'auto';
});
</script>

<template>
  <main>
    <h1 id="title">Appearance</h1>
    <div class="row">
      <button id="mode" @click="mode = modes[(modes.indexOf(mode) + 1) % modes.length]">Mode</button>
      <button id="palette" @click="palette = palettes[(palettes.indexOf(palette) + 1) % palettes.length]">Palette</button>
      <button id="accent" @click="accent = !accent">Accent</button>
    </div>
    <p id="state">{{ mode }} {{ palette }} {{ accent }} {{ wide }}</p>
  </main>
</template>
