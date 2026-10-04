<script setup lang="ts">
import { ref } from 'vue';
const color = ref<string | undefined>('rgb(32, 80, 160)');
const width = ref(120);
const base = ref('margin: 4px;  PADDING:6px');
const tone = ref('#dfe7f0');

function recolor() {
  if (color.value) color.value = undefined;
  else color.value = 'rgb(32, 80, 160)';
}
</script>

<template>
  <main>
    <div class="row">
      <button id="color" @click="recolor">Color</button>
      <button id="wider" @click="width += 20">Wider</button>
      <button id="base" @click="base = base.startsWith('margin') ? 'padding: 2px; color: green' : 'margin: 4px;  PADDING:6px'">Base</button>
      <button id="tone" @click="tone = tone === '#dfe7f0' ? '#f0e7df' : '#dfe7f0'">Tone</button>
    </div>
    <p id="directive" :style="{ color, width: `${width}px` }">Directive</p>
    <p id="text" :style="base">Text</p>
    <p id="both" style="border: 1px solid #52665b" :style="{ backgroundColor: tone }">Both</p>
    <p id="static" style="color: RED; margin-top: 4px">Static</p>
    <p id="mixed" :style="[{ 'margin-left': '2px', color }, 'padding: 1px /* a; b */', { '--accent': tone, borderColor: color, border: '1px solid' }]">Mixed</p>
    <p id="important" :style="{ color: color ? `${color} !important` : 'gray', opacity: width / 200 }">Important</p>
    <div id="legend" class="row"><span style="color: RED">1</span><span style="font-weight: 700">2</span><span style="color: green">3</span><span style="PADDING: 2px">4</span><span style="margin-left: 2px">5</span></div>
  </main>
</template>
