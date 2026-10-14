<script setup lang="ts">
import { onBeforeUnmount } from 'vue';

const props = defineProps<{ id: number; n: number; record: (line: string) => void }>();

onBeforeUnmount(() => props.record(`cell destroy ${props.id}`));
</script>

<template>
  <span>{{ n % 2 === 0 ? 'even' : 'odd' }}</span>
</template>
