<script setup lang="ts">
import ToggleGroup from './ToggleGroup.vue';

const items = [
  { value: 'b', label: 'Bold' },
  { value: 'i', label: 'Italic' },
  { value: 'u', label: 'Underline' },
];
</script>

<template><main><h1>Class hierarchy</h1><ToggleGroup type="single" name="align" :items="items" /><ToggleGroup type="multiple" name="format" :items="items" /></main></template>
