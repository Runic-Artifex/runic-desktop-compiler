<script lang="ts">
  const units = ['day', 'hour', 'minute'];
  let unit = $state('hour');
  let kind = $state('text');
  let extra = $state(false);
  let fixed = $state('b');
  let log = $state<string[]>([]);
</script>

<main>
  <div class="row">
    <select id="unit" aria-label="Unit" bind:value={unit}>
      {#each units as u (u)}<option value={u}>{u}</option>{/each}
      {#if extra}<option value="week">week</option>{/if}
    </select>
    <select id="kind" aria-label="Kind" value={kind} onchange={(e) => { kind = e.currentTarget.value; log.push(`kind:${kind}`); }}>
      <option value="text">Text</option>
      <option value="input" disabled>Input</option>
      <option value="markup">Semantic markup</option>
    </select>
    <select id="free" aria-label="Free" onchange={(e) => log.push(`free:${e.currentTarget.value}`)}>
      <option>Alpha</option>
      <option>  Beta   gamma </option>
    </select>
    <select id="fixed" aria-label="Fixed" value={fixed}>
      <option value="a">A</option>
      <option value="b">B</option>
      <option value="c">C</option>
    </select>
  </div>
  <div class="row">
    <button id="extra" onclick={() => (extra = !extra)}>Extra</button>
    <button id="reset" onclick={() => (unit = 'day')}>Reset</button>
    <button id="bad" onclick={() => (unit = 'month')}>Bad</button>
  </div>
  <p id="state">{unit} {kind}</p>
  <p id="log">{log.join(' ')}</p>
</main>
