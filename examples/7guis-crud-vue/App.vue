<script setup lang="ts">
import { ref, computed } from 'vue';
import Entry from './Entry.vue';
import { matching, type Person } from './people.ts';

const people = ref<Person[]>([
  { id: 1, name: 'Hans', surname: 'Emil' },
  { id: 2, name: 'Max', surname: 'Mustermann' },
  { id: 3, name: 'Roman', surname: 'Tisch' },
]);
const next = ref(4);
const prefix = ref('');
const name = ref('');
const surname = ref('');
const selected = ref<number | null>(null);
const shown = computed(() => matching(people.value, prefix.value));
const valid = computed(() => name.value.trim() !== '' && surname.value.trim() !== '');

function select(id: number) {
  selected.value = id;
  const p = people.value.find(x => x.id === id);
  if (p) {
    name.value = p.name;
    surname.value = p.surname;
  }
}
function create() {
  people.value.push({ id: next.value, name: name.value.trim(), surname: surname.value.trim() });
  selected.value = next.value;
  next.value += 1;
}
function update() {
  const p = people.value.find(x => x.id === selected.value);
  if (p) {
    p.name = name.value.trim();
    p.surname = surname.value.trim();
  }
}
function remove() {
  people.value = people.value.filter(x => x.id !== selected.value);
  selected.value = null;
  name.value = '';
  surname.value = '';
}
</script>
<template>
  <main>
    <h1>CRUD</h1>
    <p class="field filter">Filter prefix <input id="prefix" type="text" aria-label="Filter prefix" :value="prefix" @input="prefix = $event.target.value" /></p>
    <div class="grid">
      <ul class="list">
        <Entry v-for="person in shown" :key="person.id" :person="person" :selected="person.id === selected" @select="select" />
      </ul>
      <div class="fields">
        <p class="field">Name <input id="name" type="text" aria-label="Name" :value="name" @input="name = $event.target.value" /></p>
        <p class="field">Surname <input id="surname" type="text" aria-label="Surname" :value="surname" @input="surname = $event.target.value" /></p>
      </div>
    </div>
    <div class="row">
      <button id="create" :disabled="!valid" @click="create">Create</button>
      <button id="update" :disabled="selected === null || !valid" @click="update">Update</button>
      <button id="delete" :disabled="selected === null" @click="remove">Delete</button>
    </div>
  </main>
</template>
