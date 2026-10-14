<script setup>
import { ref } from 'vue';
const marked = ref(false);
const unfilled = ref(false);
const hidden = ref(false);
const renamed = ref(false);
</script>
<template>
  <main>
    <div class="controls">
      <button id="mark" @click="marked = !marked">Mark</button>
      <button id="unfill" @click="unfilled = !unfilled">Unfill</button>
      <button id="toggle" @click="hidden = !hidden">Hide</button>
      <button id="swap" @click="renamed = !renamed">Rename</button>
    </div>
    <div id="rows" :class="marked ? 'rows marked' : 'rows'">
      <div id="row-fwd" class="row"><div id="fwd" class="box"></div></div>
      <div id="row-both" class="row"><div id="both" class="box"></div></div>
      <div id="row-alt" class="row"><div id="alt" class="box"></div></div>
      <div id="row-var" class="row"><div id="var" class="box"></div></div>
      <div id="row-unfilled" class="row"><div id="unfilled" class="box" :style="{ animationFillMode: unfilled ? 'none' : 'forwards' }"></div></div>
      <div id="row-inline" class="row"><div id="inline" class="box" :style="{ animationFillMode: 'both' }"></div></div>
      <div id="row-hide" class="row"><div id="hide" :class="hidden ? 'box hidden' : 'box'"></div></div>
      <div id="row-rename" class="row"><div id="rename" :class="renamed ? 'box renamed' : 'box'"></div></div>
    </div>
  </main>
</template>
