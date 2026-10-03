<script lang="ts">
  import Entry from './Entry.svelte';
  import { matching, type Person } from './people.ts';

  let people = $state<Person[]>([
    { id: 1, name: 'Hans', surname: 'Emil' },
    { id: 2, name: 'Max', surname: 'Mustermann' },
    { id: 3, name: 'Roman', surname: 'Tisch' },
  ]);
  let next = $state(4);
  let prefix = $state('');
  let name = $state('');
  let surname = $state('');
  let selected = $state<number | null>(null);
  let shown = $derived(matching(people, prefix));
  let valid = $derived(name.trim() !== '' && surname.trim() !== '');

  function select(id: number) {
    selected = id;
    const p = people.find(x => x.id === id);
    if (p) {
      name = p.name;
      surname = p.surname;
    }
  }
  function create() {
    people.push({ id: next, name: name.trim(), surname: surname.trim() });
    selected = next;
    next += 1;
  }
  function update() {
    const p = people.find(x => x.id === selected);
    if (p) {
      p.name = name.trim();
      p.surname = surname.trim();
    }
  }
  function remove() {
    people = people.filter(x => x.id !== selected);
    selected = null;
    name = '';
    surname = '';
  }
</script>
<main>
  <h1>CRUD</h1>
  <p class="field filter">Filter prefix <input id="prefix" type="text" aria-label="Filter prefix" bind:value={prefix} /></p>
  <div class="grid">
    <ul class="list">
      {#each shown as person (person.id)}<Entry {person} selected={person.id === selected} onselect={select} />{/each}
    </ul>
    <div class="fields">
      <p class="field">Name <input id="name" type="text" aria-label="Name" bind:value={name} /></p>
      <p class="field">Surname <input id="surname" type="text" aria-label="Surname" bind:value={surname} /></p>
    </div>
  </div>
  <div class="row">
    <button id="create" disabled={!valid} onclick={create}>Create</button>
    <button id="update" disabled={selected === null || !valid} onclick={update}>Update</button>
    <button id="delete" disabled={selected === null} onclick={remove}>Delete</button>
  </div>
</main>
