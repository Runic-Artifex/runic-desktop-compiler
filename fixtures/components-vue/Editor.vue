<script setup lang="ts">
import { ref } from 'vue';
const value = defineModel<string>({ default: '' });
const edits = ref(0);
</script>
<template>
  <p><input id="name" aria-label="Name" type="text" :value="value" @input="value = $event.target.value; edits++" /></p>
  <p id="edits">Edits: {{ edits }}</p>
</template>
