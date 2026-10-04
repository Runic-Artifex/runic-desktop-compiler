<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { ROW, matching, clamp, first, last, describe } from './rows.ts';

// A virtualized list: 10,000 rows of a fixed height, of which only the
// rows in view (plus a few above and below) are in the document.
const filter = ref('');
const scrollTop = ref(0);
const height = ref(0);
const selected = ref<number | null>(null);
const list = ref<HTMLDivElement | null>(null);

const rows = computed(() => matching(filter.value));
const top = computed(() => clamp(scrollTop.value, rows.value.length, height.value));
const start = computed(() => first(top.value));
const end = computed(() => last(top.value, height.value, rows.value.length));
const visible = computed(() => rows.value.slice(start.value, end.value));
const spacer = computed(() => rows.value.length * ROW);
const offset = computed(() => start.value * ROW);
const status = computed(() => describe(selected.value));

function measure() {
  scrollTop.value = list.value!.scrollTop;
  height.value = list.value!.clientHeight;
}
onMounted(() => measure());

function jump() {
  const i = rows.value.findIndex(r => r.id === 5000);
  if (i < 0) return;
  selected.value = 5000;
  list.value!.scrollTop = i * ROW;
}
</script>

<template>
  <main>
    <!-- First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). -->
    <div id="list" ref="list" @scroll="measure">
      <div class="spacer" :style="{ height: `${spacer}px`, paddingTop: `${offset}px` }">
        <button
          v-for="row in visible"
          :key="row.id"
          :id="`row-${row.id}`"
          class="row"
          :class="{ even: row.id % 2 === 0, selected: row.id === selected }"
          @click="selected = row.id"
        >
          <span class="id">{{ row.id }}</span>{{ row.label }} · {{ row.kind }}
        </button>
      </div>
    </div>
    <div class="bar">
      <input id="filter" type="text" aria-label="Filter" :value="filter" @input="filter = ($event.target as HTMLInputElement).value" />
      <button id="jump" @click="jump">Jump to 5,000</button>
    </div>
    <p id="status">{{ status }} · {{ rows.length }} rows, rendering {{ start + 1 }}–{{ end }}</p>
  </main>
</template>
