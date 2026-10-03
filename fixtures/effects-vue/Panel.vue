<script setup lang="ts">
import Child from './Child.vue';
defineProps<{ count: number; note: (s: string) => void }>();
</script>

<template>
  <Child name="A" :count="count" :note="note" /><Child name="B" :count="count" :note="note" />
</template>
