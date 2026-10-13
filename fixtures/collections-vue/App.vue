<script setup lang="ts">
// Deep refs make Maps, Sets and arrays they hold reactive, also nested in
// objects: reads in the template and in computed values update.
import { computed, ref } from 'vue';

const scores = ref(new Map<string, number>());
const tags = ref(new Set<string>());
const state = ref({ rows: [{ n: 1 }], byName: new Map<string, number>() });
const total = computed(() => {
  let t = 0;
  for (const v of scores.value.values()) t += v;
  return t;
});

function score() {
  scores.value.set('a', (scores.value.get('a') ?? 0) + 1);
}
function tag() {
  tags.value.add(`t${tags.value.size}`);
}
function nested() {
  state.value.rows.push({ n: state.value.rows.length + 1 });
  state.value.rows[0].n += 10;
  state.value.byName.set('x', state.value.rows.length);
}
</script>

<template>
  <main>
    <h1 id="title">Reactive collections</h1>
    <p id="scores">{{ scores.get('a') ?? 0 }} {{ scores.size }} {{ total }}</p>
    <p id="tags">{{ tags.size }} {{ tags.has('t0') }}</p>
    <p id="nested">{{ state.rows.length }} {{ state.rows[0].n }} {{ state.byName.get('x') ?? 0 }}</p>
    <div class="controls">
      <button id="score" @click="score">Score</button>
      <button id="tag" @click="tag">Tag</button>
      <button id="nest" @click="nested">Nested</button>
    </div>
  </main>
</template>
