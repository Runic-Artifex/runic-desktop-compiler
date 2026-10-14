<script setup lang="ts">
import { watchEffect } from 'vue';
import Cell from './Cell.vue';

const props = defineProps<{ id: number; n: number; record: (line: string) => void }>();

// Runs at setup (as the diff mounts the item) and again when the parent's
// render updates the prop (as the diff patches the item).
watchEffect(() => {
  props.record(`row ${props.id} ${props.n}`);
});
</script>

<template>
  <p :id="'row-' + id">{{ id }} {{ n }} <Cell :n="n" /></p>
</template>
