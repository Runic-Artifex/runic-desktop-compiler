<script setup lang="ts">
import { ref } from 'vue';
const { id, label, first } = defineProps<{ id: number; label: string; first: boolean }>();
const emit = defineEmits<{ remove: [id: number]; up: [id: number] }>();
const clicks = ref(0);
</script>
<template>
  <li :id="`row-${id}`"><span :id="`label-${id}`">{{ label }} ({{ clicks }})</span><button :id="`count-${id}`" @click="clicks++">+1</button><button :id="`up-${id}`" :disabled="first" @click="emit('up', id)">Up</button><button :id="`remove-${id}`" @click="emit('remove', id)">Remove</button></li>
</template>
