<script setup lang="ts">
import { ref } from 'vue';
const log = ref<string[]>([]);
const stop = ref(false);
const locked = ref(true);
const agreed = ref(false);
const text = ref('');
const hovers = ref(0);
const inside = ref(false);
const doubles = ref(0);
const menus = ref(0);
const scrolled = ref(0);
const closed = ref(false);
const later = ref('');

// Logs every keydown: `.exact` takes the keys pressed without system
// modifiers and `.shift` those with Shift (the case presses no others).
function onKey(e: KeyboardEvent) {
  log.value.push(`${e.type}:${e.key}:${e.code}${e.shiftKey ? '+shift' : ''}${e.repeat ? '+repeat' : ''}`);
  if (e.key === 'x') e.preventDefault();
}
// Vue templates see setup bindings and a few globals, not setTimeout.
function onLate(e: MouseEvent) {
  setTimeout(() => (later.value = `${e.type} ${e.currentTarget === null} ${e.defaultPrevented}`), 0);
}
</script>

<template>
  <main><div id="outer" @click="log.push('outer')" @click.self="closed = true"><button id="inner" @click="(e: MouseEvent) => { log.push('inner'); if (stop) e.stopPropagation(); }">Inner</button></div> <div class="row"><button id="stop" @click.left="stop = !stop">Stop: {{ stop }}</button> <button id="lock" @click="locked = !locked" @click.middle="locked = !locked">Locked: {{ locked }}</button> <input id="agree" type="checkbox" aria-label="Agree" v-model="agreed" @click="(e) => { if (locked) e.preventDefault(); }" /></div> <div class="row"><input id="field" type="text" aria-label="Field" :value="text" @input="text = $event.target.value" @keydown.exact="onKey" @keydown.shift="onKey" @keyup="onKey" /> <button id="keep" @mousedown.prevent @click="log.push('keep')">Keep focus</button></div> <div id="box" @pointerenter="hovers++; inside = true" @pointerleave="inside = false" @dblclick="doubles++" @click.right.prevent="menus++" @wheel.prevent="scrolled += $event.deltaY">Box {{ hovers }} {{ inside }} {{ doubles }} {{ menus }} {{ scrolled }}</div> <div class="row"><button id="late" @click="onLate">Later</button> <button id="enter" @keydown.enter.prevent @click="log.push('enter-click')">No enter</button></div> <p id="state">{{ closed }} {{ agreed }} {{ text }} {{ later }}</p> <p id="log">{{ log.join(' ') }}</p></main>
</template>
