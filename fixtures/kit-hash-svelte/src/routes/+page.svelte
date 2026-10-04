<script lang="ts">
  import { page } from '$app/state';

  let count = $state(0);
</script>

<svelte:head>
  <title>Home ({count})</title>
</svelte:head>

<h1>Translations</h1>
<p id="where">{page.url.hash} · {page.route.id} · {page.status}</p>
<button id="count" onclick={() => count++}>Count {count}</button>
