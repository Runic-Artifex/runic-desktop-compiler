<script setup lang="ts">
// At unmount the props are those of the child's last render (the parent's
// update unmounts it rather than patching it); what they hold is live.
import { onBeforeUnmount, onUnmounted, watchEffect, onWatcherCleanup } from 'vue';

const props = defineProps<{
  state: { count: number };
  n: number;
  record: (line: string) => void;
}>();

watchEffect(() => {
  const seen = props.n;
  onWatcherCleanup(() => props.record(`child cleanup ${seen}/${props.n} ${props.state.count}`));
});
onBeforeUnmount(() => props.record(`before unmount ${props.state.count} ${props.n}`));
onUnmounted(() => props.record(`unmounted ${props.state.count} ${props.n}`));
</script>

<template>
  <p id="child">{{ state.count }} {{ n }}</p>
</template>
