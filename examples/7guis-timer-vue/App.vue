<script setup lang="ts">
import { ref, watchEffect } from 'vue';
const elapsed = ref(0);
const duration = ref(5000);
const segments = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
watchEffect(onCleanup => {
  const id = setInterval(() => {
    if (elapsed.value < duration.value)
      elapsed.value = Math.min(elapsed.value + 100, duration.value);
  }, 100);
  onCleanup(() => clearInterval(id));
});
</script>

<template>
  <main>
    <h1>Timer</h1>
    <div class="row">
      <span>Elapsed time:</span>
      <div id="gauge" class="gauge">
        <div
          v-for="i in segments"
          :key="i"
          :class="elapsed * 10 >= (i + 1) * duration ? 'segment on' : 'segment'"
        ></div>
      </div>
    </div>
    <p id="elapsed">{{ (elapsed / 1000).toFixed(1) }}s</p>
    <div class="row">
      <span>Duration:</span
      ><button id="shorter" @click="duration = Math.max(1000, duration - 1000)">−1s</button
      ><span id="duration">{{ duration / 1000 }}s</span
      ><button id="longer" @click="duration += 1000">+1s</button>
    </div>
    <div class="row"><button id="reset" @click="elapsed = 0">Reset</button></div>
  </main>
</template>
