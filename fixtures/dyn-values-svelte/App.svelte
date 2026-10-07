<script lang="ts">
  import { makeItems, keyed, describe, tally, pick, total, apply, run, names } from './lib.js';
  let count = $state(3);
  let key = $state('a');
  let flag = $state(true);
  let op = $state('double');
  const next = { double: 'square', square: 'label', label: 'double' };
  const items = $derived(makeItems(count));
  const table = $derived(keyed(key, 'b'));
  const counts = $derived(tally(items));
  const picked = $derived(pick(flag));
</script>

<main>
  <h1>Dynamic values</h1>
  <ul>
    {#each items as item (item.n)}
      <li class={item.kind}>{describe(item)}</li>
    {/each}
  </ul>
  <p id="table">{table.a ?? '-'} {table.b} {table.c ?? '-'}</p>
  <p id="counts">odd {counts.odd ?? 0}, even {counts.even ?? 0}, total {total(items)}</p>
  <p id="keys">{Object.keys(counts).join(',')} {items.filter(i => i.half).map(i => i.n).join('+')}</p>
  <p id="functions">{apply(n => n * 2, count)} {items.map(describe).length} {run(op, count)} {names(table.b)}</p>
  <p id="picked">{picked} {picked + 1}</p>
  <div class="controls">
    <button id="more" onclick={() => count++}>More</button>
    <button id="fewer" onclick={() => count--} disabled={count === 0}>Fewer</button>
    <button id="key" onclick={() => (key = key === 'a' ? 'c' : 'a')}>Key</button>
    <button id="op" onclick={() => (op = next[op as keyof typeof next])}>Op</button>
    <button id="flip" onclick={() => (flag = !flag)}>Flip</button>
  </div>
</main>
