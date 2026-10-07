<script lang="ts">
  interface Row {
    id: number;
    name: string;
    selected: boolean;
  }

  let rows = $state<Row[]>([
    { id: 1, name: 'Alpha', selected: false },
    { id: 2, name: 'Beta', selected: true },
    { id: 3, name: 'Gamma', selected: false },
  ]);
  let next = $state(4);
  let lastRow = $state('-');
  let saved = $state('-');
  let stopped = $state('-');
  let wide = $state(false);

  function add() {
    rows.push({ id: next, name: 'Added ' + next, selected: false });
    next += 1;
  }

  function remove(id: number) {
    rows = rows.filter((row) => row.id !== id);
  }

  function activate(id: number) {
    lastRow = String(id);
  }

  function save(id: number) {
    saved = String(id);
  }

  function stop(event: MouseEvent, id: number) {
    event.stopPropagation();
    stopped = String(id);
  }
</script>

<main>
  <div class="controls">
    <button id="add" onclick={add}>Add</button>
    <button id="reverse" onclick={() => rows = rows.toReversed()}>Reverse</button>
    <button id="toggle-span" onclick={() => wide = !wide}>Toggle colspan</button>
  </div>

  <div id="pane" class="pane">
    <table id="table">
      <caption id="caption">Orders ({rows.length})</caption>
      <colgroup><col class="name" /><col class="edit" /><col class="actions" /></colgroup>
      <thead>
        <tr><th scope="col">Name</th><th scope="col">Selected</th><th scope="col">Actions</th></tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr id={'row-' + row.id} onclick={() => activate(row.id)}>
            <td><input id={'name-' + row.id} aria-label={'Name ' + row.id} bind:value={row.name} /></td>
            <td><input id={'selected-' + row.id} aria-label={'Selected ' + row.id} type="checkbox" bind:checked={row.selected} /></td>
            <td>
              <button id={'save-' + row.id} onclick={() => save(row.id)}>Save</button>
              <button id={'stop-' + row.id} onclick={(event) => stop(event, row.id)}>Stop</button>
              <button id={'remove-' + row.id} onclick={() => remove(row.id)}>Remove</button>
            </td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr id="span-row">
          <td id="span" colspan={wide ? 2 : 1}>Span {wide ? 'wide' : 'narrow'}</td>
          {#if !wide}<td>Detail</td>{/if}
          <td>{rows.length} rows</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <p id="state">row={lastRow} save={saved} stop={stopped} selected={rows.filter((row) => row.selected).length}</p>
</main>
