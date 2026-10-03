<script lang="ts">
  import { display, type Person } from './people.ts';
  let { person, selected, onselect }: { person: Person; selected: boolean; onselect: (id: number) => void } = $props();
</script>
<li><button id={`person-${person.id}`} class={selected ? 'selected' : ''} aria-pressed={selected ? 'true' : 'false'} onclick={() => onselect(person.id)}>{display(person)}</button></li>
