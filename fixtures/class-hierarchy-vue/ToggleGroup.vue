<script setup lang="ts">
import { ref } from 'vue';
import { MultipleSelection, Selection, type AnySelection, type Item } from './selection';

const props = defineProps<{ type: 'single' | 'multiple'; name: string; items: Item[] }>();

// The selection class is chosen by the `type` prop.
const selection = ref<AnySelection>(Selection.create(props.type, props.name, props.items));

function toggle(value: string) {
  selection.value = selection.value.toggled(value);
}
function clear() {
  // The same instance through its base class.
  const base: Selection = selection.value;
  selection.value = base.cleared();
}
</script>

<template><section :id="`${name}-group`"><h2>{{ name }}</h2><div class="items"><button v-for="item in items" :key="item.value" :id="`${name}-${item.value}`" :class="{ on: selection.isPressed(item.value) }" :aria-pressed="selection.isPressed(item.value) ? 'true' : 'false'" @click="toggle(item.value)">{{ item.label }}</button><button :id="`${name}-clear`" @click="clear">clear</button></div><p :id="`${name}-summary`">{{ selection.summary }}</p><p :id="`${name}-detail`">{{ selection.kind === 'single' ? `value=${selection.value || '-'}` : `values=${selection.values.join('+') || '-'}` }}</p><p :id="`${name}-count`">{{ selection.pressedCount }} pressed, {{ selection.presses }} presses, {{ selection instanceof MultipleSelection ? 'multiple' : 'single' }}</p></section></template>
