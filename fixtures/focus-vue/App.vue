<script setup lang="ts">
import { ref, useTemplateRef } from 'vue';
const log = ref<string[]>([]);
const field = useTemplateRef<HTMLInputElement>('field');

function activate() {
  log.value.push('a-click');
  field.value?.focus();
  log.value.push('a-after');
}
</script>

<template>
  <main @focusout="log.push('main-out')" @focusin.self="log.push('main-in')">
    <div class="row" @focusin="log.push('row-in')" @focusout.stop="log.push('row-out')">
      <button id="a" @focus="log.push('a-focus')" @blur="log.push('a-blur')" @click="activate">A</button>
      <input id="field" ref="field" type="text" aria-label="Field" @focus="log.push(`field-focus ${$event.relatedTarget !== null}`)" @blur="log.push('field-blur')" />
      <div id="box" tabindex="0" @focus.prevent="log.push('box-focus')" @blur="(e: FocusEvent) => log.push(`box-blur ${e.relatedTarget === null}`)">Box</div>
    </div>
    <p id="plain">Plain</p>
    <p id="log">{{ log.join(' ') }}</p>
  </main>
</template>
