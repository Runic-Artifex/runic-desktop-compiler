<script setup lang="ts">
// CSS animation and transition events (CSS slice 3b) through Vue's
// per-element listeners (@animationstart, ...), on virtual time: the same
// rows as animation-events-svelte, with script listeners (capture and
// bubble) next to the template's at an element and an ancestor. Every line carries the number of the
// animation frame callbacks run so far, so the order against the frame's
// callbacks shows (a listener's requestAnimationFrame runs in the same
// frame).
import { ref, onMounted, onUnmounted } from 'vue';

const log = ref('');
const on = ref(false);
const hidden = ref(false);
// Not rendered: the frame count only appears in the log lines.
const frames = ref(0);
const id = ref(0);
const b = ref<HTMLElement | null>(null);
const p = ref<HTMLElement | null>(null);

function add(line: string) {
  log.value = log.value + frames.value + ' ' + line + '\n';
}
function anim(e: AnimationEvent, who: string) {
  add(who + ' ' + e.type + ' ' + e.animationName + ' ' + e.elapsedTime + (e.pseudoElement === '' ? '' : ' ' + e.pseudoElement));
}
function trans(e: TransitionEvent) {
  add('t ' + e.type + ' ' + e.propertyName + ' ' + e.elapsedTime);
}
function end(e: AnimationEvent) {
  anim(e, 'a');
  requestAnimationFrame(() => add('a raf from listener'));
}
function onDocumentEnd(e: AnimationEvent) {
  anim(e, 'document');
}
function captureB(e: AnimationEvent) {
  anim(e, 'b capture');
}
function bubbleB(e: AnimationEvent) {
  anim(e, 'b script');
}
function captureP(e: AnimationEvent) {
  anim(e, 'p capture');
}
function tick() {
  frames.value = frames.value + 1;
  id.value = requestAnimationFrame(tick);
}
onMounted(() => {
  id.value = requestAnimationFrame(tick);
  document.addEventListener('animationend', onDocumentEnd);
  b.value!.addEventListener('animationend', captureB, true);
  b.value!.addEventListener('animationend', bubbleB);
  p.value!.addEventListener('animationcancel', captureP, true);
});
onUnmounted(() => {
  cancelAnimationFrame(id.value);
  document.removeEventListener('animationend', onDocumentEnd);
});
</script>
<template>
  <main>
    <div class="controls">
      <button id="toggle" @click="on = !on">toggle</button>
      <button id="hide" @click="hidden = !hidden">hide</button>
    </div>
    <div class="rows">
      <div class="row"><div id="a" class="box" @animationstart="anim($event, 'a')" @animationiteration="anim($event, 'a')" @animationend="end"></div></div>
      <div class="row"><div id="b" ref="b" class="box" @animationstart="anim($event, 'b')" @animationend="anim($event, 'b')"></div></div>
      <div class="row"><div id="c" class="box" @animationstart="anim($event, 'c')" @animationend="anim($event, 'c')"></div></div>
      <div class="row"><div id="e" class="box" @animationstart="anim($event, 'e')" @animationend="anim($event, 'e')"></div></div>
      <div class="row"><div id="t" :class="on ? 'box on' : 'box'" @transitionrun="trans" @transitionstart="trans" @transitionend="trans" @transitioncancel="trans"></div></div>
      <div id="p" ref="p" :class="hidden ? 'row hidden' : 'row'" @animationstart="anim($event, 'p')" @animationcancel="anim($event, 'p')">
        <div id="d" class="box"></div>
      </div>
    </div>
    <pre id="log">{{ log }}</pre>
  </main>
</template>
