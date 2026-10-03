<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>

<template>
  <main>
    <h1>Counter</h1>
    <div class="row">
      <input id="value" type="text" readonly :value="count" />
      <button id="count" @click="count++">Count</button>
    </div>
  </main>
</template>
