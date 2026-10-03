<script setup lang="ts">
// Attributes and listeners the parent passes beyond `variant` fall through
// to the root <button>; a passed class joins the button's own.
const { variant = 'default' } = defineProps<{ variant?: string }>();
</script>

<template>
  <button :class="`btn ${variant}`" type="button"><slot /></button>
</template>
