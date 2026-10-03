<script setup lang="ts">
import { ref } from 'vue';
import { MODES, reorder } from './order.ts';
const items = ref<number[]>([1, 2, 3, 4, 5, 6]);
const mode = ref('reverse');
</script>
<template><main><p id="mode">Mode: {{ mode }}</p><div class="modes"><button v-for="m in MODES" :key="m" :id="`mode-${m}`" @click="mode = m">{{ m }}</button></div><ul><li v-for="x in items" :key="x"><button :id="`item-${x}`" @click="items = reorder(items, mode, x)">Item {{ x }}</button></li></ul></main></template>
