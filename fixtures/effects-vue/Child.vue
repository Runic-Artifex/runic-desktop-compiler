<script setup lang="ts">
import { watch, watchEffect, onMounted, onBeforeUnmount, onUnmounted, onWatcherCleanup } from 'vue';
const props = defineProps<{ name: string; count: number; note: (s: string) => void }>();
watchEffect(() => {
  props.note(`${props.name} pre ${props.count}`);
  onWatcherCleanup(() => props.note(`${props.name} pre cleanup`));
});
watch(
  () => props.count * 2,
  (double, old, onCleanup) => {
    props.note(`${props.name} watch ${double} ${old}`);
    onCleanup(() => props.note(`${props.name} watch cleanup ${double}`));
  },
  { immediate: true },
);
onMounted(() => props.note(`${props.name} mount`));
onBeforeUnmount(() => props.note(`${props.name} before unmount`));
onUnmounted(() => props.note(`${props.name} unmount`));
</script>

<template>
  <p :id="'child-' + name">{{ name }}: {{ count }}</p>
</template>
