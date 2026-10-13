<script lang="ts">
  import { getCounter } from './counter.ts';

  const ctx = getCounter();
  const alias = ctx;

  function bump() {
    ctx.count += 1;
  }
  function add() {
    alias.items.push(ctx.count);
  }
  function clear() {
    ctx.items = [];
  }
</script>

<p id="seen">{ctx.count} {alias.items.length}</p>
<div class="controls">
  <button id="bump" onclick={bump}>Bump</button>
  <button id="add" onclick={add}>Add</button>
  <button id="clear" onclick={clear}>Clear</button>
</div>
