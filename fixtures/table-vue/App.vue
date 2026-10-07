<script setup lang="ts">
import { ref } from 'vue';

interface Row {
  id: number;
  name: string;
  selected: boolean;
}

const rows = ref<Row[]>([
  { id: 1, name: 'Alpha', selected: false },
  { id: 2, name: 'Beta', selected: true },
  { id: 3, name: 'Gamma', selected: false },
]);
const next = ref(4);
const lastRow = ref('-');
const saved = ref('-');
const stopped = ref('-');
const wide = ref(false);

function add() {
  rows.value.push({ id: next.value, name: 'Added ' + next.value, selected: false });
  next.value += 1;
}

function remove(id: number) {
  rows.value = rows.value.filter((row) => row.id !== id);
}

function selectedCount() {
  return rows.value.filter((row) => row.selected).length;
}
</script>

<template>
  <main>
    <div class="controls">
      <button id="add" @click="add">Add</button>
      <button id="reverse" @click="rows = rows.toReversed()">Reverse</button>
      <button id="toggle-span" @click="wide = !wide">Toggle colspan</button>
    </div>

    <div id="pane" class="pane">
      <table id="table">
        <caption id="caption">Orders ({{ rows.length }})</caption>
        <colgroup><col class="name" /><col class="edit" /><col class="actions" /></colgroup>
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Selected</th><th scope="col">Actions</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :id="'row-' + row.id" :key="row.id" @click="lastRow = String(row.id)">
            <td><input :id="'name-' + row.id" :aria-label="'Name ' + row.id" v-model="row.name" /></td>
            <td><input :id="'selected-' + row.id" :aria-label="'Selected ' + row.id" type="checkbox" v-model="row.selected" /></td>
            <td>
              <button :id="'save-' + row.id" @click="saved = String(row.id)">Save</button>
              <button :id="'stop-' + row.id" @click.stop="stopped = String(row.id)">Stop</button>
              <button :id="'remove-' + row.id" @click="remove(row.id)">Remove</button>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr id="span-row">
            <td id="span" :colspan="wide ? 2 : 1">Span {{ wide ? 'wide' : 'narrow' }}</td>
            <td v-if="!wide">Detail</td>
            <td>{{ rows.length }} rows</td>
          </tr>
        </tfoot>
      </table>
    </div>

    <p id="state">row={{ lastRow }} save={{ saved }} stop={{ stopped }} selected={{ selectedCount() }}</p>
  </main>
</template>
