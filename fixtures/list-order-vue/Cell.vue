<script setup lang="ts">
defineProps<{ n: number }>();
</script>

<template>
  <span>{{ n % 2 === 0 ? 'even' : 'odd' }}</span>
</template>
