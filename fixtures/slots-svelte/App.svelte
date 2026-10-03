<script lang="ts">
  import Card from './Card.svelte';
  import Picker from './Picker.svelte';
  import Tally from './Tally.svelte';
  let items = $state([{ id: 1, name: 'Apple' }, { id: 2, name: 'Pear' }, { id: 3, name: 'Plum' }]);
  let picked = $state(0);
  let note = $state('none');
  function pick(id: number) { picked = id; }
</script>
<main><h1 id="title">Slots</h1>
<Card title="plain"><p id="plain-body">Picked {picked}</p></Card>
<Card title="fancy">
  {#snippet header(t)}<span id="fancy-header">Header for {t}</span>{/snippet}
  <p id="fancy-body">Note: {note}</p>
  <button id="note" onclick={() => note = note === 'none' ? 'set' : 'none'}>Note</button>
</Card>
<Picker {items}>
  {#snippet row(item, first)}<span id={`name-${item.id}`}>{first ? '* ' : ''}{item.name}</span><button id={`pick-${item.id}`} disabled={picked === item.id} onclick={() => pick(item.id)}>Pick</button><Tally id={item.id} />{/snippet}
</Picker>
<button id="drop" onclick={() => items = items.slice(1)}>Drop first</button>
</main>
