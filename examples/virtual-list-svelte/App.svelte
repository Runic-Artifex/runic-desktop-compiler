<script lang="ts">
  import { onMount } from 'svelte';
  import { ROW, matching, clamp, first, last, describe } from './rows.ts';

  // A virtualized list: 10,000 rows of a fixed height, of which only the
  // rows in view (plus a few above and below) are in the document.
  let filter = $state('');
  let scrollTop = $state(0);
  let height = $state(0);
  let selected = $state<number | null>(null);
  let list: HTMLDivElement;

  const rows = $derived(matching(filter));
  const top = $derived(clamp(scrollTop, rows.length, height));
  const start = $derived(first(top));
  const end = $derived(last(top, height, rows.length));
  const visible = $derived(rows.slice(start, end));
  const status = $derived(describe(selected));

  function measure() {
    scrollTop = list.scrollTop;
    height = list.clientHeight;
  }
  onMount(() => measure());

  function jump() {
    const i = rows.findIndex(r => r.id === 5000);
    if (i < 0) return;
    selected = 5000;
    list.scrollTop = i * ROW;
  }
</script>

<main>
  <!-- First: Blitz hit-tests a scrolled container over the area above it (docs/BLITZ-GAPS.md). -->
  <div id="list" bind:this={list} onscroll={measure}>
    <div class="spacer" style="height: {rows.length * ROW}px; padding-top: {start * ROW}px">
      {#each visible as row (row.id)}
        <button id="row-{row.id}" class="row" class:even={row.id % 2 === 0} class:selected={row.id === selected} onclick={() => (selected = row.id)}>
          <span class="id">{row.id}</span>{row.label} · {row.kind}
        </button>
      {/each}
    </div>
  </div>
  <div class="bar">
    <input id="filter" type="text" aria-label="Filter" bind:value={filter} />
    <button id="jump" onclick={jump}>Jump to 5,000</button>
  </div>
  <p id="status">
    {status} ·{rows.length} rows, rendering {start + 1}–{end}
  </p>
</main>
