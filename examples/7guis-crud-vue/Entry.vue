<script setup lang="ts">
import { display, type Person } from './people.ts';
const { person, selected } = defineProps<{ person: Person; selected: boolean }>();
const emit = defineEmits<{ select: [id: number] }>();
</script>
<template>
  <li><button :id="`person-${person.id}`" :class="selected ? 'selected' : ''" :aria-pressed="selected ? 'true' : 'false'" @click="emit('select', person.id)">{{ display(person) }}</button></li>
</template>
