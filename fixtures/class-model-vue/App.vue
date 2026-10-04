<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { Stack, Tally } from './model';

const count = ref(0);
const summary = ref('');
const stack = ref(Stack.empty());
const first = stack.value;
const tally = Tally.create(3, (c, s) => {
  count.value = c;
  summary.value = s;
});
// A bound method and an arrow function field used as listeners.
const increment = tally.increment;
const decrement = tally.decrement;

/** A class declared in the component script. */
class Labeller {
  #prefix: string;
  constructor(prefix: string) {
    this.#prefix = prefix;
  }
  label(n: number): string {
    return `${this.#prefix}${n}`;
  }
}
const labeller = new Labeller('#');

function push() {
  stack.value = stack.value.push(labeller.label(count.value));
}
function pop() {
  stack.value = stack.value.pop();
}
function reset() {
  tally.count = 0;
}

onMounted(() => window.addEventListener('keydown', tally.onKey));
onUnmounted(() => window.removeEventListener('keydown', tally.onKey));
</script>

<template><main><h1 id="title">Classes</h1>
<p id="count">{{ count }}</p>
<p id="summary">{{ summary }}</p>
<p id="stack">{{ stack.size }} items, top {{ stack.top }}{{ stack === first ? ' (initial)' : '' }}</p>
<p id="limit">Limit {{ Tally.LIMIT }}{{ count >= Tally.LIMIT ? ' reached' : '' }}</p>
<div class="controls"><button id="increment" @click="increment">Increment</button><button id="decrement" @click="decrement">Decrement</button><button id="push" @click="push" :disabled="stack.includes(labeller.label(count))">Push</button><button id="pop" @click="pop" :disabled="stack.size === 0">Pop</button><button id="reset" @click="reset">Reset</button></div>
</main></template>
