<script setup lang="ts">
import { watch } from 'vue';
const props = defineProps<{ b: number; note: (s: string) => void }>();
watch(
  () => props.b,
  (value, old) => props.note(`child b ${value} ${old}`),
);
</script>

<template>
  <p id="child">child: {{ b }}</p>
</template>
