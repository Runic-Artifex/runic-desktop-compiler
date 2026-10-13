<script lang="ts">
  import { watch } from 'runed';
  import { run } from './logic.ts';
  import { describe } from './calendar.ts';

  let k = $state(1);
  let kind = $state(0);
  const rows = $derived(run(k));
  // A callback given to a pack: runed passes undefined as the previous
  // value on the first run, which takes the default.
  let trail = $state('');
  watch(
    () => k,
    (now: number, before: number = 0) => {
      trail = trail + before + '>' + now + ' ';
    },
  );
</script>

<main>
  <h1>Default parameters</h1>
  <div class="row">
    <button id="next" onclick={() => (k = k + 1)}>next</button>
    <button id="kind" onclick={() => (kind = (kind + 1) % 4)}>kind</button>
  </div>
  <ol>
    {#each rows as row, i}
      <li id={'r' + i}>{row}</li>
    {/each}
  </ol>
  <p id="date">{describe(kind)}</p>
  <p id="trail">{trail}</p>
</main>
