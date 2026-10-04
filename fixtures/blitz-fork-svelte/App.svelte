<script lang="ts">
  // One section per patch of the Blitz fork (docs/BLITZ-GAPS.md).
  let above = $state(0);
  let picked = $state('none');
  let chosen = $state('none');
  let draft = $state('');
  let enabled = $state(false);
  let items = $state(['one', 'two']);
  let target = $state<HTMLButtonElement | null>(null);
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const tags = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India'];
</script>

<main>
  <section id="hit">
    <button id="above" onclick={() => above++}>Toolbar {above}</button>
    <div id="list">
      {#each rows as r (r)}
        <button id={`row-${r}`} class="row" onclick={() => (picked = `row ${r}`)}>Row {r}</button>
      {/each}
    </div>
    <p id="picked">Picked: {picked}</p>
  </section>
  <section id="tags">
    {#each tags as t (t)}
      <button id={`tag-${t}`} onclick={() => (chosen = t)}>{t}</button>
    {/each}
    <span id="tags-end">end</span>
  </section>
  <p id="chosen">Chosen: {chosen}</p>
  <section id="breaks">
    <p id="dates">Due 1999-12-31, moved to 2001-02-03; split 1/2 and -5.</p>
    <span id="date-min">1999-12-31</span>
  </section>
  <section id="fields">
    <input id="title" type="text" placeholder="What needs to be done?" bind:value={draft} />
    <textarea id="notes" placeholder="Notes for translators"></textarea>
    <p id="draft">Draft: {draft}</p>
  </section>
  <section id="has">
    <label id="has-card"><input id="has-check" type="checkbox" bind:checked={enabled} /> Enabled</label>
    <div id="has-list">
      {#each items as item (item)}
        <span id={`item-${item}`}>{item}</span>
      {/each}
    </div>
    <button id="has-add" onclick={() => items.push(items.length === 2 ? 'three' : 'four')}>Add</button>
  </section>
  <section id="truncate">
    <p id="trunc-fits" class="truncate">Fits</p>
    <p id="trunc-long" class="truncate">Translations for the release notes of version 2</p>
    <p id="trunc-styled" class="truncate">Plain then <b>bold words that overflow</b> the box</p>
  </section>
  <section id="fv">
    <button id="fv-a">Plain</button>
    <button id="fv-b" onclick={() => target?.focus()}>Focus next</button>
    <button id="fv-c" bind:this={target}>Target</button>
    <input id="fv-t" type="text" />
  </section>
</main>
