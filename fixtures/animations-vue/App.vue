<script setup>
import { ref } from 'vue';
const moved = ref(false);
const open = ref(false);
</script>
<template>
  <main>
    <h1 id="heading">Animations</h1>
    <div id="badges" class="badges"><span class="badge">New</span></div>
    <button id="tint" class="tint">Hover me</button>
    <div class="controls">
      <button id="move" @click="moved = !moved">Move</button>
      <button id="open" @click="open = !open">{{ open ? 'Close' : 'Open' }}</button>
    </div>
    <div id="stage" class="stage"><div :class="moved ? 'box moved' : 'box'"></div></div>
    <div id="loaders" class="row"><div class="spinner"></div><div class="pulse"></div></div>
    <div id="panels" class="panels"><div v-if="open" class="panel">Panel content</div></div>
  </main>
</template>
