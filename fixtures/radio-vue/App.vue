<script setup lang="ts">
import { ref } from 'vue';
const size = ref('m');
const log = ref<string[]>([]);
const locked = ref(false);
function guard(e: MouseEvent) {
  if (locked.value) e.preventDefault();
}
</script>

<template>
  <main>
    <div class="row">
      <button id="before">Before</button>
      <label id="s-label"><input id="s" type="radio" name="size" value="s" v-model="size" @change="log.push('s')" /> Small</label>
      <label id="m-label"><input id="m" type="radio" name="size" value="m" v-model="size" @change="log.push('m')" /> Medium</label>
      <label id="l-label"><input id="l" type="radio" name="size" value="l" v-model="size" disabled /> Large</label>
      <label id="xl-label"><input id="xl" type="radio" name="size" :value="'xl'" v-model="size" @click="guard" @change="log.push('xl')" /> Extra</label>
    </div>
    <div class="row">
      <button id="after">After</button>
      <button id="lock" @click="locked = !locked">Lock</button>
      <button id="pick" @click="size = 's'">Pick small</button>
    </div>
    <p id="state">{{ size }} {{ locked }}</p>
    <p id="log">{{ log.join(' ') }}</p>
  </main>
</template>
