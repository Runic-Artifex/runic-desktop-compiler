<script setup lang="ts">
// A deep ref's contents read and written through aliases: `state.value` is
// Vue's reactive proxy, and reads through it are dependencies wherever it is
// held (a constant, a plain object's field, a function).
import { ref } from 'vue';

type Counter = { count: number; items: number[] };
const state = ref<Counter>({ count: 0, items: [] });
const alias = state.value;
const holder = { counter: state.value };
function shown() {
  return alias.count;
}
function bump() {
  state.value.count += 1;
}
function add() {
  state.value.items.push(state.value.items.length);
}
</script>

<template>
  <main>
    <h1 id="title">Alias reads</h1>
    <p id="owner">{{ state.count }} {{ state.items.length }}</p>
    <p id="alias">{{ alias.count }} {{ alias.items.length }}</p>
    <p id="holder">{{ holder.counter.count }}</p>
    <p id="fn">{{ shown() }}</p>
    <div class="controls">
      <button id="bump" @click="bump">Bump</button>
      <button id="add" @click="add">Add</button>
    </div>
  </main>
</template>
