<script setup lang="ts">
// The watcher after the watchEffect depends on a record field reached
// through a prop, which the watchEffect reads in every run: a write of the
// field notifies both, the watchEffect first; the prop n, which only the
// watchEffect reads, is updated by the parent's render.
import { watch, watchEffect } from 'vue';

const props = defineProps<{
  state: { a: { b: number } };
  n: number;
  record: (line: string) => void;
}>();

watchEffect(() => {
  props.record(`child effect ${props.n} ${props.state.a.b}`);
});
watch(
  () => props.state.a.b,
  v => props.record(`child watch ${v}`),
);
</script>

<template>
  <p id="child">{{ state.a.b }} {{ n }}</p>
</template>
