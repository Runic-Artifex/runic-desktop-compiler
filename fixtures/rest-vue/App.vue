<script setup lang="ts">
import { ref } from 'vue';
import Button from './Button.vue';
import IconButton from './IconButton.vue';
const count = ref(0);
const busy = ref(false);
const title = ref<string | undefined>('First');
const log = ref<string[]>([]);
function toggle() {
  busy.value = !busy.value;
  title.value = busy.value ? undefined : 'Second';
}
</script>

<template>
  <main>
    <div class="row">
      <Button id="inc" @click="count++" aria-label="Increment" :title="title">Add</Button>
      <Button id="toggle" variant="outline" class="wide" @click="toggle">Toggle</Button>
      <IconButton id="icon" label="Icon" :disabled="busy" :data-count="count" @click="(e: MouseEvent) => log.push(e.type)" @pointerenter="log.push('enter')" />
    </div>
    <p id="state">{{ count }} {{ busy }}</p>
    <p id="log">{{ log.join(' ') }}</p>
  </main>
</template>
