<script setup lang="ts">
import Button from './Button.vue';
// The attributes beyond `label` are forwarded explicitly to <Button>, and fall
// through from there to its <button>.
defineOptions({ inheritAttrs: false });
defineProps<{ label: string }>();
</script>

<template>
  <Button variant="ghost" v-bind="$attrs">{{ label }}</Button>
</template>
