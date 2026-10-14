<script lang="ts">
  // Teardowns of blocks an update removes, logged into one plain array with
  // the pre effects of the components after them: Svelte destroys a block
  // where the effect tree walk reaches its {#if}/{#each} block (its DOM,
  // then its effects' teardowns in tree order), so a later component's
  // $effect.pre runs after it; a branch replacing another is created first.
  import Row from './Row.svelte';

  let items = $state([1, 2, 3]);
  let n = $state(0);
  let show = $state(true);
  let mode = $state(true);
  let next = 4;
  let entries: string[] = [];
  let shown = $state('');

  function record(line: string) {
    entries.push(line);
  }
  function dump() {
    shown = entries.join(' | ');
    entries = [];
  }
  function drop() {
    items.splice(1, 1);
    n++;
  }
  function clear() {
    items = [];
    n++;
  }
  function refill() {
    const out: number[] = [next];
    out.push(next + 1);
    next += 2;
    items = out;
    n++;
  }
  function replace() {
    const out: number[] = [next];
    if (items.length > 0) out.push(items[items.length - 1]);
    next += 1;
    items = out;
    n++;
  }
  function flip() {
    mode = !mode;
    n++;
  }
  function hide() {
    show = !show;
    n++;
  }
</script>

<main>
  <h1 id="title">Teardown order</h1>
  {#if show}<Row id={0} {n} {record} />{/if}
  {#each items as i (i)}<Row id={i} {n} {record} />{:else}<Row id={99} {n} {record} />{/each}
  {#if mode}<Row id={10} {n} {record} />{:else}<Row id={20} {n} {record} />{/if}
  <Row id={9} {n} {record} />
  <p id="log">{shown}</p>
  <div class="controls">
    <button id="bump" onclick={() => n++}>Bump</button><button id="drop" onclick={drop}>Drop</button><button id="clear" onclick={clear}>Clear</button><button id="refill" onclick={refill}>Refill</button><button id="replace" onclick={replace}>Replace</button><button id="flip" onclick={flip}>Flip</button><button id="hide" onclick={hide}>Hide</button><button id="dump" onclick={dump}>Dump</button>
  </div>
</main>
