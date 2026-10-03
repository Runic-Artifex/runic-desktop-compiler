<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
import Field from './Field.vue';
const field = useTemplateRef<InstanceType<typeof Field>>('field');
const name = ref('');
const shown = ref(true);
</script>

<template>
  <main>
    <div v-if="shown" class="row"><Field ref="field" v-model="name" id="name" aria-label="Name" /></div>
    <div class="row">
      <button id="focus" @click="field?.input?.focus()">Focus</button>
      <button id="toggle" @click="shown = !shown">Toggle</button>
    </div>
    <p id="state">{{ field ? 'ref' : 'none' }} {{ name }}</p>
  </main>
</template>
