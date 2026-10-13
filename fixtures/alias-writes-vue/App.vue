<script setup lang="ts">
// A deep ref's contents written through aliases: `state.value` is Vue's
// reactive proxy, so writes through a constant holding it, a function's
// parameter given it and a function's result returning it are tracked and
// update the ref's readers. After the ref is given a new object, the
// constant still holds the old one: writes through it update its own
// readers only.
import { ref } from 'vue';

type Counter = { count: number; items: number[] };
const state = ref<Counter>({ count: 0, items: [] });
const alias = state.value;
function current(): Counter {
  return state.value;
}
function grow(c: Counter) {
  c.items.push(c.count);
}
function bump() {
  alias.count += 1;
}
function add() {
  grow(state.value);
}
function twice() {
  current().count *= 2;
}
function replace() {
  state.value = { count: 10, items: [7] };
}
</script>

<template>
  <main>
    <h1 id="title">Alias writes</h1>
    <p id="owner">{{ state.count }} {{ state.items.join(',') }}</p>
    <p id="alias">{{ alias.count }} {{ alias.items.length }}</p>
    <div class="controls">
      <button id="bump" @click="bump">Bump</button>
      <button id="add" @click="add">Add</button>
      <button id="twice" @click="twice">Twice</button>
      <button id="replace" @click="replace">Replace</button>
    </div>
  </main>
</template>
