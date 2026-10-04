<script lang="ts">
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();
</script>

<svelte:head>
  <title>Items</title>
</svelte:head>

<ul>
  <li><a id="item-1" href="/items/1">One</a></li>
  <li><a id="item-2" href="items/2">Two (relative)</a></li>
</ul>
<p id="list">{data.section} list</p>
