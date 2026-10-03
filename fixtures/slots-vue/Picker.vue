<script setup lang="ts">
import { ref, computed } from 'vue';
interface Item { id: number; name: string }
const { items } = defineProps<{ items: Item[] }>();
const descending = ref(false);
const shown = computed(() => (descending.value ? items.toReversed() : items));
</script>
<template>
<ul><li v-for="(item, i) in shown" :key="item.id"><slot name="row" :item="item" :first="i === 0" /></li></ul>
<button id="order" @click="descending = !descending">{{ descending ? 'Ascending' : 'Descending' }}</button>
</template>
