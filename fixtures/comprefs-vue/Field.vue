<script setup lang="ts">
import { useAttrs, useTemplateRef } from 'vue';
// The parent reaches the input through the exposed template ref; the other
// attributes it passes are bound to the input.
defineOptions({ inheritAttrs: false });
const value = defineModel<string>({ default: '' });
const attrs = useAttrs();
const input = useTemplateRef<HTMLInputElement>('input');
defineExpose({ input });
</script>

<template>
  <input ref="input" :value="value" @input="value = $event.target.value" type="text" v-bind="attrs" />
</template>
