<script setup lang="ts">
// Vue's template listeners are native listeners at their elements, added
// when Vue creates the element: listeners script adds after mount run after
// them at the same element and phase, in registration order (IR
// schedule.elementListeners). Nested dispatches (dispatchEvent and
// requestSubmit from a listener) follow the same order. Each dispatch here
// comes from a task later than the elements' creation, so Vue's
// attach-timestamp guard skips no invoker (the second and later invokers an
// event reaches run).
import { onBeforeUnmount, onMounted, ref } from 'vue';

const log = ref('ready');
const mode = ref('open');
const outer = ref<HTMLElement | null>(null);
const inner = ref<HTMLElement | null>(null);
const target = ref<HTMLElement | null>(null);
const other = ref<HTMLElement | null>(null);
const form = ref<HTMLElement | null>(null);

function note(s: string) {
  log.value = (log.value === 'ready' ? s : log.value + ' ' + s).slice(-480);
}
function select(m: string) {
  mode.value = m;
  log.value = 'ready';
}
function templateTarget(e: MouseEvent) {
  note('tt');
  if (mode.value === 'immediate') e.stopImmediatePropagation();
}
function templateInner() {
  note('ti');
}
function templateOuter() {
  note('to');
}
function scriptTarget() {
  note('st');
}
function scriptTargetCapture() {
  note('stc');
}
function scriptInner(e: Event) {
  note('si');
  if (mode.value === 'inner-stop') e.stopPropagation();
}
function scriptOuterCapture(e: Event) {
  note('soc');
  if (mode.value === 'capture-stop') e.stopPropagation();
}
function templateOther() {
  note('tx');
}
function templateSection() {
  note('ts');
}
function scriptOther() {
  note('sx');
}
function nestedClick() {
  note('n<');
  other.value?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  note('>n');
}
function nestedSubmit() {
  note('r<');
  form.value?.requestSubmit();
  note('>r');
}
function templateSubmit(e: Event) {
  e.preventDefault();
  note('tf');
}
function scriptSubmit() {
  note('sf');
}
function microtask() {
  queueMicrotask(() => note('m'));
}

function attach() {
  target.value?.addEventListener('click', scriptTarget);
  target.value?.addEventListener('click', scriptTargetCapture, true);
  target.value?.addEventListener('click', microtask);
  inner.value?.addEventListener('click', scriptInner);
  outer.value?.addEventListener('click', scriptOuterCapture, true);
  other.value?.addEventListener('click', scriptOther);
  form.value?.addEventListener('submit', scriptSubmit);
}
function detach() {
  target.value?.removeEventListener('click', scriptTarget);
  target.value?.removeEventListener('click', scriptTargetCapture, true);
  target.value?.removeEventListener('click', microtask);
  inner.value?.removeEventListener('click', scriptInner);
  outer.value?.removeEventListener('click', scriptOuterCapture, true);
  other.value?.removeEventListener('click', scriptOther);
  form.value?.removeEventListener('submit', scriptSubmit);
}
onMounted(() => attach());
onBeforeUnmount(() => detach());
</script>

<template>
  <main>
    <section>
      <button id="mode-open" type="button" @click="select('open')">Open</button>
      <button id="mode-inner-stop" type="button" @click="select('inner-stop')">Stop at inner</button>
      <button id="mode-capture-stop" type="button" @click="select('capture-stop')">Stop in capture</button>
      <button id="mode-immediate" type="button" @click="select('immediate')">Immediate at target</button>
    </section>
    <div id="outer" ref="outer" @click="templateOuter">
      <section id="inner" ref="inner" @click="templateInner">
        <button id="target" ref="target" type="button" @click="templateTarget">
          Target
        </button>
        <button id="nested-click" type="button" @click="nestedClick">Nested click</button>
        <button id="nested-submit" type="button" @click="nestedSubmit">Nested submit</button>
      </section>
    </div>
    <section id="section" @click="templateSection">
      <button id="other" ref="other" type="button" @click="templateOther">Other</button>
      <form id="form" ref="form" @submit="templateSubmit">
        <button id="physical" type="submit">Submit</button>
      </form>
    </section>
    <p id="mode">{{ mode }}</p>
    <p id="log">{{ log }}</p>
  </main>
</template>
