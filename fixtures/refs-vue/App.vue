<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
const input = useTemplateRef<HTMLInputElement>('field');
const details = ref<HTMLButtonElement | null>(null);
const text = ref('');
const show = ref(true);
const status = ref('unchecked');
function focusField() {
  input.value?.focus();
}
function check() {
  status.value = details.value === null || details.value === undefined ? 'details gone' : 'details mounted';
}
</script>
<template>
<main><h1 id="title">Refs</h1>
<p><input id="field" aria-label="Field" type="text" ref="field" :value="text" @input="text = $event.target.value" @keydown.esc="input!.blur()" /></p>
<p id="echo">Text: {{ text }}</p>
<div class="controls"><button id="focus" @click="focusField">Focus field</button><button id="toggle" @click="show = !show">Toggle</button><button id="check" @click="check">Check</button><button id="focus-details" @click="details?.focus()">Focus details</button><button id="hide-focus" @click="show = false; details?.focus()">Hide and focus</button></div>
<p v-if="show"><button id="details" ref="details">Details</button></p>
<p id="status">{{ status }}</p>
</main>
</template>
