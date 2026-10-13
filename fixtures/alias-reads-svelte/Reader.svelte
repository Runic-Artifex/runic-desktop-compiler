<script lang="ts">
  import { getCounter, Holder, mapOf } from './counter.ts';

  const ctx = getCounter();
  const alias = ctx;
  let raw = $state.raw(ctx);
  const holder = new Holder(ctx);
  const map = mapOf(ctx);
  const list = [ctx];
  const doubled = $derived(ctx.count * 2);
  const length = $derived(alias.items.length);
  function shown() {
    return ctx.count;
  }
</script>

<p id="ctx">{ctx.count}</p>
<p id="alias">{alias.items.length}</p>
<p id="raw">{raw.count}</p>
<p id="holder">{holder.counter.count}</p>
<p id="map">{map.get('c')?.count}</p>
<p id="list">{#each list as c}{c.count}{/each}</p>
<p id="derived">{doubled} {length}</p>
<p id="fn">{shown()}</p>
