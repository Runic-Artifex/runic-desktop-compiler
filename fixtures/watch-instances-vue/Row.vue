<script setup lang="ts">
import { watch } from 'vue';

const props = defineProps<{ id: number; n: number; record: (line: string) => void }>();

// Triggered by the parent's render updating the prop: Vue runs it while it
// patches this instance (updateComponentPreRender), in document order.
watch(
  () => props.n,
  v => props.record(`row ${props.id} ${v}`),
);
</script>

<template>
  <p :id="'row-' + id">{{ id }} {{ n }}</p>
</template>
