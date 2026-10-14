<script setup lang="ts">
import { onBeforeUnmount, onUnmounted, onWatcherCleanup, watchEffect } from 'vue';
import Cell from './Cell.vue';

const props = defineProps<{ id: number; n: number; record: (line: string) => void }>();

watchEffect(() => {
  const n = props.n;
  props.record(`row ${props.id} ${n}`);
  onWatcherCleanup(() => props.record(`cleanup ${props.id} ${n}`));
});
onBeforeUnmount(() => props.record(`destroy ${props.id}`));
onUnmounted(() => props.record(`unmounted ${props.id}`));
</script>

<template>
  <p :id="'row-' + id">{{ id }} {{ n }} <Cell :id="id" :n="n" :record="record" /></p>
</template>
