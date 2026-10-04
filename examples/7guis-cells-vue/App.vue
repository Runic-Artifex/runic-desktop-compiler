<script setup lang="ts">
import { ref } from 'vue';
import { COLUMNS, cellName, columnName, columns, commit, display, emptySheet, rows } from './sheet.ts';

// Every cell is a text input showing its value; focusing one (a click or
// Tab) edits its formula in place, and leaving it (Enter or blur) commits.
const cells = ref(emptySheet());
const editing = ref(-1);
const draft = ref('');

function start(i: number) {
  editing.value = i;
  draft.value = cells.value[i].formula;
}

function finish(i: number) {
  if (editing.value !== i) return;
  editing.value = -1;
  if (draft.value !== cells.value[i].formula) cells.value = commit(cells.value, i, draft.value);
}

function key(e: KeyboardEvent) {
  if (e.key === 'Enter') (e.target as HTMLInputElement | null)?.blur();
}
</script>

<template>
  <main>
    <h1>Cells</h1>
    <div id="sheet" class="sheet">
      <div class="row">
        <div class="corner"></div>
        <div v-for="c in columns" :key="c" class="head">{{ columnName(c) }}</div>
      </div>
      <div v-for="r in rows" :key="r" class="row">
        <div class="side">{{ r }}</div>
        <input
          v-for="c in columns"
          :key="c"
          :id="cellName(r * COLUMNS + c)"
          type="text"
          :class="cells[r * COLUMNS + c].kind === 'error' ? 'cell error' : 'cell'"
          :value="editing === r * COLUMNS + c ? draft : display(cells[r * COLUMNS + c])"
          @focus="start(r * COLUMNS + c)"
          @input="draft = $event.target.value"
          @keydown="key"
          @blur="finish(r * COLUMNS + c)"
        />
      </div>
    </div>
  </main>
</template>
