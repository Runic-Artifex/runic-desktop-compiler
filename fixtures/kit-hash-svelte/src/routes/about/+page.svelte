<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head>
  <title>About</title>
</svelte:head>

<h1>About</h1>
<p id="where">{page.url.hash} · {page.route.id} · {page.status}</p>
