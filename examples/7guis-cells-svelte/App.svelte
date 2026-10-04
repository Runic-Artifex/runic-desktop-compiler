<script lang="ts">
  import { COLUMNS, cellName, columnName, columns, commit, display, emptySheet, rows } from './sheet.ts';

  // Every cell is a text input showing its value; focusing one (a click or
  // Tab) edits its formula in place, and leaving it (Enter or blur) commits.
  let cells = $state.raw(emptySheet());
  let editing = $state(-1);
  let draft = $state('');

  function start(i: number) {
    editing = i;
    draft = cells[i].formula;
  }

  function finish(i: number) {
    if (editing !== i) return;
    editing = -1;
    if (draft !== cells[i].formula) cells = commit(cells, i, draft);
  }

  function key(e: KeyboardEvent) {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement | null)?.blur();
  }
</script>

<main>
  <h1>Cells</h1>
  <div id="sheet" class="sheet">
    <div class="row">
      <div class="corner"></div>
      {#each columns as c (c)}<div class="head">{columnName(c)}</div>{/each}
    </div>
    {#each rows as r (r)}
      <div class="row">
        <div class="side">{r}</div>
        {#each columns as c (c)}
          <input
            id={cellName(r * COLUMNS + c)}
            type="text"
            class="cell"
            class:error={cells[r * COLUMNS + c].kind === 'error'}
            value={editing === r * COLUMNS + c ? draft : display(cells[r * COLUMNS + c])}
            onfocus={() => start(r * COLUMNS + c)}
            oninput={(e) => (draft = e.currentTarget.value)}
            onkeydown={key}
            onblur={() => finish(r * COLUMNS + c)}
          />
        {/each}
      </div>
    {/each}
  </div>
</main>
