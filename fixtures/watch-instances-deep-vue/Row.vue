<script setup lang="ts">
import { watch } from 'vue';

const props = defineProps<{ id: number; state: { n: number }; record: (line: string) => void }>();

watch(
  () => props.state.n,
  v => props.record(`row ${props.id} ${v}`),
);
</script>

<template>
  <p :id="'row-' + id">{{ id }} {{ state.n }}</p>
</template>
