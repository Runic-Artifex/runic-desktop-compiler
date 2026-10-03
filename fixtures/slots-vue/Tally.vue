<script setup lang="ts">
import { ref } from 'vue';
const { id } = defineProps<{ id: number }>();
const n = ref(0);
</script>
<template><button :id="`tally-${id}`" @click="n += 1">{{ n }}</button></template>
